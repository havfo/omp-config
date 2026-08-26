import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectErrors,
  diffErrors,
  formatDiagnostics,
  buildErrorSummary,
  MAX_LISTED_DIAGNOSTICS,
  type SyntaxDiagnostic,
} from "./diagnostics.ts";
import syntaxGuard from "./index.ts";

// ── Hook wiring ─────────────────────────────────────────────────────────
// Regression fence for the bug where this guard keyed on `input.path` and so
// silently never ran on `edit` at all: omp's edit tool takes only `{input}`,
// with the target file named by the `[PATH#TAG]` header inside the patch.
describe("syntax-guard hook wiring", () => {
  function harness() {
    const handlers: Record<string, Function> = {};
    const messages: string[] = [];
    const pi: any = {
      on: (evt: string, fn: Function) => { handlers[evt] = fn; },
      sendUserMessage: (m: string) => { messages.push(m); },
    };
    syntaxGuard(pi);
    const ctx: any = { ui: { notify: () => {} } };
    return { handlers, messages, ctx };
  }

  it("detects a syntax error introduced by an `edit` (no path arg present)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sg-"));
    const file = join(dir, "broken.ts");
    try {
      // Valid before the edit.
      writeFileSync(file, "export function ok() {\n  return 1;\n}\n");

      const { handlers, ctx } = harness();
      const patch = `[${file}#A1B2]\nPUT 2.=2:\n+  return 1;`;
      const call = {
        toolName: "edit",
        toolCallId: "call-1",
        input: { input: patch },
      };
      await handlers.tool_call!(call);

      // The edit lands and breaks the parse (unbalanced brace).
      writeFileSync(file, "export function ok() {\n  return 1;\n");

      const result = await handlers.tool_result!(
        { ...call, isError: false, content: [{ type: "text", text: "applied" }] },
        ctx,
      );

      expect(result).toBeDefined();
      const appended = result.content.at(-1).text as string;
      expect(appended).toContain(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression: with no pre-edit snapshot the guard used to report every error
  // in the file as "introduced by this edit" whenever there were more than 3 —
  // blaming the current call for breakage it never caused (an `MV` destination,
  // a file first touched by another tool).
  it("stays quiet on a broken file it never snapshotted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sg-"));
    const file = join(dir, "already-broken.ts");
    try {
      writeFileSync(file, "function a( {\nfunction b( {\nfunction c( {\nfunction d( {\n");
      const { handlers, ctx } = harness();
      // tool_result WITHOUT a preceding tool_call — no snapshot exists.
      const result = await handlers.tool_result!(
        {
          toolName: "edit",
          toolCallId: "no-snapshot",
          input: { input: `[${file}#A1B2]\nPUT 1.=1:\n+function a( {` },
          isError: false,
          content: [{ type: "text", text: "applied" }],
        },
        ctx,
      );
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays quiet when the edit leaves the file parsing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sg-"));
    const file = join(dir, "fine.ts");
    try {
      writeFileSync(file, "export const a = 1;\n");
      const { handlers, ctx } = harness();
      const call = {
        toolName: "edit",
        toolCallId: "call-2",
        input: { input: `[${file}#A1B2]\nPUT 1.=1:\n+export const a = 2;` },
      };
      await handlers.tool_call!(call);
      writeFileSync(file, "export const a = 2;\n");
      const result = await handlers.tool_result!(
        { ...call, isError: false, content: [{ type: "text", text: "applied" }] },
        ctx,
      );
      expect(result).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

  // Regression: one unbalanced brace makes tree-sitter re-read the rest of the
  // file, so errors past the first are cascade pointing at untouched lines.
  // Quoting all 20 is what made these warnings read as flat-out wrong.
  it("lists only the first few and summarises the cascade", () => {
    const diags: SyntaxDiagnostic[] = Array.from({ length: 11 }, (_, i) => ({
      line: i + 1, column: 0, type: "ERROR" as const, message: "Syntax error", text: `t${i}`,
    }));
    const result = formatDiagnostics(diags);
    const lines = result.split("\n");
    expect(lines.length).toBe(MAX_LISTED_DIAGNOSTICS + 1);
    expect(result).toContain("[t0]");
    expect(result).not.toContain("[t9]");
    expect(lines.at(-1)).toContain("8 more");
    expect(lines.at(-1)).toContain("cascade");
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
