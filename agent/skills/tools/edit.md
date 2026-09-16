---
name: edit-guidance
type: tool-guidance
target_tool: Edit
priority: 10
token_cost: 250
user-invocable: false
---
Gotchas not stated in the hashline patch language description:

- The arg shape is a DOUBLED key — the patch string goes in `input.input`, and the path lives
  in the section header, not in a separate argument:
  `{"name": "edit", "input": {"input": "[gcc.go#0DB3]\nPUT 39.=39:\n+\tdecreaseFactor = 0.85"}}`
- ONE bracket each side: `[PATH#TAG]`. A doubled `[[PATH#TAG]` folds the extra `[` into the
  path and fails as "file not found". Copy the header verbatim; don't re-wrap it.
- FULL path in the header: `[pkg/aether/foo.go#TAG]`, not `[foo.go#TAG]`. In `grep` output the
  directory is on the `# dir/` line and the file on the `## name#TAG` line below it — join
  them into `[dir/name#TAG]`.
- The edit response already carries the new tag and line numbers. Do NOT re-`read` the file
  after a successful edit just to refresh them.
- Add a single import with `PUT >` on the last import line — do NOT `PUT` over the whole
  import block; you will drop an existing import and break the build.
