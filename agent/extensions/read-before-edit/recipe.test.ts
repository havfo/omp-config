import { describe, expect, it } from "vitest";
import { buildReadFirstRecipe, parseHeader, reconcileHeaderPath } from "./index.ts";

describe("buildReadFirstRecipe", () => {
  it("includes the file path and a concrete read+hashline-edit recipe", () => {
    const r = buildReadFirstRecipe("/tmp/foo.ts");
    expect(r).toContain("/tmp/foo.ts");
    expect(r).toMatch(/read/i);
    expect(r).toMatch(/edit/i);
    // Teaches the hashline format (tag-anchored), NOT old_string/new_string.
    expect(r).toMatch(/\[.*#TAG\]/);
    expect(r).toMatch(/SWAP/);
    expect(r).not.toMatch(/old_string/);
  });
});

describe("parseHeader", () => {
  it("extracts path and uppercased tag from the first header", () => {
    expect(parseHeader("[pkg/a/b.go#665a]\nSWAP 1.=1:\n+x")).toEqual({ path: "pkg/a/b.go", tag: "665A" });
  });
  it("tolerates a doubled leading bracket", () => {
    expect(parseHeader("[[pkg/a/b.go#A2A9]")).toEqual({ path: "pkg/a/b.go", tag: "A2A9" });
  });
  it("returns undefined when there is no header", () => {
    expect(parseHeader("SWAP 1.=1:")).toBeUndefined();
  });
});

describe("reconcileHeaderPath", () => {
  const reg = new Map([
    ["/proj/pkg/aether/webrtctransport_binding.go", { tag: "665A", display: "pkg/aether/webrtctransport_binding.go" }],
  ]);
  const neverResolves = () => false;

  it("rewrites a bare basename to the full path when basename+tag match uniquely", () => {
    const out = reconcileHeaderPath("[webrtctransport_binding.go#665A]\nSWAP 85.=120:\n+func f()", reg, neverResolves);
    expect(out?.to).toBe("pkg/aether/webrtctransport_binding.go");
    expect(out?.input).toContain("[pkg/aether/webrtctransport_binding.go#665A]");
  });

  it("collapses a doubled bracket while reconciling", () => {
    const out = reconcileHeaderPath("[[webrtctransport_binding.go#665A]\nSWAP 1.=1:\n+x", reg, neverResolves);
    expect(out?.input.startsWith("[pkg/aether/webrtctransport_binding.go#665A]")).toBe(true);
  });

  it("does NOT rewrite when the tag does not match (file changed since read)", () => {
    expect(reconcileHeaderPath("[webrtctransport_binding.go#9999]\nSWAP 1.=1:\n+x", reg, neverResolves)).toBeNull();
  });

  it("does NOT rewrite when the header path already resolves", () => {
    const always = () => true;
    expect(reconcileHeaderPath("[webrtctransport_binding.go#665A]\nSWAP 1.=1:\n+x", reg, always)).toBeNull();
  });

  it("does NOT rewrite when the basename is ambiguous", () => {
    const amb = new Map([
      ["/proj/a/util.go", { tag: "1111", display: "a/util.go" }],
      ["/proj/b/util.go", { tag: "1111", display: "b/util.go" }],
    ]);
    expect(reconcileHeaderPath("[util.go#1111]\nSWAP 1.=1:\n+x", amb, neverResolves)).toBeNull();
  });

  it("leaves a correct full-path header unchanged", () => {
    expect(
      reconcileHeaderPath("[pkg/aether/webrtctransport_binding.go#665A]\nSWAP 1.=1:\n+x", reg, neverResolves),
    ).toBeNull();
  });
});
