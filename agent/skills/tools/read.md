---
name: read-guidance
type: tool-guidance
target_tool: Read
priority: 10
token_cost: 585
user-invocable: false
---
## Read Tool
Read files, directories, archives, SQLite, documents, and URLs with line numbers.

REQUIRED: path    (that is the ONLY argument — there is no `offset` and no `limit`)

RULES:
- Absolute or relative paths both work (relative resolves against the working dir).
- Line range: append `:SEL` to the path. `file.go:182-376` (inclusive), `:182-` (to
  EOF), `:182+150` (150 lines from 182), `:29` (one line), `:5-16,960-973` (several
  ranges in one call). Selector is line numbers ONLY — never append a snapshot tag
  (`file.go:29:0DB3` is wrong). Chunk large files ~200 lines at a time.
- Other selectors: `:raw` (verbatim, no line prefixes), `:2-4:raw` (range + verbatim),
  `:conflicts` (one line per unresolved merge conflict block).
- Also reads: a directory (dirent listing — there is no `ls` tool), `archive.zip:path/
  inside`, `db.sqlite` / `db.sqlite:table` / `db.sqlite:table:key`, http(s) URLs
  (reader-mode text; `:raw` for the raw HTML), and internal URIs like `artifact://N`.
- Issue independent reads in parallel.
- Output: header `[PATH#TAG]` then `LINE:TEXT` rows (e.g. `[gcc.go#0DB3]`, `29:const (`).
  The 4-hex TAG is what `edit` anchors on. Every applied edit RETURNS a fresh
  `[PATH#TAG]` + changed lines — reuse it; do NOT re-read just to refresh the tag.
  Re-read only for lines you haven't seen, or after a stale-tag rejection. Never guess it.
- FOLDING: a bare-path read of parseable code returns a STRUCTURAL SUMMARY — bodies
  collapse to a signature row `34-49:func foo(...) { .. }` and the footer names the
  ranges that were elided. The `{ .. }` body is HIDDEN, not empty. To see it you MUST
  re-read that span as an explicit range (`file.go:34-49`) — re-reading the BARE PATH
  returns the SAME fold and gains nothing. Re-issue ONLY the ranges you need; never
  guess what `..` or `…` hid. When you need the real code of a whole file (reviewing,
  hunting bugs), read it with a full explicit range (`file.go:1-400`) the FIRST time.

EXAMPLES:
```tool
{"name": "Read", "input": {"path": "internal/bwe/gcc/gcc.go"}}
{"name": "Read", "input": {"path": "internal/bwe/gcc/gcc.go:182-376"}}
{"name": "Read", "input": {"path": "internal/bwe/gcc/gcc.go:1-400"}}
{"name": "Read", "input": {"path": "internal/bwe/gcc/gcc.go:182+150"}}
{"name": "Read", "input": {"path": "artifact://24"}}
```
