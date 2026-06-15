import { describe, expect, it } from "vitest";
import { specOf, isFileWriteTool, isSearchTool, pathArgOf } from "./taxonomy.ts";

// Guards the taxonomy against the real omp tool surface (https://omp.sh/docs/tools).
describe("taxonomy matches the real omp tool surface", () => {
  it("has no phantom `grep` or `ls` tools (search + read cover those)", () => {
    expect(specOf("grep")).toBeUndefined();
    expect(specOf("ls")).toBeUndefined();
  });

  it("classifies `search` as the regex content-search tool", () => {
    const s = specOf("search");
    expect(s?.canonical).toBe("search");
    expect(isSearchTool("search")).toBe(true);
    // No single pathArg — it scopes via the `paths` array.
    expect(pathArgOf("search")).toBeUndefined();
  });

  it("guards `ast_edit` as a file-write tool with a path arg", () => {
    // This is what makes read-before-edit require a prior read and lets
    // path-preflight existence-check the target before a structural codemod.
    expect(isFileWriteTool("ast_edit")).toBe(true);
    expect(pathArgOf("ast_edit")).toBe("path");
  });

  it("resolves the built-in `web_search` by canonical name and display alias", () => {
    expect(specOf("web_search")?.family).toBe("web");
    // "websearch" resolves via the WebSearch display name → web_search spec.
    expect(specOf("websearch")?.canonical).toBe("web_search");
  });
});
