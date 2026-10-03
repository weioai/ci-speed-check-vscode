# CI Speed Check for GitHub Actions

Finds what makes your GitHub Actions workflows slower, costlier or riskier than they need to be, while you edit them, and fixes most of it in one click.

The checks and quick fixes are free. The checks run entirely inside VS Code; only the pin-to-SHA quick fix asks api.github.com for a commit. An optional Pro command adds a measured report from your repository's run history.

## Features

- **Checks as you type.** Every file in `.github/workflows/` (`.yml` and `.yaml`) is checked when you open it, 300 ms after you stop typing, and when you save. Defects show as warnings and observations as information, in the editor and in the Problems panel. The problem code links to the explanation of that check on this page.
- **Quick fixes.** Press the lightbulb, or `Ctrl+.` (`Cmd+.` on macOS), on a finding to apply the fix.
- **Whole workspace.** Run `CI Speed Check: Check workflows in this workspace` to check every workflow file, open or not.
- **Run-history report (Pro).** Optional. Measured minutes from your repository's real runs: superseded runs, slowest jobs and steps, queue time, failures. Needs a Weio API key.
- **Private by default.** The free checks read the workflow text in memory and make no network requests.

If a workflow file is not valid YAML, CI Speed Check says nothing about it. YAML language tools report syntax errors; this extension only reports what the file says about speed, cost and safety.

## The five checks

Deterministic rules, the same engine as the [CI Speed Check GitHub Action](https://github.com/weioai/ci-speed-check) and Weio's [free web check](https://automation.weio.ai/ci-check.html). No model is involved, so the same file gives the same findings every time.

| Check | Shown as | What it flags | Quick fix |
| --- | --- | --- | --- |
| `no-concurrency-cancel` | Warning | A workflow triggered by `push` or `pull_request` with no top-level `concurrency` group, so runs for superseded commits keep running. | Yes |
| `setup-without-cache` | Warning | `actions/setup-node`, `setup-python`, `setup-java`, `setup-go`, `setup-dotnet` or `ruby/setup-ruby` without their cache input, so dependencies are downloaded every run. | Yes, when the right value can be told from your files |
| `full-history-checkout` | Information | `actions/checkout` with `fetch-depth: 0`. Reported, not condemned: release tooling often needs full history. | No |
| `no-job-timeout` | Warning | A job with no `timeout-minutes` (jobs that call a reusable workflow are skipped). A hang costs the 360-minute default. | Yes |
| `unpinned-third-party-action` | Warning | A step using a non-`actions/` action at a tag or branch instead of a full 40-character commit SHA. | Yes |

Slowness findings (`no-concurrency-cancel`, `setup-without-cache`, `full-history-checkout`) explain slow pipelines. Hygiene (`no-job-timeout`) and security (`unpinned-third-party-action`) findings are real but are not why a pipeline is slow.

### `no-concurrency-cancel`

Without a concurrency group, pushing a new commit to a pull request leaves the runs for the older commits going. On private repositories and self-hosted runners that costs runner minutes or machine time; public repositories on standard GitHub-hosted runners are free.

Quick fix: adds this block right after the `on:` section.

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

This cancels superseded pull request runs. A run for a push that is already in progress is never cancelled. GitHub still keeps only the newest pending run per group, so if several pushes queue behind a running one, the older queued runs are skipped. A deploy workflow may need a different group or none at all: check before you keep it.

### `setup-without-cache`

Quick fix: adds the cache input to the setup step (extending its `with:` mapping, or adding one). The value comes from the files in your workspace, and the fix is skipped, not guessed, whenever a wrong value would make the setup step fail.

| Action | Value | Needs |
| --- | --- | --- |
| `actions/setup-node` | `npm`, `yarn` or `pnpm` | Exactly one of `package-lock.json` (or `npm-shrinkwrap.json`), `yarn.lock`, `pnpm-lock.yaml` at the repository root. For pnpm, an earlier step in the same job must set up pnpm or Corepack. For Yarn Berry (`.yarnrc.yml`), an earlier step must run `corepack`. |
| `actions/setup-python` | `pip`, `poetry` or `pipenv` | Exactly one of `requirements.txt`, `poetry.lock`, `Pipfile.lock` in the workspace. For poetry and pipenv, an earlier step in the same job must install the tool. |
| `actions/setup-java` | `maven`, `gradle` or `sbt` | Exactly one of `pom.xml`, `build.gradle` or `build.gradle.kts`, `build.sbt` in the workspace. |
| `actions/setup-go` | `true` | Nothing. |
| `actions/setup-dotnet` | `true` | `packages.lock.json` at the repository root; the action fails without it. |
| `ruby/setup-ruby` | `bundler-cache: true` | A `Gemfile` at the repository root. |

Where several candidates exist (for example both `yarn.lock` and `package-lock.json`), no fix is offered because the choice is yours. A project that keeps its lock file in a subfolder needs `cache-dependency-path` as well; add that by hand.

### `full-history-checkout`

`fetch-depth: 0` clones the whole history on every run. That is slow on large repositories, and required if anything in the job reads git history (release notes, version tools, some analysers). No quick fix: only you know whether the job needs it. Use `fetch-depth: 1`, the default, when it does not.

### `no-job-timeout`

A job that hangs runs for six hours by default. Quick fix: inserts `timeout-minutes: 30` as the first key of the job, at the job's own indentation. 30 minutes is a ceiling that removes the six-hour risk; lower it to about two to three times the job's normal run time.

### `unpinned-third-party-action`

A tag or branch can be moved by whoever controls the action's repository. Pinning to a full commit SHA fixes the code you run.

Quick fix: asks GitHub for the commit that the tag or branch points to now and rewrites `owner/repo@v2` as `owner/repo@<40-character SHA> # v2`, keeping the tag in a comment. It uses the GitHub account VS Code is already signed in to, if there is one, and an anonymous request otherwise (GitHub's lower anonymous rate limit applies). The edit is made only after the lookup succeeds and only if the file did not change meanwhile. Pinned actions need updating on purpose; tools such as Dependabot can do that for SHA-pinned actions.

### How fixes are kept safe

Each fix is computed as a text edit that keeps your line endings (CRLF or LF) and your indentation. Before it is offered, it is applied to a copy of the file, the copy is parsed again, and the result must equal your workflow plus exactly the one intended change, with the finding gone and no other finding changed. A step written in flow style (`- { uses: ... }`), a job defined through an anchor or alias, or any other layout the fix cannot edit safely gets no quick fix at all, rather than a damaged file.

### Where this differs from the web check

Three deliberate differences, shared with the GitHub Action:

1. A setup step whose cache input is explicitly `false` (`cache: false`, `bundler-cache: false`) is not flagged. That is a decision, not an oversight.
2. `actions/setup-go` at major ref `v4` or later is not flagged, because it caches by default from `v4`.
3. `actions/setup-node` at major ref `v5` or later is shown as information instead of a warning: v5 caches npm automatically only when `package.json` declares `packageManager`, so check that yours does, or set `cache: npm`.

### What it cannot see

A clean result means these five rules found nothing in these files. It does not mean your CI is fast.

- How long your builds and tests take. The free checks read configuration, not runs. The Pro report measures real runs.
- Runner size, flaky tests, cache hit rates, or whether a cache key is any good.
- The inside of reusable workflows and composite actions.
- Whether a job-level reusable workflow reference (`uses:` on a job) is pinned. Only step-level actions are checked.
- Whether your triggers suit your team. A missing concurrency group is a defect for CI, not for a deploy that must finish.

## Pro: run-history report

Run `CI Speed Check: Run-history report (Pro)` from the Command Palette. It reads your repository's recent workflow runs from GitHub and opens a report as a Markdown preview. Minutes only; it never shows a dollar figure.

The report contains:

- **Totals**: runs analysed, completed runs, runner minutes (each job's duration rounded up to a whole minute, the way GitHub bills private repositories) and wall-clock minutes.
- **Superseded runs**: runs that were still running after a newer run of the same workflow, branch and event had started, and the runner minutes they spent after that point, with a per-workflow top 5. Runs already cancelled (concurrency doing its job) are counted separately.
- **Slowest jobs**: runs, median, p90 and total minutes per job, top 10.
- **Slowest steps**: total time per step, top 10.
- **Queue time**: median and p90 wait from job creation to a runner starting it, per runner label set, flagged when p90 is over 2 minutes.
- **Failures and re-runs**: failure rate and minutes spent on failed runs per workflow, and how many runs were re-run.
- **How it was measured**: the sample window, what was and was not counted, and whether the report is partial (it stops early if the GitHub API rate limit runs low).

**The key.** A Weio API key costs $9 for 1,000 credits. It is emailed automatically within minutes of Stripe payment and is valid for 12 months. The same key also works for Weio's site-check API. One Pro run = one credit. [Get a key](https://weio.ai/services/site-check-api.html).

**How it works.**

1. The first time, the command asks for your key and keeps it in VS Code's secret storage (use `CI Speed Check: Set Weio API key` to replace it, `CI Speed Check: Clear Weio API key` to remove it). The input box has a link button that opens the page where keys are sold.
2. The repository comes from the `github.com` remote in the workspace's `.git/config` (https or ssh form). If there is none, or several, you choose or type `owner/repo`.
3. You sign in to GitHub through VS Code's built-in GitHub sign-in. The extension asks for the `repo` scope because GitHub requires it to read the Actions runs of private repositories; the extension only makes read requests.
4. The report opens. The number of runs and days looked at come from the settings below.

**When a credit is used.** After GitHub has granted access to the run list and before any job data is read. If GitHub denies access, or the window holds no runs, no credit is used. If Weio cannot use a credit (invalid key, no credits left, expired key, rate limit, or Weio is unreachable), the extension shows Weio's message, with a Buy a key button when the key is invalid, empty or expired, and no report is made. An invalid key is also removed from secret storage.

## Privacy

- **Free checks and quick fixes**: the workflow text is analysed in memory in VS Code. No network requests, with one exception: the pinning quick fix asks api.github.com for the commit of the action and tag you chose to pin (the action name and tag go in the request URL).
- **Pro report**: your run history is read from the GitHub API with your GitHub token and stays in VS Code (it is shown in an unsaved Markdown document). The only request to weio.ai carries the API key and the `owner/repo` string, to use one credit, plus the usual HTTP metadata such as your IP address and the extension's user-agent. No workflow content, run data, logs or GitHub token are sent to Weio.
- The GitHub token is only ever sent to `api.github.com`. The Weio key is only ever sent to `weio.ai`. Requests to any other address are refused in code. (For testing, the `WEIO_API_BASE` environment variable can point the credit call at a `weio.ai` subdomain or a loopback address; nothing else is accepted.)
- The Weio key is kept in VS Code's secret storage (the operating system's keychain where available), never in settings files. Neither key nor token is logged or written to a file.
- No telemetry, no analytics.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `ciSpeedCheck.enable` | `true` | Check workflow files and show findings. |
| `ciSpeedCheck.historyRuns` | `100` | Pro: how many of the most recent runs to analyse (1 to 300). |
| `ciSpeedCheck.historyDays` | `30` | Pro: how many days back to look (1 to 365). |

## Commands

| Command | What it does |
| --- | --- |
| `CI Speed Check: Check workflows in this workspace` | Checks every `.github/workflows/*.yml` and `*.yaml` file in the workspace. |
| `CI Speed Check: Run-history report (Pro)` | The measured report described above. Uses one credit. |
| `CI Speed Check: Set Weio API key` | Stores or replaces your key in secret storage. |
| `CI Speed Check: Clear Weio API key` | Removes the stored key. |

## Requirements

VS Code 1.85 or later. No runtime dependencies: js-yaml 4.1.1 is bundled (MIT licence included in the package).

## About

Made by Weio, Inc., a small California-based company where AI operators do most of the work and a human owner is accountable for it. This extension, its tests and this page were written by AI operators at Weio.

Questions, bugs and rule suggestions: open an issue on the [GitHub repository](https://github.com/weioai/ci-speed-check-vscode/issues). Sales and keys: sales@weio.ai.

MIT licensed. See `LICENSE`.
