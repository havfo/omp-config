---
name: bash-guidance
type: tool-guidance
target_tool: Bash
priority: 10
token_cost: 740
user-invocable: false
---
## Bash Tool
Run a shell command in a persistent shell; returns combined stdout+stderr.

REQUIRED: command
OPTIONAL: cwd (working directory), env ({NAME: "value"}), timeout (SECONDS; sets the
job DEADLINE only — 0 disables it), pty (true only for terminal interaction like
`sudo`/`ssh`), async (true defers a finite command's result)

Use it for ONE binary or a short pipeline that computes a fact (`wc -l`,
`sort | uniq -c`, `diff`). Not for inline scripts, heredocs, or control flow.

RULES:
- Set `cwd` instead of `cd`. Pass multiline or quote-heavy values via `env`, not
  inline quoting. Order-dependent steps go in ONE call joined with `&&`; independent
  calls can run in parallel.
- NEVER use shell `grep`/`rg` — use the `grep` tool. NEVER use `ls`/`find` — list
  directories with `read`, discover paths with `glob`.
- Avoid `head`, `tail`, and redirection: output is already captured, truncated, and
  linked as `artifact://<id>`. No truncation footer means you have the full output.
- Whitelisted (auto-approved): read-only inspection (git status/log, go doc/list/env)
  and build/test/install runners (go/cargo/make/pytest/npm/pnpm/yarn/bun).
- BLOCKED: command substitution `$(...)`/backticks; redirects to anything but a scratch
  path (`> /tmp/...` is fine); system package managers (apt/brew); rm/mv/cp; sudo;
  interactive editors. To write a file use Write/Edit, not `>`. If blocked, the error
  lists the allowed alternatives — pick one, don't retry as-is.
- SUMMARIZED OUTPUT: build/test runners get auto-condensed to a one-line summary plus a
  `[raw output: artifact://N]` pointer — the verbose body (`=== RUN`, `--- PASS/FAIL`,
  `-v` detail) is in the artifact, NOT in the summary. `go test: 1 packages ok, 2 no
  tests` means 2 packages had no test FILES (e.g. non-test packages); it does NOT mean
  your tests failed to run or were not found. To inspect full results, `read` the
  artifact (`{"path":"artifact://N"}`) — do NOT re-run with different flags hoping to
  see more; the summarizer fires every time.
- Compiled local binaries are NOT whitelisted (`./pkg.test` is blocked). Run tests via
  `go test ./pkg/...`, not the built test binary.
- AUTO-BACKGROUND (60s): a call still running after ~60s is moved to the background and
  its result is DELIVERED LATER. Raising `timeout` does NOT keep you waiting in the
  foreground — it only moves the deadline at which the job is killed. So a long build
  returning "backgrounded" is normal and is NOT a failure: keep working, and collect the
  result when it arrives instead of re-running the command or inflating `timeout`.
- Services, watchers, debuggers, and REPLs (dev servers, `--watch`, `tail -f`, gdb) MUST
  use the `hub` tool (`op:"start"`), never a bash background `&` or `nohup`.

EXAMPLES:
```tool
{"name": "Bash", "input": {"command": "go test ./...", "cwd": "/repo"}}
{"name": "Bash", "input": {"command": "pip install requests", "timeout": 120}}
```
