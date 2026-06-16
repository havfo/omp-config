import { describe, expect, it } from "vitest";
import { pickHint, pickNoopHint } from "./index.ts";

describe("pickHint", () => {
  it("matches ENOENT to a Glob suggestion", () => {
    expect(pickHint("read", "ENOENT: no such file or directory")).toMatch(/Glob/);
  });
  it("matches old_string-not-found per-tool hint over generic", () => {
    expect(pickHint("edit", "old_string was not found")).toMatch(/2-3 lines/);
  });
  it("matches whitelist failure", () => {
    expect(pickHint("bash", "bash whitelist: rm not in SAFE_PREFIXES")).toMatch(/whitelisted prefix/);
  });
  it("returns undefined for unknown errors", () => {
    expect(pickHint("read", "kernel panic")).toBeUndefined();
  });
});

describe("pickNoopHint", () => {
  it("coaches a byte-identical no-op edit", () => {
    expect(pickNoopHint("parsed and applied cleanly, but produced no change: your body row(s) are byte-identical"))
      .toMatch(/changed nothing/);
  });
  it("coaches an ast_edit with no replacements", () => {
    expect(pickNoopHint("No replacements made")).toMatch(/changed nothing/);
  });
  it("returns undefined for a normal successful result", () => {
    expect(pickNoopHint("Successfully wrote 7474 bytes to file.go")).toBeUndefined();
  });
});
