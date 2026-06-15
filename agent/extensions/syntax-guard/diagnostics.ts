// Diagnostics extraction — walks a tree-sitter AST looking for ERROR
// and MISSING nodes, extracts their positions and surrounding context,
// and formats them into compact, actionable diagnostic messages.

export interface SyntaxDiagnostic {
  /** 1-indexed line number */
  line: number;
  /** 0-indexed column */
  column: number;
  /** Type of error node */
  type: "ERROR" | "MISSING";
  /** Short description */
  message: string;
  /** The text of the error node (capped) */
  text: string;
}

/**
 * Walk the tree-sitter tree and collect all ERROR and MISSING nodes.
 */
export function collectErrors(tree: any): SyntaxDiagnostic[] {
  const errors: SyntaxDiagnostic[] = [];
  const MAX_ERRORS = 20; // cap to avoid overwhelming the model

  function walk(node: any): void {
    if (errors.length >= MAX_ERRORS) return;

    if (node.type === "ERROR") {
      const text = node.text?.slice(0, 80) ?? "";
      errors.push({
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        type: "ERROR",
        message: `Syntax error`,
        text,
      });
    } else if (node.isMissing) {
      errors.push({
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        type: "MISSING",
        message: `Missing ${node.type}`,
        text: "",
      });
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      if (errors.length >= MAX_ERRORS) break;
      walk(node.child(i));
    }
  }

  walk(tree.rootNode);
  return errors;
}

/**
 * Format diagnostics into a compact string for the model.
 * Each diagnostic is one line: `L{line}:{col} {type}: {message} [{text}]`
 */
export function formatDiagnostics(diags: SyntaxDiagnostic[]): string {
  if (diags.length === 0) return "";
  const lines = diags.map((d) => {
    const loc = `L${d.line}:${d.column}`;
    const text = d.text ? ` [${d.text}]` : "";
    return `  ${loc} ${d.type}: ${d.message}${text}`;
  });
  return lines.join("\n");
}

/**
 * Compute which errors are NEW compared to a previous set.
 * An error is "new" if there's no matching error at the same line+col+type
 * in the previous set.
 */
export function diffErrors(
  before: SyntaxDiagnostic[],
  after: SyntaxDiagnostic[],
): SyntaxDiagnostic[] {
  // Build a set of "before" fingerprints
  const beforeSet = new Set(
    before.map((d) => `${d.line}:${d.column}:${d.type}`),
  );
  // Return only errors in "after" that aren't in "before"
  // But since line numbers shift after edits, use a simpler heuristic:
  // if after has MORE errors than before, the extras are new
  if (after.length <= before.length) return [];

  // Find errors in 'after' that don't have a matching type+message in 'before'
  const beforeMessages = new Map<string, number>();
  for (const d of before) {
    const key = `${d.type}:${d.message}`;
    beforeMessages.set(key, (beforeMessages.get(key) ?? 0) + 1);
  }

  const newErrors: SyntaxDiagnostic[] = [];
  const usedBefore = new Map<string, number>();

  for (const d of after) {
    const key = `${d.type}:${d.message}`;
    const availBefore = (beforeMessages.get(key) ?? 0) - (usedBefore.get(key) ?? 0);
    if (availBefore > 0) {
      // This error existed before — consume one match
      usedBefore.set(key, (usedBefore.get(key) ?? 0) + 1);
    } else {
      // This is a new error
      newErrors.push(d);
    }
  }

  return newErrors;
}

/**
 * Build a human-readable summary of newly introduced syntax errors.
 */
export function buildErrorSummary(
  filePath: string,
  newErrors: SyntaxDiagnostic[],
  totalAfter: number,
): string {
  if (newErrors.length === 0) return "";

  const diagnosticList = formatDiagnostics(newErrors);
  const plural = newErrors.length === 1 ? "error" : "errors";
  const totalNote = totalAfter > newErrors.length
    ? ` (${totalAfter} total in file)`
    : "";

  return (
    `\n\n⚠ SYNTAX WARNING: This edit introduced ${newErrors.length} new syntax ${plural}${totalNote} in ${filePath}:\n` +
    diagnosticList + "\n" +
    `\nPlease review and fix these syntax errors before proceeding. ` +
    `Common causes: missing closing bracket/brace/paren, unterminated string, or duplicated lines.`
  );
}
