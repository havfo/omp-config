---
name: bash-guidance
type: tool-guidance
target_tool: Bash
priority: 10
token_cost: 270
user-invocable: false
---
## Bash Tool
Run a shell command; returns combined stdout+stderr.

REQUIRED: command    OPTIONAL: timeout (seconds; use 120-300 for installs/builds)

RULES:
- Stateless: `cd` does not persist. Use absolute paths or chain `cd /path && make`.
- Whitelisted (auto-approved): read-only inspection (ls, cat, find, grep/rg, git status/log,
  go doc/list/env), and build/test/install runners (go/cargo/make/pytest/npm/pnpm/yarn/bun).
- BLOCKED: command substitution `$(...)`/backticks; redirects to anything but a scratch path
  (`> /tmp/...` is fine); system package managers (apt/brew). To write a file use Write/Edit,
  not `>`. If blocked, the error lists the allowed alternatives — pick one, don't retry as-is.
- Prefer the Read/Glob/Search tools over `cat`/`find`/`grep` when you just need file content.
- SUMMARIZED OUTPUT: build/test runners get auto-condensed to a one-line summary plus a
  `[raw output: artifact://N]` pointer — the verbose body (`=== RUN`, `--- PASS/FAIL`, `-v`
  detail) is in the artifact, NOT in the summary. `go test: 1 packages ok, 2 no tests` means
  2 packages had no test FILES (e.g. non-test packages); it does NOT mean your tests failed to
  run or were not found. To inspect full results, `Read` the artifact (`{"path":"artifact://N"}`)
  — do NOT re-run with different flags hoping to see more; the summarizer fires every time.
- Compiled local binaries are NOT whitelisted (`./pkg.test` is blocked). Run tests via
  `go test ./pkg/...`, not the built test binary.

EXAMPLES:
```tool
{"name": "Bash", "input": {"command": "cd /repo && go test ./..."}}
{"name": "Bash", "input": {"command": "pip install requests", "timeout": 120}}
```
