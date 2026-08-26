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
    const input: any = { path: "src/**", limit: "10" };
    repairArgs("glob", input);
    expect(input.limit).toBe(10);
  });

  it("coerces stringified booleans on known boolean keys", () => {
    const input: any = { path: "src/**", gitignore: "false", hidden: "true" };
    repairArgs("glob", input);
    expect(input.gitignore).toBe(false);
    expect(input.hidden).toBe(true);
  });

  it("aliases Claude's run_in_background onto bash's `async`", () => {
    const input: any = { command: "sleep 30", run_in_background: "true" };
    repairArgs("bash", input);
    expect(input.async).toBe(true);
    expect(input.run_in_background).toBeUndefined();
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

  it("aliases a stray `pattern` onto `path` for glob (glob has no pattern arg)", () => {
    const input: any = { pattern: "**/*.py" };
    repairArgs("glob", input);
    expect(input.pattern).toBeUndefined();
    expect(input.path).toBe("**/*.py");
  });

  it("repairs a JSON-array serialized into a glob path", () => {
    const input: any = { path: '{["internal/bwe/gcc/","internal/bwe/gcchybrid/**/*"]}' };
    repairArgs("glob", input);
    expect(input.path).toBe("{internal/bwe/gcc/;internal/bwe/gcchybrid/**/*}");
    expect(input.path).not.toMatch(/["'\[\]]/);
  });

  it("leaves a legitimate glob character class untouched", () => {
    const input: any = { path: "src/[0-9]*.go" };
    repairArgs("glob", input);
    expect(input.path).toBe("src/[0-9]*.go");
  });

  it("does not strip quotes from a grep regex pattern", () => {
    // grep `pattern` is a regex — quotes can be meaningful, must not be
    // touched; only the `path` scope is normalized.
    const input: any = { pattern: 'foo"bar', path: '["a","b"]' };
    repairArgs("grep", input);
    expect(input.pattern).toBe('foo"bar');  // regex untouched
    expect(input.path).toBe("a;b");         // scope joined with `;`
  });

  it("joins a stringified JSON array into grep.path (the reported bug)", () => {
    // Exact failing call shape: the model sends the scope as a serialized
    // array, which omp reads as one literal glob → "unclosed character class".
    const input: any = {
      pattern: "burst.*loss",
      path: '["internal/bwe/gcc/", "internal/bwe/gcchybrid/", "internal/bwe/piongcc/"]',
    };
    const r = repairArgs("grep", input);
    expect(input.path).toBe(
      "internal/bwe/gcc/;internal/bwe/gcchybrid/;internal/bwe/piongcc/",
    );
    expect(input.pattern).toBe("burst.*loss"); // regex untouched
    expect(r.coerced).toContain("path:path-list");
  });

  it("salvages a malformed/truncated path array string", () => {
    // Missing closing ']' — relaxedJson fails, fall back to strip+split.
    const input: any = { pattern: "x", path: '["internal/bwe/gcc/", "lib/' };
    repairArgs("grep", input);
    expect(input.path).toBe("internal/bwe/gcc/;lib/");
  });

  it("joins a real array sent for grep.path, cleaning stray artifacts", () => {
    const input: any = { path: ['["src/"', "lib/**/*.go"] };
    repairArgs("grep", input);
    expect(input.path).toBe("src/;lib/**/*.go");
  });

  it("splits a comma-joined path list onto semicolons", () => {
    const input: any = { pattern: "x", path: "internal/bwe/gcc/,lib/" };
    repairArgs("grep", input);
    expect(input.path).toBe("internal/bwe/gcc/;lib/");
  });

  it("leaves an already-semicolon-delimited grep.path untouched", () => {
    const input: any = { pattern: "x", path: "internal/bwe/gcc/;lib/**/*.go" };
    const r = repairArgs("grep", input);
    expect(input.path).toBe("internal/bwe/gcc/;lib/**/*.go");
    expect(r.coerced).not.toContain("path:path-list");
  });

  it("leaves a clean single-path grep scope untouched", () => {
    const input: any = { pattern: "x", path: "internal/bwe/gcc/" };
    const r = repairArgs("grep", input);
    expect(input.path).toBe("internal/bwe/gcc/");
    expect(r.coerced).not.toContain("path:path-list");
  });

  it("aliases glob/paths → path for grep", () => {
    const input: any = { pattern: "x", glob: '["a/","b/"]' };
    repairArgs("grep", input);
    expect(input.glob).toBeUndefined();
    expect(input.path).toBe("a/;b/");
  });

  it("aliases over a present-but-null canonical key", () => {
    const input: any = { pattern: "**/*.go", path: null };
    repairArgs("glob", input);
    expect(input.pattern).toBeUndefined();
    expect(input.path).toBe("**/*.go");
  });

  it("negates a stray ignore-case flag onto grep.case", () => {
    // omp replaced `i` (ignore-case) with `case` (case-SENSITIVE) — a straight
    // alias would invert the model's intent.
    const input: any = { pattern: "x", i: true };
    const r = repairArgs("grep", input);
    expect(input.i).toBeUndefined();
    expect(input.case).toBe(false);
    expect(r.coerced).toContain("i→case:negated");
  });

  it("does not override an explicit grep.case", () => {
    const input: any = { pattern: "x", case: true, ignore_case: true };
    repairArgs("grep", input);
    expect(input.case).toBe(true);
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

  it("converts a CUT-with-body hashline op into PUT (replace was meant)", () => {
    const input: any = { input: "[a.ts#0DB3]\nCUT 8.=10:\n+const x = 1\n+const y = 2" };
    const r = repairArgs("edit", input);
    expect(input.input).toContain("PUT 8.=10:");
    expect(input.input).not.toContain("CUT 8.=10:");
    expect(input.input).toContain("+const x = 1");
    expect(r.coerced).toContain("input:cut-with-body\u2192put");
  });

  it("strips a stray trailing colon from a bodyless CUT", () => {
    const input: any = { input: "[a.ts#0DB3]\nCUT 8.=10:" };
    repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nCUT 8.=10");
  });

  it("adds a missing colon to a PUT that has body rows", () => {
    const input: any = { input: "[a.ts#0DB3]\nPUT 3.=3\n+const z = 0" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nPUT 3.=3:\n+const z = 0");
    expect(r.coerced).toContain("input:put-add-colon");
  });

  it("strips a stray colon from a bodyless register paste", () => {
    const input: any = { input: "[a.ts#0DB3]\nCUT 5.=9 @fn\n[b.ts#1C2D]\nPUT >40 @fn:" };
    const r = repairArgs("edit", input);
    expect(input.input).toContain("PUT >40 @fn");
    expect(input.input).not.toContain("@fn:");
    expect(r.coerced).toContain("input:register-strip-colon");
  });

  it("leaves a correct CUT and a correct PUT untouched", () => {
    const ok = "[a.ts#0DB3]\nCUT 8.=10\nPUT 3.=3:\n+const z = 0";
    const input: any = { input: ok };
    const r = repairArgs("edit", input);
    expect(input.input).toBe(ok);
    expect(r.coerced.filter((c) => c.startsWith("input:"))).toEqual([]);
  });

  it("leaves gap and block locators untouched", () => {
    const ok = "[a.ts#0DB3]\nPUT <1:\n+first\nPUT >$:\n+last\nPUT 12*:\n+function f() {}\nCUT 20*";
    const input: any = { input: ok };
    const r = repairArgs("edit", input);
    expect(input.input).toBe(ok);
    expect(r.coerced.filter((c) => c.startsWith("input:"))).toEqual([]);
  });

  // ---- legacy dialect (omp <17.4.0) --------------------------------------
  // hashline 17.4.0 replaced SWAP/DEL/INS.* with PUT/CUT and kept NO alias,
  // so a carried-over keyword is a hard parse error we must translate away.
  it("translates legacy SWAP into PUT", () => {
    const input: any = { input: "[a.ts#0DB3]\nSWAP 39.=41:\n+x" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nPUT 39.=41:\n+x");
    expect(r.coerced).toContain("input:swap\u2192put");
  });

  it("translates legacy DEL into CUT", () => {
    const input: any = { input: "[a.ts#0DB3]\nDEL 8.=10" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nCUT 8.=10");
    expect(r.coerced).toContain("input:del\u2192cut");
  });

  it("translates a legacy DEL-with-body all the way to PUT", () => {
    const input: any = { input: "[a.ts#0DB3]\nDEL 8.=10:\n+const x = 1" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nPUT 8.=10:\n+const x = 1");
    expect(r.coerced).toContain("input:del\u2192cut");
    expect(r.coerced).toContain("input:cut-with-body\u2192put");
  });

  it("translates legacy INS.PRE / INS.POST into gap PUTs", () => {
    const input: any = { input: "[a.ts#0DB3]\nINS.PRE 5:\n+before\nINS.POST 9:\n+after" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nPUT <5:\n+before\nPUT >9:\n+after");
    expect(r.coerced).toContain("input:ins.pre\u2192put");
    expect(r.coerced).toContain("input:ins.post\u2192put");
  });

  it("translates legacy INS.HEAD / INS.TAIL into <1 and >$", () => {
    const input: any = { input: "[a.ts#0DB3]\nINS.HEAD:\n+first\nINS.TAIL:\n+last" };
    repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nPUT <1:\n+first\nPUT >$:\n+last");
  });

  it("translates legacy block ops into `N*` form", () => {
    const input: any = { input: "[a.ts#0DB3]\nSWAP.BLK 12:\n+function f() {}" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nPUT 12*:\n+function f() {}");
    expect(r.coerced).toContain("input:swap.blk\u2192put");
  });

  it("translates a legacy DEL.BLK-with-body into a block PUT", () => {
    const input: any = { input: "[a.ts#0DB3]\nDEL.BLK 12:\n+function f() {}" };
    repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nPUT 12*:\n+function f() {}");
  });

  it("translates a bodyless legacy DEL.BLK into CUT N*", () => {
    const input: any = { input: "[a.ts#0DB3]\nDEL.BLK 12" };
    repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nCUT 12*");
  });

  it("converts a read-style `-` range separator in a PUT header to `.=`", () => {
    const input: any = { input: "[a.ts#0DB3]\nPUT 560-571:\n+func f() {}" };
    const r = repairArgs("edit", input);
    expect(input.input).toContain("PUT 560.=571:");
    expect(r.coerced).toContain("input:range-sep-fix");
  });

  it("converts a `-` range separator in a CUT header", () => {
    const input: any = { input: "[a.ts#0DB3]\nCUT 8-10" };
    const r = repairArgs("edit", input);
    expect(input.input).toContain("CUT 8.=10");
  });

  it("does NOT touch a block op (no range) or a hyphen in body text", () => {
    const ok = "[a.ts#0DB3]\nPUT 12*:\n+x := a - b";
    const input: any = { input: ok };
    const r = repairArgs("edit", input);
    expect(input.input).toBe(ok);
    expect(r.coerced).not.toContain("input:range-sep-fix");
  });

  it("collapses a doubled leading bracket on a section header", () => {
    const input: any = { input: "[[pkg/a/b.go#A2A9]\nPUT 7.=14:\n+const x = 1" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[pkg/a/b.go#A2A9]\nPUT 7.=14:\n+const x = 1");
    expect(r.coerced).toContain("input:header-normalize-brackets");
  });

  it("collapses a doubled closing bracket on a section header", () => {
    const input: any = { input: "[a.ts#0DB3]]\nPUT 3.=3:\n+x" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nPUT 3.=3:\n+x");
    expect(r.coerced).toContain("input:header-normalize-brackets");
  });

  it("adds a missing closing bracket on a section header", () => {
    const input: any = { input: "[a.ts#0DB3\nPUT 3.=3:\n+x" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nPUT 3.=3:\n+x");
    expect(r.coerced).toContain("input:header-normalize-brackets");
  });

  it("uppercases a lowercase snapshot tag in the header", () => {
    const input: any = { input: "[a.ts#0db3]\nPUT 3.=3:\n+x" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nPUT 3.=3:\n+x");
    expect(r.coerced).toContain("input:header-tag-uppercase");
  });

  it("uppercases a lowercased op keyword", () => {
    const input: any = { input: "[a.ts#0DB3]\nput 3.=3:\n+x" };
    const r = repairArgs("edit", input);
    expect(input.input).toBe("[a.ts#0DB3]\nPUT 3.=3:\n+x");
    expect(r.coerced).toContain("input:op-keyword-uppercase");
  });

  it("uppercases a lowercased legacy dotted op keyword (ins.post)", () => {
    const input: any = { input: "[a.ts#0DB3]\nins.post 14:\n+x" };
    const r = repairArgs("edit", input);
    expect(input.input).toContain("PUT >14:");
  });

  it("leaves a correct single-bracket header untouched", () => {
    const ok = "[pkg/a/b.go#A2A9]\nPUT 7.=14:\n+const x = 1";
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
