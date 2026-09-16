---
name: glob-guidance
type: tool-guidance
target_tool: Glob
priority: 8
token_cost: 90
user-invocable: false
---
Gotchas not stated in the `glob` tool description:

- There is NO `pattern` argument. The glob itself goes in `path`.
- `path` is ONE STRING, never an array. Several scopes join with SEMICOLONS:
  `"src/**/*.ts;docs/*.md"` — never `["a","b"]`, never `"a,b"`.
- `limit` defaults to 200.
- Selecting by file CONTENTS rather than name is `grep`, not glob.
