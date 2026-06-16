---
name: edit-guidance
type: tool-guidance
target_tool: Edit
priority: 10
token_cost: 416
user-invocable: false
---
## edit Tool (hashline, line-anchored)
Changes an EXISTING file (`write` only creates new ones). NOT old_string/new_string.
One arg `input`: a hashline patch string (note the doubled key):
```tool
{"name": "edit", "input": {"input": "[gcc.go#0DB3]\nSWAP 39.=39:\n+	decreaseFactor = 0.85"}}
```

Each section starts `[PATH#TAG]` (path lives in the header — no separate path arg), then ops:
- `SWAP N.=M:` replace lines N..M with the `+` body rows
- `INS.PRE N:` / `INS.POST N:` insert body before/after line N
- `DEL N.=M` delete lines N..M (no body)
- body rows are `+TEXT` (literal; `+` alone = blank). Never `-old` or bare lines.

TAG (4-hex file hash, the usual confusion):
- Comes from your latest `read`/`search` header `[PATH#TAG]` or the previous edit's
  response. Every applied edit mints a NEW one and RETURNS it with the changed lines.
- Reuse that returned tag + line numbers for the next edit to the same file. Do NOT
  re-`read` just to refresh the tag — re-reading after every edit is the #1 wasted turn.
- Re-`read` only to see lines you haven't, or after a stale-tag rejection:
  `{"name":"read","input":{"path":"gcc.go:29-67"}}` — selector is `path:LINE-RANGE`
  (`-`, not `.=`); never append the tag (`gcc.go:29:0DB3` is wrong).
- N/M are ORIGINAL line numbers; they don't shift as hunks apply.

RULES & COMMON MISTAKES:
1. Touch only lines the latest read showed as `LINE:TEXT`; cover ONLY changed lines.
   Never guess line numbers — `read` the exact range first if a `…` hid them.
2. REPLACE = `SWAP N.=M:` + `+body`. `DEL` takes NO colon/body (`DEL 8.=10`). Content
   to insert ⇒ it's a SWAP, never `DEL ...:` with `+` rows.
3. ONE hunk per line; hunks must not overlap. Merge touching changes into one `SWAP`.
4. Prefer ONE edit call per file: all hunks in a single patch, ascending, non-overlapping.
5. ONE bracket each side: `[PATH#TAG]`. `[[PATH#TAG]` folds the extra `[` into the path
   → "file not found". Copy the header verbatim; don't re-wrap it.
6. FULL path in the header: `[pkg/aether/foo.go#TAG]`, not just `[foo.go#TAG]`. In
   `search` output the directory is on the `# dir/` line and the file on the
   `## name#TAG` line below it — join them into `[dir/name#TAG]`.
7. Add a single import with `INS.POST` on the last import line — do NOT `SWAP` the
   whole import block (you will drop an existing import → build break).
8. Pure additions use INS.*, never a widened SWAP. Never reformat with edit (run the formatter).
