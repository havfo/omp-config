import { describe, it, expect } from "vitest";
import { parseSource, isSupported, getExtension } from "./parsers.ts";
import { collectErrors } from "./diagnostics.ts";

describe("parsers", () => {
  describe("getExtension", () => {
    it("extracts ts", () => expect(getExtension("/foo/bar.ts")).toBe("ts"));
    it("extracts tsx", () => expect(getExtension("file.tsx")).toBe("tsx"));
    it("extracts py", () => expect(getExtension("a/b.py")).toBe("py"));
    it("handles no extension", () => expect(getExtension("Makefile")).toBe(""));
    it("handles dots in path", () => expect(getExtension("/a.b/c.js")).toBe("js"));
  });

  describe("isSupported", () => {
    it("supports ts", () => expect(isSupported("ts")).toBe(true));
    it("supports tsx", () => expect(isSupported("tsx")).toBe(true));
    it("supports js", () => expect(isSupported("js")).toBe(true));
    it("supports py", () => expect(isSupported("py")).toBe(true));
    it("supports go", () => expect(isSupported("go")).toBe(true));
    it("supports rs", () => expect(isSupported("rs")).toBe(true));
    it("does not support md", () => expect(isSupported("md")).toBe(false));
    it("does not support txt", () => expect(isSupported("txt")).toBe(false));
  });
});

describe("tree-sitter integration", () => {
  it("parses valid TypeScript without errors", async () => {
    const source = `
function greet(name: string): string {
  return "Hello, " + name;
}
`;
    const result = await parseSource(source, "ts");
    expect(result).not.toBeNull();
    const errors = collectErrors(result!.tree);
    expect(errors.length).toBe(0);
    result!.tree.delete();
    result!.parser.delete();
  });

  it("detects missing closing brace in TypeScript", async () => {
    const source = `
function greet(name: string): string {
  return "Hello, " + name;
`;
    const result = await parseSource(source, "ts");
    expect(result).not.toBeNull();
    const errors = collectErrors(result!.tree);
    expect(errors.length).toBeGreaterThan(0);
    // Should have a MISSING "}" error
    const hasMissing = errors.some(
      (e) => e.type === "MISSING" && e.message.includes("}"),
    );
    expect(hasMissing).toBe(true);
    result!.tree.delete();
    result!.parser.delete();
  });

  it("detects syntax error in JavaScript", async () => {
    const source = `
const x = {
  a: 1,
  b: 2
  c: 3
};
`;
    const result = await parseSource(source, "js");
    expect(result).not.toBeNull();
    const errors = collectErrors(result!.tree);
    // Missing comma between b and c
    expect(errors.length).toBeGreaterThan(0);
    result!.tree.delete();
    result!.parser.delete();
  });

  it("parses valid Python without errors", async () => {
    const source = `
def greet(name):
    return f"Hello, {name}"

class Foo:
    def __init__(self):
        self.x = 1
`;
    const result = await parseSource(source, "py");
    expect(result).not.toBeNull();
    const errors = collectErrors(result!.tree);
    expect(errors.length).toBe(0);
    result!.tree.delete();
    result!.parser.delete();
  });

  it("returns null for unsupported extensions", async () => {
    const result = await parseSource("hello world", "txt");
    expect(result).toBeNull();
  });
});
