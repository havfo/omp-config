// Shared tool taxonomy used by arg-repair, tool-error-coach, path-preflight,
// and read-before-edit.
//
// IMPORTANT: canonical arg names match omp's actual tool schemas as exposed
// by @oh-my-pi/pi-coding-agent — NOT Claude's conventions.
//
// Tool surface (verified against omp 17.4.0's own schemas, 2026-08-21): the
// built-in content search tool is `grep` (regex) and file-name lookup is
// `glob`. These were RENAMED from `search`/`find` in v16.2.x (2026-06-27) —
// settings migrated automatically, this taxonomy did not, which silently
// disabled every extension keyed on them until 2026-08-19. Directory listing
// is folded into `read` (there is NO `ls` tool), and web search is the
// built-in `web_search` (underscore). Web fetch is folded into `read`(URL).
// Structural edit/search are `ast_edit` / `ast_grep`.
// Keep this list in lockstep with what omp actually registers: `specOf`
// returning undefined makes arg-repair / path-preflight / read-before-edit
// silently skip a tool.
//
// omp's `edit` is a HASHLINE patch tool (see the `edit` spec below) — it does
// NOT take old_string/new_string. The skill files in skills/tools/*.md teach
// the hashline format directly. omp's native `write` is `{path, content}`.

export type ToolFamily =
  | "file-read"
  | "file-write"
  | "shell"
  | "search"
  | "browser"
  | "web"
  | "agent";

export interface ToolSpec {
  canonical: string;          // lowercase pi name
  display: string;            // TitleCase prose name
  family: ToolFamily;
  pathArg?: string;           // arg holding a path, if any
  // Common alternate arg-name spellings the model may emit. Each maps to
  // the canonical name pi's `execute` actually destructures. Keys are
  // matched case-insensitively.
  argAliases?: Record<string, string>;
  knownArgs: string[];        // for opt-in unknown-key dropping
}

export const TOOLS: ToolSpec[] = [
  // omp native read({path}) — `path` is the ONLY arg. `offset`/`limit` were
  // removed; line ranges are selectors appended to the path ("foo.ts:50-200",
  // ":50+150", ":raw", ":conflicts"). Aliasing a stray offset/limit onto a
  // selector is NOT attempted — we let omp reject them so the model re-reads
  // with a selector rather than silently getting a different range.
  { canonical: "read",  display: "Read",  family: "file-read",
    pathArg: "path",
    argAliases: { file_path: "path", filepath: "path", filename: "path" },
    knownArgs: ["path"] },

  // pi native edit: a HASHLINE patch tool. Its only argument is `input` (the
  // patch string; `_input` is accepted and normalized to `input`). There is NO
  // path arg — the file path lives inside each section's `[PATH#TAG]` header,
  // and the 4-hex TAG comes from the latest read/edit. It does NOT take
  // old_string/new_string/edits. (Because there's no path arg, read-before-edit
  // and path-preflight can't key off it — that's fine: the tag already forces a
  // prior read. See skills/tools/edit.md for the format taught to the model.)
  { canonical: "edit",  display: "Edit",  family: "file-write",
    argAliases: { _input: "input", patch: "input", diff: "input", patchText: "input" },
    knownArgs: ["input"] },

  // omp native write({path, content}).
  { canonical: "write", display: "Write", family: "file-write",
    pathArg: "path",
    argAliases: { file_path: "path", filepath: "path", filename: "path", text: "content", body: "content" },
    knownArgs: ["path", "content"] },

  // omp native bash({command, env?, timeout?, cwd?, pty?, async?}). The shell
  // is PERSISTENT and `cwd` is a real arg — omp's own guidance is to set `cwd`
  // rather than `cd`. There is no `description` and no `run_in_background`
  // (those are Claude's); background execution is `async`.
  { canonical: "bash",  display: "Bash",  family: "shell",
    argAliases: { cmd: "command", script: "command",
                  run_in_background: "async", background: "async",
                  working_directory: "cwd", workdir: "cwd", dir: "cwd" },
    knownArgs: ["command", "env", "timeout", "cwd", "pty", "async"] },

  // omp native glob({path?, hidden?, gitignore?, limit?}) — file-name/path
  // discovery. NOTE there is NO `pattern` arg: the glob itself goes in `path`,
  // and multiple targets are SEMICOLON-delimited in that one string
  // ("src/**/*.ts;lib/") — never a JSON array. Omitted `path` defaults to ".".
  { canonical: "glob",  display: "Glob",  family: "search",
    pathArg: "path",
    argAliases: { pattern: "path", glob: "path", globs: "path", paths: "path",
                  dir: "path", directory: "path", file_path: "path" },
    knownArgs: ["path", "hidden", "gitignore", "limit"] },

  // omp native grep({pattern, path?, case?, gitignore?, skip?}) — regex content
  // search. `pattern` is a REGEX (required). `path` is the scope and is a
  // SEMICOLON-delimited STRING ("internal/bwe/**;cmd/"), NOT an array — local
  // models routinely send a JSON array or a stringified one, which the tool
  // then reads as a single broken glob; arg-repair joins those back into one
  // `;` string. `case` means CASE-SENSITIVE and defaults to true — it replaced
  // the old `i` (ignore-case) flag with INVERTED semantics, so arg-repair
  // negates a stray `i`/`ignore_case` rather than aliasing it straight across.
  { canonical: "grep", display: "Grep", family: "search",
    pathArg: "path",
    argAliases: { glob: "path", globs: "path", paths: "path",
                  dir: "path", directory: "path", file_path: "path",
                  regex: "pattern", query: "pattern" },
    knownArgs: ["pattern", "path", "case", "gitignore", "skip"] },

  // omp native ast_grep({pat, path?, skip?}) — structural code search (the
  // read-only sibling of ast_edit). The pattern arg is `pat`, NOT `pattern`,
  // and it is an ast-grep pattern, not a glob. There is no `lang` arg — the
  // language is inferred from each file's extension.
  { canonical: "ast_grep", display: "AstGrep", family: "search",
    pathArg: "path",
    argAliases: { dir: "path", directory: "path", file_path: "path",
                  pattern: "pat", query: "pat", regex: "pat" },
    knownArgs: ["pat", "path", "skip"] },

  // omp native web_search({query, recency?, limit?, max_tokens?, temperature?,
  // num_search_results?}) — the built-in web search (underscore form). There
  // are no allowed_domains/blocked_domains filters.
  { canonical: "web_search", display: "WebSearch", family: "web",
    argAliases: { q: "query", search: "query", text: "query" },
    knownArgs: ["query", "recency", "limit", "max_tokens", "temperature",
                "num_search_results"] },

  // omp native ast_edit({ops:[{pat,out}], paths:[...]}) — structural codemod
  // that WRITES files. Unlike every other tool here its scope arg is `paths`
  // and it genuinely IS a string ARRAY (not a `;`-joined string), and there is
  // no singular `path`, so `pathArg` is deliberately unset: path-preflight and
  // read-before-edit cannot key off a single target and skip it. Still classed
  // file-write so write-side gates (syntax-guard, checkpoints) see it.
  { canonical: "ast_edit", display: "AstEdit", family: "file-write",
    argAliases: { rewrites: "ops", edits: "ops", files: "paths" },
    knownArgs: ["ops", "paths"] },
];

const byCanon = new Map(TOOLS.map((t) => [t.canonical.toLowerCase(), t]));
const byDisplay = new Map(TOOLS.map((t) => [t.display.toLowerCase(), t]));

export function specOf(toolName: string): ToolSpec | undefined {
  if (!toolName) return undefined;
  const k = toolName.toLowerCase();
  return byCanon.get(k) ?? byDisplay.get(k);
}

export function isFileWriteTool(toolName: string): boolean {
  return specOf(toolName)?.family === "file-write";
}
export function isFileReadTool(toolName: string): boolean {
  return specOf(toolName)?.family === "file-read";
}
export function isSearchTool(toolName: string): boolean {
  return specOf(toolName)?.family === "search";
}
export function isShellTool(toolName: string): boolean {
  return specOf(toolName)?.family === "shell";
}

export function pathArgOf(toolName: string): string | undefined {
  return specOf(toolName)?.pathArg;
}

export function groupByFamily(names: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const n of names) {
    const fam = specOf(n)?.family ?? "other";
    (out[fam] ??= []).push(n);
  }
  return out;
}
