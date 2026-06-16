---
name: read-guidance
type: tool-guidance
target_tool: Read
priority: 10
token_cost: 280
user-invocable: false
---
## Read Tool
Read a file's contents with line numbers.

REQUIRED: path    OPTIONAL: limit (max lines), offset (1-indexed start line)

RULES:
- Absolute or relative paths both work (relative resolves against the working dir).
- Line range: append `:START-END` to the path — `file.go:182-376` (preferred over
  offset+limit). `:N` reads one line, `:1-50,100-120` multiple ranges. Selector is
  line numbers ONLY — never append a snapshot tag (`file.go:29:0DB3` is wrong).
- Or offset+limit for large files (~200-line chunks).
- Output: header `[PATH#TAG]` then `LINE:TEXT` rows (e.g. `[gcc.go#0DB3]`, `29:const (`).
  The 4-hex TAG is what `edit` anchors on. Every applied edit RETURNS a fresh
  `[PATH#TAG]` + changed lines — reuse it; do NOT re-read just to refresh the tag.
  Re-read only for lines you haven't seen, or after a stale-tag rejection. Never guess it.
- FOLDING: a bare-path read of a large file returns a FOLDED OUTLINE — function/struct
  bodies collapse to a signature row `34-49:func foo(...) { .. }` and the footer reads
  `[N lines elided; re-read needed ranges, e.g. file.go:3-7,34-49]`. The `{ .. }` body is
  HIDDEN, not empty. To see a hidden body you MUST re-read that span as an explicit line
  range (`file.go:34-49`) — re-reading the BARE PATH returns the SAME fold and gains nothing.
  When you need the real code of a whole file (reviewing, hunting bugs), read it with a full
  explicit range (`file.go:1-400`) or offset+limit chunks the FIRST time — don't read the bare
  path and then re-read it expanded.

EXAMPLES:
```tool
{"name": "Read", "input": {"path": "internal/bwe/gcc/gcc.go"}}
{"name": "Read", "input": {"path": "internal/bwe/gcc/gcc.go:182-376"}}
{"name": "Read", "input": {"path": "internal/bwe/gcc/gcc.go:1-400"}}
{"name": "Read", "input": {"path": "artifact://24"}}
{"name": "Read", "input": {"path": "/abs/path/file.py", "offset": 100, "limit": 50}}
```
