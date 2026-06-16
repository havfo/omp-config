import { describe, expect, it } from "vitest";
import { repairArgs } from "./index.ts";

describe("repairArgs", () => {
  it("aliases file_path → path for read (pi schema is `path`)", () => {
    const input: any = { file_path: "/tmp/x" };
    const r = repairArgs("read", input);
    expect(input).toEqual({ path: "/tmp/x" });
    expect(r.aliased).toEqual(["file_path→path"]);
  });

  it("preserves `path` when model already used the canonical name (regression)", () => {
    // The exact original bug: model emits {path: "~/foo"}, arg-repair must
    // NOT delete `path`. Previously the alias direction was reversed and
    // drop-unknowns nuked it, leaving path=undefined and crashing pi at
    // expandPath().startsWith.
    const input: any = { path: "~/foo.md" };
    repairArgs("read", input);
    expect(typeof input.path).toBe("string");
    expect(input.file_path).toBeUndefined();
  });

  it("expands tilde in path-like values", () => {
    const input: any = { path: "~/notes.md" };
    const r = repairArgs("read", input);
    expect(input.path.startsWith("/")).toBe(true);
    expect(input.path.endsWith("/notes.md")).toBe(true);
    expect(r.expanded).toEqual(["path"]);
  });

  it("does NOT drop unknown keys by default", () => {
    const input: any = { path: "/x", garbage: 1 };
    const r = repairArgs("read", input);
    expect(input).toEqual({ path: "/x", garbage: 1 });
    expect(r.dropped).toEqual([]);
  });

  it("drops unknown keys when explicitly enabled", () => {
    const input: any = { path: "/x", garbage: 1 };
    const r = repairArgs("read", input, { dropUnknown: true });
    expect(input).toEqual({ path: "/x" });
    expect(r.dropped).toEqual(["garbage"]);
  });

  it("coerces stringified numbers on known numeric keys", () => {
    const input: any = { path: "/x", offset: "5", limit: "10" };
    repairArgs("read", input);
    expect(input.offset).toBe(5);
    expect(input.limit).toBe(10);
  });

  it("coerces stringified booleans on known boolean keys", () => {
    const input: any = { command: "ls", run_in_background: "true" };
    repairArgs("bash", input);
    expect(input.run_in_background).toBe(true);
  });

  it("re-parses _raw with trailing comma", () => {
    const input: any = { _raw: '{"path":"/x","offset":1,}' };
    const r = repairArgs("read", input);
    expect(r.parsedRaw).toBe(true);
    expect(input.path).toBe("/x");
    expect(input.offset).toBe(1);
  });

  it("write aliases file_path → path (omp native write({path, content}))", () => {
    const input: any = { file_path: "/tmp/new.txt", content: "hi" };
    repairArgs("write", input);
    expect(input.path).toBe("/tmp/new.txt");
    expect(input.file_path).toBeUndefined();
  });

  it("repairs a JSON-array serialized into a glob pattern", () => {
    const input: any = { pattern: '{["internal/bwe/gcc/","internal/bwe/gcchybrid/**/*"]}' };
    repairArgs("find", input);
    expect(input.pattern).toBe("{internal/bwe/gcc/,internal/bwe/gcchybrid/**/*}");
    expect(input.pattern).not.toMatch(/["'\[\]]/);
  });

  it("leaves a legitimate glob character class untouched", () => {
    const input: any = { pattern: "src/[0-9]*.go" };
    repairArgs("glob", input);
    expect(input.pattern).toBe("src/[0-9]*.go");
  });

  it("does not strip quotes from a search regex pattern", () => {
    // search `pattern` is a regex — quotes can be meaningful, must not be
    // touched; only the `paths` scope array is normalized.
    const input: any = { pattern: 'foo"bar', paths: '["a","b"]' };
    repairArgs("search", input);
    expect(input.pattern).toBe('foo"bar');       // regex untouched
    expect(input.paths).toEqual(["a", "b"]);     // paths array repaired
  });

  it("parses a stringified JSON array for search.paths (the reported bug)", () => {
    // Exact failing call: search({pattern, paths:'["a/","b/","c/"]'}). The tool
    // split the raw string on commas → '["a/' → "unclosed character class".
    const input: any = {
      pattern: "burst.*loss",
      paths: '["internal/bwe/gcc/", "internal/bwe/gcchybrid/", "internal/bwe/piongcc/"]',
    };
    const r = repairArgs("search", input);
    expect(input.paths).toEqual([
      "internal/bwe/gcc/", "internal/bwe/gcchybrid/", "internal/bwe/piongcc/",
    ]);
    expect(input.pattern).toBe("burst.*loss"); // regex untouched
    expect(r.coerced).toContain("paths:glob-array[]");
  });

  it("salvages a malformed/truncated paths array string", () => {
    // Missing closing ']' — relaxedJson fails, fall back to strip+split.
    const input: any = { pattern: "x", paths: '["internal/bwe/gcc/", "lib/' };
    repairArgs("search", input);
    expect(input.paths).toEqual(["internal/bwe/gcc/", "lib/"]);
  });

  it("cleans stray glob artifacts inside a real paths array", () => {
    const input: any = { paths: ['["src/"', 'lib/**/*.go'] };
    repairArgs("search", input);
    expect(input.paths).toEqual(["src/", "lib/**/*.go"]);
  });

  it("leaves a clean search.paths array untouched", () => {
    const input: any = { paths: ["internal/bwe/gcc/", "lib/**/*.go"] };
    const r = repairArgs("search", input);
    expect(input.paths).toEqual(["internal/bwe/gcc/", "lib/**/*.go"]);
    expect(r.coerced).not.toContain("paths:glob-array[]");
  });

  it("aliases glob → paths for search", () => {
    const input: any = { pattern: "x", glob: '["a/","b/"]' };
    repairArgs("search", input);
    expect(input.glob).toBeUndefined();
    expect(input.paths).toEqual(["a/", "b/"]);
  });

  it("strips a stray hashline tag appended to a read path (range + tag)", () => {
    const input: any = { path: "internal/bwe/gcc/gcc.go:29:0DB3" };
    const r = repairArgs("read", input);
    expect(input.path).toBe("internal/bwe/gcc/gcc.go:29");
    expect(r.coerced).toContain("path:hashline-tag");
  });

  it("strips a #-form hashline tag from a read path", () => {
    const input: any = { path: "gcc.go#78F3" };
    repairArgs("read", input);
    expect(input.path).toBe("gcc.go");
  });

  it("does NOT strip a real numeric line range from a read path", () => {
    const input: any = { path: "gcc.go:29-67" };
    const r = repairArgs("read", input);
    expect(input.path).toBe("gcc.go:29-67");
    expect(r.coerced).not.toContain("path:hashline-tag");
  });

  it("converts a hashline edit-range separator leaked into a read path", () => {
    const input: any = { path: "internal/turn/server.go:130.=160" };
    const r = repairArgs("read", input);
    expect(input.path).toBe("internal/turn/server.go:130-160");
    expect(r.coerced).toContain("path:read-range-sep");
  });

  it("does NOT mistake an all-digit suffix for a tag", () => {
    // 4 digits with no hex letter is a plausible line number — leave it.
    const input: any = { path: "gcc.go:1234" };
    repairArgs("read", input);
    expect(input.path).toBe("gcc.go:1234");
  });

  it("converts a DEL-with-body hashline op into SWAP (replace was meant)", () => {
    const input: any = { input: "[a.ts#0DB3]\nDEL 8.=10:\n+const x = 1\n+const y = 2" };
    const r = repairArgs("edit", input);
    expect(input.input).toContain("SWAP 8.=10:");
    expect(input.input).not.toContain("DEL 8.=10:");
    expect(input.input).toContain("+const x = 1");
    expect(r.coerced).toContain("input:del-with-body→swap");
  });

  it("strips a stray trailing colon from a bodyless DEL", () => {
    const input: any = { input: "[a.ts#0DB3]\nDEL 8.=10:" };
    repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nDEL 8.=10");
  });

  it("converts DEL.BLK-with-body into SWAP.BLK", () => {
    const input: any = { input: "[a.ts#0DB3]\nDEL.BLK 12:\n+function f() {}" };
    repairArgs("edit", input);
    expect(input.input).toContain("SWAP.BLK 12:");
  });

  it("leaves a correct DEL and a correct SWAP untouched", () => {
    const ok = "[a.ts#0DB3]\nDEL 8.=10\nSWAP 3.=3:\n+const z = 0";
    const input: any = { input: ok };
    const r = repairArgs("edit", input);
    expect(input.input).toBe(ok);
    expect(r.coerced.filter((c) => c.startsWith("input:"))).toEqual([]);
  });

  it("collapses a doubled leading bracket on a section header", () => {
    const input: any = { input: "[[pkg/a/b.go#A2A9]\nSWAP 7.=14:\n+const x = 1" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[pkg/a/b.go#A2A9]\nSWAP 7.=14:\n+const x = 1");
    expect(r.coerced).toContain("input:header-normalize-brackets");
  });

  it("collapses a doubled closing bracket on a section header", () => {
    const input: any = { input: "[a.ts#0DB3]]\nSWAP 3.=3:\n+x" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nSWAP 3.=3:\n+x");
    expect(r.coerced).toContain("input:header-normalize-brackets");
  });

  it("adds a missing closing bracket on a section header", () => {
    const input: any = { input: "[a.ts#0DB3\nSWAP 3.=3:\n+x" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nSWAP 3.=3:\n+x");
    expect(r.coerced).toContain("input:header-normalize-brackets");
  });

  it("uppercases a lowercase snapshot tag in the header", () => {
    const input: any = { input: "[a.ts#0db3]\nSWAP 3.=3:\n+x" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nSWAP 3.=3:\n+x");
    expect(r.coerced).toContain("input:header-tag-uppercase");
  });

  it("uppercases a lowercased op keyword", () => {
    const input: any = { input: "[a.ts#0DB3]\nswap 3.=3:\n+x" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nSWAP 3.=3:\n+x");
    expect(r.coerced).toContain("input:op-keyword-uppercase");
  });

  it("uppercases a lowercased dotted op keyword (ins.post)", () => {
    const input: any = { input: "[a.ts#0DB3]\nins.post 14:\n+x" };
    const r = repairArgs("edit", input);
    expect(input.input).toContain("INS.POST 14:");
    expect(r.coerced).toContain("input:op-keyword-uppercase");
  });

  it("leaves a correct single-bracket header untouched", () => {
    const ok = "[pkg/a/b.go#A2A9]\nSWAP 7.=14:\n+const x = 1";
    const input: any = { input: ok };
    const r = repairArgs("edit", input);
    expect(input.input).toBe(ok);
    expect(r.coerced.filter((c) => c.startsWith("input:header"))).toEqual([]);
  });

  it("ignores tools not in taxonomy", () => {
    const input: any = { whatever: 1 };
    const r = repairArgs("UnknownTool", input);
    expect(r).toEqual({ aliased: [], dropped: [], coerced: [], expanded: [], parsedRaw: false });
    expect(input).toEqual({ whatever: 1 });
  });
});
