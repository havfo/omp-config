---
name: write-guidance
type: tool-guidance
target_tool: Write
priority: 10
token_cost: 310
user-invocable: false
---
## Write Tool
Create a file, or OVERWRITE an existing one with `content` in full. Creates parent
directories automatically.

REQUIRED: path, content (the complete file content)

**Write replaces the whole file — it does not warn you.** So:
- Creating from scratch → Write.
- ANY change to an existing file (fix, refactor, add a function, rename) → Edit.
  Edit is a line-anchored hashline patch (see the edit guidance); it patches in place,
  so you never retype the whole file when iterating after a failed test, and you can't
  lose lines you never read.
- Write over an existing file ONLY for a full rewrite of a short file, or a major
  restructure where a patch would be larger than the file.
- Never Write a file you have not read — you would silently discard its contents.

Also writes archive entries (`archive.zip:path/inside`) and SQLite rows
(`db.sqlite:table` insert, `db.sqlite:table:key` update with JSON / delete with empty
content).

Never create documentation files (*.md, README) unless explicitly asked.

EXAMPLE:
```tool
{"name": "Write", "input": {"path": "/tmp/example/new_module.py", "content": "def hello():\n    return 'hi'\n"}}
```
Always use the EXACT path from the task, never a placeholder.
