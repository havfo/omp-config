---
name: search-guidance
type: tool-guidance
target_tool: Search
priority: 8
token_cost: 125
user-invocable: false
---
## search Tool
Regex content search across files, directories, globs, and internal URLs.
This is the content-search tool — there is no separate `grep` tool.

REQUIRED: pattern (regex)
OPTIONAL: paths (ARRAY of file/dir/glob scopes, e.g. ["internal/bwe/**","cmd/"]), limit

RULES:
- `pattern` is a regex (full syntax). Do NOT quote or bracket it as if it were a glob.
- `paths` is a real JSON array, not a stringified one: ["a/","b/"] — never "[\"a/\",\"b/\"]".
- Omit `paths` to search the whole working tree.
- Returns matching lines with file path and line number.

EXAMPLE:
```tool
{"name": "search", "input": {"pattern": "func main", "paths": ["cmd/"]}}
```

EXAMPLE whole-tree:
```tool
{"name": "search", "input": {"pattern": "TODO|FIXME"}}
```
