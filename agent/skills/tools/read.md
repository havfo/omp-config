---
name: read-guidance
type: tool-guidance
target_tool: Read
priority: 10
token_cost: 100
user-invocable: false
---
## Read Tool
Read a file's contents with line numbers.

REQUIRED: file_path
OPTIONAL: limit (max lines), offset (start line, 1-indexed — offset:1 is the first line)

RULES:
- Absolute OR relative paths both work (relative resolves against the working dir).
- To read a line range, the SIMPLEST way is to append `:START-END` to the path —
  e.g. `file.go:182-376`. This is preferred over offset+limit. `:N` reads one line,
  `:1-50,100-120` reads multiple ranges. The selector is ONLY line numbers —
  never append a snapshot tag (`file.go:29:0DB3` is wrong).
- Or use offset+limit for large files (read in chunks of ~200 lines).
- Output format: a header line `[PATH#TAG]` followed by `LINE:TEXT` rows, e.g.
  `[gcc.go#0DB3]` then `29:const (`. The 4-hex `TAG` is the snapshot hash the
  `edit` tool anchors hunks on — copy it from here (or from an edit response).
  Re-read to get a fresh TAG after the file changes; do not guess it.

EXAMPLE (whole file):
```tool
{"name": "Read", "input": {"file_path": "internal/bwe/gcc/gcc.go"}}
```

EXAMPLE (line range — preferred):
```tool
{"name": "Read", "input": {"file_path": "internal/bwe/gcc/gcc.go:182-376"}}
```

EXAMPLE (offset+limit equivalent):
```tool
{"name": "Read", "input": {"file_path": "/abs/path/file.py", "offset": 100, "limit": 50}}
```
