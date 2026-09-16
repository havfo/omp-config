---
name: grep-guidance
type: tool-guidance
target_tool: Grep
priority: 8
token_cost: 145
user-invocable: false
---
Gotchas not stated in the `grep` tool description:

- `path` is ONE STRING, never an array. To search several scopes, join them with SEMICOLONS:
  `"internal/bwe/**;cmd/"` — never `["a/","b/"]`, never a JSON array serialized into a string.
- Omit `path` to search the whole working tree (it defaults to `.`).
- `case` means CASE-SENSITIVE and defaults to true. There is no `i` flag; to search
  case-insensitively pass `case: false`.
- Results are capped at 20 files. If you hit the cap, paginate with `skip` (files to skip) —
  don't re-run the same search hoping for more.
