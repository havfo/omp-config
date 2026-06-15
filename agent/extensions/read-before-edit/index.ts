import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isFileReadTool, isFileWriteTool, isShellTool, pathArgOf } from "../_shared/taxonomy.ts";

// Block Edit when the target file hasn't been Read this session.
// Local models routinely emit Edit with guessed old_string and burn turns
// on "string not found" errors. Forcing a Read first matches Claude harness
// behavior and gives the model the actual current content.
//
// Write is intentionally NOT gated here — `write` legitimately creates new
// files, so requiring a prior Read would block first-time file creation.
// Overwrites are rare for this model (the skills steer it to Edit/hashline).

const readPaths = new Set<string>();

function normalize(p: unknown): string | undefined {
  if (typeof p !== "string" || !p) return undefined;
  let resolved = p;
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

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => { readPaths.clear(); });

  pi.on("tool_result", async (event) => {
    const name = (event as any).toolName;
    if ((event as any).isError) return;

    // Native file-read tools.
    if (isFileReadTool(name)) {
      const arg = pathArgOf(name);
      if (!arg) return;
      const p = normalize((event as any).input?.[arg]);
      if (p) readPaths.add(p);
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

  pi.on("tool_call", async (event) => {
    const name = (event as any).toolName;
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
export const _state = { readPaths };
