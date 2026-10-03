"use strict";
/* Weio credit call, repository detection and request guards for the Pro run-history report.
 * Pure: no vscode import. Everything that touches the network takes an injected fetch. */

const { DEFAULT_WEIO_BASE, CREDIT_TIMEOUT_MS, KEY_RE } = require("./constants");

class CreditError extends Error {
  /* kind: "network" | "bad-request" | "invalid-key" | "no-credits" | "rate-limit" | "server" | "other" */
  constructor(kind, message, status) {
    super(message);
    this.name = "CreditError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

function cleanText(s, max) {
  return String(s === undefined || s === null ? "" : s).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max || 200);
}

// Remove every secret from a message before it is shown anywhere.
function redact(text, secrets) {
  let out = String(text === undefined || text === null ? "" : text);
  (secrets || []).forEach(function (s) {
    if (typeof s === "string" && s.length >= 6) out = out.split(s).join("***");
  });
  return out;
}

function isLoopback(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/* Base URL for the Weio credit call. Default https://weio.ai. WEIO_API_BASE may override it for testing, but only
 * with https on weio.ai or one of its subdomains, or http on a loopback address. Anything else returns null, so the
 * key cannot be pointed at another host. */
function resolveWeioBase(env) {
  const raw = env && env.WEIO_API_BASE ? String(env.WEIO_API_BASE) : DEFAULT_WEIO_BASE;
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  const weio = u.hostname === "weio.ai" || u.hostname.slice(-8) === ".weio.ai";
  if (!(u.protocol === "https:" && weio) && !(u.protocol === "http:" && isLoopback(u.hostname))) return null;
  return raw.replace(/\/+$/, "");
}

/* A fetch that refuses any URL outside one origin, so a credential can only go where it is meant to. */
function guardedFetch(origin, getFetch) {
  const allowed = new URL(origin).origin;
  return function (url, init) {
    let u;
    try { u = new URL(url); } catch (e) { throw new Error("blocked: not a valid URL"); }
    if (u.origin !== allowed) throw new Error("blocked: request outside " + allowed);
    const f = typeof getFetch === "function" ? getFetch() : globalThis.fetch;
    if (typeof f !== "function") throw new Error("this VS Code has no fetch");
    return f(url, init);
  };
}

/* POST {base}/api/credit?for=ci-speed-check&ref=<owner>/<repo>. Resolves {status, body}; rejects with a
 * CreditError of kind "network" when Weio cannot be reached in time. */
async function postCredit(opts) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(function () { ctl.abort(); }, opts.timeoutMs || CREDIT_TIMEOUT_MS) : null;
  try {
    const res = await opts.fetchImpl(opts.base + "/api/credit?for=ci-speed-check&ref=" + opts.slug, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + opts.apiKey,
        "User-Agent": "weio-ci-speed-check/" + (opts.version || "1.0.0"),
        "Accept": "application/json"
      },
      signal: ctl ? ctl.signal : undefined
    });
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    return { status: res.status, body: body };
  } catch (e) {
    throw new CreditError("network", "could not reach Weio to use a credit (" +
      (e && e.name === "AbortError" ? "no answer within 15 s" : "network error") + ")");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* Reads a credit response. Returns {creditsRemaining} on success (null when Weio did not say); throws a CreditError
 * that carries Weio's own error text otherwise. */
function interpretCredit(res) {
  const b = res && res.body && typeof res.body === "object" ? res.body : {};
  const status = res ? res.status : 0;
  if (status === 200 && b.ok === true) {
    return { creditsRemaining: typeof b.credits_remaining === "number" && isFinite(b.credits_remaining) ? b.credits_remaining : null };
  }
  if (status === 200 && b.ok !== false) throw new CreditError("other", "unexpected answer from Weio (HTTP 200 without a confirmed credit)", status);
  const text = cleanText(typeof b.error === "string" && b.error ? b.error : "HTTP " + status, 200);
  const kind = status === 400 ? "bad-request" : status === 401 ? "invalid-key" : status === 402 ? "no-credits" :
    status === 429 ? "rate-limit" : status >= 500 ? "server" : "other";
  throw new CreditError(kind, "Weio said: " + text + " (HTTP " + status + ")", status);
}

/* ---------------------------------------------------------- repository detection */

/* "owner/repo" for any common GitHub remote URL form, else null. Credentials inside the URL are never returned. */
function githubSlug(url) {
  const m = /^(?:(?:https?|git|ssh|git\+ssh):\/\/)?(?:[^@\/\s]+@)?(?:www\.)?github\.com(?::\d+)?[:\/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(String(url || "").trim());
  if (!m) return null;
  const bad = function (s) { return s === "." || s === ".."; };
  if (bad(m[1]) || bad(m[2])) return null;
  return m[1] + "/" + m[2];
}

/* Remotes from the text of a .git/config: [{name, url}] in file order. */
function parseGitConfig(text) {
  const out = [];
  let current = null;
  String(text || "").split(/\r\n|\r|\n/).forEach(function (line) {
    const head = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(?:[#;].*)?$/.exec(line);
    if (head) {
      current = head[1].toLowerCase() === "remote" && head[2] !== undefined ? { name: head[2].replace(/\\(.)/g, "$1"), url: null } : null;
      if (current) out.push(current);
      return;
    }
    if (!current || current.url !== null) return;
    const kv = /^\s*url\s*=\s*(.*?)\s*$/i.exec(line);
    if (kv) {
      const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(kv[1]);
      current.url = quoted ? quoted[1].replace(/\\(.)/g, "$1") : kv[1].replace(/\s+[#;].*$/, "");
    }
  });
  return out.filter(function (r) { return r.url; });
}

/* Distinct GitHub slugs among the remotes, origin first. */
function githubSlugs(remotes) {
  const list = (remotes || []).slice().sort(function (a, b) { return (a.name === "origin" ? 0 : 1) - (b.name === "origin" ? 0 : 1); });
  const slugs = [];
  list.forEach(function (r) {
    const s = githubSlug(r.url);
    if (s && slugs.indexOf(s) < 0) slugs.push(s);
  });
  return slugs;
}

function validSlug(s) {
  return typeof s === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.trim()) &&
    s.trim().split("/").every(function (p) { return p !== "." && p !== ".."; });
}

module.exports = {
  CreditError, cleanText, redact, resolveWeioBase, guardedFetch, postCredit, interpretCredit,
  githubSlug, parseGitConfig, githubSlugs, validSlug, KEY_RE
};
