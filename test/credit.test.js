"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const credit = require("../src/credit");
const C = require("../src/constants");

const KEY = "wk_" + "A1b2C3d4".repeat(4);
const TOKEN = "gho_SECRET_GITHUB_TOKEN_0123456789";

test("key format", () => {
  assert.equal(C.KEY_RE.test(KEY), true);
  for (const bad of ["", "wk_short", "wk_" + "a".repeat(65), "xx_" + "a".repeat(30), "wk_" + "a".repeat(23) + "!", " " + KEY])
    assert.equal(C.KEY_RE.test(bad), false, bad);
  assert.equal(C.KEY_RE.test("wk_" + "a".repeat(24)), true);
  assert.equal(C.KEY_RE.test("wk_" + "a".repeat(64)), true);
  assert.equal(C.KEY_RE.test("wk_" + "a_-".repeat(10)), true);
});

test("BUY_URL is the Weio key page", () => {
  assert.equal(C.BUY_URL, "https://weio.ai/services/site-check-api.html");
});

/* ------------------------------------------------------------ credit POST */

function fakeFetch(handler) {
  const calls = [];
  const f = async function (url, init) {
    calls.push({ url: url, init: init });
    const r = await handler(url, init);
    return { status: r.status, async json() { if (r.json === undefined) throw new Error("no json"); return r.json; } };
  };
  f.calls = calls;
  return f;
}

test("postCredit: POST to /api/credit with Bearer key, user-agent with the version, no GitHub token", async () => {
  const f = fakeFetch(() => ({ status: 200, json: { ok: true, credits_remaining: 41 } }));
  const r = await credit.postCredit({ fetchImpl: f, base: "https://weio.ai", apiKey: KEY, slug: "weioai/https-check-action", version: "1.2.3" });
  assert.deepEqual(r, { status: 200, body: { ok: true, credits_remaining: 41 } });
  const c = f.calls[0];
  assert.equal(c.url, "https://weio.ai/api/credit?for=ci-speed-check&ref=weioai/https-check-action");
  assert.equal(c.init.method, "POST");
  assert.equal(c.init.headers.Authorization, "Bearer " + KEY);
  assert.equal(c.init.headers["User-Agent"], "weio-ci-speed-check/1.2.3");
  assert.ok(!JSON.stringify(c.init).includes(TOKEN));
  assert.equal(c.init.body, undefined);
});

test("postCredit: unreadable body gives body null; network failure and timeout become CreditError(network)", async () => {
  const r = await credit.postCredit({ fetchImpl: fakeFetch(() => ({ status: 502 })), base: "https://weio.ai", apiKey: KEY, slug: "a/b" });
  assert.deepEqual(r, { status: 502, body: null });
  await assert.rejects(
    () => credit.postCredit({ fetchImpl: async () => { throw new TypeError("fetch failed " + KEY); }, base: "https://weio.ai", apiKey: KEY, slug: "a/b" }),
    (e) => e.name === "CreditError" && e.kind === "network" && !e.message.includes(KEY) && /network error/.test(e.message));
  await assert.rejects(
    () => credit.postCredit({
      fetchImpl: (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); })),
      base: "https://weio.ai", apiKey: KEY, slug: "a/b", timeoutMs: 30
    }),
    (e) => e.kind === "network" && /15 s/.test(e.message));
});

test("interpretCredit: success, and every documented failure keeps Weio's own text", () => {
  assert.deepEqual(credit.interpretCredit({ status: 200, body: { ok: true, credits_remaining: 7 } }), { creditsRemaining: 7 });
  assert.deepEqual(credit.interpretCredit({ status: 200, body: { ok: true } }), { creditsRemaining: null });
  const cases = [
    [400, { ok: false, error: "bad ref" }, "bad-request", /bad ref/],
    [401, { ok: false, error: "invalid API key", buy: "https://example.invalid/x" }, "invalid-key", /invalid API key/],
    [402, { ok: false, error: "no credits left on this key" }, "no-credits", /no credits left on this key/],
    [402, { ok: false, error: "this key has expired" }, "no-credits", /expired/],
    [429, { ok: false, error: "rate limit exceeded" }, "rate-limit", /rate limit/],
    [503, null, "server", /HTTP 503/],
    [418, { ok: false }, "other", /HTTP 418/],
    [200, { ok: false, error: "nope" }, "other", /nope/],
    [200, {}, "other", /unexpected answer from Weio/],
    [200, null, "other", /unexpected answer from Weio/]
  ];
  for (const [status, body, kind, re] of cases) {
    assert.throws(() => credit.interpretCredit({ status: status, body: body }), (e) => {
      assert.equal(e.name, "CreditError");
      assert.equal(e.kind, kind, status + " " + kind);
      assert.match(e.message, re);
      assert.ok(!e.message.includes("example.invalid"), "server-supplied URLs are never surfaced");
      return true;
    });
  }
  // control characters and long text are cleaned
  assert.throws(() => credit.interpretCredit({ status: 402, body: { error: "a\nb\u0007" + "x".repeat(500) } }), (e) => !/[\n\u0007]/.test(e.message) && e.message.length < 300);
});

test("resolveWeioBase: default weio.ai, override only https or loopback http", () => {
  assert.equal(credit.resolveWeioBase({}), "https://weio.ai");
  assert.equal(credit.resolveWeioBase(undefined), "https://weio.ai");
  assert.equal(credit.resolveWeioBase({ WEIO_API_BASE: "https://staging.weio.ai/" }), "https://staging.weio.ai");
  assert.equal(credit.resolveWeioBase({ WEIO_API_BASE: "http://127.0.0.1:8080" }), "http://127.0.0.1:8080");
  assert.equal(credit.resolveWeioBase({ WEIO_API_BASE: "http://localhost:3000/" }), "http://localhost:3000");
  assert.equal(credit.resolveWeioBase({ WEIO_API_BASE: "http://weio.ai" }), null);
  for (const evil of ["https://evil.example", "https://weio.ai.evil.example", "https://notweio.ai", "https://evil.example/weio.ai", "https://weio.ai@evil.example", "http://127.0.0.1.evil.example"]) {
    assert.equal(credit.resolveWeioBase({ WEIO_API_BASE: evil }), null, evil);
  }
  assert.equal(credit.resolveWeioBase({ WEIO_API_BASE: "ftp://x" }), null);
  assert.equal(credit.resolveWeioBase({ WEIO_API_BASE: "not a url" }), null);
});

test("guardedFetch: only the allowed origin is reachable", async () => {
  const seen = [];
  const g = credit.guardedFetch("https://api.github.com", () => async (url) => { seen.push(url); return { status: 200 }; });
  assert.equal((await g("https://api.github.com/repos/a/b")).status, 200);
  for (const bad of ["https://weio.ai/api/credit", "http://api.github.com/x", "https://api.github.com.evil.test/x", "https://evil.test/https://api.github.com/", "not a url"]) {
    assert.throws(() => g(bad), /blocked/, bad);
  }
  assert.deepEqual(seen, ["https://api.github.com/repos/a/b"]);
});

test("redact removes secrets and leaves short strings alone", () => {
  assert.equal(credit.redact("key " + KEY + " and " + TOKEN + " again " + KEY, [KEY, TOKEN]), "key *** and *** again ***");
  assert.equal(credit.redact("abc", ["a"]), "abc");
  assert.equal(credit.redact(undefined, [KEY]), "");
});

/* -------------------------------------------------------- repository detection */

test("githubSlug: https, ssh, scp, git and credentialed forms; anything else is null", () => {
  const ok = {
    "https://github.com/weioai/ci-speed-check-vscode.git": "weioai/ci-speed-check-vscode",
    "https://github.com/weioai/ci-speed-check-vscode": "weioai/ci-speed-check-vscode",
    "https://github.com/a/b/": "a/b",
    ["https://user:" + TOKEN + "@github.com/a/b.git"]: "a/b",
    "https://x-access-token:abc@github.com/a/b": "a/b",
    "git@github.com:a/b.git": "a/b",
    "git@github.com:a/b": "a/b",
    "ssh://git@github.com/a/b.git": "a/b",
    "ssh://git@github.com:22/a/b.git": "a/b",
    "git://github.com/a/b.git": "a/b",
    "github.com:a/b.git": "a/b",
    "https://www.github.com/a/b": "a/b",
    "https://github.com/a.b/c_d-e.git": "a.b/c_d-e",
    "HTTPS://GitHub.com/A/B.git": "A/B"
  };
  Object.keys(ok).forEach((u) => assert.equal(credit.githubSlug(u), ok[u], u));
  for (const bad of ["https://gitlab.com/a/b.git", "https://github.com.evil.test/a/b", "https://github.com/a", "https://github.com/a/b/c", "https://github.com/../b", "https://github.com/a/..", "", null, undefined, "/local/path/repo", "git@bitbucket.org:a/b.git"]) {
    assert.equal(credit.githubSlug(bad), null, String(bad));
  }
});

test("parseGitConfig and githubSlugs: origin first, non-GitHub remotes and duplicates dropped", () => {
  const cfg = [
    "[core]", "\trepositoryformatversion = 0", "\tbare = false",
    "[remote \"upstream\"]", "\turl = https://github.com/upstream-org/project.git", "\tfetch = +refs/heads/*:refs/remotes/upstream/*",
    "[remote \"origin\"]", "\turl = git@github.com:me/project.git", "\tpushurl = git@github.com:me/other.git",
    "[remote \"mirror\"]", "\turl = https://gitlab.com/me/project.git",
    "[remote \"dup\"]", "\turl = https://github.com/me/project",
    "[branch \"main\"]", "\tremote = origin", "\tmerge = refs/heads/main"
  ].join("\r\n");
  const remotes = credit.parseGitConfig(cfg);
  assert.deepEqual(remotes.map((r) => r.name), ["upstream", "origin", "mirror", "dup"]);
  assert.equal(remotes[1].url, "git@github.com:me/project.git");
  assert.deepEqual(credit.githubSlugs(remotes), ["me/project", "upstream-org/project"]);
  assert.deepEqual(credit.githubSlugs(credit.parseGitConfig("[core]\nbare = false\n")), []);
  assert.deepEqual(credit.parseGitConfig("[remote \"o\"]\n  url = \"https://github.com/a/b\"  # note\n"), [{ name: "o", url: "https://github.com/a/b" }]);
  assert.deepEqual(credit.parseGitConfig(""), []);
});

test("validSlug", () => {
  for (const ok of ["a/b", "weioai/https-check-action", "A.b/c_d", " a/b "]) assert.equal(credit.validSlug(ok), true, ok);
  for (const bad of ["", "a", "a/b/c", "/b", "a/", "a b/c", "../x", "a/..", null, undefined, 3]) assert.equal(credit.validSlug(bad), false, String(bad));
});
