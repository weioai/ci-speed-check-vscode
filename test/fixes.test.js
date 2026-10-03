"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("../src/core/vendor/js-yaml.min.js");
const fixes = require("../src/fixes");
const { analyzeText } = require("../src/analyze");
const U = require("./helpers/util");

const GROUP = "${{ github.workflow }}-${{ github.ref }}";
const CANCEL = "${{ github.event_name == 'pull_request' }}";

/* ------------------------------------------------------------ applyEdits */

test("applyEdits: inserts and replaces by 0-based line and character, in any order", () => {
  const text = "aaa\nbbb\nccc\n";
  const out = fixes.applyEdits(text, [
    { line: 0, character: 3, insertText: "!" },
    { startLine: 2, startChar: 1, endLine: 2, endChar: 3, newText: "XY" },
    { line: 1, character: 0, insertText: "new\n" }
  ]);
  assert.equal(out, "aaa!\nnew\nbbb\ncXY\n");
  assert.throws(() => fixes.applyEdits(text, [{ line: 9, character: 0, insertText: "x" }]));
});

test("applyEdits: lines end at CRLF, CR or LF, like the editor", () => {
  assert.equal(fixes.applyEdits("a\r\nb\rc\nd", [{ line: 3, character: 1, insertText: "!" }]), "a\r\nb\rc\nd!");
});

/* ---------------------------------------------------------- no-job-timeout */

const TWO = `name: ci
on:
  push:
    branches: [main]
concurrency:
  group: g
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
  lint:
    # lint things
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`;

test("no-job-timeout: inserts as the first key of the job, at the job's child indentation", async () => {
  const r = await U.applyFix(TWO, "no-job-timeout", { index: 0 });
  assert.match(r.fix.title, /timeout-minutes: 30.*'build'/);
  assert.equal(r.text, TWO.replace("  build:\n", "  build:\n    timeout-minutes: 30\n"));
  U.assertOnlyTargetGone(TWO, r.text, r.finding, assert);
  // the second job is fixed on its own, ahead of its comment
  const r2 = await U.applyFix(TWO, "no-job-timeout", { index: 1 });
  assert.equal(r2.text, TWO.replace("  lint:\n", "  lint:\n    timeout-minutes: 30\n"));
});

test("no-job-timeout: follows a 4-space and a 3-space indentation style", async () => {
  const four = TWO.replace(/^( +)/gm, (m) => m + m);
  const r = await U.applyFix(four, "no-job-timeout");
  assert.match(r.text, /\n {4}build:\n {8}timeout-minutes: 30\n {8}runs-on: ubuntu-latest\n/);
  const three = "on: push\njobs:\n   build:\n      runs-on: x\n      steps: []\n";
  const r3 = await U.applyFix(three, "no-job-timeout");
  assert.match(r3.text, /\n {3}build:\n {6}timeout-minutes: 30\n {6}runs-on: x\n/);
});

test("no-job-timeout: keeps CRLF line endings", async () => {
  const text = U.crlf(TWO);
  const r = await U.applyFix(text, "no-job-timeout");
  assert.ok(r.fix);
  assert.ok(U.eolsConsistent(r.text, "\r\n"), "mixed line endings");
  assert.equal(r.text, U.crlf(TWO.replace("  build:\n", "  build:\n    timeout-minutes: 30\n")));
});

test("no-job-timeout: quoted job names and a trailing comment on the job line", async () => {
  const text = "on: push\njobs:\n  \"my job\":   # the job\n    runs-on: x\n";
  const r = await U.applyFix(text, "no-job-timeout");
  assert.equal(r.text, "on: push\njobs:\n  \"my job\":   # the job\n    timeout-minutes: 30\n    runs-on: x\n");
});

test("no-job-timeout: works when the file has no final newline", async () => {
  const text = "on: push\njobs:\n  a:\n    runs-on: x";
  const r = await U.applyFix(text, "no-job-timeout");
  assert.equal(r.text, "on: push\njobs:\n  a:\n    timeout-minutes: 30\n    runs-on: x");
});

test("no-job-timeout: skips flow-style jobs and jobs behind an alias or anchor", () => {
  const flow = "on: push\njobs: {build: {runs-on: x, steps: []}}\n";
  const f = U.findings(flow, "no-job-timeout")[0];
  assert.equal(fixes.canFix(flow, f, {}), null);
  assert.equal(fixes.computeFixSync(flow, f, {}), null);
  const one = "on: push\njobs:\n  build: {runs-on: x}\n";
  assert.equal(fixes.canFix(one, U.findings(one, "no-job-timeout")[0], {}), null);
});

/* -------------------------------------------------------- no-concurrency-cancel */

test("no-concurrency-cancel: block goes after the on: section with the cancel-only-PRs expression", async () => {
  const text = "name: ci\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n";
  const r = await U.applyFix(text, "no-concurrency-cancel");
  assert.equal(r.text, "name: ci\non:\n  push:\n    branches: [main]\n  pull_request:\n" +
    "concurrency:\n  group: " + GROUP + "\n  cancel-in-progress: " + CANCEL + "\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n");
  assert.match(r.fix.title, /pull request/i);
  assert.match(r.fix.title, /never cancelled/i);
  assert.equal(yaml.load(r.text).concurrency["cancel-in-progress"], CANCEL);
  U.assertOnlyTargetGone(text, r.text, r.finding, assert);
});

test("no-concurrency-cancel: keeps a blank line between sections and does not split comments from what they describe", async () => {
  const text = "on:\n  push:\n    branches: [main]\n    # - dev\n\n# The jobs\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n";
  const r = await U.applyFix(text, "no-concurrency-cancel");
  assert.equal(r.text, "on:\n  push:\n    branches: [main]\n    # - dev\n\n" +
    "concurrency:\n  group: " + GROUP + "\n  cancel-in-progress: " + CANCEL + "\n\n# The jobs\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n");
});

test("no-concurrency-cancel: one-line on:, quoted 'on', and a flow-style value all work", async () => {
  for (const head of ["on: [push, pull_request]", "'on': push", "\"on\": {push: {branches: [main]}}", "on: push # trigger"]) {
    const text = head + "\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n";
    const r = await U.applyFix(text, "no-concurrency-cancel");
    assert.ok(r.fix, head);
    assert.ok(r.text.startsWith(head + "\nconcurrency:\n"), head);
  }
});

test("no-concurrency-cancel: on: as the last section, with and without a final newline", async () => {
  const body = "jobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\non:\n  push:\n";
  const a = await U.applyFix(body, "no-concurrency-cancel");
  assert.equal(a.text, body + "concurrency:\n  group: " + GROUP + "\n  cancel-in-progress: " + CANCEL + "\n");
  const bare = body.replace(/\n$/, "");
  const b = await U.applyFix(bare, "no-concurrency-cancel");
  assert.equal(b.text, bare + "\nconcurrency:\n  group: " + GROUP + "\n  cancel-in-progress: " + CANCEL);
});

test("no-concurrency-cancel: uses the file's indentation step and keeps CRLF", async () => {
  const four = "on:\n    push:\n        branches: [main]\njobs:\n    a:\n        runs-on: x\n        timeout-minutes: 5\n";
  const r = await U.applyFix(four, "no-concurrency-cancel");
  assert.match(r.text, /\nconcurrency:\n {4}group: .*\n {4}cancel-in-progress: .*\njobs:/);
  const r2 = await U.applyFix(U.crlf(TWO.replace(/concurrency:\n.*\n.*\n/, "")), "no-concurrency-cancel");
  assert.ok(U.eolsConsistent(r2.text, "\r\n"));
  assert.ok(r2.text.includes("concurrency:\r\n  group:"));
});

test("no-concurrency-cancel: a multi-line flow on: that would be split is not fixed", () => {
  const text = "on: {\n  push: {},\n}\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n";
  const f = U.findings(text, "no-concurrency-cancel")[0];
  assert.ok(f);
  assert.equal(fixes.canFix(text, f, {}), null);
});

test("no-concurrency-cancel: an existing but empty concurrency key is not duplicated", () => {
  const text = "on: push\nconcurrency:\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 5\n";
  const f = U.findings(text, "no-concurrency-cancel")[0];
  assert.ok(f);
  assert.equal(fixes.canFix(text, f, {}), null);
});

/* ---------------------------------------------------- setup-without-cache */

function job(steps, extra) {
  return "on: push\nconcurrency: x\njobs:\n  build:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n" + (extra || "") + "    steps:\n" + steps;
}

test("setup-without-cache: adds a with: block under the uses line, value from the lock file", async () => {
  const text = job("      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n      - run: npm ci\n");
  const r = await U.applyFix(text, "setup-without-cache", { files: ["package-lock.json"] });
  assert.equal(r.text, job("      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          cache: npm\n      - run: npm ci\n"));
  assert.match(r.fix.title, /cache: npm/);
  assert.match(r.fix.title, /package-lock\.json/);
  U.assertOnlyTargetGone(text, r.text, r.finding, assert);
});

test("setup-without-cache: extends an existing with: mapping after its last key", async () => {
  const text = job("      - name: Node\n        uses: actions/setup-node@v4\n        with:\n          node-version: 20\n          registry-url: https://r.example\n        env:\n          X: 1\n      - run: npm ci\n");
  const r = await U.applyFix(text, "setup-without-cache", { files: ["yarn.lock"] });
  assert.equal(r.text, job("      - name: Node\n        uses: actions/setup-node@v4\n        with:\n          node-version: 20\n          registry-url: https://r.example\n          cache: yarn\n        env:\n          X: 1\n      - run: npm ci\n"));
});

test("setup-without-cache: with: after uses, with: before uses, and trailing comments inside with:", async () => {
  const text = job("      - with:\n          node-version: 20\n          # cache: later\n        uses: actions/setup-node@v4\n      - run: x\n");
  const r = await U.applyFix(text, "setup-without-cache", { files: ["package-lock.json"] });
  assert.equal(r.text, job("      - with:\n          node-version: 20\n          # cache: later\n          cache: npm\n        uses: actions/setup-node@v4\n      - run: x\n"));
});

test("setup-without-cache: indentation follows the step (4-space file, unindented sequence)", async () => {
  const four = "on: push\nconcurrency: x\njobs:\n    build:\n        runs-on: x\n        timeout-minutes: 5\n        steps:\n            - uses: actions/setup-go@v3\n";
  const r = await U.applyFix(four, "setup-without-cache", { files: ["go.sum"] });
  assert.match(r.text, /\n {12}- uses: actions\/setup-go@v3\n {14}with:\n {18}cache: true\n$/);
  const flat = "on: push\nconcurrency: x\njobs:\n  build:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n    - uses: actions/setup-go@v3\n    - run: go test\n";
  const r2 = await U.applyFix(flat, "setup-without-cache", { files: ["go.sum"] });
  assert.match(r2.text, /\n {4}- uses: actions\/setup-go@v3\n {6}with:\n {8}cache: true\n {4}- run: go test\n/);
});

test("setup-without-cache: keeps CRLF", async () => {
  const text = U.crlf(job("      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n"));
  const r = await U.applyFix(text, "setup-without-cache", { files: ["pnpm-lock.yaml"], resolveSha: null });
  assert.equal(r.fix, null, "pnpm without pnpm set up first gets no fix");
  const r2 = await U.applyFix(text, "setup-without-cache", { files: ["package-lock.json"] });
  assert.ok(U.eolsConsistent(r2.text, "\r\n"));
  assert.ok(r2.text.endsWith("node-version: 20\r\n          cache: npm\r\n"));
});

test("setup-without-cache: the value table", async () => {
  const cases = [
    ["actions/setup-node@v4", ["package-lock.json"], "cache", "npm"],
    ["actions/setup-node@v4", ["npm-shrinkwrap.json"], "cache", "npm"],
    ["actions/setup-node@v4", ["yarn.lock"], "cache", "yarn"],
    ["actions/setup-python@v5", ["requirements.txt"], "cache", "pip"],
    ["actions/setup-python@v5", ["sub/dir/requirements.txt"], "cache", "pip"],
    ["actions/setup-java@v4", ["pom.xml"], "cache", "maven"],
    ["actions/setup-java@v4", ["app/build.gradle"], "cache", "gradle"],
    ["actions/setup-java@v4", ["build.gradle.kts"], "cache", "gradle"],
    ["actions/setup-java@v4", ["build.sbt"], "cache", "sbt"],
    ["actions/setup-go@v3", ["go.sum"], "cache", "true"],
    ["actions/setup-dotnet@v4", ["packages.lock.json"], "cache", "true"],
    ["ruby/setup-ruby@v1", ["Gemfile"], "bundler-cache", "true"]
  ];
  for (const [uses, files, key, value] of cases) {
    const text = job("      - uses: " + uses + "\n");
    const r = await U.applyFix(text, "setup-without-cache", { files: files });
    assert.ok(r.fix, uses + " " + files);
    assert.ok(r.text.includes("        with:\n          " + key + ": " + value + "\n"), uses + " " + r.text);
    assert.deepEqual(yaml.load(r.text).jobs.build.steps[0].with[key], value === "true" ? true : value);
  }
});

test("setup-without-cache: no fix when the value cannot be known", async () => {
  const cases = [
    ["actions/setup-node@v4", []],                                       // nothing to infer from
    ["actions/setup-node@v4", ["package-lock.json", "yarn.lock"]],       // ambiguous
    ["actions/setup-node@v4", ["web/package-lock.json"]],                // lock file not at the root
    ["actions/setup-node@v4", ["pnpm-lock.yaml"]],                       // pnpm not installed first
    ["actions/setup-node@v4", ["yarn.lock", ".yarnrc.yml"]],             // Yarn Berry without corepack
    ["actions/setup-python@v5", []],
    ["actions/setup-python@v5", ["poetry.lock"]],                        // poetry not installed first
    ["actions/setup-python@v5", ["Pipfile.lock"]],
    ["actions/setup-python@v5", ["requirements.txt", "poetry.lock"]],
    ["actions/setup-java@v4", []],
    ["actions/setup-java@v4", ["pom.xml", "build.gradle"]],
    ["actions/setup-dotnet@v4", []],                                     // action fails without packages.lock.json
    ["actions/setup-dotnet@v4", ["src/packages.lock.json"]],
    ["ruby/setup-ruby@v1", []],
    ["ruby/setup-ruby@v1", ["sub/Gemfile"]]
  ];
  for (const [uses, files] of cases) {
    const text = job("      - uses: " + uses + "\n");
    const r = await U.applyFix(text, "setup-without-cache", { files: files });
    assert.equal(r.fix, null, uses + " " + files);
  }
});

test("setup-without-cache: pnpm, Yarn Berry, poetry and pipenv need their tool set up earlier in the job", async () => {
  const cases = [
    ["actions/setup-node@v4", ["pnpm-lock.yaml"], "      - uses: pnpm/action-setup@v4\n", "pnpm"],
    ["actions/setup-node@v4", ["pnpm-lock.yaml"], "      - run: corepack enable\n", "pnpm"],
    ["actions/setup-node@v4", ["yarn.lock", ".yarnrc.yml"], "      - run: corepack enable\n", "yarn"],
    ["actions/setup-python@v5", ["poetry.lock"], "      - run: pipx install poetry\n", "poetry"],
    ["actions/setup-python@v5", ["Pipfile.lock"], "      - run: pipx install pipenv\n", "pipenv"]
  ];
  for (const [uses, files, pre, value] of cases) {
    const text = job(pre + "      - uses: " + uses + "\n");
    const r = await U.applyFix(text, "setup-without-cache", { files: files });
    assert.ok(r.fix, uses + files);
    assert.ok(r.text.endsWith("        with:\n          cache: " + value + "\n"), r.text);
  }
  // a mention in a comment, or in the setup step's own earlier lines, does not count
  const noop = job("      # install pnpm first\n      - name: node with pnpm\n        uses: actions/setup-node@v4\n");
  assert.equal((await U.applyFix(noop, "setup-without-cache", { files: ["pnpm-lock.yaml"] })).fix, null);
});

test("setup-without-cache: with two identical setup steps in a job, each fix lands on its own step", async () => {
  const text = job("      - uses: actions/setup-node@v4\n        with:\n          node-version: 18\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n");
  const a = await U.applyFix(text, "setup-without-cache", { index: 0, files: ["package-lock.json"] });
  assert.equal(yaml.load(a.text).jobs.build.steps[0].with.cache, "npm");
  assert.equal(yaml.load(a.text).jobs.build.steps[1].with.cache, undefined);
  const b = await U.applyFix(text, "setup-without-cache", { index: 1, files: ["package-lock.json"] });
  assert.equal(yaml.load(b.text).jobs.build.steps[1].with.cache, "npm");
  assert.equal(yaml.load(b.text).jobs.build.steps[0].with.cache, undefined);
  U.assertOnlyTargetGone(text, b.text, b.finding, assert);
});

test("setup-without-cache: flow-style steps and flow-style or aliased with: are skipped, not corrupted", async () => {
  const cases = [
    job("      - {uses: actions/setup-node@v4, with: {node-version: 20}}\n"),
    job("      - uses: actions/setup-node@v4\n        with: {node-version: 20}\n"),
    "on: push\nconcurrency: x\njobs:\n  build:\n    runs-on: x\n    timeout-minutes: 5\n    steps: [{uses: actions/setup-node@v4}]\n",
    "on: push\nconcurrency: x\nx-with: &w\n  node-version: 20\njobs:\n  build:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n      - uses: actions/setup-node@v4\n        with: *w\n",
    job("      - uses: actions/setup-node@v4\n        with:\n          cache:\n"),            // key present, empty
    job("      - uses: actions/setup-node@v4\n        with:\n          cache: ''\n")
  ];
  for (const text of cases) {
    const list = U.findings(text, "setup-without-cache");
    assert.equal(list.length, 1, text);
    const fix = await fixes.computeFix(text, list[0], { files: ["package-lock.json"] });
    assert.equal(fix, null, text);
  }
});

test("setup-without-cache: a fix that would change anything beyond the one step is not offered", async () => {
  // A step defined once and reused through an alias: the edit would fix both findings at once.
  const alias = job("      - &node\n        uses: actions/setup-node@v4\n      - *node\n");
  assert.equal(U.findings(alias, "setup-without-cache").length, 2);
  assert.equal((await U.applyFix(alias, "setup-without-cache", { index: 0, files: ["package-lock.json"] })).fix, null);
  // A |+ block scalar keeps its trailing blank line; inserting after its text would change its value.
  const keep = job("      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n          registry-url: |+\n            x\n\n      - run: npm ci\n");
  assert.equal((await U.applyFix(keep, "setup-without-cache", { files: ["package-lock.json"] })).fix, null);
  // the same layout with a plain last value is fine
  const plain = job("      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n\n      - run: npm ci\n");
  const ok = await U.applyFix(plain, "setup-without-cache", { files: ["package-lock.json"] });
  assert.ok(ok.fix);
  assert.equal(ok.text, job("      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n          cache: npm\n\n      - run: npm ci\n"));
});

test("setup-without-cache: observation findings (setup-node v5) get the same fix", async () => {
  const text = job("      - uses: actions/setup-node@v5\n");
  const f = U.findings(text, "setup-without-cache")[0];
  assert.equal(f.severity, "observation");
  const r = await U.applyFix(text, "setup-without-cache", { files: ["package-lock.json"] });
  assert.ok(r.fix);
  assert.equal(U.findings(r.text, "setup-without-cache").length, 0);
});

/* ------------------------------------------- unpinned-third-party-action */

function steps(uses) { return job("      - uses: " + uses + "\n"); }

test("unpinned-third-party-action: owner/repo@ref becomes owner/repo@sha # ref", async () => {
  const text = steps("some-org/lint-action@v2");
  const calls = [];
  const r = await U.applyFix(text, "unpinned-third-party-action", { resolveSha: async (o, rp, ref) => { calls.push([o, rp, ref]); return U.sha("b"); } });
  assert.deepEqual(calls, [["some-org", "lint-action", "v2"]]);
  assert.equal(r.text, steps("some-org/lint-action@" + U.sha("b") + " # v2"));
  assert.match(r.fix.title, /Pin some-org\/lint-action/);
  assert.equal(U.findings(r.text, "unpinned-third-party-action").length, 0);
  U.assertOnlyTargetGone(text, r.text, r.finding, assert);
});

test("unpinned-third-party-action: quotes, sub-paths, branch names with slashes and a trailing comment", async () => {
  const q = await U.applyFix(steps("'third/party@v3'    # single-quoted"), "unpinned-third-party-action");
  assert.equal(q.text, steps("'third/party@" + U.sha("a") + "' # v3 # single-quoted"));
  const d = await U.applyFix(steps('"third/party@v3"'), "unpinned-third-party-action");
  assert.equal(d.text, steps('"third/party@' + U.sha("a") + '" # v3'));
  const sub = await U.applyFix(steps("github/codeql-action/analyze@v3"), "unpinned-third-party-action");
  assert.equal(sub.text, steps("github/codeql-action/analyze@" + U.sha("a") + " # v3"));
  const slash = await U.applyFix(steps("org/tool@feature/x"), "unpinned-third-party-action", { resolveSha: async (o, r, ref) => { assert.equal(ref, "feature/x"); return U.sha("c"); } });
  assert.equal(slash.text, steps("org/tool@" + U.sha("c") + " # feature/x"));
  const key = await U.applyFix(job("      - name: x\n        uses: org/tool@v1\n        with:\n          a: b\n"), "unpinned-third-party-action");
  assert.ok(key.text.includes("        uses: org/tool@" + U.sha("a") + " # v1\n        with:\n"));
});

test("unpinned-third-party-action: CRLF is kept and only the one line changes", async () => {
  const text = U.crlf(steps("a/b@v1"));
  const r = await U.applyFix(text, "unpinned-third-party-action");
  assert.ok(U.eolsConsistent(r.text, "\r\n"));
  assert.equal(r.text, U.crlf(steps("a/b@" + U.sha("a") + " # v1")));
});

test("unpinned-third-party-action: two steps with the same action each pin their own line", async () => {
  const text = job("      - uses: a/b@v1\n      - run: x\n      - uses: a/b@v1\n");
  const second = await U.applyFix(text, "unpinned-third-party-action", { index: 1 });
  const s = yaml.load(second.text).jobs.build.steps;
  assert.equal(s[0].uses, "a/b@v1");
  assert.equal(s[2].uses, "a/b@" + U.sha("a"));
});

test("unpinned-third-party-action: resolver failures propagate, bad SHAs are refused, no resolver means no fix", async () => {
  const text = steps("a/b@v1");
  const f = U.findings(text, "unpinned-third-party-action")[0];
  await assert.rejects(() => fixes.computeFix(text, f, { resolveSha: async () => { throw new Error("GitHub has no commit"); } }), /no commit/);
  await assert.rejects(() => fixes.computeFix(text, f, { resolveSha: async () => "not-a-sha" }), /40-character/);
  await assert.rejects(() => fixes.computeFix(text, f, { resolveSha: async () => "<html>" }), /40-character/);
  assert.equal(await fixes.computeFix(text, f, {}), null);
  assert.equal(await fixes.computeFix(text, f, null), null);
  // upper-case hex is normalised
  const up = await fixes.computeFix(text, f, { resolveSha: async () => U.sha("A") + "\n" });
  assert.ok(up.edits[0].newText.startsWith("a/b@" + U.sha("a")));
});

test("unpinned-third-party-action: canFix needs no network; computeFixSync leaves it to computeFix", () => {
  const text = steps("a/b@v1");
  const f = U.findings(text, "unpinned-third-party-action")[0];
  assert.match(fixes.canFix(text, f, {}).title, /^Pin a\/b to the commit behind v1$/);
  assert.equal(fixes.computeFixSync(text, f, {}), null);
});

test("unpinned-third-party-action: flow style, docker and local references get no fix", async () => {
  for (const text of [
    job("      - {uses: a/b@v1}\n"),
    job("      - uses: docker://ghcr.io/org/img@sha256:" + "0".repeat(64) + "\n")
  ]) {
    const f = U.findings(text, "unpinned-third-party-action")[0];
    assert.ok(f, text);
    assert.equal(await fixes.computeFix(text, f, { resolveSha: async () => U.sha("a") }), null, text);
  }
});

/* -------------------------------------------------------------- flow style */

test("flow-style workflow: only the fix that is still safe is offered", async () => {
  const text = "name: flow style\non: {push: {branches: [main]}, pull_request: {}}\njobs: {build: {runs-on: ubuntu-latest, steps: [{uses: 'actions/checkout@v4', with: {fetch-depth: 0}}, {uses: actions/setup-node@v4}, {uses: foo/bar@v1}]}}\n";
  const all = U.findings(text);
  assert.deepEqual(all.map((f) => f.check).sort(), ["full-history-checkout", "no-concurrency-cancel", "no-job-timeout", "setup-without-cache", "unpinned-third-party-action"]);
  for (const f of all) {
    const fix = await fixes.computeFix(text, f, { files: U.FILES, resolveSha: async () => U.sha("a") });
    if (f.check === "no-concurrency-cancel") {
      assert.ok(fix, "the block-style concurrency insertion is still safe");
      assert.equal(U.findings(fixes.applyEdits(text, fix.edits), "no-concurrency-cancel").length, 0);
    } else {
      assert.equal(fix, null, f.check);
    }
  }
});

test("a check without a quick fix returns null", async () => {
  const text = job("      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n");
  const f = U.findings(text, "full-history-checkout")[0];
  assert.ok(f);
  assert.equal(await fixes.computeFix(text, f, {}), null);
  assert.equal(fixes.canFix(text, f, {}), null);
  assert.equal(await fixes.computeFix(text, null, {}), null);
  assert.equal(await fixes.computeFix(text, { check: "nope" }, {}), null);
});

test("a very large file gets no quick fixes (they re-parse the file)", async () => {
  const filler = "# " + "x".repeat(100) + "\n";
  const text = TWO + filler.repeat(3000);
  const f = U.findings(text, "no-job-timeout")[0];
  assert.ok(f);
  assert.equal(await fixes.computeFix(text, f, {}), null);
  assert.equal(fixes.canFix(text, f, {}), null);
});

test("a byte-order mark does not shift the edits", async () => {
  const text = "\uFEFF" + TWO;
  const r = await U.applyFix(text.slice(1), "no-job-timeout");
  const f = analyzeText(text, "x").findings.find((x) => x.check === "no-job-timeout");
  const fix = await fixes.computeFix(text, f, {});
  assert.deepEqual(fix.edits, r.fix.edits);
});

/* --------------------------------------------- every fixture, every finding */

function fixtureTexts() {
  const dir = path.join(__dirname, "fixtures");
  return fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]);
}

test("every fixable finding in every fixture: apply, re-check, the finding is gone and nothing else moved", async () => {
  const texts = fixtureTexts();
  assert.ok(texts.length >= 5);
  let applied = 0;
  for (const [name, original] of texts) {
    for (const variant of [original, U.crlf(original)]) {
      const r = analyzeText(variant, "x");
      if (!r.ok) continue;
      for (const f of r.findings) {
        const fix = await fixes.computeFix(variant, f, { files: U.FILES, resolveSha: async () => U.sha("d") });
        if (!fix) continue;
        const after = fixes.applyEdits(variant, fix.edits);
        applied++;
        assert.ok(analyzeText(after, "x").ok, name + " still parses after " + f.check);
        U.assertOnlyTargetGone(variant, after, f, assert);
        if (variant.indexOf("\r\n") >= 0) assert.ok(U.eolsConsistent(after, "\r\n"), name + " keeps CRLF after " + f.check);
      }
    }
  }
  assert.ok(applied >= 20, "applied " + applied);
});

test("applying fixes one after another reaches a stable file that only has unfixable findings left", async () => {
  for (const [name, original] of fixtureTexts()) {
    let text = original;
    if (!analyzeText(text, "x").ok) continue;
    for (let round = 0; round < 40; round++) {
      let progressed = false;
      for (const f of analyzeText(text, "x").findings) {
        const fix = await fixes.computeFix(text, f, { files: U.FILES, resolveSha: async () => U.sha("e") });
        if (!fix) continue;
        text = fixes.applyEdits(text, fix.edits);
        progressed = true;
        break;
      }
      if (!progressed) break;
      assert.ok(round < 39, name + " did not settle");
    }
    const left = analyzeText(text, "x").findings;
    for (const f of left) {
      const fix = await fixes.computeFix(text, f, { files: U.FILES, resolveSha: async () => U.sha("e") });
      assert.equal(fix, null, name + " " + f.check);
    }
  }
});

test("setup-without-cache: setup-go v3 gets no cache fix without a go.sum at the repository root", async () => {
  const text = "on: push\nconcurrency: x\njobs:\n  build:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n    - uses: actions/setup-go@v3\n";
  for (const files of [[], ["service/go.sum", "service/go.mod"]]) {
    const r = await U.applyFix(text, "setup-without-cache", { files: files });
    assert.equal(r.fix, null, JSON.stringify(files));
  }
});

test("pin quick fix: refs that could carry markdown links or path segments are not offered", async () => {
  for (const ref of ["[Sign-in](command:x)", "../../../evil/fork/commits/main", "v1/../x", "a b"]) {
    const text = "on: push\nconcurrency: x\njobs:\n  build:\n    runs-on: x\n    timeout-minutes: 5\n    steps:\n    - uses: \"org/tool@" + ref + "\"\n";
    const r = await U.applyFix(text, "unpinned-third-party-action", { files: [], resolveSha: async () => "a".repeat(40) });
    assert.equal(r.fix, null, ref);
  }
});
