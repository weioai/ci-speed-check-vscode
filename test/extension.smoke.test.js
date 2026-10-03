"use strict";
/* Loads src/extension.js against a stub 'vscode' module (Module._resolveFilename is hooked) and drives it with a
 * fake context: activation, diagnostics, quick fixes, the workspace scan, and the Pro run-history flow against a
 * mocked GitHub and a mocked Weio credit endpoint. */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const vscode = require("./helpers/vscode-stub");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const C = require("../src/constants");

const KEY = "wk_" + "Zy9Xw8Vu".repeat(4);
const GH_TOKEN = "gho_FAKE_GITHUB_TOKEN_0123456789";   // what the stub's getSession hands out
const REPO = "weioai/https-check-action";
const ROOT_URI = "file:///work/repo";
const WF_URI = ROOT_URI + "/.github/workflows/ci.yml";

let uninstall, ext;
const realFetch = globalThis.fetch;
const realEnv = process.env.WEIO_API_BASE;
const consoleCalls = [];
const realConsole = {};

test.before(() => {
  uninstall = vscode.__install();
  ext = require("../src/extension");
  ["log", "info", "warn", "error", "debug"].forEach((k) => {
    realConsole[k] = console[k];
    console[k] = function () { consoleCalls.push([k].concat(Array.from(arguments))); };
  });
});
test.after(() => {
  uninstall();
  globalThis.fetch = realFetch;
  if (realEnv === undefined) delete process.env.WEIO_API_BASE; else process.env.WEIO_API_BASE = realEnv;
  Object.keys(realConsole).forEach((k) => { console[k] = realConsole[k]; });
});
test.beforeEach(() => {
  delete process.env.WEIO_API_BASE;
  globalThis.fetch = async () => { throw new Error("unexpected network call"); };
  consoleCalls.length = 0;
});

function boot() {
  vscode.__reset();
  const state = vscode.__state;
  const context = {
    subscriptions: [],
    extension: { packageJSON: { version: pkg.version } },
    secrets: {
      async get(k) { return state.secrets.get(k); },
      async store(k, v) { state.secrets.set(k, v); },
      async delete(k) { state.secrets.delete(k); }
    }
  };
  ext.activate(context);
  return { state, context, collection: state.collections[0] };
}

function openDoc(state, uri, text) {
  const doc = vscode.__makeDocument(uri, text);
  state.docs.push(doc);
  vscode.workspace.onDidOpenTextDocument.fire(doc);
  return doc;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WF = [
  "name: ci",                                   // 0
  "on:",                                        // 1
  "  push:",                                    // 2
  "jobs:",                                      // 3
  "  build:",                                   // 4
  "    runs-on: ubuntu-latest",                 // 5
  "    steps:",                                 // 6
  "      - uses: actions/checkout@v4",          // 7
  "        with:",                              // 8
  "          fetch-depth: 0",                   // 9
  "      - uses: actions/setup-node@v4",        // 10
  "      - uses: org/tool@v1",                  // 11
  ""
].join("\n");

/* ------------------------------------------------------------- activation */

test("activate registers every contributed command, one diagnostic collection and a quick-fix provider", () => {
  const { state, context } = boot();
  pkg.contributes.commands.forEach((c) => assert.equal(typeof state.commands[c.command], "function", c.command));
  assert.equal(state.collections.length, 1);
  assert.equal(state.providers.length, 1);
  assert.deepEqual(state.providers[0].selector, [{ pattern: "**/.github/workflows/*.{yml,yaml}" }]);
  assert.deepEqual(state.providers[0].meta.providedCodeActionKinds, [vscode.CodeActionKind.QuickFix]);
  assert.equal(state.watchers.length, 1);
  assert.equal(state.watchers[0].glob, "**/.github/workflows/*.{yml,yaml}");
  assert.ok(context.subscriptions.length >= 12);
  assert.equal(typeof ext.deactivate, "function");
  ext.deactivate();
  context.subscriptions.forEach((s) => s.dispose());
  assert.equal(state.collections[0].disposed, true);
  assert.equal(state.providers.length, 0);
  assert.equal(Object.keys(state.commands).length, 0);
});

test("activate checks workflow documents that are already open", () => {
  vscode.__reset();
  const doc = vscode.__makeDocument(WF_URI, WF);
  vscode.__state.docs.push(doc);
  const state = vscode.__state;
  const context = { subscriptions: [], extension: { packageJSON: { version: "1.0.0" } }, secrets: { async get() {}, async store() {}, async delete() {} } };
  ext.activate(context);
  assert.ok(state.collections[0].get(doc.uri).length >= 4);
});

/* ------------------------------------------------------------ diagnostics */

test("open: findings become diagnostics with severity, source, code link and range", () => {
  const { state, collection } = boot();
  const doc = openDoc(state, WF_URI, WF);
  const d = collection.get(doc.uri);
  const by = Object.fromEntries(d.map((x) => [x.code.value, x]));
  assert.deepEqual(Object.keys(by).sort(), ["full-history-checkout", "no-concurrency-cancel", "no-job-timeout", "setup-without-cache", "unpinned-third-party-action"]);
  d.forEach((x) => {
    assert.equal(x.source, "CI Speed Check");
    assert.equal(x.code.target.toString(), "https://github.com/weioai/ci-speed-check-vscode#" + x.code.value);
    assert.equal(x.range.start.line, x.range.end.line);
  });
  assert.equal(by["no-concurrency-cancel"].severity, vscode.DiagnosticSeverity.Warning);
  assert.equal(by["no-job-timeout"].severity, vscode.DiagnosticSeverity.Warning);
  assert.equal(by["setup-without-cache"].severity, vscode.DiagnosticSeverity.Warning);
  assert.equal(by["unpinned-third-party-action"].severity, vscode.DiagnosticSeverity.Warning);
  assert.equal(by["full-history-checkout"].severity, vscode.DiagnosticSeverity.Information, "observations are information");
  assert.equal(by["no-concurrency-cancel"].range.start.line, 1);
  assert.equal(by["no-job-timeout"].range.start.line, 4);
  assert.equal(by["full-history-checkout"].range.start.line, 7);
  assert.equal(by["setup-without-cache"].range.start.line, 10);
  assert.equal(by["unpinned-third-party-action"].range.start.line, 11);
  assert.equal(by["unpinned-third-party-action"].range.start.character, 6, "squiggle starts after the indentation");
  assert.equal(by["unpinned-third-party-action"].range.end.character, "      - uses: org/tool@v1".length);
  assert.match(by["no-job-timeout"].message, /^Job 'build' has no timeout-minutes/);
});

test("open: files outside .github/workflows, other extensions and other schemes are ignored", () => {
  const { state, collection } = boot();
  const a = openDoc(state, ROOT_URI + "/docs/ci.yml", WF);
  const b = openDoc(state, ROOT_URI + "/.github/workflows/readme.md", WF);
  const c = openDoc(state, ROOT_URI + "/.github/workflows/sub/ci.yml", WF);
  const d = openDoc(state, "git://repo/.github/workflows/ci.yml", WF);
  [a, b, c, d].forEach((x) => assert.equal(collection.has(x.uri), false, x.uri.toString()));
  const e = openDoc(state, ROOT_URI + "/.github/workflows/build.yaml", WF);
  assert.equal(collection.has(e.uri), true, ".yaml works too");
  const f = openDoc(state, "vscode-remote://ssh-remote+box/home/me/repo/.github/workflows/ci.yml", WF);
  assert.equal(collection.has(f.uri), true, "remote workspaces work");
});

test("open: YAML that does not parse gives no diagnostics", () => {
  const { state, collection } = boot();
  const doc = openDoc(state, WF_URI, "on: [push\njobs: {\n");
  assert.deepEqual(collection.get(doc.uri), []);
});

test("change is debounced by 300 ms; save checks at once", async () => {
  const { state, collection } = boot();
  const doc = openDoc(state, WF_URI, WF);
  const before = collection.get(doc.uri).length;
  const fixed = WF.replace("  build:\n", "  build:\n    timeout-minutes: 5\n");
  doc.setText(fixed);
  vscode.workspace.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{}] });
  assert.equal(collection.get(doc.uri).length, before, "not re-checked immediately");
  await sleep(150);
  assert.equal(collection.get(doc.uri).length, before, "still waiting at 150 ms");
  await sleep(300);
  assert.equal(collection.get(doc.uri).length, before - 1, "checked after the pause");
  assert.ok(!collection.get(doc.uri).some((x) => x.code.value === "no-job-timeout"));

  // a burst of edits becomes one check, 300 ms after the last edit: the first edit's timer must be cancelled
  doc.setText(WF);
  vscode.workspace.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{}] });
  await sleep(200);
  doc.setText(WF + "# still defective\n");
  vscode.workspace.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{}] });
  await sleep(200);                                   // t = 400 ms: the first timer (due at 300) would have fired by now
  assert.equal(collection.get(doc.uri).length, before - 1, "the first edit's timer was cancelled");
  await sleep(250);                                   // t = 650 ms: the second timer (due at 500) has fired
  assert.equal(collection.get(doc.uri).length, before);

  // save is immediate and cancels a pending check
  doc.setText(fixed);
  vscode.workspace.onDidSaveTextDocument.fire(doc);
  assert.equal(collection.get(doc.uri).length, before - 1);
  doc.setText(WF);
  vscode.workspace.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{}] });
  vscode.workspace.onDidSaveTextDocument.fire(doc);
  assert.equal(collection.get(doc.uri).length, before);
  // changes with no content (dirty-flag flips) do nothing
  doc.setText(fixed);
  vscode.workspace.onDidChangeTextDocument.fire({ document: doc, contentChanges: [] });
  await sleep(400);
  assert.equal(collection.get(doc.uri).length, before, "no content change, no re-check");
});

test("close cancels a pending check; deleting a file clears its diagnostics", async () => {
  const { state, collection } = boot();
  const doc = openDoc(state, WF_URI, WF);
  doc.setText("name: x\n");
  vscode.workspace.onDidChangeTextDocument.fire({ document: doc, contentChanges: [{}] });
  vscode.workspace.onDidCloseTextDocument.fire(doc);
  await sleep(400);
  assert.ok(collection.get(doc.uri).length >= 4, "the timer died with the document");
  state.watchers[0].onDidDelete.fire(doc.uri);
  assert.equal(collection.has(doc.uri), false);
});

test("a checked file that changes on disk while closed is checked again; an open one is left to the editor events", async () => {
  const { state, collection } = boot();
  const uri = vscode.Uri.parse(WF_URI);
  state.files.set(uri.toString(), "on: push\nconcurrency: x\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 1\n");
  state.watchers[0].onDidChange.fire(uri);
  await sleep(20);
  assert.equal(collection.has(uri), false, "files never checked are not picked up");
  collection.set(uri, [{ stale: true }]);
  state.watchers[0].onDidChange.fire(uri);
  await sleep(20);
  assert.deepEqual(collection.get(uri), [], "re-read from disk: clean now");
  openDoc(state, WF_URI, WF);
  const shown = collection.get(uri).length;
  state.files.set(uri.toString(), "on: push\njobs:\n  a:\n    runs-on: x\n");
  state.watchers[0].onDidChange.fire(uri);
  await sleep(20);
  assert.equal(collection.get(uri).length, shown, "open documents are not overwritten from disk");
});

test("ciSpeedCheck.enable=false clears and silences the checks; turning it on checks again", () => {
  const { state, collection } = boot();
  const doc = openDoc(state, WF_URI, WF);
  assert.ok(collection.get(doc.uri).length > 0);
  state.config["ciSpeedCheck.enable"] = false;
  vscode.workspace.onDidChangeConfiguration.fire({ affectsConfiguration: (k) => k === "ciSpeedCheck.enable" });
  assert.equal(collection.has(doc.uri), false);
  vscode.workspace.onDidOpenTextDocument.fire(doc);
  vscode.workspace.onDidSaveTextDocument.fire(doc);
  assert.equal(collection.has(doc.uri), false);
  state.config["ciSpeedCheck.enable"] = true;
  vscode.workspace.onDidChangeConfiguration.fire({ affectsConfiguration: (k) => k === "ciSpeedCheck.enable" });
  assert.ok(collection.get(doc.uri).length > 0);
  // unrelated settings are ignored
  vscode.workspace.onDidChangeConfiguration.fire({ affectsConfiguration: () => false });
  assert.ok(collection.get(doc.uri).length > 0);
});

/* -------------------------------------------------------------- quick fixes */

async function actionsFor(state, collection, doc) {
  const provider = state.providers[0].provider;
  const diagnostics = collection.get(doc.uri);
  return { diagnostics, actions: await provider.provideCodeActions(doc, diagnostics[0].range, { diagnostics }) };
}

test("code actions: quick fixes for the diagnostics, edits ready to apply", async () => {
  const { state, collection } = boot();
  state.folder = { uri: vscode.Uri.parse(ROOT_URI), name: "repo" };
  state.findFilesImpl = async (pattern) => (pattern instanceof vscode.RelativePattern && /package-lock/.test(pattern.pattern) ? [vscode.Uri.parse(ROOT_URI + "/package-lock.json")] : []);
  const doc = openDoc(state, WF_URI, WF);
  const { diagnostics, actions } = await actionsFor(state, collection, doc);
  const byTitle = (re) => actions.find((a) => re.test(a.title));
  assert.equal(actions.length, 4, actions.map((a) => a.title).join(" | "));
  actions.forEach((a) => {
    assert.equal(a.kind, vscode.CodeActionKind.QuickFix);
    assert.equal(a.diagnostics.length, 1);
    assert.ok(diagnostics.some((d) => d.range.start.line === a.diagnostics[0].range.start.line));
  });
  const timeout = byTitle(/timeout-minutes: 30/);
  assert.deepEqual(timeout.edit.entries.map((e) => [e.type, e.position.line, e.position.character, e.text]), [["insert", 5, 0, "    timeout-minutes: 30\n"]]);
  const conc = byTitle(/concurrency group/);
  assert.equal(conc.edit.entries[0].position.line, 3);
  assert.match(conc.edit.entries[0].text, /^concurrency:\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n$/);
  const cache = byTitle(/cache: npm/);
  assert.match(cache.title, /found package-lock\.json/);
  assert.equal(cache.edit.entries[0].text, "        with:\n          cache: npm\n");
  const pin = byTitle(/^Pin org\/tool/);
  assert.equal(pin.edit, undefined, "pinning needs a lookup: it is a command, not a ready edit");
  assert.equal(pin.command.command, "ciSpeedCheck.pinAction");
  assert.equal(pin.command.arguments[0], WF_URI);
  assert.deepEqual(pin.command.arguments[1], { check: "unpinned-third-party-action", job: "build", action: "org/tool", ref: "v1", nth: 0 });
  assert.equal(state.findCalls.length, 2, "project files were looked up (once per pattern kind), only because a cache fix was in play");
  assert.ok(state.findCalls.every((c) => c.exclude.includes("node_modules")));
});

test("code actions: no cache fix when no lock file is known; nothing for foreign diagnostics or unparseable files", async () => {
  const { state, collection } = boot();
  const doc = openDoc(state, WF_URI, WF);
  const { actions } = await actionsFor(state, collection, doc);
  assert.equal(actions.length, 3);
  assert.ok(!actions.some((a) => /cache/.test(a.title)));
  const provider = state.providers[0].provider;
  assert.deepEqual(await provider.provideCodeActions(doc, null, { diagnostics: [{ source: "other", code: "no-job-timeout", range: { start: { line: 4 } } }] }), []);
  assert.deepEqual(await provider.provideCodeActions(doc, null, { diagnostics: [] }), []);
  const bad = openDoc(state, ROOT_URI + "/.github/workflows/bad.yml", "on: [x\n");
  assert.deepEqual(await provider.provideCodeActions(bad, null, { diagnostics: collection.get(doc.uri) }), []);
  const other = openDoc(state, ROOT_URI + "/docs/x.yml", WF);
  assert.deepEqual(await provider.provideCodeActions(other, null, { diagnostics: collection.get(doc.uri) }), []);
});

test("code actions: a diagnostic whose line no longer matches a finding gets no action", async () => {
  const { state, collection } = boot();
  const doc = openDoc(state, WF_URI, WF);
  const stale = collection.get(doc.uri).map((d) => Object.assign({}, d, { range: { start: { line: 0 }, end: { line: 0 } } }));
  assert.deepEqual(await state.providers[0].provider.provideCodeActions(doc, null, { diagnostics: stale }), []);
});

function githubReply(status, text) {
  return { status: status, headers: { get: () => null }, async text() { return text; }, async json() { return JSON.parse(text); } };
}

test("pin command: looks the commit up on api.github.com, then edits the file", async () => {
  const { state, collection } = boot();
  const doc = openDoc(state, WF_URI, WF);
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return githubReply(200, "0123456789abcdef0123456789abcdef01234567\n"); };
  const { actions } = await actionsFor(state, collection, doc);
  const pin = actions.find((a) => a.command);
  await state.commands[pin.command.command](...pin.command.arguments);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/org/tool/commits/v1");
  assert.equal(calls[0].init.headers.Accept, "application/vnd.github.sha");
  assert.equal(calls[0].init.headers.Authorization, undefined, "no session: anonymous");
  assert.match(calls[0].init.headers["User-Agent"], /^weio-ci-speed-check-vscode\/1\.0\.0$/);
  assert.equal(state.applied.length, 1);
  const e = state.applied[0].entries[0];
  assert.equal(e.type, "replace");
  assert.equal(e.text, "org/tool@0123456789abcdef0123456789abcdef01234567 # v1");
  assert.deepEqual([e.range.start.line, e.range.start.character, e.range.end.line, e.range.end.character], [11, 14, 11, 25]);
  assert.equal(state.messages.filter((m) => m.kind === "error" || m.kind === "warn").length, 0);
});

test("pin command: uses a GitHub session only if one already exists (silent), and only for api.github.com", async () => {
  const { state, collection } = boot();
  const doc = openDoc(state, WF_URI, WF);
  state.sessionImpl = (provider, scopes, opts) => (opts && opts.silent && scopes.length === 1 ? { accessToken: "gho_already_signed_in_token" } : undefined);
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return githubReply(200, "a".repeat(40)); };
  const { actions } = await actionsFor(state, collection, doc);
  const pin = actions.find((a) => a.command);
  await state.commands[pin.command.command](...pin.command.arguments);
  assert.equal(calls[0].init.headers.Authorization, "Bearer gho_already_signed_in_token");
  assert.ok(state.sessionCalls.every((c) => c.opts.silent === true && !c.opts.createIfNone), "never prompts for sign-in");
  assert.equal(state.applied.length, 1);
});

test("pin command: a rejected token is retried anonymously", async () => {
  const { state, collection } = boot();
  const doc = openDoc(state, WF_URI, WF);
  state.sessionImpl = (p, scopes, opts) => (scopes.length === 1 ? { accessToken: "gho_expired" } : undefined);
  const auths = [];
  globalThis.fetch = async (url, init) => { auths.push(init.headers.Authorization); return auths.length === 1 ? githubReply(401, "{}") : githubReply(200, "b".repeat(40)); };
  const { actions } = await actionsFor(state, collection, doc);
  const pin = actions.find((a) => a.command);
  await state.commands[pin.command.command](...pin.command.arguments);
  assert.deepEqual(auths, ["Bearer gho_expired", undefined]);
  assert.equal(state.applied.length, 1);
});

test("pin command: lookup failures show GitHub's reason and edit nothing", async () => {
  for (const [status, re] of [[404, /no commit for org\/tool@v1/], [403, /rate limit/], [500, /HTTP 500/]]) {
    const { state, collection } = boot();
    const doc = openDoc(state, WF_URI, WF);
    globalThis.fetch = async () => githubReply(status, "{}");
    const { actions } = await actionsFor(state, collection, doc);
    const pin = actions.find((a) => a.command);
    await state.commands[pin.command.command](...pin.command.arguments);
    assert.equal(state.applied.length, 0);
    const err = state.messages.find((m) => m.kind === "error");
    assert.ok(err && re.test(err.text), status + " " + (err && err.text));
  }
  const { state, collection } = boot();
  const doc = openDoc(state, WF_URI, WF);
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  const { actions } = await actionsFor(state, collection, doc);
  await state.commands["ciSpeedCheck.pinAction"](...actions.find((a) => a.command).command.arguments);
  assert.match(state.messages.find((m) => m.kind === "error").text, /could not reach the GitHub API \(network error\)/);
  assert.equal(state.applied.length, 0);
});

test("pin command: no edit if the document changed while the commit was being looked up", async () => {
  const { state, collection } = boot();
  const doc = openDoc(state, WF_URI, WF);
  globalThis.fetch = async () => { doc.setText(WF + "# edited meanwhile\n"); return githubReply(200, "c".repeat(40)); };
  const { actions } = await actionsFor(state, collection, doc);
  await state.commands["ciSpeedCheck.pinAction"](...actions.find((a) => a.command).command.arguments);
  assert.equal(state.applied.length, 0);
  assert.match(state.messages.find((m) => m.kind === "warn").text, /changed while the commit was being looked up/);
});

test("pin command: a finding that is gone, or a step that cannot be edited safely, is explained and untouched", async () => {
  const { state } = boot();
  const doc = openDoc(state, WF_URI, WF.replace("org/tool@v1", "org/tool@" + "d".repeat(40)));
  await state.commands["ciSpeedCheck.pinAction"](WF_URI, { check: "unpinned-third-party-action", job: "build", action: "org/tool", ref: "v1", nth: 0 });
  assert.match(state.messages.find((m) => m.kind === "warn").text, /finding is gone/);
  doc.setText(WF.replace("- uses: org/tool@v1", "- {uses: org/tool@v1}"));
  globalThis.fetch = async () => githubReply(200, "e".repeat(40));
  await state.commands["ciSpeedCheck.pinAction"](WF_URI, { check: "unpinned-third-party-action", job: "build", action: "org/tool", ref: "v1", nth: 0 });
  assert.ok(state.messages.some((m) => m.kind === "warn" && /Pin it by hand: org\/tool@<full commit SHA> # v1/.test(m.text)));
  assert.equal(state.applied.length, 0);
});

/* ---------------------------------------------------------- check workspace */

test("checkWorkspace: scans every workflow file, using unsaved text for open ones, and reports counts", async () => {
  const { state, collection } = boot();
  const u1 = vscode.Uri.parse(ROOT_URI + "/.github/workflows/a.yml");
  const u2 = vscode.Uri.parse(ROOT_URI + "/.github/workflows/b.yaml");
  const u3 = vscode.Uri.parse(ROOT_URI + "/.github/workflows/broken.yml");
  const u4 = vscode.Uri.parse(ROOT_URI + "/.github/workflows/big.yml");
  state.foundFiles = [u1, u2, u3, u4];
  state.files.set(u1.toString(), WF);
  state.files.set(u2.toString(), "on: push\nconcurrency: x\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 1\n");
  state.files.set(u3.toString(), "on: [push\n");
  state.files.set(u4.toString(), Buffer.alloc(C.MAX_FILE_BYTES + 1, 97));
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.parse(ROOT_URI), name: "repo" }];
  openDoc(state, u2.toString(), "on: push\njobs:\n  a:\n    runs-on: x\n");   // unsaved edit with two defects
  state.pickQueue.push("Show Problems");
  await state.commands["ciSpeedCheck.checkWorkspace"]();
  assert.deepEqual(state.findCalls[0], { pattern: "**/.github/workflows/*.{yml,yaml}", exclude: "**/node_modules/**", max: C.MAX_WORKSPACE_FILES });
  assert.equal(collection.get(u1).length, 5);
  assert.equal(collection.get(u2).length, 2, "the open document's text, not the file on disk");
  assert.equal(collection.has(u3), false);
  assert.equal(collection.has(u4), false);
  const info = state.messages.find((m) => m.kind === "info");
  assert.equal(info.text, "CI Speed Check: 7 findings (6 warnings) in 2 workflow files; 2 not checked (YAML did not parse, or the file is over 1 MiB).");
  assert.deepEqual(info.items, ["Show Problems"]);
  assert.deepEqual(state.executed.map((e) => e.id), ["workbench.actions.view.problems"]);
  assert.ok(state.messages.some((m) => m.kind === "progress"));
});

test("checkWorkspace: results from an earlier scan for files that are gone are cleared", async () => {
  const { state, collection } = boot();
  const gone = vscode.Uri.parse(ROOT_URI + "/.github/workflows/old.yml");
  collection.set(gone, [{ stale: true }]);
  const u = vscode.Uri.parse(ROOT_URI + "/.github/workflows/a.yml");
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.parse(ROOT_URI), name: "repo" }];
  state.foundFiles = [u];
  state.files.set(u.toString(), WF);
  await state.commands["ciSpeedCheck.checkWorkspace"]();
  assert.equal(collection.has(gone), false);
  assert.equal(collection.get(u).length, 5);
});

test("checkWorkspace: no folder, no workflow files, and a clean workspace each say so", async () => {
  let { state } = boot();
  vscode.workspace.workspaceFolders = undefined;
  await state.commands["ciSpeedCheck.checkWorkspace"]();
  assert.match(state.messages[0].text, /open a folder/);
  ({ state } = boot());
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.parse(ROOT_URI), name: "repo" }];
  await state.commands["ciSpeedCheck.checkWorkspace"]();
  assert.match(state.messages[0].text, /no workflow files found/);
  const { state: s3 } = boot();
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.parse(ROOT_URI), name: "repo" }];
  const u = vscode.Uri.parse(ROOT_URI + "/.github/workflows/ok.yml");
  s3.foundFiles = [u];
  s3.files.set(u.toString(), "on: push\nconcurrency: x\njobs:\n  a:\n    runs-on: x\n    timeout-minutes: 1\n");
  await s3.commands["ciSpeedCheck.checkWorkspace"]();
  const info = s3.messages.find((m) => m.kind === "info");
  assert.equal(info.text, "CI Speed Check: 0 findings (0 warnings) in 1 workflow file.");
  assert.deepEqual(info.items, [], "no Show Problems button when there is nothing to show");
});

/* ------------------------------------------------------- Pro: run history */

const T0 = Date.parse("2026-09-20T10:00:00Z");
const iso = (ms) => new Date(T0 + ms).toISOString();
function run(id, startMin, endMin) {
  return { id: id, workflow_id: 7, name: "CI", event: "push", head_branch: "main", status: "completed", conclusion: "success",
    run_attempt: 1, run_started_at: iso(startMin * 60000), created_at: iso(startMin * 60000), updated_at: iso(endMin * 60000) };
}
function jobsFor(startMin, endMin) {
  return { total_count: 1, jobs: [{ name: "build", labels: ["ubuntu-latest"], conclusion: "success", created_at: iso(startMin * 60000 - 20000),
    started_at: iso(startMin * 60000), completed_at: iso(endMin * 60000),
    steps: [{ name: "Run tests", conclusion: "success", started_at: iso(startMin * 60000), completed_at: iso(endMin * 60000) }] }] };
}

/* Routes mocked traffic. Returns the list of calls; `over` replaces a route's reply. */
function mockNet(over) {
  over = over || {};
  const calls = [];
  const reply = (status, body) => ({ status: status, headers: { get: () => null }, async json() { if (body === undefined) throw new Error("no body"); return body; }, async text() { return JSON.stringify(body); } });
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init });
    const u = new URL(url);
    if (u.pathname === "/api/credit") {
      if (over.credit) return over.credit(url, init, reply);
      return reply(200, { ok: true, credits_remaining: 998 });
    }
    if (u.host === "api.github.com") {
      if (over.github) { const r = over.github(url, init, reply); if (r) return r; }
      if (/\/actions\/runs$/.test(u.pathname)) return reply(200, { total_count: 2, workflow_runs: [run(1, 0, 10), run(2, 4, 8)] });
      if (/\/actions\/runs\/1\/jobs$/.test(u.pathname)) return reply(200, jobsFor(0, 10));
      if (/\/actions\/runs\/2\/jobs$/.test(u.pathname)) return reply(200, jobsFor(4, 8));
    }
    return reply(404, { message: "Not Found" });
  };
  return calls;
}

function repoWithRemote(state, url) {
  state.folder = { uri: vscode.Uri.parse(ROOT_URI), name: "repo" };
  vscode.workspace.workspaceFolders = [state.folder];
  state.files.set(ROOT_URI + "/.git/config", "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = " + url + "\n");
}

function readyForPro(extra) {
  const b = boot();
  b.state.secrets.set(C.SECRET_KEY, KEY);
  repoWithRemote(b.state, extra && extra.remote || "git@github.com:" + REPO + ".git");
  return b;
}

function noSecretsIn(texts) {
  texts.forEach((t) => {
    assert.ok(!String(t).includes(KEY), "Weio key leaked: " + String(t).slice(0, 80));
    assert.ok(!String(t).includes(GH_TOKEN), "GitHub token leaked: " + String(t).slice(0, 80));
  });
}

test("Pro report, happy path: key from secret storage, repo from .git/config, GitHub sign-in, one credit, report as Markdown", async () => {
  const { state } = readyForPro();
  const calls = mockNet();
  await state.commands["ciSpeedCheck.historyReport"]();

  // GitHub sign-in: reuse an existing session silently, else ask for no scope (public repos need none)
  assert.deepEqual(state.sessionCalls, [
    { provider: "github", scopes: [], opts: { silent: true } },
    { provider: "github", scopes: ["repo"], opts: { silent: true } },
    { provider: "github", scopes: [], opts: { createIfNone: true } }
  ]);

  // network: runs list first, then exactly one credit POST, then job reads
  const urls = calls.map((c) => c.url);
  assert.match(urls[0], /^https:\/\/api\.github\.com\/repos\/weioai\/https-check-action\/actions\/runs\?per_page=100&created=/);
  assert.equal(urls[1], "https://weio.ai/api/credit?for=ci-speed-check&ref=weioai/https-check-action");
  assert.equal(urls.filter((u) => u.includes("/api/credit")).length, 1);
  assert.ok(urls.slice(2).every((u) => /\/actions\/runs\/[12]\/jobs/.test(u)), urls.slice(2).join(" "));
  assert.equal(urls.length, 4);

  // each secret goes to its own host only
  calls.forEach((c) => {
    const host = new URL(c.url).host;
    assert.ok(host === "api.github.com" || host === "weio.ai", host);
    const h = c.init.headers;
    if (host === "weio.ai") {
      assert.equal(c.init.method, "POST");
      assert.equal(h.Authorization, "Bearer " + KEY);
      assert.equal(h["User-Agent"], "weio-ci-speed-check/1.0.0");
      noSecretsIn([JSON.stringify(Object.assign({}, c.init, { headers: Object.assign({}, h, { Authorization: "" }) })), c.url].concat([]));
      assert.ok(!JSON.stringify(h).includes(GH_TOKEN), "GitHub token sent to Weio");
    } else {
      assert.equal(h.Authorization, "Bearer " + GH_TOKEN);
      assert.ok(!JSON.stringify(c).includes(KEY), "Weio key sent to GitHub");
    }
  });

  // result: untitled Markdown document, previewed
  assert.equal(state.untitledOpened.length, 1);
  const doc = state.untitledOpened[0];
  assert.equal(doc.languageId, "markdown");
  assert.match(doc.getText(), /^## CI Speed Check Pro: run history/);
  assert.match(doc.getText(), /Repository weioai\/https-check-action\. 2 runs created since/);
  assert.match(doc.getText(), /\| Runner minutes \| 14 \|/);
  assert.match(doc.getText(), /One Weio credit was used for this report; 998 credits remain on this key\.\n$/);
  assert.equal(state.shown.length, 1);
  assert.deepEqual(state.executed.map((e) => e.id), ["markdown.showPreview"]);
  assert.equal(state.executed[0].args[0], doc.uri);

  // nothing sensitive in any message or console output
  noSecretsIn(state.messages.map((m) => m.text).concat(doc.getText(), consoleCalls.map((c) => c.join(" "))));
  assert.deepEqual(consoleCalls, []);
  assert.equal(state.messages.filter((m) => m.kind === "error").length, 0);
});

test("Pro report: settings choose the window; https remotes with credentials work and are never shown", async () => {
  const { state } = readyForPro({ remote: "https://someone:ghp_REMOTE_TOKEN_123@github.com/" + REPO });
  state.config["ciSpeedCheck.historyDays"] = 7;
  state.config["ciSpeedCheck.historyRuns"] = 1;
  const calls = mockNet();
  await state.commands["ciSpeedCheck.historyReport"]();
  const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  assert.ok(decodeURIComponent(calls[0].url).includes("created=>=" + since), calls[0].url);
  assert.match(state.untitledOpened[0].getText(), /1 run created since .* \(7 days, limit 1 runs\)/);
  assert.ok(calls.every((c) => !c.url.includes("ghp_REMOTE") && !JSON.stringify(c.init).includes("ghp_REMOTE")));
  assert.ok(!state.messages.some((m) => /ghp_REMOTE/.test(m.text || "")));
});

test("Pro report: an empty window uses no credit", async () => {
  const { state } = readyForPro();
  const calls = mockNet({ github: (url, init, reply) => (/\/actions\/runs\?/.test(url) ? reply(200, { total_count: 0, workflow_runs: [] }) : null) });
  await state.commands["ciSpeedCheck.historyReport"]();
  assert.equal(calls.filter((c) => c.url.includes("/api/credit")).length, 0);
  assert.match(state.untitledOpened[0].getText(), /The run window held no runs, so no credit was used\.\n$/);
});

test("Pro report: without the repo scope, a denied run list asks before requesting it; no credit is used", async () => {
  const { state } = readyForPro();
  const calls = mockNet({ github: (url, init, reply) => reply(404, { message: "Not Found" }) });
  await state.commands["ciSpeedCheck.historyReport"]();
  assert.equal(calls.filter((c) => c.url.includes("/api/credit")).length, 0);
  const ask = state.messages.find((m) => m.kind === "warn");
  assert.match(ask.text, /without repository access/);
  assert.match(ask.text, /No credit was used\./);
  assert.deepEqual(ask.items, [{ modal: true }, "Sign in with repository access"]);
  assert.ok(!state.sessionCalls.some((c) => c.scopes.length && c.opts.createIfNone), "repo scope not requested without consent");
  assert.ok(!state.messages.some((m) => m.kind === "error"));
});

test("Pro report: GitHub denying access stops before any credit is used", async () => {
  for (const status of [401, 403, 404]) {
    const { state } = readyForPro();
    const calls = mockNet({ github: (url, init, reply) => reply(status, { message: "nope" }) });
    state.pickQueue.push("Sign in with repository access");
    await state.commands["ciSpeedCheck.historyReport"]();
    assert.ok(state.sessionCalls.some((c) => c.scopes[0] === "repo" && c.opts.createIfNone), "asked for repo after consent");
    assert.equal(calls.filter((c) => c.url.includes("/api/credit")).length, 0, "status " + status);
    const err = state.messages.find((m) => m.kind === "error");
    assert.match(err.text, /did not allow this account to read the Actions run history of weioai\/https-check-action \(HTTP \d+\)/);
    assert.match(err.text, /No credit was used\./);
    assert.ok(!/permissions: actions: read/.test(err.text), "workflow-file advice does not apply in the editor");
    assert.equal(state.untitledOpened.length, 0);
    noSecretsIn(state.messages.map((m) => m.text));
  }
});

test("Pro report: Weio refusals show Weio's text and a way to buy; an invalid key is removed", async () => {
  // 401
  let ctx = readyForPro();
  let calls = mockNet({ credit: (u, i, reply) => reply(401, { ok: false, error: "invalid API key", buy: "https://evil.example/pay" }) });
  ctx.state.pickQueue.push("Buy a key");
  await ctx.state.commands["ciSpeedCheck.historyReport"]();
  await sleep(20);                                   // the notification's button is handled after the command returns
  let err = ctx.state.messages.find((m) => m.kind === "error");
  assert.match(err.text, /Weio said: invalid API key \(HTTP 401\)\./);
  assert.match(err.text, /No credit was used\. The stored key was removed\./);
  assert.deepEqual(err.items, ["Buy a key", "Enter a different key"]);
  assert.equal(ctx.state.secrets.has(C.SECRET_KEY), false);
  assert.deepEqual(ctx.state.openedExternal, [C.BUY_URL], "the fixed BUY_URL opens, never a server-supplied link");
  assert.ok(calls.every((c) => !/\/jobs/.test(c.url)), "no job data read after a refused credit");
  assert.equal(ctx.state.untitledOpened.length, 0);
  noSecretsIn(ctx.state.messages.map((m) => m.text));

  // 402 (both messages from the spec), key kept
  for (const text of ["no credits left on this key", "this key has expired"]) {
    ctx = readyForPro();
    calls = mockNet({ credit: (u, i, reply) => reply(402, { ok: false, error: text, buy: "https://weio.ai/x" }) });
    await ctx.state.commands["ciSpeedCheck.historyReport"]();
    err = ctx.state.messages.find((m) => m.kind === "error");
    assert.ok(err.text.includes("Weio said: " + text + " (HTTP 402)."), err.text);
    assert.deepEqual(err.items, ["Buy a key"]);
    assert.equal(ctx.state.secrets.get(C.SECRET_KEY), KEY, "an empty or expired key is kept");
    assert.equal(ctx.state.untitledOpened.length, 0);
  }

  // 429, 500, 400, network error, timeout-shaped failure
  for (const [mk, re] of [
    [(r) => r(429, { ok: false, error: "rate limit, slow down" }), /rate limit, slow down \(HTTP 429\)\. Try again later\./],
    [(r) => r(500, undefined), /HTTP 500\)\. Try again later\./],
    [(r) => r(400, { ok: false, error: "bad ref" }), /bad ref \(HTTP 400\)\. No credit was used/]
  ]) {
    ctx = readyForPro();
    mockNet({ credit: (u, i, reply) => mk(reply) });
    await ctx.state.commands["ciSpeedCheck.historyReport"]();
    err = ctx.state.messages.find((m) => m.kind === "error");
    assert.match(err.text, re);
    assert.match(err.text, /No credit was used/);
    assert.deepEqual(err.items, []);
    assert.equal(ctx.state.secrets.get(C.SECRET_KEY), KEY);
  }
  ctx = readyForPro();
  mockNet({ credit: () => { throw new TypeError("fetch failed (" + KEY + ")"); } });
  await ctx.state.commands["ciSpeedCheck.historyReport"]();
  err = ctx.state.messages.find((m) => m.kind === "error");
  assert.match(err.text, /could not reach Weio to use a credit \(network error\)\. Weio did not confirm the credit; if one was used, it shows in your remaining balance\./);
  noSecretsIn([err.text]);
});

test("Pro report: choosing 'Enter a different key' after a rejected key opens the key prompt", async () => {
  const { state } = readyForPro();
  mockNet({ credit: (u, i, reply) => reply(401, { ok: false, error: "invalid API key" }) });
  state.pickQueue.push("Enter a different key");
  const NEW = "wk_" + "Qq7Rr6Ss".repeat(4);
  state.onInputBox = (box) => { box.value = NEW; box.onDidAccept.fire(); };
  await state.commands["ciSpeedCheck.historyReport"]();
  await sleep(30);
  assert.equal(state.secrets.get(C.SECRET_KEY), NEW);
});

test("Pro report: runs whose jobs cannot be read still give a report, and the credit line stays true", async () => {
  const { state } = readyForPro();
  mockNet({ github: (url, init, reply) => (/\/jobs/.test(url) ? { status: 500, headers: { get: () => null }, async json() { return {}; } } : null) });
  await state.commands["ciSpeedCheck.historyReport"]();
  assert.match(state.untitledOpened[0].getText(), /One Weio credit was used for this report; 998 credits remain/);
  assert.match(state.untitledOpened[0].getText(), /could not have their jobs read/);
});

test("Pro report: a failure after the credit was used says a credit was used", async () => {
  const { state } = readyForPro();
  mockNet();
  vscode.workspace.openTextDocument = async () => { throw new Error("cannot open an editor"); };
  await state.commands["ciSpeedCheck.historyReport"]();
  const err = state.messages.find((m) => m.kind === "error");
  assert.match(err.text, /unexpected error \(cannot open an editor\)\. A credit had already been used\./);
});

test("Pro report: a server message that echoes the key cannot put it on screen", async () => {
  const { state } = readyForPro();
  mockNet({ credit: (u, i, reply) => reply(402, { ok: false, error: "key " + KEY + " has expired" }) });
  await state.commands["ciSpeedCheck.historyReport"]();
  const err = state.messages.find((m) => m.kind === "error");
  assert.match(err.text, /key \*\*\* has expired/);
  noSecretsIn([err.text]);
});

test("Pro report: no stored key asks for one (password box, Buy a key button, format check), then stores it", async () => {
  const b = boot();
  repoWithRemote(b.state, "https://github.com/" + REPO);
  const calls = mockNet();
  const seen = {};
  b.state.onInputBox = (box) => {
    seen.password = box.password; seen.button = box.buttons[0]; seen.ignoreFocusOut = box.ignoreFocusOut; seen.placeholder = box.placeholder;
    box.onDidTriggerButton.fire(box.buttons[0]);
    box.value = "not-a-key"; box.onDidChangeValue.fire("not-a-key");
    seen.msgBad = box.validationMessage;
    box.onDidAccept.fire();
    seen.stillShown = box.shown;
    seen.storedEarly = b.state.secrets.has(C.SECRET_KEY);
    box.value = "  " + KEY + "  "; box.onDidChangeValue.fire(box.value);
    seen.msgGood = box.validationMessage;
    box.onDidAccept.fire();
  };
  await b.state.commands["ciSpeedCheck.historyReport"]();
  assert.equal(seen.password, true);
  assert.equal(seen.button.tooltip, "Buy a key");
  assert.equal(seen.button.iconPath.id, "link-external");
  assert.equal(seen.ignoreFocusOut, true);
  assert.match(seen.msgBad, /Expected wk_ followed by 24 to 64 letters/);
  assert.equal(seen.stillShown, true, "a bad key does not close the box");
  assert.equal(seen.storedEarly, false);
  assert.equal(seen.msgGood, undefined);
  assert.deepEqual(b.state.openedExternal, [C.BUY_URL]);
  assert.equal(b.state.secrets.get(C.SECRET_KEY), KEY, "trimmed and kept in secret storage");
  assert.equal(calls.filter((c) => c.url.includes("/api/credit")).length, 1);
  assert.equal(b.state.inputBoxes.length, 1);
  assert.ok(b.state.inputBoxes[0].disposed);
  noSecretsIn(b.state.messages.map((m) => m.text));
});

test("Pro report: cancelling the key prompt stops everything", async () => {
  const b = boot();
  repoWithRemote(b.state, "https://github.com/" + REPO);
  const calls = mockNet();
  b.state.onInputBox = (box) => box.hide();
  await b.state.commands["ciSpeedCheck.historyReport"]();
  assert.equal(calls.length, 0);
  assert.equal(b.state.sessionCalls.length, 0);
  assert.equal(b.state.secrets.has(C.SECRET_KEY), false);
  assert.equal(b.state.untitledOpened.length, 0);
});

test("Pro report: a stored value that is not a key is dropped and asked for again", async () => {
  const b = boot();
  repoWithRemote(b.state, "https://github.com/" + REPO);
  b.state.secrets.set(C.SECRET_KEY, "garbage");
  mockNet();
  b.state.onInputBox = (box) => box.hide();
  await b.state.commands["ciSpeedCheck.historyReport"]();
  assert.equal(b.state.secrets.has(C.SECRET_KEY), false);
  assert.equal(b.state.inputBoxes.length, 1);
});

test("Pro report: without a github.com remote the repository is asked for (validated); cancelling stops", async () => {
  const b = boot();
  b.state.secrets.set(C.SECRET_KEY, KEY);
  b.state.folder = { uri: vscode.Uri.parse(ROOT_URI), name: "repo" };
  vscode.workspace.workspaceFolders = [b.state.folder];
  b.state.files.set(ROOT_URI + "/.git/config", "[remote \"origin\"]\n\turl = https://gitlab.com/a/b.git\n");
  const calls = mockNet();
  b.state.inputBoxQueue.push("owner-x/repo-y");
  await b.state.commands["ciSpeedCheck.historyReport"]();
  const ask = b.state.messages.find((m) => m.kind === "inputBox");
  assert.match(ask.text, /No github\.com remote found/);
  assert.match(ask.opts.validateInput("nope"), /owner\/repo/);
  assert.equal(ask.opts.validateInput("owner-x/repo-y"), null);
  assert.match(calls[0].url, /\/repos\/owner-x\/repo-y\/actions\/runs\?/);
  assert.equal(calls[1].url, "https://weio.ai/api/credit?for=ci-speed-check&ref=owner-x/repo-y");

  const c = boot();
  c.state.secrets.set(C.SECRET_KEY, KEY);
  const calls2 = mockNet();            // no folder at all: ask, user cancels
  await c.state.commands["ciSpeedCheck.historyReport"]();
  assert.equal(calls2.length, 0);
  assert.equal(c.state.sessionCalls.length, 0, "no GitHub sign-in before the repository is known");
});

test("Pro report: several GitHub remotes offer a choice; a .git file (worktree) is followed", async () => {
  const b = readyForPro();
  b.state.files.set(ROOT_URI + "/.git/config", "[remote \"origin\"]\n\turl = git@github.com:me/fork.git\n[remote \"upstream\"]\n\turl = https://github.com/org/upstream.git\n");
  mockNet();
  b.state.quickPickQueue.push("org/upstream");
  await b.state.commands["ciSpeedCheck.historyReport"]();
  const pick = b.state.messages.find((m) => m.kind === "quickPick");
  assert.deepEqual(pick.items, ["me/fork", "org/upstream"]);
  assert.match(b.state.untitledOpened[0].getText(), /Repository org\/upstream\./);

  const w = boot();
  w.state.secrets.set(C.SECRET_KEY, KEY);
  w.state.folder = { uri: vscode.Uri.parse(ROOT_URI), name: "repo" };
  vscode.workspace.workspaceFolders = [w.state.folder];
  w.state.files.set(ROOT_URI + "/.git", "gitdir: /main/.git/worktrees/wt\n");
  w.state.files.set("file:///main/.git/worktrees/wt/commondir", "../..\n");
  w.state.files.set("file:///main/.git/config", "[remote \"origin\"]\n\turl = https://github.com/wt/owner.git\n");
  mockNet();
  await w.state.commands["ciSpeedCheck.historyReport"]();
  assert.match(w.state.untitledOpened[0].getText(), /Repository wt\/owner\./);
});

test("Pro report: a second request while one is running does not start another (no double credit)", { timeout: 10000 }, async () => {
  const { state } = readyForPro();
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = mockNet({ credit: async (u, i, reply) => { await gate; return reply(200, { ok: true, credits_remaining: 5 }); } });
  const first = state.commands["ciSpeedCheck.historyReport"]();
  await sleep(30);
  await state.commands["ciSpeedCheck.historyReport"]();
  assert.match(state.messages.find((m) => m.kind === "info").text, /already being made/);
  release();
  await first;
  assert.equal(calls.filter((c) => c.url.includes("/api/credit")).length, 1);
  assert.equal(state.untitledOpened.length, 1);
  // and the next request after it finished works again
  mockNet();
  await state.commands["ciSpeedCheck.historyReport"]();
  assert.equal(state.untitledOpened.length, 2);
});

test("Pro report: an error notification left open does not block the next report", { timeout: 10000 }, async () => {
  const { state } = readyForPro();
  state.hold = true;
  mockNet({ credit: (u, i, reply) => reply(402, { ok: false, error: "no credits left on this key" }) });
  await state.commands["ciSpeedCheck.historyReport"]();            // returns although the toast never closes
  assert.equal(state.messages.filter((m) => m.kind === "error").length, 1);
  mockNet();
  await state.commands["ciSpeedCheck.historyReport"]();
  assert.ok(!state.messages.some((m) => m.kind === "info" && /already being made/.test(m.text)));
  assert.equal(state.untitledOpened.length, 1);
});

test("Pro report: GitHub sign-in cancelled or failing stops before anything is sent", async () => {
  for (const impl of [() => { throw new Error("User did not consent to login."); }, () => undefined]) {
    const { state } = readyForPro();
    state.sessionImpl = impl;
    const calls = mockNet();
    await state.commands["ciSpeedCheck.historyReport"]();
    assert.equal(calls.length, 0);
    assert.match(state.messages.find((m) => m.kind === "error").text, /No credit was used\./);
  }
});

test("Pro report: WEIO_API_BASE only accepts weio.ai or loopback; the key follows it, the GitHub token never does", async () => {
  let ctx = readyForPro();
  for (const bad of ["http://weio.example", "https://evil.example"]) {
    ctx = readyForPro();
    process.env.WEIO_API_BASE = bad;
    const none = mockNet();
    await ctx.state.commands["ciSpeedCheck.historyReport"]();
    assert.equal(none.length, 0, "refused before the key could be sent anywhere: " + bad);
    assert.match(ctx.state.messages.find((m) => m.kind === "error").text, /WEIO_API_BASE must be an https URL on weio\.ai/);
  }
  let calls;

  ctx = readyForPro();
  process.env.WEIO_API_BASE = "http://127.0.0.1:9";
  calls = mockNet();
  await ctx.state.commands["ciSpeedCheck.historyReport"]();
  const credit = calls.find((c) => c.url.includes("/api/credit"));
  assert.ok(credit.url.startsWith("http://127.0.0.1:9/api/credit?for=ci-speed-check&ref="));
  assert.ok(!JSON.stringify(credit.init).includes(GH_TOKEN));
});

test("Pro report: an unexpected failure is reported without leaking the key or token", async () => {
  const { state } = readyForPro();
  mockNet({ github: () => { throw new Error("socket exploded for " + KEY + " and " + GH_TOKEN); } });
  await state.commands["ciSpeedCheck.historyReport"]();
  const err = state.messages.find((m) => m.kind === "error");
  assert.match(err.text, /could not reach the GitHub API/);
  noSecretsIn([err.text]);
  assert.deepEqual(consoleCalls, []);
});

/* ------------------------------------------------------------ key commands */

test("Set Weio API key stores a valid key; Clear removes it", async () => {
  const { state } = boot();
  state.onInputBox = (box) => { box.value = KEY; box.onDidAccept.fire(); };
  await state.commands["ciSpeedCheck.setApiKey"]();
  assert.equal(state.secrets.get(C.SECRET_KEY), KEY);
  assert.match(state.messages.at(-1).text, /key saved in VS Code's secret storage/);
  noSecretsIn(state.messages.map((m) => m.text));
  await state.commands["ciSpeedCheck.clearApiKey"]();
  assert.equal(state.secrets.has(C.SECRET_KEY), false);
  assert.match(state.messages.at(-1).text, /key removed/);

  state.onInputBox = (box) => box.hide();
  await state.commands["ciSpeedCheck.setApiKey"]();
  assert.equal(state.secrets.has(C.SECRET_KEY), false, "cancelling stores nothing");
});

test("no run of the extension wrote to the console", () => {
  assert.deepEqual(consoleCalls, []);
});
