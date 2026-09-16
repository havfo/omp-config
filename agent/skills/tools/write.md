---
name: write-guidance
type: tool-guidance
target_tool: Write
priority: 10
token_cost: 145
user-invocable: false
---
Gotchas not stated in the `write` tool description:

- Write REPLACES the whole file and does not warn you. Never Write a file you have not read —
  you would silently discard its contents.
- ANY change to an existing file (fix, refactor, add a function, rename) → `edit`. It patches
  in place, so you never retype the file while iterating on a failing test. Write over an
  existing file ONLY for a full rewrite of a short file, or a restructure larger than the file.
- Parent directories are created automatically.
- Use the EXACT path from the task, never a placeholder.
