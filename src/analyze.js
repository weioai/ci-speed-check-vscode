"use strict";
/* Turns workflow text into findings with editor positions. Pure: no vscode import, no file or network access. */

const yaml = require("./core/vendor/js-yaml.min.js");
const rules = require("./core/rules");
const { WORKFLOW_PATH_RE, MAX_FILE_BYTES } = require("./constants");
const MAX_FINDINGS = 1000;

function isWorkflowPath(p) {
  return typeof p === "string" && WORKFLOW_PATH_RE.test(p);
}

// Same line model as the rules engine and VS Code: CRLF, CR and LF all end a line.
function splitLines(text) {
  return String(text).replace(/^﻿/, "").split(/\r\n|\r|\n/);
}

function signature(f) {
  return [f.check, f.job, f.action, f.ref, f.cache_key].join("\u0000");
}

/* analyzeText(text, name) ->
 *   {ok: true,  findings: [{check, severity, detail, job?, action?, ref?, cache_key?, line, startChar, endChar, nth}]}
 *   {ok: false, reason: "too-large" | "parse-error", findings: []}
 * line is 1-based. startChar..endChar span the line without its indentation and trailing whitespace.
 * nth counts identical findings (same check, job, action, ref, cache key) in document order, so two identical
 * steps each point at their own line. YAML that does not parse yields no findings: YAML tools report that. */
function analyzeText(text, name) {
  text = String(text === undefined || text === null ? "" : text);
  if (text.length > MAX_FILE_BYTES) return { ok: false, reason: "too-large", findings: [] };
  let docs;
  try {
    docs = yaml.loadAll(text);
  } catch (e) {
    return { ok: false, reason: "parse-error", findings: [] };
  }
  let found;
  try {
    found = rules.checkWorkflow(name || "workflow.yml", docs[0]);
  } catch (e) {
    return { ok: false, reason: "parse-error", findings: [] };
  }
  if (found.length > MAX_FINDINGS) found = found.slice(0, MAX_FINDINGS);   // YAML aliases can multiply findings
  const lines = splitLines(text);
  const seen = Object.create(null);
  const findings = found.map(function (f) {
    const sig = signature(f);
    const nth = seen[sig] || 0;
    seen[sig] = nth + 1;
    const line = rules.locate(text, f, nth);
    const src = lines[line - 1] === undefined ? "" : lines[line - 1];
    const startChar = /^\s*/.exec(src)[0].length;
    const endChar = Math.max(startChar, src.trimEnd().length);
    return Object.assign({}, f, { line: line, startChar: startChar, endChar: endChar, nth: nth });
  });
  return { ok: true, findings: findings };
}

module.exports = { analyzeText, isWorkflowPath, splitLines, signature };
