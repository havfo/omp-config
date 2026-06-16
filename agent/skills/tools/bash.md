---
name: bash-guidance
type: tool-guidance
target_tool: Bash
priority: 10
token_cost: 145
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

EXAMPLES:
```tool
{"name": "Bash", "input": {"command": "cd /repo && go test ./..."}}
{"name": "Bash", "input": {"command": "pip install requests", "timeout": 120}}
```
