"use strict";
/* CI Speed Check for GitHub Actions: VS Code extension.
 *
 * Free: checks .github/workflows/*.yml as you type and offers quick fixes. Nothing leaves your machine.
 * Pro (optional Weio API key): reads the repository's Actions run history from GitHub and reports measured minutes.
 *   - The GitHub token goes only to api.github.com. The Weio key goes only to weio.ai (one credit call).
 *   - Neither is logged, shown or stored anywhere except VS Code's secret storage (the Weio key) and its
 *     authentication provider (the GitHub token). No telemetry.
 */

const vscode = require("vscode");
const path = require("path");
const C = require("./constants");
const { analyzeText, isWorkflowPath } = require("./analyze");
const fixes = require("./fixes");
const credit = require("./credit");
const history = require("./core/history");

const CMD_PIN = "ciSpeedCheck.pinAction";                    // internal: not listed in package.json
const SCHEMES = ["file", "vscode-remote", "vscode-vfs", "vscode-test-web"];
const BUY = "Buy a key";

function isWorkflowDocument(doc) {
  return !!doc && !!doc.uri && SCHEMES.indexOf(doc.uri.scheme) >= 0 && isWorkflowPath(doc.uri.fsPath);
}

function decode(bytes) { return new TextDecoder("utf-8").decode(bytes); }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function codeValue(d) { return d && d.code && typeof d.code === "object" ? d.code.value : d && d.code; }

function toDiagnostic(f) {
  const line = Math.max(0, f.line - 1);
  const d = new vscode.Diagnostic(
    new vscode.Range(line, f.startChar, line, f.endChar),
    capitalize(f.detail),
    f.severity === "defect" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information
  );
  d.source = C.SOURCE;
  d.code = { value: f.check, target: vscode.Uri.parse(C.REPO_URL + "#" + f.check) };
  return d;
}

function toWorkspaceEdit(uri, edits) {
  const we = new vscode.WorkspaceEdit();
  edits.forEach(function (e) {
    if (e.insertText !== undefined) we.insert(uri, new vscode.Position(e.line, e.character), e.insertText);
    else we.replace(uri, new vscode.Range(e.startLine, e.startChar, e.endLine, e.endChar), e.newText);
  });
  return we;
}

function activate(context) {
  const subs = context.subscriptions;
  const collection = vscode.languages.createDiagnosticCollection("ci-speed-check");
  subs.push(collection);

  const analyses = new Map();        // document uri -> {version, result}
  const timers = new Map();          // document uri -> pending debounce timer
  const filesCache = new Map();      // workspace folder uri -> {at, files}

  const version = (function () {
    try {
      const v = context.extension && context.extension.packageJSON && context.extension.packageJSON.version;
      return v || require("../package.json").version;
    } catch (e) { return "1.0.0"; }
  })();

  function enabled() {
    return vscode.workspace.getConfiguration("ciSpeedCheck").get("enable", true) !== false;
  }

  /* --------------------------------------------------------- diagnostics */

  function analysisFor(doc) {
    const key = doc.uri.toString();
    const hit = analyses.get(key);
    if (hit && hit.version === doc.version) return hit.result;
    const result = analyzeText(doc.getText(), path.basename(doc.uri.path));
    analyses.set(key, { version: doc.version, result: result });
    return result;
  }

  function refresh(doc) {
    if (!isWorkflowDocument(doc)) return;
    if (!enabled()) { collection.delete(doc.uri); return; }
    collection.set(doc.uri, analysisFor(doc).findings.map(toDiagnostic));
  }

  function cancelTimer(doc) {
    const key = doc.uri.toString();
    const t = timers.get(key);
    if (t) { clearTimeout(t); timers.delete(key); }
  }

  function schedule(doc) {
    if (!isWorkflowDocument(doc)) return;
    cancelTimer(doc);
    timers.set(doc.uri.toString(), setTimeout(function () {
      timers.delete(doc.uri.toString());
      refresh(doc);
    }, C.DEBOUNCE_MS));
  }

  function openDocument(uri) {
    const key = uri.toString();
    return vscode.workspace.textDocuments.find(function (d) { return d.uri.toString() === key; });
  }

  async function readText(uri) {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > C.MAX_FILE_BYTES) return null;
    return decode(bytes);
  }

  subs.push(vscode.workspace.onDidOpenTextDocument(refresh));
  subs.push(vscode.workspace.onDidChangeTextDocument(function (e) {
    if (e.contentChanges && e.contentChanges.length) schedule(e.document);
  }));
  subs.push(vscode.workspace.onDidSaveTextDocument(function (doc) { cancelTimer(doc); refresh(doc); }));
  subs.push(vscode.workspace.onDidCloseTextDocument(function (doc) {
    cancelTimer(doc);
    analyses.delete(doc.uri.toString());
  }));
  subs.push(vscode.workspace.onDidChangeConfiguration(function (e) {
    if (!e.affectsConfiguration("ciSpeedCheck.enable")) return;
    if (enabled()) vscode.workspace.textDocuments.forEach(refresh);
    else collection.clear();
  }));
  subs.push({ dispose: function () { timers.forEach(function (t) { clearTimeout(t); }); timers.clear(); } });

  // Files that were checked but are not open: drop them when deleted, re-check them when changed on disk.
  const watcher = vscode.workspace.createFileSystemWatcher(C.WORKFLOW_GLOB);
  subs.push(watcher);
  subs.push(watcher.onDidDelete(function (uri) { collection.delete(uri); }));
  subs.push(watcher.onDidChange(async function (uri) {
    if (!enabled() || !collection.has(uri) || openDocument(uri)) return;
    try {
      const text = await readText(uri);
      collection.set(uri, text === null ? [] : analyzeText(text, path.basename(uri.path)).findings.map(toDiagnostic));
    } catch (e) { /* unreadable: keep what is shown */ }
  }));

  vscode.workspace.textDocuments.forEach(refresh);

  /* ----------------------------------------------------------- quick fixes */

  // Lock and build files that decide which cache value is right. Root-level names and any-depth names.
  async function projectFiles(doc) {
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) return [];
    const key = folder.uri.toString();
    const hit = filesCache.get(key);
    if (hit && Date.now() - hit.at < 10000) return hit.files;
    const exclude = "**/{node_modules,.git,.venv,venv}/**";
    let files = [];
    try {
      const found = await Promise.all([
        vscode.workspace.findFiles(new vscode.RelativePattern(folder,
          "{package-lock.json,npm-shrinkwrap.json,yarn.lock,pnpm-lock.yaml,.yarnrc.yml,packages.lock.json,Gemfile}"), exclude, 50),
        vscode.workspace.findFiles(new vscode.RelativePattern(folder,
          "**/{requirements.txt,poetry.lock,Pipfile.lock,pom.xml,build.gradle,build.gradle.kts,build.sbt}"), exclude, 200)
      ]);
      found.forEach(function (list) {
        list.forEach(function (u) {
          const rel = vscode.workspace.asRelativePath(u, false).split("\\").join("/");
          if (files.indexOf(rel) < 0) files.push(rel);
        });
      });
    } catch (e) { files = []; }
    filesCache.set(key, { at: Date.now(), files: files });
    return files;
  }

  const provider = {
    async provideCodeActions(document, range, ctx) {
      if (!isWorkflowDocument(document) || !enabled()) return [];
      const mine = (ctx.diagnostics || []).filter(function (d) {
        return d.source === C.SOURCE && fixes.FIXABLE.indexOf(codeValue(d)) >= 0;
      });
      if (!mine.length) return [];
      const result = analysisFor(document);
      if (!result.ok) return [];
      const text = document.getText();
      const needsFiles = mine.some(function (d) { return codeValue(d) === "setup-without-cache"; });
      const files = needsFiles ? await projectFiles(document) : [];
      const actions = [];
      mine.forEach(function (d) {
        const f = result.findings.find(function (x) { return x.check === codeValue(d) && x.line - 1 === d.range.start.line; });
        if (!f) return;
        if (f.check === "unpinned-third-party-action") {
          const can = fixes.canFix(text, f, {});
          if (!can) return;
          const a = new vscode.CodeAction(can.title, vscode.CodeActionKind.QuickFix);
          a.diagnostics = [d];
          a.command = {
            command: CMD_PIN, title: can.title,
            arguments: [document.uri.toString(), { check: f.check, job: f.job, action: f.action, ref: f.ref, nth: f.nth }]
          };
          actions.push(a);
          return;
        }
        const fix = fixes.computeFixSync(text, f, { files: files });
        if (!fix) return;
        const a = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
        a.diagnostics = [d];
        a.edit = toWorkspaceEdit(document.uri, fix.edits);
        actions.push(a);
      });
      return actions;
    }
  };
  subs.push(vscode.languages.registerCodeActionsProvider([{ pattern: C.WORKFLOW_GLOB }], provider, {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
  }));

  /* ------------------------------------------------------------ GitHub calls */

  const githubFetch = credit.guardedFetch(C.GITHUB_API_ORIGIN);

  async function silentGithubSession() {
    for (const scopes of [["repo"], []]) {
      try {
        const s = await vscode.authentication.getSession("github", scopes, { silent: true });
        if (s && s.accessToken) return s;
      } catch (e) { /* no session: fall through */ }
    }
    return null;
  }

  async function githubGet(url, token) {
    const ctl = new AbortController();
    const timer = setTimeout(function () { ctl.abort(); }, 15000);
    try {
      const headers = { "Accept": "application/vnd.github.sha", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "weio-ci-speed-check-vscode/" + version };
      if (token) headers["Authorization"] = "Bearer " + token;
      const res = await githubFetch(url, { method: "GET", headers: headers, signal: ctl.signal });
      let text = "";
      try { text = await res.text(); } catch (e) { text = ""; }
      return { status: res.status, text: text };
    } finally {
      clearTimeout(timer);
    }
  }

  // The commit SHA that owner/repo@ref points at now. Uses a signed-in GitHub session when one exists already.
  async function resolveSha(owner, repo, ref) {
    const url = C.GITHUB_API_ORIGIN + "/repos/" + owner + "/" + repo + "/commits/" + ref.split("/").map(encodeURIComponent).join("/");
    const session = await silentGithubSession();
    let res;
    try {
      res = await githubGet(url, session && session.accessToken);
      if (res.status === 401 && session) res = await githubGet(url, null);
    } catch (e) {
      throw new Error("could not reach the GitHub API (" + (e && e.name === "AbortError" ? "timed out" : "network error") + ")");
    }
    if (res.status === 200) return res.text.trim();
    if (res.status === 404 || res.status === 422) {
      throw new Error("GitHub has no commit for " + owner + "/" + repo + "@" + ref + " that this account can see (wrong tag, or a private repository: sign in to GitHub in VS Code and try again)");
    }
    if (res.status === 403 || res.status === 429) {
      throw new Error("GitHub rate limit reached; sign in to GitHub in VS Code (Accounts menu) for a higher limit, or try again later");
    }
    throw new Error("GitHub returned HTTP " + res.status);
  }

  subs.push(vscode.commands.registerCommand(CMD_PIN, async function (uriString, ref) {
    try {
      const uri = vscode.Uri.parse(uriString);
      const doc = await vscode.workspace.openTextDocument(uri);
      const startVersion = doc.version;
      const text = doc.getText();
      const finding = analyzeText(text, path.basename(uri.path)).findings.find(function (x) {
        return x.check === ref.check && x.job === ref.job && x.action === ref.action && x.ref === ref.ref && x.nth === ref.nth;
      });
      if (!finding) {
        vscode.window.showWarningMessage("CI Speed Check: the file changed and this finding is gone. Nothing was edited.");
        return;
      }
      let fix;
      try {
        fix = await fixes.computeFix(text, finding, { files: [], resolveSha: resolveSha });
      } catch (e) {
        vscode.window.showErrorMessage("CI Speed Check: could not pin " + finding.action + "@" + finding.ref + ": " + credit.cleanText(e && e.message, 240));
        return;
      }
      if (!fix) {
        vscode.window.showWarningMessage("CI Speed Check: this step is written in a form the quick fix does not edit safely. Pin it by hand: " + finding.action + "@<full commit SHA> # " + finding.ref);
        return;
      }
      if (doc.version !== startVersion) {
        vscode.window.showWarningMessage("CI Speed Check: the file changed while the commit was being looked up. Nothing was edited; run the quick fix again.");
        return;
      }
      await vscode.workspace.applyEdit(toWorkspaceEdit(uri, fix.edits));
    } catch (e) {
      vscode.window.showErrorMessage("CI Speed Check: the quick fix failed (" + credit.cleanText(e && e.message, 160) + ")");
    }
  }));

  /* -------------------------------------------------------- check workspace */

  async function checkWorkspace() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || !folders.length) {
      vscode.window.showInformationMessage("CI Speed Check: open a folder that contains .github/workflows first.");
      return;
    }
    const uris = await vscode.workspace.findFiles(C.WORKFLOW_GLOB, "**/node_modules/**", C.MAX_WORKSPACE_FILES);
    if (!uris.length) {
      vscode.window.showInformationMessage("CI Speed Check: no workflow files found under .github/workflows in this workspace.");
      return;
    }
    let checked = 0, skipped = 0, total = 0, defects = 0;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "CI Speed Check: checking workflows" }, async function () {
      collection.clear();
      for (const uri of uris) {
        const open = openDocument(uri);
        let text = null;
        try { text = open ? open.getText() : await readText(uri); } catch (e) { text = null; }
        const result = text === null ? { ok: false, findings: [] } : analyzeText(text, path.basename(uri.path));
        if (!result.ok) { skipped++; continue; }
        checked++;
        total += result.findings.length;
        defects += result.findings.filter(function (f) { return f.severity === "defect"; }).length;
        collection.set(uri, result.findings.map(toDiagnostic));
      }
    });
    const msg = "CI Speed Check: " + total + (total === 1 ? " finding" : " findings") + " (" + defects + (defects === 1 ? " warning" : " warnings") +
      ") in " + checked + (checked === 1 ? " workflow file" : " workflow files") +
      (skipped ? "; " + skipped + " not checked (YAML did not parse, or the file is over 1 MiB)" : "") + ".";
    const pick = total ? await vscode.window.showInformationMessage(msg, "Show Problems") : await vscode.window.showInformationMessage(msg);
    if (pick === "Show Problems") await vscode.commands.executeCommand("workbench.actions.view.problems");
  }

  /* ----------------------------------------------------------- Weio API key */

  function promptForKey() {
    return new Promise(function (resolve) {
      const box = vscode.window.createInputBox();
      let done = false;
      box.title = "CI Speed Check: Weio API key";
      box.prompt = "Paste your Weio API key (wk_...). $9 buys 1,000 credits; one run-history report uses one credit. Need a key? Use the link button.";
      box.placeholder = "wk_...";
      box.password = true;
      box.ignoreFocusOut = true;
      box.buttons = [{ iconPath: new vscode.ThemeIcon("link-external"), tooltip: BUY }];
      const bad = "Expected wk_ followed by 24 to 64 letters, digits, _ or -";
      box.onDidTriggerButton(function () { vscode.env.openExternal(vscode.Uri.parse(C.BUY_URL)); });
      box.onDidChangeValue(function (v) { box.validationMessage = !v || credit.KEY_RE.test(v.trim()) ? undefined : bad; });
      box.onDidAccept(function () {
        const v = box.value.trim();
        if (!credit.KEY_RE.test(v)) { box.validationMessage = bad; return; }
        done = true;
        resolve(v);
        box.hide();
      });
      box.onDidHide(function () { box.dispose(); if (!done) resolve(undefined); });
      box.show();
    });
  }

  async function setApiKey() {
    const key = await promptForKey();
    if (!key) return false;
    await context.secrets.store(C.SECRET_KEY, key);
    vscode.window.showInformationMessage("CI Speed Check: Weio API key saved in VS Code's secret storage.");
    return true;
  }

  async function clearApiKey() {
    await context.secrets.delete(C.SECRET_KEY);
    vscode.window.showInformationMessage("CI Speed Check: Weio API key removed.");
  }

  /* ------------------------------------------------------- run-history report */

  function pickFolder() {
    const folders = vscode.workspace.workspaceFolders || [];
    const active = vscode.window.activeTextEditor;
    const own = active && active.document ? vscode.workspace.getWorkspaceFolder(active.document.uri) : null;
    return own || folders[0] || null;
  }

  function childUri(base, p) {
    return base.with({ path: path.posix.join(base.path, p) });
  }

  // Text of the repository's .git/config, or null (not a repository, virtual folder, unreadable).
  async function readGitConfig(folder) {
    try {
      const gitUri = childUri(folder.uri, ".git");
      const st = await vscode.workspace.fs.stat(gitUri);
      if (st.type & vscode.FileType.Directory) return decode(await vscode.workspace.fs.readFile(childUri(gitUri, "config")));
      // A worktree or submodule: ".git" is a file that names the real git directory.
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(decode(await vscode.workspace.fs.readFile(gitUri)));
      if (!m) return null;
      const dir = path.posix.isAbsolute(m[1].split("\\").join("/")) || /^[A-Za-z]:[\\/]/.test(m[1])
        ? (folder.uri.scheme === "file" ? vscode.Uri.file(m[1]) : folder.uri.with({ path: m[1] }))
        : childUri(folder.uri, m[1]);
      try { return decode(await vscode.workspace.fs.readFile(childUri(dir, "config"))); } catch (e) { /* worktree: use the common dir */ }
      const common = decode(await vscode.workspace.fs.readFile(childUri(dir, "commondir"))).trim();
      return decode(await vscode.workspace.fs.readFile(childUri(childUri(dir, common), "config")));
    } catch (e) {
      return null;
    }
  }

  async function chooseRepository(folder) {
    let slugs = [];
    if (folder) {
      const text = await readGitConfig(folder);
      if (text) slugs = credit.githubSlugs(credit.parseGitConfig(text));
    }
    if (slugs.length === 1) return slugs[0];
    if (slugs.length > 1) return vscode.window.showQuickPick(slugs, { placeHolder: "Which repository should the run-history report cover?", ignoreFocusOut: true });
    const typed = await vscode.window.showInputBox({
      title: "CI Speed Check: repository",
      prompt: "No github.com remote found in this workspace. Enter the repository as owner/repo.",
      placeHolder: "owner/repo",
      ignoreFocusOut: true,
      validateInput: function (v) { return credit.validSlug(v) ? null : "Use the form owner/repo"; }
    });
    return typed ? typed.trim() : undefined;
  }

  let reportRunning = false;
  async function historyReport() {
    // One report at a time: each one costs a credit, so a double click must not run twice.
    if (reportRunning) {
      vscode.window.showInformationMessage("CI Speed Check: a run-history report is already being made.");
      return;
    }
    reportRunning = true;
    try {
      await runHistoryReport();
    } finally {
      reportRunning = false;
    }
  }

  async function runHistoryReport() {
    // 1. Weio key: from secret storage, else ask.
    let key = await context.secrets.get(C.SECRET_KEY);
    if (key && !credit.KEY_RE.test(key)) { await context.secrets.delete(C.SECRET_KEY); key = undefined; }
    if (!key) {
      key = await promptForKey();
      if (!key) return;
      await context.secrets.store(C.SECRET_KEY, key);
    }
    // 2. Repository.
    const slug = await chooseRepository(pickFolder());
    if (!slug) return;
    const parts = slug.split("/");
    // 3. GitHub sign-in (read access to the repository's Actions runs).
    let session;
    try {
      session = await vscode.authentication.getSession("github", ["repo"], { createIfNone: true });
    } catch (e) {
      vscode.window.showErrorMessage("CI Speed Check: GitHub sign-in was cancelled or failed. No credit was used.");
      return;
    }
    if (!session || !session.accessToken) {
      vscode.window.showErrorMessage("CI Speed Check: no GitHub session. No credit was used.");
      return;
    }
    const token = session.accessToken;
    const weioBase = credit.resolveWeioBase(process.env);
    if (!weioBase) {
      vscode.window.showErrorMessage("CI Speed Check: WEIO_API_BASE must be an https URL on weio.ai (or http on localhost). No credit was used.");
      return;
    }
    const weioFetch = credit.guardedFetch(weioBase);
    const cfg = vscode.workspace.getConfiguration("ciSpeedCheck");
    const state = { used: false, remaining: null };

    try {
      const report = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: "CI Speed Check: reading the run history of " + slug
      }, function () {
        return history.analyze({
          owner: parts[0], repo: parts[1], token: token,
          maxRuns: cfg.get("historyRuns", 100), days: cfg.get("historyDays", 30),
          fetchImpl: githubFetch,
          onFirstPage: async function () {
            // GitHub has granted access and the window holds runs: this is when one credit is used.
            const r = await credit.postCredit({ fetchImpl: weioFetch, base: weioBase, apiKey: key, slug: slug, version: version });
            const out = credit.interpretCredit(r);
            state.used = true;
            state.remaining = out.creditsRemaining;
          }
        });
      });
      const creditLine = state.used
        ? "One Weio credit was used for this report" + (state.remaining !== null ? "; " + state.remaining + " credits remain on this key." : ".")
        : "The run window held no runs, so no credit was used.";
      const md = history.renderMarkdown(report) + "\n" + creditLine + "\n";
      const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: md });
      await vscode.window.showTextDocument(doc, { preview: false });
      try { await vscode.commands.executeCommand("markdown.showPreview", doc.uri); } catch (e) { /* the source is open */ }
    } catch (e) {
      const shown = await describeHistoryError(e, slug, state, [key, token]);
      // Not awaited: an error notification can stay open for a long time and must not keep the busy flag set.
      presentError(shown.text, shown.buttons);
    }
  }

  async function describeHistoryError(e, slug, state, secrets) {
    const used = state.used ? " A credit had already been used." : " No credit was used.";
    let text, buttons = [];
    if (e && e.name === "CreditError") {
      text = "CI Speed Check: " + e.message + "." + (e.kind === "rate-limit" || e.kind === "server" || e.kind === "network" ? " Try again later." : "") + used;
      if (e.kind === "invalid-key") {
        await context.secrets.delete(C.SECRET_KEY);
        text += " The stored key was removed.";
        buttons = [BUY, "Enter a different key"];
      } else if (e.kind === "no-credits") {
        buttons = [BUY];
      }
    } else if (e && e.name === "HistoryError" && e.code === "NO_ACCESS") {
      text = "CI Speed Check: GitHub did not allow this account to read the Actions run history of " + slug + " (HTTP " + e.status +
        "). Check the repository name and that your GitHub account can see it." + used;
    } else if (e && e.name === "HistoryError") {
      text = "CI Speed Check: " + e.message + "." + used;
    } else {
      text = "CI Speed Check: unexpected error (" + credit.cleanText(e && e.message, 160) + ")." + used;
    }
    return { text: credit.redact(text, secrets), buttons: buttons };
  }

  async function presentError(text, buttons) {
    try {
      const pick = await vscode.window.showErrorMessage(text, ...buttons);
      if (pick === BUY) vscode.env.openExternal(vscode.Uri.parse(C.BUY_URL));
      else if (pick === "Enter a different key") await setApiKey();
    } catch (e) { /* the notification went away */ }
  }

  /* ----------------------------------------------------------------- commands */

  subs.push(vscode.commands.registerCommand("ciSpeedCheck.checkWorkspace", checkWorkspace));
  subs.push(vscode.commands.registerCommand("ciSpeedCheck.historyReport", historyReport));
  subs.push(vscode.commands.registerCommand("ciSpeedCheck.setApiKey", setApiKey));
  subs.push(vscode.commands.registerCommand("ciSpeedCheck.clearApiKey", clearApiKey));
}

function deactivate() {}

module.exports = { activate, deactivate };
