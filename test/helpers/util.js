"use strict";
const { analyzeText, signature } = require("../../src/analyze");
const fixes = require("../../src/fixes");

function crlf(text) { return text.replace(/\r?\n/g, "\r\n"); }

function findings(text, check) {
  const r = analyzeText(text, "ci.yml");
  if (!r.ok) throw new Error("fixture does not parse: " + r.reason);
  return check ? r.findings.filter(function (f) { return f.check === check; }) : r.findings;
}

function counts(list) {
  const m = {};
  list.forEach(function (f) { const k = signature(f); m[k] = (m[k] || 0) + 1; });
  return m;
}

const FILES = ["package-lock.json", "requirements.txt", "pom.xml", "Gemfile", "packages.lock.json"];
function sha(c) { return new Array(41).join(c || "a"); }

/* Applies the fix for the nth finding of `check`. Returns {fix, text} (text unchanged and fix null when none). */
async function applyFix(text, check, opts) {
  opts = opts || {};
  const list = findings(text, check);
  const f = list[opts.index || 0];
  if (!f) throw new Error("no " + check + " finding #" + (opts.index || 0));
  const ctx = { files: opts.files || FILES, resolveSha: opts.resolveSha || (async function () { return sha("a"); }) };
  const fix = await fixes.computeFix(text, f, ctx);
  return { finding: f, fix: fix, text: fix ? fixes.applyEdits(text, fix.edits) : text };
}

/* The fix removed exactly the finding it targeted and nothing else changed. */
function assertOnlyTargetGone(before, after, finding, assert) {
  const was = counts(findings(before));
  const now = counts(findings(after));
  const want = Object.assign({}, was);
  want[signature(finding)]--;
  Object.keys(Object.assign({}, want, now)).forEach(function (k) {
    assert.strictEqual(now[k] || 0, want[k] || 0, "finding set changed for " + JSON.stringify(k));
  });
}

function eolsConsistent(text, eol) {
  if (eol === "\r\n") return !/(^|[^\r])\n/.test(text) && !/\r(?!\n)/.test(text);
  return text.indexOf("\r") < 0;
}

module.exports = { crlf, findings, counts, applyFix, assertOnlyTargetGone, eolsConsistent, FILES, sha };
