import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { isFileWriteTool, pathArgOf } from "../_shared/taxonomy.ts";
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
// AND queue a followUp message so the model can fix them immediately.
//
// Strategy:
//   - On tool_call (edit): snapshot pre-edit error count
//   - On tool_result (edit/write): re-parse, diff, report new errors
//
// Only runs for file types with available tree-sitter grammars.
// Falls back gracefully (no-op) for unsupported languages.

// Pre-edit snapshots keyed by tool call ID
const preEditSnapshots = new Map<string, SyntaxDiagnostic[]>();

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
    const filePath = input.path ?? input.file_path;
    const toolCallId = (event as any).toolCallId ?? (event as any).id;

    if (typeof filePath !== "string" || !filePath) return;
    if (typeof toolCallId !== "string" || !toolCallId) return;

    // Only snapshot for supported languages
    const ext = getExtension(filePath);
    if (!isSupported(ext)) return;

    // For write (new file), there are no pre-existing errors
    if (name?.toLowerCase() === "write") {
      preEditSnapshots.set(toolCallId, []);
      return;
    }

    // For edit, capture current errors
    const diags = await getFileDiagnostics(filePath);
    if (diags !== null) {
      preEditSnapshots.set(toolCallId, diags);
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
    const filePath = input.path ?? input.file_path;
    const toolCallId = (event as any).toolCallId ?? (event as any).id;

    if (typeof filePath !== "string" || !filePath) return;

    // Check if we have a pre-edit snapshot
    const beforeErrors = toolCallId ? preEditSnapshots.get(toolCallId) : undefined;
    if (toolCallId) preEditSnapshots.delete(toolCallId);

    // Parse the file after the edit
    const afterErrors = await getFileDiagnostics(filePath);
    if (afterErrors === null) return; // unsupported or unreadable

    // No errors at all — great, nothing to do
    if (afterErrors.length === 0) return;

    // If we have a pre-edit snapshot, only report NEW errors
    let newErrors: SyntaxDiagnostic[];
    if (beforeErrors !== undefined) {
      newErrors = diffErrors(beforeErrors, afterErrors);
    } else {
      // No snapshot — report all errors (conservative)
      // But only if there are many (>3), to avoid noise on files that already had errors
      if (afterErrors.length <= 3) return;
      newErrors = afterErrors;
    }

    if (newErrors.length === 0) return;

    // Build the warning message
    const summary = buildErrorSummary(filePath, newErrors, afterErrors.length);

    // Notify in the UI
    try {
      ctx.ui.notify(
        `syntax-guard: ${newErrors.length} new syntax error(s) in ${filePath}`,
        "warning",
      );
    } catch {}

    // Send a followUp so the model is prompted to fix errors on its next turn
    if (syntaxFollowUpsThisSession < MAX_FOLLOWUPS_PER_SESSION) {
      syntaxFollowUpsThisSession++;
      const diagnosticList = formatDiagnostics(newErrors);
      submitFollowUp(
        pi, "syntax-guard", FollowUpPriority.SYNTAX_ERROR,
        `Your last edit to ${filePath} introduced ${newErrors.length} syntax error(s):\n` +
        diagnosticList + "\n\n" +
        "Please fix these syntax errors now before making further changes.",
        "followUp",
      );
    }

    // Append warning to the tool result content so the model sees it inline
    const existingContent = (event as any).content;
    if (Array.isArray(existingContent)) {
      return {
        content: [
          ...existingContent,
          { type: "text" as const, text: summary },
        ],
        isError: false,
      };
    }
  });
}
