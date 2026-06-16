---
name: write-guidance
type: tool-guidance
target_tool: Write
priority: 10
token_cost: 150
user-invocable: false
---
## Write Tool
Create a **new** file. Creates parent directories automatically.

REQUIRED: path (absolute), content (full file content)

**New files only.** If the path exists, Write is REFUSED with an error telling you to
use Edit — do not retry Write on it, it will be refused again.

- Creating from scratch → Write.
- ANY change to an existing file (fix, refactor, add a function, rename, reformat) → Edit.
  Edit is a line-anchored hashline patch (see the edit guidance); it patches in place, so
  you never retype the whole file when iterating after a failed test.
- A full rewrite of an existing file: use Edit with a `SWAP` over the whole range.

EXAMPLE:
```tool
{"name": "Write", "input": {"path": "/tmp/example/new_module.py", "content": "def hello():\n    return 'hi'\n"}}
```
Always use the EXACT path from the task, never a placeholder.
