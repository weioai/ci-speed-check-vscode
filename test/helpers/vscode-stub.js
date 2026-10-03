"use strict";
/* A stand-in for the 'vscode' module, enough for src/extension.js. Tests install it by hooking
 * Module._resolveFilename (see install()) and drive the extension through the recorded state:
 * registered commands, event emitters, messages, edits. reset() clears everything in place, so the same module
 * object can be reused by many activations. */

const Module = require("module");

function emitter() {
  const listeners = [];
  const ev = function (fn) {
    listeners.push(fn);
    return { dispose: function () { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); } };
  };
  ev.fire = function (arg) { listeners.slice().forEach(function (l) { l(arg); }); };
  ev.count = function () { return listeners.length; };
  return ev;
}

class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) { this.start = a; this.end = b; }
    else { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
}
class Uri {
  constructor(scheme, authority, path, fragment) {
    this.scheme = scheme; this.authority = authority || ""; this.path = path || ""; this.fragment = fragment || "";
  }
  static parse(s) {
    const u = new URL(s);
    return new Uri(u.protocol.replace(/:$/, ""), u.host, decodeURIComponent(u.pathname), u.hash.replace(/^#/, ""));
  }
  static file(p) { return new Uri("file", "", p.split("\\").join("/").replace(/^([A-Za-z]:)/, "/$1"), ""); }
  with(c) {
    return new Uri(c.scheme !== undefined ? c.scheme : this.scheme, c.authority !== undefined ? c.authority : this.authority,
      c.path !== undefined ? c.path : this.path, c.fragment !== undefined ? c.fragment : this.fragment);
  }
  get fsPath() { return this.path; }
  toString() { return this.scheme + "://" + this.authority + this.path + (this.fragment ? "#" + this.fragment : ""); }
}
class Diagnostic {
  constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity; }
}
class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
class WorkspaceEdit {
  constructor() { this.entries = []; }
  insert(uri, position, text) { this.entries.push({ type: "insert", uri: uri, position: position, text: text }); }
  replace(uri, range, text) { this.entries.push({ type: "replace", uri: uri, range: range, text: text }); }
}
class ThemeIcon { constructor(id) { this.id = id; } }
class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }

class DiagnosticCollection {
  constructor(name) { this.name = name; this.map = new Map(); this.disposed = false; }
  set(uri, diags) { this.map.set(uri.toString(), diags); }
  get(uri) { return this.map.get(uri.toString()); }
  has(uri) { return this.map.has(uri.toString()); }
  delete(uri) { this.map.delete(uri.toString()); }
  clear() { this.map.clear(); }
  dispose() { this.disposed = true; this.map.clear(); }
}

const vscode = {
  Position, Range, Uri, Diagnostic, CodeAction, WorkspaceEdit, ThemeIcon, RelativePattern,
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  CodeActionKind: { QuickFix: { value: "quickfix" } },
  ProgressLocation: { Notification: 15 },
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  __state: null
};

function makeDocument(uriString, text, version) {
  const doc = {
    uri: Uri.parse(uriString), version: version || 1, languageId: "yaml", _text: text,
    getText() { return this._text; },
    setText(t) { this._text = t; this.version++; }
  };
  return doc;
}

function reset() {
  const state = {
    collections: [], commands: {}, executed: [], messages: [], openedExternal: [], applied: [], providers: [],
    secrets: new Map(), docs: [], untitledOpened: [], shown: [], config: {}, files: new Map(), foundFiles: [],
    folder: null, watchers: [], inputBoxes: [], inputBoxQueue: [], pickQueue: [], quickPickQueue: [],
    sessionCalls: [], sessionImpl: null, onInputBox: null, findCalls: [], findFilesImpl: null
  };
  vscode.__state = state;

  vscode.languages = {
    createDiagnosticCollection(name) { const c = new DiagnosticCollection(name); state.collections.push(c); return c; },
    registerCodeActionsProvider(selector, provider, meta) {
      const p = { selector: selector, provider: provider, meta: meta };
      state.providers.push(p);
      return { dispose() { state.providers.splice(state.providers.indexOf(p), 1); } };
    }
  };

  const ws = {
    textDocuments: state.docs,
    workspaceFolders: undefined,
    onDidOpenTextDocument: emitter(), onDidChangeTextDocument: emitter(), onDidSaveTextDocument: emitter(),
    onDidCloseTextDocument: emitter(), onDidChangeConfiguration: emitter(),
    getConfiguration(section) {
      return { get(key, dflt) { const k = section + "." + key; return k in state.config ? state.config[k] : dflt; } };
    },
    async findFiles(pattern, exclude, max) {
      state.findCalls.push({ pattern: pattern, exclude: exclude, max: max });
      if (state.findFilesImpl) return state.findFilesImpl(pattern, exclude, max);
      return typeof pattern === "string" ? state.foundFiles.slice() : [];
    },
    fs: {
      async readFile(uri) {
        const k = uri.toString();
        if (!state.files.has(k)) throw new Error("ENOENT " + k);
        const v = state.files.get(k);
        return typeof v === "string" ? Buffer.from(v, "utf8") : v;
      },
      async stat(uri) {
        const k = uri.toString();
        if (state.files.has(k)) return { type: vscode.FileType.File };
        if (Array.from(state.files.keys()).some(function (f) { return f.indexOf(k + "/") === 0; })) return { type: vscode.FileType.Directory };
        throw new Error("ENOENT " + k);
      }
    },
    getWorkspaceFolder() { return state.folder; },
    asRelativePath(uri) { return state.folder ? uri.path.slice(state.folder.uri.path.length).replace(/^\//, "") : uri.path; },
    async applyEdit(edit) { state.applied.push(edit); return true; },
    async openTextDocument(arg) {
      if (arg && arg.content !== undefined) {
        const d = { uri: Uri.parse("untitled://untitled/Untitled-" + (state.untitledOpened.length + 1)), languageId: arg.language, _text: arg.content, version: 1, getText() { return this._text; } };
        state.untitledOpened.push(d);
        return d;
      }
      const found = state.docs.find(function (d) { return d.uri.toString() === arg.toString(); });
      if (!found) throw new Error("no such document " + arg.toString());
      return found;
    },
    createFileSystemWatcher(glob) {
      const w = { glob: glob, onDidChange: emitter(), onDidCreate: emitter(), onDidDelete: emitter(), dispose() {} };
      state.watchers.push(w);
      return w;
    }
  };
  vscode.workspace = ws;

  function msg(kind) {
    return async function (text, ...items) {
      state.messages.push({ kind: kind, text: String(text), items: items });
      if (state.hold) return new Promise(function () {});     // a notification that is never dismissed
      return state.pickQueue.length ? state.pickQueue.shift() : undefined;
    };
  }
  vscode.window = {
    activeTextEditor: undefined,
    showInformationMessage: msg("info"), showWarningMessage: msg("warn"), showErrorMessage: msg("error"),
    async showInputBox(opts) { state.messages.push({ kind: "inputBox", text: opts && opts.prompt, opts: opts }); return state.inputBoxQueue.length ? state.inputBoxQueue.shift() : undefined; },
    async showQuickPick(items, opts) { state.messages.push({ kind: "quickPick", items: items, opts: opts }); return state.quickPickQueue.length ? state.quickPickQueue.shift() : undefined; },
    createInputBox() {
      const box = {
        title: "", prompt: "", placeholder: "", password: false, ignoreFocusOut: false, buttons: [], value: "", validationMessage: undefined,
        onDidTriggerButton: emitter(), onDidChangeValue: emitter(), onDidAccept: emitter(), onDidHide: emitter(),
        shown: false, disposed: false,
        show() { this.shown = true; state.inputBoxes.push(this); if (state.onInputBox) Promise.resolve().then(() => state.onInputBox(this)); },
        hide() { this.shown = false; this.onDidHide.fire(); },
        dispose() { this.disposed = true; }
      };
      return box;
    },
    async withProgress(opts, task) { state.messages.push({ kind: "progress", text: opts && opts.title }); return task({ report() {} }); },
    async showTextDocument(doc, opts) { state.shown.push({ doc: doc, opts: opts }); return {}; }
  };

  vscode.commands = {
    registerCommand(id, fn) { state.commands[id] = fn; return { dispose() { delete state.commands[id]; } }; },
    async executeCommand(id, ...args) { state.executed.push({ id: id, args: args }); if (state.commands[id]) return state.commands[id](...args); return undefined; }
  };
  vscode.env = { async openExternal(uri) { state.openedExternal.push(uri.toString()); return true; } };
  vscode.authentication = {
    async getSession(provider, scopes, opts) {
      state.sessionCalls.push({ provider: provider, scopes: scopes, opts: opts });
      if (state.sessionImpl) return state.sessionImpl(provider, scopes, opts);
      return opts && opts.silent ? undefined : { accessToken: "gho_FAKE_GITHUB_TOKEN_0123456789", account: { label: "tester" } };
    }
  };
}

vscode.__reset = reset;
vscode.__makeDocument = makeDocument;
reset();

// Make require("vscode") resolve to this file. Returns a function that undoes it.
function install() {
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request) {
    if (request === "vscode") return __filename;
    return orig.apply(this, arguments);
  };
  return function uninstall() { Module._resolveFilename = orig; };
}

module.exports = vscode;
module.exports.__install = install;
