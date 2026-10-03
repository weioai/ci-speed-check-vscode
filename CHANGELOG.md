# Changelog

## 1.0.0

Initial release.

- Checks `.github/workflows/*.yml` and `*.yaml` on open, as you type (after a 300 ms pause) and on save. Defects show as warnings, observations as information, in the editor and the Problems panel.
- The five checks of the CI Speed Check GitHub Action: `no-concurrency-cancel`, `setup-without-cache`, `full-history-checkout`, `no-job-timeout`, `unpinned-third-party-action`. Same rules, shared code.
- Quick fixes for `no-job-timeout`, `no-concurrency-cancel`, `setup-without-cache` and `unpinned-third-party-action`. A fix is offered only if applying it to a copy gives a workflow that parses and equals the original plus the one intended change.
- Command "CI Speed Check: Check workflows in this workspace".
- Optional Pro command "CI Speed Check: Run-history report (Pro)" with a Weio API key (one credit per report), plus "Set Weio API key" and "Clear Weio API key".
- Settings `ciSpeedCheck.enable`, `ciSpeedCheck.historyRuns`, `ciSpeedCheck.historyDays`.
- Pro report: runner minutes, jobs, steps, queue time and failures include earlier attempts of re-run workflows; a run's end time and superseded waste use its latest attempt. The superseded figure is described as at most what a `cancel-in-progress` group would cancel.
- Pro report: names from GitHub are escaped so they cannot become links or emphasis in the report.
- Bundles js-yaml 4.1.1 (fixes CVE-2025-64718, prototype pollution through a merge key).
