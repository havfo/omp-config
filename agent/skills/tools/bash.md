---
name: bash-guidance
type: tool-guidance
target_tool: Bash
priority: 10
token_cost: 560
user-invocable: false
---
Gotchas not stated in the `bash` tool description:

- SUMMARIZED OUTPUT: build/test runners are auto-condensed to a one-line summary plus a
  `[raw output: artifact://N]` pointer. The verbose body (`=== RUN`, `--- PASS/FAIL`, `-v`
  detail) is in the artifact, NOT in the summary. To inspect it, `read` `artifact://N` — do
  NOT re-run with different flags hoping to see more; the summarizer fires every time.
- `go test: 1 packages ok, 2 no tests` means 2 packages had no test FILES (e.g. non-test
  packages). It does NOT mean your tests failed to run or were not found.
- AUTO-BACKGROUND (~60s): the foreground wait is `min(threshold, timeout - 1s)`, so raising
  `timeout` does NOT keep you waiting — it only moves the deadline at which the job is
  killed. A long build returning "backgrounded" is normal and is NOT a failure: keep working
  and collect the result when it arrives. Never re-run it or inflate `timeout` in response.
- NEVER WAIT FOR A BACKGROUND JOB. `Backgrounded as job N; result will be delivered
  automatically` means exactly that: when the job settles you are re-invoked with a
  `<system-notice>` carrying its full output. There is nothing to poll and nothing to
  block on. `sleep`, `wait`, retry loops, and "let me check if it's done yet" calls are all
  wasted turns — the gate blocks a bash call that only waits.
- While a job runs, pick ONE: (a) do the next piece of work that does not depend on the
  result (read the next file, draft the next edit, start an independent job), or (b) if
  everything left depends on it, stop and end your turn with one line saying you are waiting
  for job N. Ending the turn is the CORRECT move — the job's completion wakes you back up,
  and no progress is lost. Do not keep thinking to fill the time.
- PERMISSION GATE (plugin "permission-gate"; settings in /settings → Plugins →
  permission-gate): non-whitelisted bash commands are gated by the `approvalTimeout`
  setting — "30s" prompts the USER (a dialog with the full command; auto-rejects after
  30s or on "No"), "immediate" blocks the call at once with NO prompt, "forever"
  prompts with no timeout. The mode is re-read per call and can change between calls;
  the block reason states which fired (immediate: "blocked without prompting").
  Treat a gate block as "not approved": never wait for a dialog and never re-issue the
  same command to re-trigger a prompt — take the alternative the block reason names.
- BLOCKED by the permission gate: command substitution `$(...)`/backticks, `rm`/`mv`/`cp`,
  `sudo`, `apt`/`brew`, `source`/`export`, interactive editors, and redirects to anything but
  a scratch path (`> /tmp/...` is fine). Delete a file with a hashline `REM` op, rename with
  `MV`, set variables via the `env` argument. If blocked, the error names the alternative —
  take it, don't retry as-is.
- Whitelisted (auto-approved): read-only inspection and build/test/install runners
  (go/cargo/make/pytest/npm/pnpm/yarn/bun). Compiled local binaries are NOT (`./pkg.test` is
  blocked) — run tests via `go test ./pkg/...`.
