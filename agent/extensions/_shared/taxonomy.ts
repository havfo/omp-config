// Shared tool taxonomy used by arg-repair, tool-error-coach, path-preflight,
// and read-before-edit.
//
// IMPORTANT: canonical arg names match omp's actual tool schemas as exposed
// by @mariozechner/pi-coding-agent — NOT Claude's conventions.
//
// Tool surface (verified against the oh-my-pi source, can1357/oh-my-pi): the
// built-in content search tool is `search` (regex; there is NO `grep` tool),
// file-name lookup is `find`, directory listing is folded into `read` (there
// is NO `ls` tool), and web search is the built-in `web_search` (underscore).
// Web fetch is the built-in `fetch`/`read`(URL); there is no `webfetch`/`glob`/
// `websearch` tool. Structural edit/search are `ast_edit` / `ast_grep`.
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
  // pi native: read({path, offset?, limit?})
  { canonical: "read",  display: "Read",  family: "file-read",
    pathArg: "path",
    argAliases: { file_path: "path", filepath: "path", filename: "path" },
    knownArgs: ["path", "offset", "limit"] },

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

  { canonical: "bash",  display: "Bash",  family: "shell",
    argAliases: { cmd: "command", script: "command" },
    knownArgs: ["command", "description", "timeout", "run_in_background"] },

  // pi native: find({pattern, path?, limit?})
  { canonical: "find",  display: "Find",  family: "search",
    pathArg: "path",
    argAliases: { dir: "path", directory: "path", file_path: "path" },
    knownArgs: ["pattern", "path", "limit"] },

  // omp native search({pattern, paths?, limit?}) — regex content search (this is
  // the tool the model means when it says "grep"). `pattern` is a REGEX; `paths`
  // is an ARRAY of glob/path scopes. Local models routinely send `paths` as a
  // JSON-stringified array ('["a/","b/"]'), which the tool then splits on commas
  // into broken globs ('["a/') → "unclosed character class". arg-repair parses
  // that back into a real array. No single pathArg (it's plural).
  { canonical: "search", display: "Search", family: "search",
    argAliases: { glob: "paths", globs: "paths", path: "paths",
                  regex: "pattern", query: "pattern" },
    knownArgs: ["pattern", "paths", "limit"] },

  // pi native ast_grep({pattern, path?, lang?}) — structural code search (the
  // read-only sibling of ast_edit). pattern is an ast-grep pattern, not a glob.
  { canonical: "ast_grep", display: "AstGrep", family: "search",
    pathArg: "path",
    argAliases: { dir: "path", directory: "path", file_path: "path",
                  language: "lang" },
    knownArgs: ["pattern", "path", "lang"] },

  // omp native web_search({query}) — the built-in web search (underscore form).
  { canonical: "web_search", display: "WebSearch", family: "web",
    argAliases: { q: "query", search: "query", text: "query" },
    knownArgs: ["query", "allowed_domains", "blocked_domains"] },

  // pi native ast_edit({path, pattern, rewrite, lang?}) — structural codemod
  // that WRITES files (preview-staged). Classed file-write so read-before-edit
  // requires a prior Read and path-preflight checks the target exists, same as
  // a plain edit. (There is no `ls` tool — directory listing is part of `read`.)
  { canonical: "ast_edit", display: "AstEdit", family: "file-write",
    pathArg: "path",
    argAliases: { file_path: "path", filepath: "path", language: "lang" },
    knownArgs: ["path", "pattern", "rewrite", "lang"] },
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
