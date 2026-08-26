---
name: grep-guidance
type: tool-guidance
target_tool: Grep
priority: 8
token_cost: 365
user-invocable: false
---
## grep Tool
Regex content search across files, directories, globs, and internal URLs.
This is the content-search tool. It was named `search` in older omp versions.

REQUIRED: pattern (regex)
OPTIONAL: path, case, gitignore, skip

RULES:
- `pattern` is a regex (full syntax). Do NOT quote or bracket it as if it were a glob.
- `path` is ONE STRING, never an array. To search several scopes, join them
  with SEMICOLONS: "internal/bwe/**;cmd/" — never ["a/","b/"], never "a/,b/".
- Omit `path` to search the whole working tree (it defaults to ".").
- `case` means CASE-SENSITIVE and defaults to true. There is no `i` flag;
  to search case-insensitively pass `case: false`.
- `path` also accepts a single-file line selector, e.g. "src/foo.ts:50-100".
- A literal `\n` in the pattern enables cross-line matching.
- Returns matching lines with file path and line number, newest file first, capped at
  20 files. If you hit that cap, paginate with `skip` (files to skip) — don't re-run
  the same search hoping for more.
- Broad searches can time out — narrow the scope, or use `glob` first.

EXAMPLE:
```tool
{"name": "grep", "input": {"pattern": "func main", "path": "cmd/"}}
```

EXAMPLE — several scopes in ONE semicolon-joined string:
```tool
{"name": "grep", "input": {"pattern": "NewSender", "path": "internal/bwe/**;cmd/"}}
```

EXAMPLE whole-tree, case-insensitive:
```tool
{"name": "grep", "input": {"pattern": "TODO|FIXME", "case": false}}
```
