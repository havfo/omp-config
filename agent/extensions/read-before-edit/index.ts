import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { isFileReadTool, isFileWriteTool, isShellTool, pathArgOf, specOf } from "../_shared/taxonomy.ts";

// Block Edit when the target file hasn't been Read this session.
// Local models routinely emit Edit with guessed old_string and burn turns
// on "string not found" errors. Forcing a Read first matches Claude harness
// behavior and gives the model the actual current content.
//
// Write is intentionally NOT gated here — `write` legitimately creates new
// files, so requiring a prior Read would block first-time file creation.
// Overwrites are rare for this model (the skills steer it to Edit/hashline).
//
// This extension also reconciles a truncated edit-header PATH (see
// reconcileHeaderPath): the hashline edit carries its path inside the
// `[PATH#TAG]` header, and the model sometimes drops the directory
// (`[binding.go#665A]` instead of `[pkg/aether/binding.go#665A]`) → "file not
// found", a wasted turn. When the basename AND the 4-hex tag uniquely match a
// file read this session, we rewrite the header to the real path. The tag
// match makes a wrong rewrite practically impossible.

const readPaths = new Set<string>();
// Latest snapshot tag + the path string the model used, per absolute path.
// Fed by read AND edit results so reconciliation keys off the current tag.
const fileTags = new Map<string, { tag: string; display: string }>();

function stripSelector(p: string): string {
  return p.replace(/:[0-9,\-]+$/, "").replace(/#[0-9A-Fa-f]{4}$/, "");
}

function normalize(p: unknown): string | undefined {
  if (typeof p !== "string" || !p) return undefined;
  let resolved = stripSelector(p);
  if (resolved === "~") resolved = homedir();
  else if (resolved.startsWith("~/")) resolved = homedir() + resolved.slice(1);
  return resolve(resolved);
}

export function buildReadFirstRecipe(filePath: string): string {
  return (
    `Error: Edit refused — ${filePath} has not been Read in this session.\n` +
    `\n` +
    `edit uses the hashline patch format and anchors every hunk on the 4-hex ` +
    `[PATH#TAG] snapshot tag from your latest read. Without a current read you ` +
    `have no valid tag and the patch will be rejected.\n` +
    `\n` +
    `Recipe:\n` +
    `  1. {"name":"read","input":{"path":"${filePath}"}}  → gives [${filePath}#TAG] and LINE:TEXT rows\n` +
    `  2. build a hashline patch anchored on that tag, e.g.\n` +
    `     {"name":"edit","input":{"input":"[${filePath}#TAG]\\nSWAP N.=M:\\n+<new line>"}}\n` +
    `  (the file path goes inside the [PATH#TAG] header; edit has no separate path arg)`
  );
}

// Files the model viewed via a shell read (cat/head/tail/...) count as Read —
// otherwise an Edit after `cat file` is wrongly blocked. Best-effort token scan.
const SHELL_READ_RE = /\b(?:cat|head|tail|less|more|nl|bat|sed -n)\b([^|&;<>\n]*)/g;
function pathsFromShellCommand(cmd: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = SHELL_READ_RE.exec(cmd))) {
    for (const tok of m[1].trim().split(/\s+/)) {
      if (!tok || tok.startsWith("-")) continue; // skip flags
      out.push(tok.replace(/^["']|["']$/g, ""));
    }
  }
  return out;
}

function isShellName(name: unknown): boolean {
  return isShellTool(name as string) || String(name).toLowerCase() === "shellsession";
}

// First `[PATH#TAG]` header in a read/edit output or an edit patch input. `\[+`
// tolerates a doubled bracket that arg-repair may not have collapsed yet.
const HEADER_RE = /\[+\s*([^\]\n#]*?)\s*#([0-9A-Fa-f]{4})\s*\]/;

export function parseHeader(text: string): { path: string; tag: string } | undefined {
  const m = text.match(HEADER_RE);
  if (!m) return undefined;
  const path = m[1].trim();
  if (!path) return undefined;
  return { path, tag: m[2].toUpperCase() };
}

// Rewrite a truncated edit-header path to a session-read file when the basename
// and tag uniquely identify it. Returns the patched input + the rewrite, or
// null when nothing should change. Pure; `resolves(headerPath)` reports whether
// the header path already points at a real/known file (then we leave it alone).
export function reconcileHeaderPath(
  inputStr: string,
  registry: Map<string, { tag: string; display: string }>,
  resolves: (headerPath: string) => boolean,
): { input: string; from: string; to: string } | null {
  const m = inputStr.match(HEADER_RE);
  if (!m) return null;
  const headerPath = m[1].trim();
  const tag = m[2].toUpperCase();
  if (!headerPath || resolves(headerPath)) return null;
  const base = basename(headerPath);
  const matches = [...registry.entries()].filter(
    ([abs, info]) => basename(abs) === base && info.tag === tag,
  );
  if (matches.length !== 1) return null; // none, or ambiguous → don't guess
  const to = matches[0][1].display;
  if (to === headerPath) return null;
  return { input: inputStr.replace(HEADER_RE, `[${to}#${m[2]}]`), from: headerPath, to };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => { readPaths.clear(); fileTags.clear(); });

  pi.on("tool_result", async (event) => {
    const name = (event as any).toolName;
    if ((event as any).isError) return;

    const recordTag = (rawPath: string | undefined, text: string) => {
      const abs = normalize(rawPath);
      const hdr = parseHeader(text);
      if (abs && hdr) fileTags.set(abs, { tag: hdr.tag, display: stripSelector(rawPath!) });
    };

    const asText = (content: unknown): string =>
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("\n")
          : "";

    // Native file-read tools.
    if (isFileReadTool(name)) {
      const arg = pathArgOf(name);
      if (!arg) return;
      const raw = (event as any).input?.[arg];
      const p = normalize(raw);
      if (p) readPaths.add(p);
      recordTag(raw, asText((event as any).content));
      return;
    }

    // Edit results echo the NEW [PATH#TAG]; record it so a follow-up edit
    // reconciles against the current tag (and the path it just landed on).
    if (specOf(name)?.canonical === "edit") {
      const hdr = parseHeader(asText((event as any).content));
      const abs = normalize(hdr?.path);
      if (abs && hdr) {
        readPaths.add(abs);
        fileTags.set(abs, { tag: hdr.tag, display: hdr.path });
      }
      return;
    }

    // Shell reads — `cat file`, `head -n 20 file`, etc.
    if (isShellName(name)) {
      const cmd = (event as any).input?.command;
      if (typeof cmd !== "string") return;
      for (const raw of pathsFromShellCommand(cmd)) {
        const p = normalize(raw);
        if (p) readPaths.add(p);
      }
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const name = (event as any).toolName;

    // Edit path reconciliation (edit has no pathArg — the path is in the header).
    if (specOf(name)?.canonical === "edit") {
      const input = (event as any).input;
      if (!input || typeof input.input !== "string") return;
      const fixed = reconcileHeaderPath(input.input, fileTags, (hp) => {
        const abs = normalize(hp);
        return !!abs && (readPaths.has(abs) || existsSync(abs));
      });
      if (fixed) {
        input.input = fixed.input;
        try { ctx.ui.notify(`read-before-edit: edit header path ${fixed.from} → ${fixed.to}`, "info"); } catch {}
      }
      return;
    }

    if (!isFileWriteTool(name)) return;
    if (name === "write") return; // write may create new files — see header
    const arg = pathArgOf(name);
    if (!arg) return;
    const p = normalize((event as any).input?.[arg]);
    if (!p) return;
    if (readPaths.has(p)) return;
    return {
      block: true,
      reason: buildReadFirstRecipe(p),
    };
  });
}

// exported for tests
export const _state = { readPaths, fileTags };
