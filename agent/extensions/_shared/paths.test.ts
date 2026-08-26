import { describe, expect, it } from "vitest";
import {
  hashlineTargetPaths,
  stripHashlineTag,
  stripReadSelector,
  writeToolTargets,
} from "./paths.ts";

describe("stripReadSelector", () => {
  it("strips every omp 17.4.0 line-range selector form", () => {
    expect(stripReadSelector("gcc.go:29")).toBe("gcc.go");
    expect(stripReadSelector("gcc.go:29-")).toBe("gcc.go");
    expect(stripReadSelector("gcc.go:29-67")).toBe("gcc.go");
    expect(stripReadSelector("gcc.go:182+150")).toBe("gcc.go");
    expect(stripReadSelector("gcc.go:5-16,960-973")).toBe("gcc.go");
    expect(stripReadSelector("gcc.go:L10")).toBe("gcc.go");
  });

  it("strips the :raw and :conflicts forms, including combined", () => {
    expect(stripReadSelector("gcc.go:raw")).toBe("gcc.go");
    expect(stripReadSelector("gcc.go:conflicts")).toBe("gcc.go");
    expect(stripReadSelector("gcc.go:2-4:raw")).toBe("gcc.go");
    expect(stripReadSelector("gcc.go:raw:2-4")).toBe("gcc.go");
  });

  it("leaves a plain path alone", () => {
    expect(stripReadSelector("internal/bwe/gcc/gcc.go")).toBe("internal/bwe/gcc/gcc.go");
  });

  it("does not eat a sqlite table selector", () => {
    // `db.sqlite:users` is a table, not a line range — stripping it would
    // point the guard at the wrong target.
    expect(stripReadSelector("db.sqlite:users")).toBe("db.sqlite:users");
  });
});

describe("hashlineTargetPaths", () => {
  it("pulls the path out of a section header", () => {
    expect(hashlineTargetPaths("[gcc.go#0DB3]\nPUT 39.=39:\n+\tx = 1"))
      .toEqual(["gcc.go"]);
  });

  it("handles several sections in one patch", () => {
    const patch = "[a/greet.py#A1B2]\nCUT 1* @fn\n[b/other.py#3C4D]\nPUT <1 @fn";
    expect(hashlineTargetPaths(patch)).toEqual(["a/greet.py", "b/other.py"]);
  });

  it("includes an MV destination", () => {
    const patch = "[greet.py#A1B2]\nPUT 1.=1:\n+x\nMV lib/greet.py";
    expect(hashlineTargetPaths(patch)).toEqual(["greet.py", "lib/greet.py"]);
  });

  it("handles a quoted MV destination with spaces", () => {
    expect(hashlineTargetPaths('[a.md#A1B2]\nMV "docs/my notes.md"'))
      .toEqual(["a.md", "docs/my notes.md"]);
  });

  it("ignores body rows that look like headers or ops", () => {
    // Body rows are always `+`-prefixed, so a literal `[x#ABCD]` or `MV y`
    // inside the new content must not be mistaken for a target.
    const patch = "[a.md#A1B2]\nPUT 1.=1:\n+[fake.go#DEAD]\n+MV nope.txt";
    expect(hashlineTargetPaths(patch)).toEqual(["a.md"]);
  });

  it("de-duplicates repeated paths", () => {
    expect(hashlineTargetPaths("[a.go#A1B2]\nPUT 1.=1:\n+x\n[a.go#A1B2]\nPUT 9.=9:\n+y"))
      .toEqual(["a.go"]);
  });
});

describe("writeToolTargets", () => {
  it("resolves `edit` through the hashline patch, not a path arg", () => {
    // omp's edit schema is literally {input: string} — there is no `path`.
    expect(writeToolTargets("edit", { input: "[gcc.go#0DB3]\nCUT 4.=4" }))
      .toEqual(["gcc.go"]);
  });

  it("accepts the `_input` spelling arg-repair normalizes from", () => {
    expect(writeToolTargets("edit", { _input: "[gcc.go#0DB3]\nCUT 4.=4" }))
      .toEqual(["gcc.go"]);
  });

  it("resolves `ast_edit` through its `paths` array", () => {
    expect(writeToolTargets("ast_edit", { paths: ["a.go", "b.go"], ops: [] }))
      .toEqual(["a.go", "b.go"]);
  });

  it("resolves `write` through its plain path", () => {
    expect(writeToolTargets("write", { path: "new.go", content: "" })).toEqual(["new.go"]);
    expect(writeToolTargets("write", { file_path: "new.go" })).toEqual(["new.go"]);
  });

  it("returns nothing when there is no resolvable target", () => {
    expect(writeToolTargets("edit", {})).toEqual([]);
    expect(writeToolTargets("edit", { input: "garbage with no header" })).toEqual([]);
    expect(writeToolTargets("ast_edit", {})).toEqual([]);
    expect(writeToolTargets("write", {})).toEqual([]);
  });
});

describe("stripHashlineTag", () => {
  it("strips a `#TAG` suffix", () => {
    expect(stripHashlineTag("gcc.go#0DB3")).toBe("gcc.go");
  });

  it("strips a `:TAG` suffix only when it contains a hex letter", () => {
    expect(stripHashlineTag("gcc.go:0DB3")).toBe("gcc.go");
    // All digits is a plausible line number — leave it.
    expect(stripHashlineTag("gcc.go:1234")).toBe("gcc.go:1234");
  });
});
