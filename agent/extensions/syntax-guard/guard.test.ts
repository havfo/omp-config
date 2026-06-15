import { describe, it, expect } from "vitest";
import {
  collectErrors,
  diffErrors,
  formatDiagnostics,
  buildErrorSummary,
  type SyntaxDiagnostic,
} from "./diagnostics.ts";

// ── collectErrors tests ─────────────────────────────────────────────────
// These need actual tree-sitter trees — tested via integration in the
// parseSource pipeline. Here we test the pure functions.

describe("formatDiagnostics", () => {
  it("formats empty array", () => {
    expect(formatDiagnostics([])).toBe("");
  });

  it("formats single error", () => {
    const diags: SyntaxDiagnostic[] = [
      { line: 5, column: 10, type: "ERROR", message: "Syntax error", text: "foo" },
    ];
    const result = formatDiagnostics(diags);
    expect(result).toContain("L5:10");
    expect(result).toContain("ERROR");
    expect(result).toContain("[foo]");
  });

  it("formats MISSING node without text", () => {
    const diags: SyntaxDiagnostic[] = [
      { line: 3, column: 0, type: "MISSING", message: "Missing }", text: "" },
    ];
    const result = formatDiagnostics(diags);
    expect(result).toContain("L3:0");
    expect(result).toContain("MISSING");
    expect(result).toContain("Missing }");
    expect(result).not.toContain("[]");
  });

  it("formats multiple diagnostics on separate lines", () => {
    const diags: SyntaxDiagnostic[] = [
      { line: 1, column: 0, type: "ERROR", message: "Syntax error", text: "x" },
      { line: 5, column: 3, type: "MISSING", message: "Missing ;", text: "" },
    ];
    const result = formatDiagnostics(diags);
    const lines = result.split("\n");
    expect(lines.length).toBe(2);
  });
});

describe("diffErrors", () => {
  it("returns empty when after has fewer errors", () => {
    const before: SyntaxDiagnostic[] = [
      { line: 1, column: 0, type: "ERROR", message: "Syntax error", text: "" },
      { line: 5, column: 0, type: "ERROR", message: "Syntax error", text: "" },
    ];
    const after: SyntaxDiagnostic[] = [
      { line: 1, column: 0, type: "ERROR", message: "Syntax error", text: "" },
    ];
    expect(diffErrors(before, after)).toEqual([]);
  });

  it("returns empty when after has same count", () => {
    const before: SyntaxDiagnostic[] = [
      { line: 1, column: 0, type: "ERROR", message: "Syntax error", text: "" },
    ];
    const after: SyntaxDiagnostic[] = [
      { line: 3, column: 5, type: "ERROR", message: "Syntax error", text: "" },
    ];
    expect(diffErrors(before, after)).toEqual([]);
  });

  it("identifies new errors by type+message", () => {
    const before: SyntaxDiagnostic[] = [
      { line: 1, column: 0, type: "ERROR", message: "Syntax error", text: "" },
    ];
    const after: SyntaxDiagnostic[] = [
      { line: 1, column: 0, type: "ERROR", message: "Syntax error", text: "" },
      { line: 10, column: 0, type: "MISSING", message: "Missing }", text: "" },
    ];
    const result = diffErrors(before, after);
    expect(result.length).toBe(1);
    expect(result[0].type).toBe("MISSING");
    expect(result[0].line).toBe(10);
  });

  it("handles multiple new errors of the same type", () => {
    const before: SyntaxDiagnostic[] = [];
    const after: SyntaxDiagnostic[] = [
      { line: 5, column: 0, type: "ERROR", message: "Syntax error", text: "" },
      { line: 10, column: 0, type: "ERROR", message: "Syntax error", text: "" },
    ];
    const result = diffErrors(before, after);
    expect(result.length).toBe(2);
  });
});

describe("buildErrorSummary", () => {
  it("returns empty for no new errors", () => {
    expect(buildErrorSummary("/foo.ts", [], 0)).toBe("");
  });

  it("builds summary for new errors", () => {
    const errors: SyntaxDiagnostic[] = [
      { line: 5, column: 0, type: "MISSING", message: "Missing }", text: "" },
    ];
    const result = buildErrorSummary("/foo.ts", errors, 1);
    expect(result).toContain("SYNTAX WARNING");
    expect(result).toContain("1 new syntax error");
    expect(result).toContain("/foo.ts");
    expect(result).toContain("Missing }");
  });

  it("shows total count when there are pre-existing errors", () => {
    const errors: SyntaxDiagnostic[] = [
      { line: 5, column: 0, type: "MISSING", message: "Missing }", text: "" },
    ];
    const result = buildErrorSummary("/foo.ts", errors, 5);
    expect(result).toContain("5 total in file");
  });

  it("uses plural for multiple errors", () => {
    const errors: SyntaxDiagnostic[] = [
      { line: 5, column: 0, type: "ERROR", message: "Syntax error", text: "" },
      { line: 10, column: 0, type: "MISSING", message: "Missing ;", text: "" },
    ];
    const result = buildErrorSummary("/foo.ts", errors, 2);
    expect(result).toContain("2 new syntax errors");
  });
});
