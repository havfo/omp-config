import { describe, expect, it } from "vitest";
import { pickHint } from "./index.ts";

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
