import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, basename } from "node:path";
import { evaluatePath } from "./index.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("evaluatePath", () => {
  it("rejects bracketed placeholder paths", () => {
    expect(evaluatePath("read", "/tmp/<FILENAME>.ts").ok).toBe(false);
    expect(evaluatePath("read", "/tmp/{TODO}.ts").ok).toBe(false);
  });
  it("does NOT treat real filenames containing TODO/FIXME as placeholders", () => {
    // Regression: `docs/TODO.md` was blocked because the regex matched \bTODO\b.
    const r = evaluatePath("read", __filename.replace(basename(__filename), "TODO.md"), __dirname);
    // File doesn't exist, but the reason must be "does not exist", NOT "placeholder".
    if (!r.ok) expect(r.reason).not.toMatch(/placeholder/);
  });
  it("resolves relative paths against cwd instead of rejecting them", () => {
    // The test file exists relative to its own directory.
    const r = evaluatePath("read", basename(__filename), __dirname);
    expect(r.ok).toBe(true);
  });
  it("accepts a Read line-range selector (pi parses it natively)", () => {
    // Regression: `file:182-376` was existence-checked literally and blocked.
    expect(evaluatePath("read", `${__filename}:182-376`).ok).toBe(true);
    expect(evaluatePath("read", `${__filename}:10`).ok).toBe(true);
    expect(evaluatePath("read", `${__filename}:1-5,20-25`).ok).toBe(true);
    expect(evaluatePath("read", `${__filename}:raw`).ok).toBe(true);
    // Relative + selector together.
    expect(evaluatePath("read", `${basename(__filename)}:182-376`, __dirname).ok).toBe(true);
  });
  it("still blocks a ranged read of a genuinely missing file", () => {
    const r = evaluatePath("read", "/tmp/__nope_42__.ts:10-20");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not exist/);
  });
  it("rejects missing absolute paths for read/edit", () => {
    const r = evaluatePath("read", "/tmp/__definitely_not_here_42__.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not exist/);
  });
  it("accepts an existing absolute path", () => {
    const r = evaluatePath("read", __filename);
    expect(r.ok).toBe(true);
  });
  it("tolerates a stray hashline tag on a read path (range + tag, and #-form)", () => {
    expect(evaluatePath("read", `${__filename}:1-5:0DB3`).ok).toBe(true);
    expect(evaluatePath("read", `${__filename}#78F3`).ok).toBe(true);
  });
  it("does not filesystem-check scheme:// read targets (read now accepts URLs/URIs)", () => {
    // read handles web URLs, internal URIs, sqlite, archives — none are paths on
    // disk, so existsSync must be skipped instead of blocking with "file does not exist".
    for (const uri of [
      "https://example.org/page",
      "agent://abc123/output",
      "vault://notes/today",
      "sqlite:///tmp/db.sqlite?table=rows",
    ]) {
      expect(evaluatePath("read", uri).ok, uri).toBe(true);
    }
  });
});
