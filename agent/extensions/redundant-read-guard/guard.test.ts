import { beforeEach, describe, expect, it } from "vitest";
import {
  _state,
  compactNote,
  evaluateRead,
  isSubset,
  MIN_SUPPRESS_LINES,
  parseShownLines,
  parseTag,
  recordEdit,
  shouldSuppress,
} from "./index.ts";

function rangeSet(a: number, b: number): Set<number> {
  const s = new Set<number>();
  for (let i = a; i <= b; i++) s.add(i);
  return s;
}

beforeEach(() => _state.shown.clear());

describe("parseTag", () => {
  it("extracts the 4-hex tag from a header", () => {
    expect(parseTag("[pkg/a.go#A2A9]\n1:package a")).toBe("A2A9");
  });
  it("uppercases a lowercase tag", () => {
    expect(parseTag("[pkg/a.go#a2a9]\n1:x")).toBe("A2A9");
  });
  it("returns undefined when there is no header", () => {
    expect(parseTag("no header here")).toBeUndefined();
  });
});

describe("parseShownLines", () => {
  it("collects individual line rows", () => {
    expect([...parseShownLines("29:const (\n30:\tx := 1")]).toEqual([29, 30]);
  });
  it("does NOT count a collapsed range row as shown content", () => {
    // `88-207:func ... ( .. )` is a structural summary; the body is hidden.
    expect(parseShownLines("88-207:func newWebRtcServer(...) ( .. )").size).toBe(0);
  });
  it("counts the individual lines around a collapsed body, not the body", () => {
    const t = "86:// doc comment\n87:// more\n88-207:func f() ( .. )\n212:func g()";
    expect([...parseShownLines(t)].sort((a, b) => a - b)).toEqual([86, 87, 212]);
  });
  it("handles an anchored (*) row", () => {
    expect([...parseShownLines("*734:   turnSideConn")]).toEqual([734]);
  });
});

describe("collapsed-body regression (the cat-fallback bug)", () => {
  it("does not suppress a range read that expands a previously-collapsed body", () => {
    // Full read showed line 86/87 individually but collapsed the 88-207 body.
    const full = "[webrtc_server.go#4B36]\n86:// doc\n87:// more\n88-207:func f() ( .. )";
    evaluateRead("webrtc_server.go", parseTag(full)!, parseShownLines(full));
    // Model now reads :86-207 to SEE the body — returns individual 88..207.
    const expanded = new Set<number>();
    for (let i = 86; i <= 207; i++) expanded.add(i);
    expect(evaluateRead("webrtc_server.go", "4B36", expanded).redundant).toBe(false);
  });
});

describe("isSubset", () => {
  it("is false for an empty candidate (nothing parsed)", () => {
    expect(isSubset(new Set(), new Set([1, 2]))).toBe(false);
  });
  it("is true when every line is already shown", () => {
    expect(isSubset(new Set([2, 3]), new Set([1, 2, 3]))).toBe(true);
  });
  it("is false when a line is new", () => {
    expect(isSubset(new Set([2, 5]), new Set([1, 2, 3]))).toBe(false);
  });
});

describe("evaluateRead", () => {
  it("lets the first read through and records it", () => {
    expect(evaluateRead("f", "A1B2", new Set([1, 2, 3])).redundant).toBe(false);
  });

  it("suppresses an identical re-read at the same tag", () => {
    evaluateRead("f", "A1B2", new Set([1, 2, 3, 4, 5]));
    expect(evaluateRead("f", "A1B2", new Set([2, 3])).redundant).toBe(true);
  });

  it("lets a new range through at the same tag, then suppresses its subset", () => {
    evaluateRead("f", "A1B2", new Set([1, 2, 3]));
    expect(evaluateRead("f", "A1B2", new Set([20, 21])).redundant).toBe(false);
    expect(evaluateRead("f", "A1B2", new Set([20])).redundant).toBe(true);
  });

  it("lets content through when the tag changed (file changed) and resets", () => {
    evaluateRead("f", "A1B2", new Set([1, 2, 3]));
    // new tag → not redundant even for the same lines (real change)
    expect(evaluateRead("f", "C3D4", new Set([1, 2, 3])).redundant).toBe(false);
    // only line 1..3 are now shown at C3D4; a different line is not redundant
    expect(evaluateRead("f", "C3D4", new Set([9])).redundant).toBe(false);
  });

  it("keys per path (a different file is never redundant by coincidence)", () => {
    evaluateRead("a", "A1B2", new Set([1, 2]));
    expect(evaluateRead("b", "A1B2", new Set([1, 2])).redundant).toBe(false);
  });
});

describe("recordEdit", () => {
  it("makes a read of the just-edited region redundant at the new tag", () => {
    recordEdit("f", "EE11", new Set([50, 51, 52]));
    expect(evaluateRead("f", "EE11", new Set([51])).redundant).toBe(true);
  });
  it("does not suppress a read outside the changed region", () => {
    recordEdit("f", "EE11", new Set([50, 51, 52]));
    expect(evaluateRead("f", "EE11", new Set([99])).redundant).toBe(false);
  });
  it("does not suppress at a stale tag after the edit advanced it", () => {
    evaluateRead("f", "OLD0", new Set([1, 2, 3]));
    recordEdit("f", "NEW9", new Set([2]));
    // a read returning the OLD tag would mean the live file no longer matches —
    // never redundant against the post-edit snapshot
    expect(evaluateRead("f", "OLD0", new Set([2])).redundant).toBe(false);
  });
});

describe("shouldSuppress (size threshold)", () => {
  it("suppresses a large redundant re-read", () => {
    evaluateRead("f", "A1B2", rangeSet(1, 200));
    expect(shouldSuppress("f", "A1B2", rangeSet(1, 200))).toBe(true);
  });

  it("does NOT suppress a small redundant re-read (recency over tiny savings)", () => {
    evaluateRead("f", "A1B2", rangeSet(76, 161)); // model has 76-161
    // re-reads a 16-line slice it already holds — let it through for recency
    expect(rangeSet(143, 158).size).toBeLessThan(MIN_SUPPRESS_LINES);
    expect(shouldSuppress("f", "A1B2", rangeSet(143, 158))).toBe(false);
  });

  it("never suppresses non-redundant reads regardless of size", () => {
    evaluateRead("f", "A1B2", rangeSet(1, 50));
    expect(shouldSuppress("f", "A1B2", rangeSet(500, 600))).toBe(false);
  });
});

describe("compactNote", () => {
  it("names the path, tag, and range, and tells the model not to re-read", () => {
    const note = compactNote("pkg/a.go", "A2A9", new Set([10, 11, 12]));
    expect(note).toContain("pkg/a.go#A2A9");
    expect(note).toContain("lines 10-12");
    expect(note).toMatch(/suppressed to save context/);
  });
});
