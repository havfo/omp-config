import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { isFileWriteTool } from "../_shared/taxonomy.ts";
import { writeToolTargets } from "../_shared/paths.ts";
import { parseSource, getExtension, isSupported } from "./parsers.ts";
import {
  collectErrors,
  diffErrors,
  buildErrorSummary,
  formatDiagnostics,
  type SyntaxDiagnostic,
} from "./diagnostics.ts";
import { submitFollowUp, FollowUpPriority } from "../_shared/followup-bus.ts";

// ── Syntax Guard ────────────────────────────────────────────────────────
//
// Post-edit syntax validation using tree-sitter. After a successful edit
// or write, parse the resulting file and check for newly introduced syntax
// errors. If new errors are found, append a diagnostic to the tool result
// AND steer the model to fix them immediately — re-verified at delivery so a
// correction whose subject is already repaired is dropped instead of sent.
//
// Strategy:
//   - On tool_call (edit): snapshot pre-edit error count
//   - On tool_result (edit/write): re-parse, diff, report new errors
//
// Only runs for file types with available tree-sitter grammars.
// Falls back gracefully (no-op) for unsupported languages.

// Pre-edit snapshots keyed by tool call ID + target path. A single `edit`
// call can carry sections for several files, so the call id alone is not a
// unique key.
const preEditSnapshots = new Map<string, SyntaxDiagnostic[]>();
const snapKey = (callId: string, path: string) => `${callId} ${path}`;

// Limit how many syntax followUps we send per session to avoid annoyance
let syntaxFollowUpsThisSession = 0;
const MAX_FOLLOWUPS_PER_SESSION = 8;

/**
 * Read a file and parse it, returning diagnostics.
 * Returns null if the file can't be read or the language isn't supported.
 */
async function getFileDiagnostics(filePath: string): Promise<SyntaxDiagnostic[] | null> {
  const ext = getExtension(filePath);
  if (!isSupported(ext)) return null;

  let content: string;
  try {
    if (!existsSync(filePath)) return null;
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const result = await parseSource(content, ext);
  if (!result) return null;

  const errors = collectErrors(result.tree);
  // Clean up parser resources
  try {
    result.tree.delete();
    result.parser.delete();
  } catch {}

  return errors;
}

/**
 * True while at least one flagged file still parses worse than it did before
 * the edit. Used to drop a queued correction whose subject has been fixed in
 * the meantime.
 */
async function stillRegressed(baselines: Map<string, number>): Promise<boolean> {
  for (const [filePath, before] of baselines) {
    const now = await getFileDiagnostics(filePath);
    if (now !== null && now.length > before) return true;
  }
  return false;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    preEditSnapshots.clear();
    syntaxFollowUpsThisSession = 0;
  });

  // ── Pre-edit snapshot ───────────────────────────────────────────────
  // Capture the file's current syntax error state before the edit is applied.
  pi.on("tool_call", async (event) => {
    const name = (event as any).toolName;
    if (!isFileWriteTool(name)) return;

    const input = (event as any).input ?? {};
    const toolCallId = (event as any).toolCallId ?? (event as any).id;
    if (typeof toolCallId !== "string" || !toolCallId) return;

    // `edit` names its targets inside the hashline patch, `ast_edit` in a
    // `paths` array — neither has a `path` argument to key off.
    for (const filePath of writeToolTargets(name, input)) {
      // Only snapshot for supported languages
      const ext = getExtension(filePath);
      if (!isSupported(ext)) continue;

      // For write (new file), there are no pre-existing errors
      if (name?.toLowerCase() === "write") {
        preEditSnapshots.set(snapKey(toolCallId, filePath), []);
        continue;
      }

      // For edit, capture current errors
      const diags = await getFileDiagnostics(filePath);
      if (diags !== null) {
        preEditSnapshots.set(snapKey(toolCallId, filePath), diags);
      }
    }
  });

  // ── Post-edit validation ────────────────────────────────────────────
  // After a successful edit/write, re-parse and check for new errors.
  pi.on("tool_result", async (event, ctx) => {
    // Only check successful results
    if ((event as any).isError) return;

    const name = (event as any).toolName;
    if (!isFileWriteTool(name)) return;

    const input = (event as any).input ?? {};
    const toolCallId = (event as any).toolCallId ?? (event as any).id;

    const summaries: string[] = [];
    const followUpSections: string[] = [];
    // path → error count the file had BEFORE this edit, so the queued message
    // can re-check on delivery whether the regression is still there.
    const baselines = new Map<string, number>();
    let totalNewErrors = 0;
    let lastPath = "";

    for (const filePath of writeToolTargets(name, input)) {
      const key = typeof toolCallId === "string" && toolCallId
        ? snapKey(toolCallId, filePath)
        : undefined;

      // Check if we have a pre-edit snapshot
      const beforeErrors = key ? preEditSnapshots.get(key) : undefined;
      if (key) preEditSnapshots.delete(key);

      // Parse the file after the edit. An `MV` source is gone by now, which
      // reads as unparseable and is correctly skipped.
      const afterErrors = await getFileDiagnostics(filePath);
      if (afterErrors === null) continue; // unsupported or unreadable

      // No errors at all — great, nothing to do
      if (afterErrors.length === 0) continue;

      // Without a pre-edit snapshot there is no way to tell this call's damage
      // from errors the file already carried (an `MV` destination, a file this
      // session never edited before). Reporting them all blamed the current
      // edit for someone else's breakage, so stay quiet instead.
      if (beforeErrors === undefined) continue;

      const newErrors = diffErrors(beforeErrors, afterErrors);
      if (newErrors.length === 0) continue;

      summaries.push(buildErrorSummary(filePath, newErrors, afterErrors.length));
      followUpSections.push(
        `${filePath} — ${newErrors.length} syntax error(s):\n` + formatDiagnostics(newErrors),
      );
      baselines.set(filePath, beforeErrors.length);
      totalNewErrors += newErrors.length;
      lastPath = filePath;
    }

    if (totalNewErrors === 0) return;

    // Notify in the UI
    const where = summaries.length === 1 ? lastPath : `${summaries.length} files`;
    try {
      ctx.ui.notify(
        `syntax-guard: ${totalNewErrors} new syntax error(s) in ${where}`,
        "warning",
      );
    } catch {}

    // Nudge the model to fix the file. Delivered as a `steer` — a `followUp`
    // is only drained once the agent loop goes idle, which in a long
    // autonomous run landed these hours after the edit, long after the model
    // had already fixed the file, and cost it a full re-read + tsc detour.
    // Re-parse on delivery too: even a steer can arrive after the repair.
    if (syntaxFollowUpsThisSession < MAX_FOLLOWUPS_PER_SESSION) {
      syntaxFollowUpsThisSession++;
      submitFollowUp(
        pi, "syntax-guard", FollowUpPriority.SYNTAX_ERROR,
        `Your last ${name} introduced ${totalNewErrors} syntax error(s):\n` +
        followUpSections.join("\n") + "\n\n" +
        "Please fix these syntax errors now before making further changes.",
        "steer",
        () => stillRegressed(baselines),
      );
    }

    // Append warning to the tool result content so the model sees it inline
    const existingContent = (event as any).content;
    if (Array.isArray(existingContent)) {
      return {
        content: [
          ...existingContent,
          { type: "text" as const, text: summaries.join("\n\n") },
        ],
        isError: false,
      };
    }
  });
}
