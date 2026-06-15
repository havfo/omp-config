---
name: edit-guidance
type: tool-guidance
target_tool: Edit
priority: 10
token_cost: 120
user-invocable: false
---
## edit Tool (hashline, line-anchored)
Default tool for changing an EXISTING file (use `write` only to create a new
file). edit does NOT take old_string/new_string. It takes ONE argument named
`input`: a hashline patch string. The full format is in the edit tool's own
description — this is the workflow that trips models up.

Tool-call shape (note the doubled key — args object has a single `input` field):
```tool
{"name": "edit", "input": {"input": "[gcc.go#0DB3]\nSWAP 39.=39:\n+	decreaseFactor = 0.85\n+	burstDecreaseFactor = 0.95"}}
```

Patch = one or more sections; each starts with `[PATH#TAG]`, then ops:
- `SWAP N.=M:` replace original lines N..M (inclusive) with the `+` body rows
- `INS.PRE N:` / `INS.POST N:` insert body rows before/after line N
- `DEL N.=M` delete lines N..M (no body)
- body rows are `+TEXT` (literal; `+` alone = blank line). Never `-old` or bare lines.
- the file PATH is inside the `[PATH#TAG]` header — there is no separate path arg.

THE TAG (the usual point of confusion):
- `TAG` is a 4-hex hash of the file (e.g. `0DB3`) from your most recent
  `read`/`search` header `[PATH#TAG]`, OR from the previous edit's response.
  Every applied edit mints a NEW tag.
- To refresh it, just re-`read` the lines: `{"name":"read","input":{"path":"gcc.go:29-67"}}`.
  Do NOT append the tag to the read path — `gcc.go:29:0DB3` is wrong; the read
  selector is `path:LINE-RANGE` only.
- N/M are ORIGINAL line numbers from that read; they don't shift as hunks apply.
- On a "stale tag" / "anchor rejected" result: STOP, re-`read` those exact lines, edit again.

RULES:
- Touch only lines the latest read showed as `LINE:TEXT`; cover ONLY changed lines.
- Pure additions use INS.*, never a widened SWAP.
- Never reformat with edit; run the project formatter instead.

COMMON MISTAKES — do not make these:
1. DELETE vs REPLACE. To REPLACE lines, use `SWAP N.=M:` with `+body`. `DEL` has
   NO colon and NO body — `DEL 8.=10` (delete only). If you have replacement
   content, it is a SWAP, never a `DEL ...:` with `+` rows.
2. ONE hunk per line. Two hunks in the same patch must not touch or overlap the
   same line ("anchor line X already targeted by another hunk"). Merge them into
   a single `SWAP` that covers the whole contiguous range you're changing.
3. ONLY anchor lines you have READ. If you didn't just see line N as `LINE:TEXT`
   in the current snapshot (a partial range or collapsed `…` hides it), `read`
   that exact range FIRST, then edit against the fresh tag. Never guess line numbers.
4. Prefer ONE edit call per file: read the full region, then issue all hunks for
   that file in a single patch (ascending, non-overlapping ranges).
