---
name: read-guidance
type: tool-guidance
target_tool: Read
priority: 10
token_cost: 220
user-invocable: false
---
Gotchas not stated in the `read` tool description:

- `path` is the ONLY argument. There is no `offset` and no `limit`.
- A bare-path read of parseable code FOLDS: `34-49:func foo(...) { .. }` means the body is
  HIDDEN, not empty. Re-reading the BARE PATH returns the SAME fold and gains nothing — you
  must re-issue that span as an explicit range (`file.go:34-49`).
- When you need the real code of a whole file (review, bug hunt), read a full explicit range
  (`file.go:1-400`) the FIRST time, instead of bare-then-again.
- The selector is line numbers only. Never append a tag — `gcc.go:29:0DB3` is wrong,
  `gcc.go:29` is right.
- Every applied `edit` RETURNS a fresh `[PATH#TAG]` with the changed lines. Reuse it.
  Re-reading a file only to refresh the tag is the #1 wasted turn. Re-read solely for lines
  you have not seen, or after a stale-tag rejection.
