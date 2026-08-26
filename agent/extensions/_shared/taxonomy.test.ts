import { describe, expect, it } from "vitest";
import { specOf, isFileWriteTool, isSearchTool, pathArgOf } from "./taxonomy.ts";

// Guards the taxonomy against the real omp tool surface (https://omp.sh/docs/tools).
describe("taxonomy matches the real omp tool surface", () => {
  it("has no phantom `ls` tool, and no stale `search`/`find` (renamed in 16.2.x)", () => {
    expect(specOf("ls")).toBeUndefined();
    expect(specOf("search")).toBeUndefined();
    expect(specOf("find")).toBeUndefined();
  });

  it("classifies `grep` as the regex content-search tool", () => {
    const s = specOf("grep");
    expect(s?.canonical).toBe("grep");
    expect(isSearchTool("grep")).toBe(true);
    // One `path` string scope arg (semicolon-delimited), not a `paths` array.
    expect(pathArgOf("grep")).toBe("path");
    expect(s?.knownArgs).toContain("case");
    expect(s?.knownArgs).not.toContain("paths");
  });

  it("classifies `glob` as the file-name lookup tool with no pattern arg", () => {
    const s = specOf("glob");
    expect(s?.canonical).toBe("glob");
    expect(isSearchTool("glob")).toBe(true);
    expect(pathArgOf("glob")).toBe("path");
    // The glob itself goes in `path` — a stray `pattern` is aliased onto it.
    expect(s?.knownArgs).not.toContain("pattern");
    expect(s?.argAliases?.pattern).toBe("path");
  });

  it("guards `ast_edit` as a file-write tool with NO singular path arg", () => {
    // ast_edit is {ops:[{pat,out}], paths:string[]} — its scope is a real
    // ARRAY under `paths`, and there is no singular `path`. Leaving pathArg
    // unset makes read-before-edit and path-preflight skip it rather than
    // gate on a key that never exists; write-side gates still see it.
    expect(isFileWriteTool("ast_edit")).toBe(true);
    expect(pathArgOf("ast_edit")).toBeUndefined();
    expect(specOf("ast_edit")?.knownArgs).toEqual(["ops", "paths"]);
  });

  it("uses `pat` (not `pattern`) for ast_grep and has no `lang` arg", () => {
    const s = specOf("ast_grep");
    expect(s?.knownArgs).toContain("pat");
    expect(s?.knownArgs).not.toContain("pattern");
    expect(s?.knownArgs).not.toContain("lang");
    expect(s?.argAliases?.pattern).toBe("pat");
  });

  it("tracks bash's real args — cwd/env/pty, no Claude-isms", () => {
    const s = specOf("bash");
    expect(s?.knownArgs).toEqual(["command", "env", "timeout", "cwd", "pty", "async"]);
    expect(s?.knownArgs).not.toContain("description");
    expect(s?.argAliases?.run_in_background).toBe("async");
  });

  it("keeps `read` at a single `path` arg (offset/limit were removed)", () => {
    expect(specOf("read")?.knownArgs).toEqual(["path"]);
  });

  it("resolves the built-in `web_search` by canonical name and display alias", () => {
    expect(specOf("web_search")?.family).toBe("web");
    // "websearch" resolves via the WebSearch display name → web_search spec.
    expect(specOf("websearch")?.canonical).toBe("web_search");
  });
});
