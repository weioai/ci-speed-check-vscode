"use strict";
/* Shared constants. Pure: no vscode import. */

// Where a Weio API key is sold. Single source of truth in code; the README repeats it (a test keeps them equal).
const BUY_URL = "https://weio.ai/services/site-check-api.html";

const REPO_URL = "https://github.com/weioai/ci-speed-check-vscode";
const DEFAULT_WEIO_BASE = "https://weio.ai";
const GITHUB_API_ORIGIN = "https://api.github.com";

const SOURCE = "CI Speed Check";
const SECRET_KEY = "ciSpeedCheck.weioApiKey";

// Weio API key format: wk_ followed by 24 to 64 letters, digits, _ or -.
const KEY_RE = /^wk_[A-Za-z0-9_-]{24,64}$/;

// Workflow files the extension checks: .github/workflows/<name>.yml|yaml.
const WORKFLOW_PATH_RE = /[\\/]\.github[\\/]workflows[\\/][^\\/]+\.ya?ml$/;
const WORKFLOW_GLOB = "**/.github/workflows/*.{yml,yaml}";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_WORKSPACE_FILES = 500;
const DEBOUNCE_MS = 300;
const CREDIT_TIMEOUT_MS = 15000;

module.exports = {
  BUY_URL, REPO_URL, DEFAULT_WEIO_BASE, GITHUB_API_ORIGIN, SOURCE, SECRET_KEY, KEY_RE,
  WORKFLOW_PATH_RE, WORKFLOW_GLOB, MAX_FILE_BYTES, MAX_WORKSPACE_FILES, DEBOUNCE_MS, CREDIT_TIMEOUT_MS
};
