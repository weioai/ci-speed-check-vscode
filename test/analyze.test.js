"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeText, isWorkflowPath } = require("../src/analyze");

test("isWorkflowPath: .github/workflows/*.yml|yaml on any platform, nothing else", () => {
  const yes = [
    "/home/me/repo/.github/workflows/ci.yml", "/home/me/repo/.github/workflows/ci.yaml",
    "C:\\work\\repo\\.github\\workflows\\build.yml", "/.github/workflows/a.yml", "c:/x/.github/workflows/Release.YML".toLowerCase()
  ];
  const no = [
    "/home/me/repo/.github/workflows/sub/ci.yml", "/home/me/repo/.github/workflows/ci.yml.bak",
    "/home/me/repo/.github/ci.yml", "/home/me/repo/workflows/ci.yml", "/home/me/repo/github/workflows/ci.yml",
    "/home/me/repo/.github/workflows/ci.json", "ci.yml", "", null, undefined, 42
  ];
  yes.forEach((p) => assert.equal(isWorkflowPath(p), true, p));
  no.forEach((p) => assert.equal(isWorkflowPath(p), false, String(p)));
});

const WF = [
  "name: ci",                                  // 1
  "on:",                                       // 2
  "  push:",                                   // 3
  "jobs:",                                     // 4
  "  build:",                                  // 5
  "    runs-on: ubuntu-latest",                // 6
  "    steps:",                                // 7
  "      - uses: actions/setup-node@v4   ",    // 8
  "      - uses: org/tool@v1 # c",             // 9
  "      - uses: org/tool@v1",                 // 10
  ""
].join("\n");

test("analyzeText: findings carry 1-based lines, character spans without indentation, and severity", () => {
  const r = analyzeText(WF, "ci.yml");
  assert.equal(r.ok, true);
  const by = (c) => r.findings.filter((f) => f.check === c);
  assert.equal(by("no-concurrency-cancel")[0].line, 2);
  assert.equal(by("no-concurrency-cancel")[0].severity, "defect");
  assert.equal(by("no-job-timeout")[0].line, 5);
  const cache = by("setup-without-cache")[0];
  assert.equal(cache.line, 8);
  assert.equal(cache.startChar, 6);
  assert.equal(cache.endChar, "      - uses: actions/setup-node@v4".length, "trailing spaces are not squiggled");
  assert.equal(cache.file, "ci.yml");
});

test("analyzeText: identical findings get their own lines through nth", () => {
  const r = analyzeText(WF, "ci.yml").findings.filter((f) => f.check === "unpinned-third-party-action");
  assert.deepEqual(r.map((f) => [f.line, f.nth]), [[9, 0], [10, 1]]);
});

test("analyzeText: CRLF text gives the same lines", () => {
  const a = analyzeText(WF, "x").findings.map((f) => [f.check, f.line, f.startChar, f.endChar]);
  const b = analyzeText(WF.replace(/\n/g, "\r\n"), "x").findings.map((f) => [f.check, f.line, f.startChar, f.endChar]);
  assert.deepEqual(b, a);
});

test("analyzeText: YAML that does not parse yields no findings and no throw", () => {
  for (const bad of ["on: [push\njobs: {", "a: b: c\n", "jobs:\n  a:\n   - x\n  b: [", "key: value\nkey: again\n", "\t- tab\n"]) {
    const r = analyzeText(bad, "x");
    assert.equal(r.ok, false, bad);
    assert.equal(r.reason, "parse-error");
    assert.deepEqual(r.findings, []);
  }
});

test("analyzeText: odd but valid input gives no findings", () => {
  for (const t of ["", "# only a comment\n", "just a string\n", "- a\n- b\n", "42\n", "jobs: 5\n"]) {
    const r = analyzeText(t, "x");
    assert.equal(r.ok, true, JSON.stringify(t));
    assert.deepEqual(r.findings, [], JSON.stringify(t));
  }
});

test("analyzeText: a file over 1 MiB is not analysed", () => {
  const r = analyzeText("a: " + "x".repeat(1024 * 1024 + 1), "big.yml");
  assert.deepEqual([r.ok, r.reason, r.findings.length], [false, "too-large", 0]);
});

test("analyzeText: only the first YAML document is checked", () => {
  const r = analyzeText("on: push\nconcurrency: x\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 1\n---\njobs:\n  b:\n    runs-on: x\n", "x");
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, []);
});
