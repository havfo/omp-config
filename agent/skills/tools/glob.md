---
name: glob-guidance
type: tool-guidance
target_tool: Glob
priority: 8
token_cost: 295
user-invocable: false
---
## glob Tool
Find files by name/path. It was named `find` in older omp versions.

REQUIRED: (nothing)
OPTIONAL: path, hidden, gitignore, limit

RULES:
- There is NO `pattern` argument. The glob itself goes in `path`.
- `path` is ONE STRING, never an array. To match several scopes, join them
  with SEMICOLONS: "src/**/*.ts;docs/*.md" — never ["a","b"], never "a,b".
- Omitted or empty `path` defaults to ".".
- Use ** for recursive matching across directories. Brace alternation
  `{a,b}` works inside one glob too.
- `hidden` defaults to true; `gitignore` defaults to true; `limit` defaults to 200.
- Returns a sorted list of matching file paths — use `grep` when the
  selection criterion is file CONTENTS rather than the name.

EXAMPLE:
```tool
{"name": "glob", "input": {"path": "**/*.py"}}
```

EXAMPLE — several scopes in ONE semicolon-joined string:
```tool
{"name": "glob", "input": {"path": "internal/bwe/gcc/**/*.go;internal/bwe/gcchybrid/**/*.go"}}
```

WRONG — do NOT pass an array, and do NOT serialize one into the string:
  {"path": ["internal/bwe/gcc/", "internal/bwe/gcchybrid/"]}
  {"path": "[\"internal/bwe/gcc/\",\"internal/bwe/gcchybrid/\"]"}
