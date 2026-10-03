"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../src/constants");

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

test("manifest: identity and marketplace fields", () => {
  assert.equal(pkg.name, "ci-speed-check");
  assert.equal(pkg.displayName, "CI Speed Check for GitHub Actions");
  assert.equal(pkg.version, "1.0.0");
  assert.equal(pkg.publisher, "weio");
  assert.equal(pkg.license, "MIT");
  assert.ok(pkg.description.length > 40 && pkg.description.length <= 120, "description is " + pkg.description.length + " chars");
  ["cache", "timeout", "concurrency", "unpinned", "quick fixes"].forEach((w) => assert.ok(pkg.description.includes(w), w));
  assert.equal(pkg.repository.url, "https://github.com/weioai/ci-speed-check-vscode.git");
  assert.equal(pkg.homepage, "https://github.com/weioai/ci-speed-check-vscode#readme");
  assert.equal(pkg.bugs.url, "https://github.com/weioai/ci-speed-check-vscode/issues");
  assert.equal(C.REPO_URL, "https://github.com/weioai/ci-speed-check-vscode");
  assert.equal(pkg.engines.vscode, "^1.85.0");
  assert.deepEqual(pkg.categories, ["Linters"]);
  assert.deepEqual(pkg.keywords, ["github actions", "workflow", "ci", "cache", "concurrency", "timeout", "pin", "lint"]);
  assert.equal(pkg.pricing, "Free");
  assert.equal(pkg.main, "./src/extension.js");
  assert.ok(fs.existsSync(path.join(ROOT, pkg.main)));
});

test("manifest: no runtime dependencies", () => {
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.scripts.test, "node --test", "no path argument: `node --test test/` fails on Node 22 and later");
});

test("manifest: activation events", () => {
  assert.deepEqual(pkg.activationEvents, [
    "workspaceContains:.github/workflows/*.yml",
    "workspaceContains:.github/workflows/*.yaml",
    "onLanguage:yaml",
    "onLanguage:github-actions-workflow"
  ]);
});

test("manifest: commands and settings", () => {
  const cmds = Object.fromEntries(pkg.contributes.commands.map((c) => [c.command, c.title]));
  assert.deepEqual(Object.keys(cmds).sort(), ["ciSpeedCheck.checkWorkspace", "ciSpeedCheck.clearApiKey", "ciSpeedCheck.historyReport", "ciSpeedCheck.setApiKey"]);
  assert.equal(cmds["ciSpeedCheck.historyReport"], "CI Speed Check: Run-history report (Pro)");
  Object.values(cmds).forEach((t) => assert.ok(t.startsWith("CI Speed Check: "), t));
  const p = pkg.contributes.configuration.properties;
  assert.deepEqual(Object.keys(p).sort(), ["ciSpeedCheck.enable", "ciSpeedCheck.historyDays", "ciSpeedCheck.historyRuns"]);
  assert.equal(p["ciSpeedCheck.enable"].default, true);
  assert.equal(p["ciSpeedCheck.historyRuns"].default, 100);
  assert.equal(p["ciSpeedCheck.historyDays"].default, 30);
  assert.equal(p["ciSpeedCheck.historyRuns"].maximum, 300);
  Object.values(p).forEach((s) => assert.ok(s.description.length > 10));
});

test("icon: a 256x256 PNG", () => {
  const buf = fs.readFileSync(path.join(ROOT, pkg.icon));
  assert.equal(pkg.icon, "images/icon.png");
  assert.equal(buf.slice(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(buf.slice(12, 16).toString("ascii"), "IHDR");
  assert.equal(buf.readUInt32BE(16), 256);
  assert.equal(buf.readUInt32BE(20), 256);
  assert.ok(buf.length < 100 * 1024);
});

test(".vscodeignore keeps tests, scripts and packages out of the .vsix", () => {
  const lines = read(".vscodeignore").split(/\r?\n/);
  ["test/**", "scripts/**", "*.vsix"].forEach((l) => assert.ok(lines.includes(l), l));
  assert.ok(!lines.some((l) => /^(src|images|README|LICENSE|CHANGELOG)/.test(l)), "must not exclude shipped files");
});

test("README states the product facts exactly, links the key page, and has an anchor per check", () => {
  const readme = read("README.md");
  assert.ok(readme.includes(C.BUY_URL), "BUY_URL in README");
  assert.ok(readme.includes("A Weio API key costs $9 for 1,000 credits."));
  assert.ok(readme.includes("emailed automatically within minutes of Stripe payment"));
  assert.ok(readme.includes("valid for 12 months"));
  assert.ok(readme.includes("The same key also works for Weio's site-check API."));
  assert.ok(readme.includes("One Pro run = one credit."));
  assert.ok(readme.includes("sales@weio.ai"));
  assert.ok(readme.includes("Weio, Inc."));
  assert.ok(readme.includes("AI operators"));
  assert.ok(readme.includes("human owner is accountable"));
  assert.ok(!/!\[[^\]]*\]\(/.test(readme), "no screenshots");
  const { CHECK_CLASS } = require("../src/core/rules");
  Object.keys(CHECK_CLASS).forEach((id) => assert.ok(readme.includes("### `" + id + "`"), "heading for " + id));
  ["ciSpeedCheck.enable", "ciSpeedCheck.historyRuns", "ciSpeedCheck.historyDays"].forEach((k) => assert.ok(readme.includes(k), k));
  pkg.contributes.commands.forEach((c) => assert.ok(readme.includes(c.title), c.title));
  assert.ok(readme.includes("never cancelled"), "the PR-only cancel behaviour is explained");
});

test("LICENSE and CHANGELOG", () => {
  const lic = read("LICENSE");
  assert.match(lic, /^MIT License/);
  assert.match(lic, /Copyright \(c\) 2026 Weio, Inc\./);
  assert.match(read("CHANGELOG.md"), /^## 1\.0\.0$/m);
  assert.ok(fs.existsSync(path.join(ROOT, "src/core/vendor/LICENSE-js-yaml")));
});

test("source modules only require relative files, vscode and path", () => {
  const files = [];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.js$/.test(e.name) && !/\.min\.js$/.test(e.name)) files.push(p);
    });
  })(path.join(ROOT, "src"));
  assert.equal(files.length, 7, files.map((f) => path.relative(ROOT, f)).join(", "));
  files.forEach((f) => {
    const src = fs.readFileSync(f, "utf8");
    const re = /require\(\s*["']([^"']+)["']\s*\)/g;
    let m;
    while ((m = re.exec(src))) {
      assert.ok(m[1].startsWith(".") || m[1] === "vscode" || m[1] === "path", path.relative(ROOT, f) + " requires " + m[1]);
    }
  });
  ["fixes.js", "analyze.js", "credit.js", "constants.js"].forEach((f) => {
    assert.ok(!/require\(["']vscode["']\)/.test(read("src/" + f)), f + " must stay free of the vscode module");
  });
});

test("no console output and no telemetry hooks in the extension source", () => {
  ["extension.js", "fixes.js", "analyze.js", "credit.js", "constants.js"].forEach((f) => {
    const src = read("src/" + f);
    assert.ok(!/console\.(log|info|warn|error|debug)/.test(src), f + " logs");
    assert.ok(!/process\.stdout|process\.stderr/.test(src), f);
    assert.ok(!/telemetry|analytics|appinsights/i.test(src.replace(/No telemetry\./g, "")), f);
  });
});

test("only two hosts are ever contacted", () => {
  const hosts = new Set();
  ["extension.js", "fixes.js", "analyze.js", "credit.js", "constants.js"].forEach((f) => {
    (read("src/" + f).match(/https?:\/\/[A-Za-z0-9.-]*[A-Za-z0-9]/g) || []).forEach((u) => hosts.add(u));
  });
  assert.deepEqual([...hosts].sort(), ["https://api.github.com", "https://github.com", "https://weio.ai"]);
});

test("every request in the extension goes through a host-guarded fetch", () => {
  const src = read("src/extension.js").replace(/\/\/.*$/gm, "");
  assert.ok(!/(^|[^.\w])fetch\s*\(/.test(src), "no bare fetch( call");
  assert.equal((src.match(/credit\.guardedFetch\(/g) || []).length, 2);
  assert.ok(src.includes("credit.guardedFetch(C.GITHUB_API_ORIGIN)"));
  assert.ok(src.includes("credit.guardedFetch(weioBase)"));
  assert.ok(src.includes("fetchImpl: githubFetch"), "run history reads GitHub through the guarded fetch");
  assert.ok(src.includes("fetchImpl: weioFetch"), "the credit call goes through the Weio-guarded fetch");
});
