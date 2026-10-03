"use strict";
/* Quick fixes for CI Speed Check findings. Pure: no vscode import, no file access; the only I/O is the injected
 * ctx.resolveSha for the pinning fix.
 *
 *   computeFix(text, finding, ctx)      -> Promise<{title, edits} | null>   all four fixes
 *   computeFixSync(text, finding, ctx)  -> {title, edits} | null            the three fixes that need no lookup
 *   canFix(text, finding, ctx)          -> {title} | null                   no network; says whether a fix is offered
 *   applyEdits(text, edits)             -> new text
 *
 * finding: a finding from analyze.js (check, job, action, ref, cache_key, nth).
 * ctx:     {files: [workspace-relative paths of lock and build files], resolveSha: async (owner, repo, ref) => sha}
 * edits:   {line, character, insertText}                              insert at a 0-based position
 *          {startLine, startChar, endLine, endChar, newText}          replace a range
 *
 * Every fix is written as a text edit that keeps the file's line endings and indentation. Before a fix is offered
 * it is applied to a copy, the copy is parsed again, and the result must equal the original document plus exactly
 * the one intended change, with the finding gone and no other finding changed. A fix that cannot pass that check
 * (flow-style YAML, anchors, odd layouts) is not offered, so a quick fix never corrupts a workflow. */

const yaml = require("./core/vendor/js-yaml.min.js");
const rules = require("./core/rules");

const FIXABLE = ["no-job-timeout", "no-concurrency-cancel", "setup-without-cache", "unpinned-third-party-action"];
const SYNC_FIXABLE = ["no-job-timeout", "no-concurrency-cancel", "setup-without-cache"];
const PLACEHOLDER_SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA_RE = /^[0-9a-f]{40}$/;
const TIMEOUT_MINUTES = 30;
const MAX_FIX_CHARS = 256 * 1024;   // quick fixes parse the file a few times; workflows are far smaller than this
const CONCURRENCY_GROUP = "${{ github.workflow }}-${{ github.ref }}";
const CONCURRENCY_CANCEL = "${{ github.event_name == 'pull_request' }}";

/* ------------------------------------------------------------ text helpers */

function stripBom(t) { return String(t === undefined || t === null ? "" : t).replace(/^﻿/, ""); }
function detectEol(text) { const m = /\r\n|\n|\r/.exec(text); return m ? m[0] : "\n"; }
function pad(n) { return new Array(n + 1).join(" "); }
function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
function clean(s, max) { return String(s).replace(/[\u0000-\u001f\u007f`]+/g, " ").trim().slice(0, max || 60); }

function lineStarts(text) {
  const starts = [0];
  const re = /\r\n|\r|\n/g;
  let m;
  while ((m = re.exec(text))) starts.push(m.index + m[0].length);
  return starts;
}

function applyEdits(text, edits) {
  text = String(text);
  const starts = lineStarts(text);
  const off = function (line, ch) {
    if (line < 0 || line >= starts.length) throw new Error("edit outside the document");
    return starts[line] + ch;
  };
  const list = edits.map(function (e) {
    if (e.insertText !== undefined) {
      const o = off(e.line, e.character);
      return { start: o, end: o, text: e.insertText };
    }
    return { start: off(e.startLine, e.startChar), end: off(e.endLine, e.endChar), text: e.newText };
  }).sort(function (a, b) { return b.start - a.start; });
  let out = text;
  list.forEach(function (e) {
    if (e.start > e.end || e.end > out.length) throw new Error("edit outside the document");
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  });
  return out;
}

// Quote-aware removal of a trailing YAML comment (same rule as the engine).
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) {
        if (q === "'" && s.charAt(i + 1) === "'") i++;
        else q = null;
      }
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s\[{,]/.test(s.charAt(i - 1))) q = c;
    } else if (c === "#" && (i === 0 || /\s/.test(s.charAt(i - 1)))) {
      return s.slice(0, i);
    }
  }
  return s;
}

// "key: value" starting at column col: {key, value (comment stripped), col} or null.
function parseKeyAt(line, col) {
  const s = line.slice(col);
  let m, key;
  if ((m = /^"((?:[^"\\]|\\.)*)"[ \t]*:(?=[ \t]|$)/.exec(s))) key = m[1].replace(/\\(.)/g, "$1");
  else if ((m = /^'((?:[^']|'')*)'[ \t]*:(?=[ \t]|$)/.exec(s))) key = m[1].replace(/''/g, "'");
  else if ((m = plainKeyMatch(s))) key = m[1];
  else return null;
  return { key: key, value: stripComment(s.slice(m[0].length)).trim(), col: col };
}

// Same match as /^([^\s#{}\[\],&*!|>%@`'"?:-][^#:]*?|-[^\s#:][^#:]*?)[ \t]*:(?=[ \t]|$)/ without its quadratic
// backtracking on long runs of spaces: [whole match, key] or null.
function plainKeyMatch(s) {
  const c0 = s.charAt(0);
  let first;
  if (c0 === "-") {
    if (s.length < 2 || /[\s#:]/.test(s.charAt(1))) return null;
    first = 2;
  } else {
    if (c0 === "" || /[\s#{}\[\],&*!|>%@`'"?:]/.test(c0)) return null;
    first = 1;
  }
  for (let i = first; i < s.length; i++) {
    const c = s.charAt(i);
    if (c === "#") return null;
    if (c === ":") {
      if (i + 1 < s.length && s.charAt(i + 1) !== " " && s.charAt(i + 1) !== "\t") return null;
      let k = i;
      while (k > first && (s.charAt(k - 1) === " " || s.charAt(k - 1) === "\t")) k--;
      return [s.slice(0, i + 1), s.slice(0, k)];
    }
  }
  return null;
}

// "- " list item line: column where the item's first key starts, or -1.
function dashKeyCol(line) {
  const m = /^( *)-( +)(?=\S)/.exec(line);
  return m ? m[1].length + 1 + m[2].length : -1;
}

function scan(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const info = lines.map(function (l) {
    const blank = /^\s*$/.test(l);
    return { blank: blank, comment: !blank && /^\s*#/.test(l), indent: /^ */.exec(l)[0].length };
  });
  // Indent step used by the file: the first nesting increase, 2 when it cannot be told.
  let unit = 2, base = -1;
  for (let i = 0; i < lines.length; i++) {
    if (info[i].blank || info[i].comment) continue;
    if (base < 0) { base = info[i].indent; continue; }
    if (info[i].indent > base) { unit = Math.min(8, info[i].indent - base); break; }
  }
  return { text: text, lines: lines, info: info, eol: detectEol(text), unit: unit };
}

// Insert newLines after line index `last`, keeping the file's line ending and not adding or losing a final newline.
function insertAfter(S, last, newLines) {
  const body = newLines.join(S.eol);
  if (last + 1 < S.lines.length) return { line: last + 1, character: 0, insertText: body + S.eol };
  return { line: last, character: S.lines[last].length, insertText: S.eol + body };
}

function locateIdx(S, finding, nth) { return rules.locate(S.text, finding, nth) - 1; }

/* ------------------------------------------------------- semantic checking */

// Structural equality that stays linear on documents with shared (aliased) nodes.
function deepEqual(a, b, memo) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return typeof a === "number" && typeof b === "number" && a !== a && b !== b;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  memo = memo || new Map();
  let seen = memo.get(a);
  if (seen && seen.has(b)) return true;
  if (!seen) memo.set(a, (seen = new Set()));
  seen.add(b);
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], memo)) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i];
    if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k], memo)) return false;
  }
  return true;
}

function sig(f) { return [f.check, f.job, f.action, f.ref, f.cache_key].join("\u0000"); }
function countSigs(list) {
  const m = Object.create(null);
  list.forEach(function (f) { const k = sig(f); m[k] = (m[k] || 0) + 1; });
  return m;
}

// Steps of a job that produce the same finding as `finding`, in document order.
function matchingSteps(doc, finding) {
  const job = isObj(doc) && isObj(doc.jobs) ? doc.jobs[finding.job] : null;
  if (!isObj(job) || !Array.isArray(job.steps)) return [];
  const target = sig(finding);
  return job.steps.filter(function (step) {
    if (!isObj(step)) return false;
    const mini = { on: "pull_request", concurrency: "x", jobs: {} };
    mini.jobs[finding.job] = { "timeout-minutes": 1, steps: [step] };
    return rules.checkWorkflow("x", mini).some(function (f) { return sig(f) === target; });
  });
}

// Applies the plan's edits to a copy and proves the copy is the original plus the one intended change.
function verify(S, finding, nth, plan, edits, sha) {
  try {
    const newText = applyEdits(S.text, edits);
    const expected = yaml.loadAll(S.text);
    const before = yaml.loadAll(S.text);
    const after = yaml.loadAll(newText);
    if (!expected.length || expected.length !== after.length) return false;
    plan.mutate(expected, nth, sha);
    if (!deepEqual(expected, after)) return false;
    const was = countSigs(rules.checkWorkflow("x", before[0]));
    const now = countSigs(rules.checkWorkflow("x", after[0]));
    const want = Object.assign({}, was);
    want[sig(finding)] = (want[sig(finding)] || 0) - 1;
    const keys = Object.keys(Object.assign({}, want, now));
    return keys.every(function (k) { return (want[k] || 0) === (now[k] || 0); });
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------- plans */

// A plan: {title, build(sha) -> edits, mutate(docs, nth, sha)}, or null when no safe fix exists.

function planTimeout(S, finding, nth) {
  const idx = locateIdx(S, finding, nth);
  const line = S.lines[idx];
  if (line === undefined) return null;
  const kl = parseKeyAt(line, S.info[idx].indent);
  if (!kl || kl.key !== String(finding.job) || kl.value !== "") return null;   // inline value: flow style or alias
  let childIndent = -1;
  for (let j = idx + 1; j < S.lines.length; j++) {
    if (S.info[j].blank || S.info[j].comment) continue;
    if (S.info[j].indent <= S.info[idx].indent || /^\s*-(\s|$)/.test(S.lines[j])) return null;
    childIndent = S.info[j].indent;
    break;
  }
  if (childIndent < 0) return null;
  return {
    title: "Add timeout-minutes: " + TIMEOUT_MINUTES + " to job '" + clean(finding.job, 40) + "'",
    build: function () { return [insertAfter(S, idx, [pad(childIndent) + "timeout-minutes: " + TIMEOUT_MINUTES])]; },
    mutate: function (docs) { docs[0].jobs[finding.job]["timeout-minutes"] = TIMEOUT_MINUTES; }
  };
}

function planConcurrency(S, finding, nth) {
  const idx = locateIdx(S, finding, nth);
  const line = S.lines[idx];
  if (line === undefined) return null;
  const top = S.info[idx].indent;
  const kl = parseKeyAt(line, top);
  if (!kl || (kl.key !== "on" && kl.key !== "true")) return null;
  // The on: section runs until the next line indented no deeper than the key. Comments indented deeper that trail
  // the section stay with it; comments at the key's own indent belong to what follows.
  let last = idx;
  for (let j = idx + 1; j < S.lines.length; j++) {
    if (S.info[j].blank) continue;
    if (S.info[j].comment) { if (S.info[j].indent > top) last = j; continue; }
    if (S.info[j].indent <= top) break;
    last = j;
  }
  const step = pad(S.unit);
  const block = [
    pad(top) + "concurrency:",
    pad(top) + step + "group: " + CONCURRENCY_GROUP,
    pad(top) + step + "cancel-in-progress: " + CONCURRENCY_CANCEL
  ];
  const next = last + 1;
  const trailingNewlineArtifact = next === S.lines.length - 1 && S.lines[next] === "";
  const lines = next < S.lines.length && S.info[next].blank && !trailingNewlineArtifact ? [""].concat(block) : block;
  return {
    title: "Add concurrency group (cancels superseded pull request runs; a push run already in progress is never cancelled)",
    build: function () { return [insertAfter(S, last, lines)]; },
    mutate: function (docs) {
      docs[0].concurrency = { group: CONCURRENCY_GROUP, "cancel-in-progress": CONCURRENCY_CANCEL };
    }
  };
}

/* What to put in the cache input, from the lock and build files that exist. Returns {value, source} or null.
 * Conservative on purpose: a wrong value makes the setup step fail, so anything ambiguous or missing a
 * prerequisite returns null and no fix is offered.
 *   - one project type per action: two lock files of different managers is ambiguous
 *   - setup-node reads lock files at the repository root only
 *   - pnpm, Yarn Berry, poetry and pipenv must be installed before the setup step (checked in the job's earlier text)
 *   - setup-dotnet needs packages.lock.json and ruby/setup-ruby needs a Gemfile, or the step fails */
function inferCache(action, files, mentions) {
  const root = new Set(files.filter(function (f) { return f.indexOf("/") < 0; }));
  const anywhere = function (name) { return files.some(function (f) { return f === name || f.slice(-(name.length + 1)) === "/" + name; }); };
  const one = function (found) { return found.length === 1 ? found[0] : null; };
  let pick;
  switch (action) {
    case "actions/setup-node": {
      const found = [];
      if (root.has("package-lock.json")) found.push({ value: "npm", source: "package-lock.json" });
      else if (root.has("npm-shrinkwrap.json")) found.push({ value: "npm", source: "npm-shrinkwrap.json" });
      if (root.has("yarn.lock")) found.push({ value: "yarn", source: "yarn.lock" });
      if (root.has("pnpm-lock.yaml")) found.push({ value: "pnpm", source: "pnpm-lock.yaml" });
      pick = one(found);
      if (pick && pick.value === "pnpm" && !mentions(/\bpnpm\b|corepack/i)) return null;
      if (pick && pick.value === "yarn" && root.has(".yarnrc.yml") && !mentions(/corepack/i)) return null;
      return pick;
    }
    case "actions/setup-python": {
      const found = [];
      if (anywhere("poetry.lock")) found.push({ value: "poetry", source: "poetry.lock" });
      if (anywhere("Pipfile.lock")) found.push({ value: "pipenv", source: "Pipfile.lock" });
      if (anywhere("requirements.txt")) found.push({ value: "pip", source: "requirements.txt" });
      pick = one(found);
      if (pick && pick.value === "poetry" && !mentions(/\bpoetry\b/i)) return null;
      if (pick && pick.value === "pipenv" && !mentions(/\bpipenv\b/i)) return null;
      return pick;
    }
    case "actions/setup-java": {
      const found = [];
      if (anywhere("pom.xml")) found.push({ value: "maven", source: "pom.xml" });
      if (anywhere("build.gradle")) found.push({ value: "gradle", source: "build.gradle" });
      else if (anywhere("build.gradle.kts")) found.push({ value: "gradle", source: "build.gradle.kts" });
      if (anywhere("build.sbt")) found.push({ value: "sbt", source: "build.sbt" });
      return one(found);
    }
    case "actions/setup-go":
      // setup-go v3 fails the step when caching is on and there is no go.sum at the repository root
      return root.has("go.sum") ? { value: true, source: "go.sum" } : null;
    case "actions/setup-dotnet":
      return root.has("packages.lock.json") ? { value: true, source: "packages.lock.json" } : null;
    case "ruby/setup-ruby":
      return root.has("Gemfile") ? { value: true, source: "Gemfile" } : null;
    default:
      return null;
  }
}

function planCache(S, finding, nth, ctx) {
  const key = finding.cache_key || rules.CACHEABLE_SETUP[finding.action];
  if (!key || rules.CACHEABLE_SETUP[finding.action] !== key) return null;
  const usesIdx = locateIdx(S, finding, nth);
  const usesLine = S.lines[usesIdx];
  if (usesLine === undefined) return null;

  // `uses:` key, on the "- " line or on its own line. Flow style ("- {uses: ...}") does not match and is skipped.
  const dashCol = dashKeyCol(usesLine);
  const keyCol = dashCol >= 0 ? dashCol : S.info[usesIdx].indent;
  const uk = parseKeyAt(usesLine, keyCol);
  if (!uk || uk.key !== "uses") return null;
  const usesValue = uk.value.replace(/^(["'])(.*)\1$/, "$2");
  if (usesValue.split("@")[0] !== finding.action) return null;

  // The step: from its "- " line to the next line indented no deeper than the dash.
  let dashIdx = usesIdx;
  if (dashCol < 0) {
    dashIdx = -1;
    for (let j = usesIdx - 1; j >= 0; j--) {
      if (S.info[j].blank || S.info[j].comment) continue;
      if (S.info[j].indent < keyCol) { if (dashKeyCol(S.lines[j]) === keyCol) dashIdx = j; break; }
    }
    if (dashIdx < 0) return null;
  }
  const dashIndent = S.info[dashIdx].indent;
  let end = S.lines.length;
  for (let j = dashIdx + 1; j < S.lines.length; j++) {
    if (S.info[j].blank || S.info[j].comment) continue;
    if (S.info[j].indent <= dashIndent) { end = j; break; }
  }

  // Which jobs-level text came before this step, for the "installed first" prerequisites.
  const jobIdx = rules.locate(S.text, { check: "no-job-timeout", job: finding.job }, 0) - 1;
  const before = S.lines.slice(jobIdx >= 0 && jobIdx < dashIdx ? jobIdx : dashIdx, dashIdx)
    .filter(function (l) { return !/^\s*#/.test(l); }).join("\n");
  const found = inferCache(finding.action, (ctx && ctx.files) || [], function (re) { return re.test(before); });
  if (!found) return null;
  const valueText = String(found.value);

  // An existing with: mapping gets one more key; otherwise a with: block is added under the uses line.
  let withIdx = -1;
  for (let j = dashIdx; j < end; j++) {
    const col = j === dashIdx ? keyCol : S.info[j].indent;
    if (j !== dashIdx && col !== keyCol) continue;
    const k = parseKeyAt(S.lines[j], col);
    if (k && k.key === "with") { withIdx = j; break; }
  }
  let edits;
  if (withIdx >= 0) {
    const wk = parseKeyAt(S.lines[withIdx], withIdx === dashIdx ? keyCol : S.info[withIdx].indent);
    if (wk.value !== "") return null;                                 // with: {..} or an alias
    let childIndent = -1, lastChild = withIdx;
    for (let j = withIdx + 1; j < end; j++) {
      if (S.info[j].blank) continue;
      if (S.info[j].indent <= keyCol) { if (S.info[j].comment) continue; break; }
      if (childIndent < 0 && !S.info[j].comment) {
        if (/^\s*-(\s|$)/.test(S.lines[j])) return null;
        childIndent = S.info[j].indent;
      }
      lastChild = j;
    }
    if (childIndent < 0) childIndent = keyCol + S.unit;
    for (let j = withIdx + 1; j <= lastChild; j++) {
      if (S.info[j].blank || S.info[j].comment || S.info[j].indent !== childIndent) continue;
      const ck = parseKeyAt(S.lines[j], childIndent);
      if (ck && ck.key === key) return null;                          // the key is there already (empty value)
    }
    edits = [insertAfter(S, lastChild, [pad(childIndent) + key + ": " + valueText])];
  } else {
    edits = [insertAfter(S, usesIdx, [pad(keyCol) + "with:", pad(keyCol + S.unit) + key + ": " + valueText])];
  }
  return {
    title: "Add " + key + ": " + valueText + " to " + finding.action + (found.source ? " (found " + found.source + ")" : ""),
    build: function () { return edits; },
    mutate: function (docs, n) {
      const step = matchingSteps(docs[0], finding)[n];
      if (!step) throw new Error("step not found");
      if (!isObj(step.with)) step.with = {};
      step.with[key] = found.value;
    }
  };
}

function planPin(S, finding, nth) {
  const action = String(finding.action || ""), ref = String(finding.ref === undefined ? "" : finding.ref);
  const parts = action.split("/");
  if (action.indexOf("docker://") === 0 || action.charAt(0) === "." || parts.length < 2 ||
      !/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(parts[1]) ||
      !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(ref) ||
      [parts[0], parts[1]].concat(ref.split("/")).some(function (p) { return p === "." || p === ".."; })) return null;
  const idx = locateIdx(S, finding, nth);
  const line = S.lines[idx];
  if (line === undefined) return null;
  const m = /^(\s*(?:-\s+)?["']?uses["']?\s*:\s*)(["']?)([^\s"'#]+)\2(\s*#.*)?\s*$/.exec(line);
  if (!m || m[3] !== action + "@" + ref) return null;                 // flow style, multi-line value or another layout
  const comment = m[4] ? " " + m[4].trim() : "";
  return {
    title: "Pin " + clean(action, 60) + " to the commit behind " + clean(ref, 40),
    owner: parts[0], repo: parts[1], ref: ref, needsSha: true,
    build: function (sha) {
      return [{
        startLine: idx, startChar: m[1].length + m[2].length, endLine: idx, endChar: line.length,
        newText: action + "@" + sha + m[2] + " # " + ref + comment
      }];
    },
    mutate: function (docs, n, sha) {
      const target = action + "@" + ref;
      const steps = [];
      const job = docs[0].jobs[finding.job];
      (job.steps || []).forEach(function (s) { if (isObj(s) && String(s.uses || "").trim() === target) steps.push(s); });
      if (!steps[n]) throw new Error("step not found");
      steps[n].uses = action + "@" + sha;
    }
  };
}

function plan(text, finding, ctx) {
  if (!finding || typeof finding !== "object" || FIXABLE.indexOf(finding.check) < 0) return null;
  if (String(text === undefined || text === null ? "" : text).length > MAX_FIX_CHARS) return null;
  const S = scan(stripBom(text));
  const nth = finding.nth > 0 ? finding.nth : 0;
  let p = null;
  try {
    switch (finding.check) {
      case "no-job-timeout": p = planTimeout(S, finding, nth); break;
      case "no-concurrency-cancel": p = planConcurrency(S, finding, nth); break;
      case "setup-without-cache": p = planCache(S, finding, nth, ctx); break;
      case "unpinned-third-party-action": p = planPin(S, finding, nth); break;
    }
  } catch (e) {
    p = null;
  }
  return p ? { S: S, nth: nth, p: p } : null;
}

function finish(planned, finding, sha) {
  const edits = planned.p.build(sha);
  return verify(planned.S, finding, planned.nth, planned.p, edits, sha) ? { title: planned.p.title, edits: edits } : null;
}

/* ------------------------------------------------------------------ public */

function canFix(text, finding, ctx) {
  const planned = plan(text, finding, ctx);
  if (!planned) return null;
  const fix = finish(planned, finding, PLACEHOLDER_SHA);
  return fix ? { title: fix.title } : null;
}

function computeFixSync(text, finding, ctx) {
  if (!finding || SYNC_FIXABLE.indexOf(finding.check) < 0) return null;
  const planned = plan(text, finding, ctx);
  return planned ? finish(planned, finding) : null;
}

async function computeFix(text, finding, ctx) {
  const planned = plan(text, finding, ctx);
  if (!planned) return null;
  if (!planned.p.needsSha) return finish(planned, finding);
  if (!ctx || typeof ctx.resolveSha !== "function") return null;
  const sha = String(await ctx.resolveSha(planned.p.owner, planned.p.repo, planned.p.ref)).trim().toLowerCase();
  if (!SHA_RE.test(sha)) throw new Error("GitHub did not return a 40-character commit SHA for " + planned.p.owner + "/" + planned.p.repo + "@" + planned.p.ref);
  return finish(planned, finding, sha);
}

module.exports = {
  computeFix, computeFixSync, canFix, applyEdits, FIXABLE, SYNC_FIXABLE, PLACEHOLDER_SHA,
  CONCURRENCY_GROUP, CONCURRENCY_CANCEL, TIMEOUT_MINUTES
};
