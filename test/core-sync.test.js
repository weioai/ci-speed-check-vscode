"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const ACTION = path.join(ROOT, "..", "ci-speed-check");
const FILES = [
  ["src/core/rules.js", "src/rules.js"],
  ["src/core/history.js", "src/history.js"],
  ["src/core/vendor/js-yaml.min.js", "src/vendor/js-yaml.min.js"],
  ["src/core/vendor/LICENSE-js-yaml", "src/vendor/LICENSE-js-yaml"]
];
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

test("the shared core is present", () => {
  FILES.forEach(([mine]) => assert.ok(fs.existsSync(path.join(ROOT, mine)), mine));
  const rules = require("../src/core/rules");
  ["checkWorkflow", "locate", "fixFor", "CHECK_CLASS", "CACHEABLE_SETUP", "DEVIATIONS"].forEach((k) => assert.ok(rules[k], "rules." + k));
  const history = require("../src/core/history");
  ["analyze", "renderMarkdown", "HistoryError"].forEach((k) => assert.ok(history[k], "history." + k));
  assert.equal(require("../src/core/vendor/js-yaml.min.js").load("a: 1").a, 1);
});

test("core files are byte copies of the GitHub Action's (when ../ci-speed-check exists)", (t) => {
  if (!fs.existsSync(path.join(ACTION, "src", "rules.js"))) {
    t.skip("../ci-speed-check is not next to this checkout");
    return;
  }
  FILES.forEach(([mine, theirs]) => {
    assert.equal(sha(path.join(ROOT, mine)), sha(path.join(ACTION, theirs)),
      mine + " differs from the action's " + theirs + "; run scripts/sync-core.sh");
  });
});

test("scripts/sync-core.sh copies the same four files", () => {
  const sh = fs.readFileSync(path.join(ROOT, "scripts", "sync-core.sh"), "utf8");
  ["rules.js", "history.js", "vendor/js-yaml.min.js", "vendor/LICENSE-js-yaml"].forEach((f) => assert.ok(sh.includes(f), f));
  assert.ok(fs.statSync(path.join(ROOT, "scripts", "sync-core.sh")).mode & 0o100, "executable");
});

test("the core has no references to GitHub Actions runner I/O (it must run inside VS Code)", () => {
  ["rules.js", "history.js"].forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, "src", "core", f), "utf8");
    assert.ok(!/process\.env|GITHUB_(?:API_URL|TOKEN|OUTPUT|STEP_SUMMARY|WORKSPACE|REPOSITORY)|require\(["']fs["']\)|require\(["']child_process["']\)/.test(src), f);
  });
});
