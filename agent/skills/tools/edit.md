---
name: edit-guidance
type: tool-guidance
target_tool: Edit
priority: 10
token_cost: 910
user-invocable: false
---
## edit Tool (hashline, line-anchored)
Changes an EXISTING file (`write` creates new ones). NOT old_string/new_string.
One arg `input`: a hashline patch string (note the doubled key):
```tool
{"name": "edit", "input": {"input": "[gcc.go#0DB3]\nPUT 39.=39:\n+	decreaseFactor = 0.85"}}
```

Each section starts `[PATH#TAG]` (path lives in the header — no separate path arg), then ops.
Ops ending in `:` take `+` body rows; the colonless ones take NONE.
- `PUT N.=M:` replace original lines N..M with the body
- `PUT N*:` replace the syntactic BLOCK opening at line N (closer resolved for you)
- `PUT <N:` insert body BEFORE line N (`PUT <1:` = file head)
- `PUT >N:` insert body AFTER line N (`PUT >$:` = file tail)
- `PUT >N*:` insert after block N's end, at sibling depth
- `CUT N.=M` / `CUT N*` delete lines N..M / block N (no colon, no body)
- `REM` delete the section's file. `MV DEST` move/rename it.
- Registers (move code): `CUT 5.=9 @fn` captures, `PUT >40 @fn` pastes. Register
  pastes are BODYLESS. `@name` is required on `PUT N.=M @name` / `PUT N* @name`.
- Body rows are `+TEXT` (literal; `+` alone = blank). Never `-old`, never bare
  context lines. A literal leading `-`/`+` doubles up: `- item` → `+- item`.

TAG (4-hex file hash, the usual confusion):
- Comes from your latest `read`/`grep` header `[PATH#TAG]` or the previous edit's
  response. Every applied edit mints a NEW one and RETURNS it with the changed lines.
- Reuse that returned tag + line numbers for the next edit to the same file. Do NOT
  re-`read` just to refresh the tag — re-reading after every edit is the #1 wasted turn.
- Re-`read` only to see lines you haven't, or after a stale-tag rejection:
  `{"name":"read","input":{"path":"gcc.go:29-67"}}` — selector is `path:LINE-RANGE`
  (`-`, not `.=`); never append the tag (`gcc.go:29:0DB3` is wrong).
- N/M are ORIGINAL line numbers; they don't shift as hunks apply.

RULES & COMMON MISTAKES:
1. Touch only lines the latest read showed as `LINE:TEXT`; cover ONLY changed lines.
   Never guess line numbers, and never hunk into or across an elision (`…`, `..`, a
   collapsed `N-M:` row) — `read` that range first.
2. REPLACE = `PUT N.=M:` + `+body`. DELETE = `CUT N.=M`, no colon and no body.
   Content to insert ⇒ it's a `PUT`, never a `CUT` with `+` rows. An empty `PUT` is
   not a delete.
3. Range = the original lines you are TOUCHING; body length is irrelevant. Don't size
   `N.=M` to the new content, and never widen a range over lines you keep.
4. ONE hunk per line; hunks must not overlap. Non-adjacent changes = separate hunks.
5. Prefer ONE edit call per file: all hunks in a single patch, ascending, non-overlapping.
6. ONE bracket each side: `[PATH#TAG]`. `[[PATH#TAG]` folds the extra `[` into the path
   → "file not found". Copy the header verbatim; don't re-wrap it.
7. FULL path in the header: `[pkg/aether/foo.go#TAG]`, not just `[foo.go#TAG]`. In
   `grep` output the directory is on the `# dir/` line and the file on the
   `## name#TAG` line below it — join them into `[dir/name#TAG]`.
8. Add a single import with `PUT >` on the last import line — do NOT `PUT` over the
   whole import block (you will drop an existing import → build break).
9. Pure additions use `PUT <N:` / `PUT >N:`, never a widened `PUT N.=M:`.
10. Block ops anchor on the OPENING line of a construct, never the closer or a bare
    inner statement. Decorators/attributes/doc-comments are separate nodes: point N at
    the first decorator to include it. To append after a closer, use plain `PUT >M:`.
11. Never reformat or fix indentation with edit — run the project formatter once.
