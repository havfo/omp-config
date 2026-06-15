import { describe, expect, it } from "vitest";
import { buildReadFirstRecipe } from "./index.ts";

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
