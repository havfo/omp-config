import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { isFileReadTool, isFileWriteTool, pathArgOf } from "../_shared/taxonomy.ts";

// Preflight Read/Edit/Write paths. Only block on signals that the path is a
// genuine guess: a syntactic placeholder, or a resolved path that doesn't
// exist (for read/edit). Relative paths are fine — pi resolves them against
// the working directory, so we resolve them the same way instead of blocking.

function looksLikePlaceholder(p: string): boolean {
  // ONLY bracketed placeholders and example-domain tokens. We deliberately do
  // NOT match bare ALL-CAPS words like TODO/FILLME: filenames such as
  // `docs/TODO.md`, `FIXME.txt`, `README` are real and common, and matching
  // them blocked every Read of those files. Genuine placeholders like <TODO>
  // or {TODO} are still caught by the bracket patterns below.
  return /<[A-Z_ ]{2,}>|\{[A-Z_ ]{2,}\}|example\.com|foo\.bar/.test(p);
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

// pi's Read tool accepts a line-range selector appended to the path, e.g.
// `gcc.go:182-376`, `file.ts:1-50,100-120`, `file.go:L10`, `:raw`, `:conflicts`
// (grammar mirrored from pi's tools/path-utils.ts). The selector is NOT part
// of the filename, so we must strip it before existence-checking — otherwise
// every ranged read is blocked as "file does not exist", which is exactly the
// failure mode that sent the model into a retry spiral.
const RANGE_CHUNK = String.raw`L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?`;
const RANGE_LIST = `${RANGE_CHUNK}(?:,${RANGE_CHUNK})*`;
const READ_SELECTOR_TAIL = new RegExp(`:(?:${RANGE_LIST}|raw|conflicts)$`, "i");

// A hashline snapshot tag the model may have appended to a read path:
// `#XXXX` (always a tag) or `:XXXX` where XXXX is 4 hex containing a letter
// (a line range is digits, optionally L-prefixed). Stripped before the
// existence check so a tag-bearing read isn't wrongly blocked as "missing".
function stripHashlineTag(p: string): string {
  const hashForm = p.replace(/#[0-9a-fA-F]{4}$/, "");
  if (hashForm !== p) return hashForm;
  const m = p.match(/^(.*):([0-9a-fA-F]{4})$/);
  if (m && /[a-fA-F]/.test(m[2]) && !/^L/i.test(m[2])) return m[1];
  return p;
}

function stripReadSelector(p: string): string {
  return stripHashlineTag(p).replace(READ_SELECTOR_TAIL, "");
}

// pi's `read` (and `write`) now accept non-filesystem targets: web URLs
// (http(s)://), internal URIs (agent://, vault://, …), sqlite and archive
// references. Those are NOT paths on disk, so tilde-expand / existsSync would
// wrongly flag them as "file does not exist" and block a legitimate read. Any
// `scheme://` value is out of scope for filesystem preflight.
const SCHEME_URI = /^[a-z][a-z0-9+.-]*:\/\//i;

export function evaluatePath(
  toolName: string,
  raw: string,
  cwd: string = process.cwd(),
): { ok: true } | { ok: false; reason: string } {
  if (SCHEME_URI.test(raw)) return { ok: true };
  if (looksLikePlaceholder(raw)) {
    return { ok: false, reason:
      `Path looks like a placeholder, not a real file: "${raw}". ` +
      `Replace it with an actual path. Use Glob to discover real paths if you don't know them.` };
  }
  // Resolve like pi does: tilde, strip the Read line-range selector, then
  // resolve relative-to-cwd. A relative path is a valid path, not an error.
  let p = expandTilde(raw);
  if (isFileReadTool(toolName)) p = stripReadSelector(p);
  if (!isAbsolute(p)) p = resolve(cwd, p);

  const lname = toolName.toLowerCase();
  if (isFileReadTool(toolName) || (isFileWriteTool(toolName) && (lname === "edit" || lname === "ast_edit"))) {
    if (!existsSync(p)) {
      const base = raw.split("/").pop() ?? raw;
      return { ok: false, reason:
        `File does not exist: "${raw}"${raw === p ? "" : ` (resolved to ${p})`}. ` +
        `Use Glob to find the real path: {"name":"Glob","input":{"pattern":"**/${stripReadSelector(base)}"}}.` };
    }
  }
  return { ok: true };
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const name = (event as any).toolName;
    if (!name) return;
    if (!isFileReadTool(name) && !isFileWriteTool(name)) return;
    const arg = pathArgOf(name);
    if (!arg) return;
    // Don't depend on arg-repair having run first: if the model used an alias
    // (file_path/filepath) and it hasn't been normalized to the canonical key
    // yet, fall back to the common spellings so preflight still fires.
    const input = (event as any).input ?? {};
    const p = input[arg] ?? input.file_path ?? input.path ?? input.filepath;
    if (typeof p !== "string" || !p) return;
    // Resolve relative paths against pi's working directory, not the
    // extension host's, so `docs/TODO.md` is checked where pi will read it.
    const cwd = (ctx as any)?.cwd ?? process.cwd();
    const verdict = evaluatePath(name, p, cwd);
    if (!verdict.ok) return { block: true, reason: verdict.reason };
  });
}
