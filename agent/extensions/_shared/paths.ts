// Shared read-path selector handling, used by path-preflight,
// read-before-edit and redundant-read-guard. Kept in one place because all
// three key state off "the path with its selector removed", and three
// divergent copies meant a `:50+150` or `:raw` read silently missed the
// guard in some of them.
//
// omp 17.4.0 read selectors (src/prompts/tools/read.md):
//   :50  :50-  :50-200  :50+150  :5-16,960-973   line ranges
//   :raw                                          verbatim, no line prefixes
//   :conflicts                                    unresolved merge conflicts
//   :2-4:raw / :raw:2-4                            combined
// SQLite/archive member selectors (`db.sqlite:table:key`, `a.zip:path/in/zip`)
// are deliberately NOT stripped — they are not line ranges and the remaining
// path would be wrong.

const RANGE_CHUNK = String.raw`L?\d+(?:(?:[-+]|\.\.)L?\d+|-|\.\.)?`;
const RANGE_LIST = `${RANGE_CHUNK}(?:,${RANGE_CHUNK})*`;
const READ_SELECTOR_TAIL = new RegExp(`(?::(?:${RANGE_LIST}|raw|conflicts))+$`, "i");

/**
 * A hashline snapshot tag the model may have appended to a read path:
 * `#XXXX` (always a tag) or `:XXXX` where XXXX is 4 hex containing a letter
 * (a bare line number is digits, optionally L-prefixed).
 */
export function stripHashlineTag(p: string): string {
  const hashForm = p.replace(/#[0-9a-fA-F]{4}$/, "");
  if (hashForm !== p) return hashForm;
  const m = p.match(/^(.*):([0-9a-fA-F]{4})$/);
  if (m && /[a-fA-F]/.test(m[2]) && !/^L/i.test(m[2])) return m[1];
  return p;
}

/** Path with any trailing read selector and snapshot tag removed. */
export function stripReadSelector(p: string): string {
  return stripHashlineTag(p).replace(READ_SELECTOR_TAIL, "");
}

// ── Write-tool target resolution ────────────────────────────────────────
//
// omp's `edit` takes exactly ONE argument — `input`, the hashline patch
// (verified against 18.0.1's `hashlineEditParamsSchema`, which is literally
// `{input: "string"}`). There is NO `path` argument: every target file is
// named by a `[PATH#TAG]` section header INSIDE the patch, and an `MV DEST`
// op can rename it mid-patch. `ast_edit` likewise scopes with a `paths`
// ARRAY and has no singular `path`.
//
// Any extension that does `input.path ?? input.file_path` therefore reads
// `undefined` for both tools and silently skips them — which is exactly how
// syntax-guard came to run on `write` only.

/** A `[PATH#TAG]` section header line. Body rows are `+`-prefixed, so they can't match. */
const HASHLINE_HEADER_LINE = /^\s*\[\s*(.+?)\s*#[0-9A-Fa-f]{4}\s*\]\s*$/;
/** `MV DEST` / `MV "DEST WITH SPACES"` — final content lands at DEST. */
const HASHLINE_MV_OP = /^\s*MV\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/i;

/**
 * Every file a hashline patch touches: each section's header path, plus the
 * destination of any `MV` rename. Order-preserving and de-duplicated.
 */
export function hashlineTargetPaths(patch: string): string[] {
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const header = HASHLINE_HEADER_LINE.exec(line);
    if (header?.[1]) {
      out.push(header[1]);
      continue;
    }
    const mv = HASHLINE_MV_OP.exec(line);
    if (mv) {
      const dest = mv[1] ?? mv[2] ?? mv[3];
      if (dest) out.push(dest);
    }
  }
  return [...new Set(out)];
}

/**
 * The file paths a file-write tool call will actually touch, for any of omp's
 * write-side shapes: `edit` (hashline headers), `ast_edit` (`paths` array), and
 * `write` (plain `path`). Returns [] when nothing resolvable is present.
 */
export function writeToolTargets(toolName: string, input: unknown): string[] {
  const name = (toolName ?? "").toLowerCase();
  const args = (input ?? {}) as Record<string, unknown>;

  if (name === "edit") {
    const patch =
      typeof args.input === "string" ? args.input
      : typeof args._input === "string" ? args._input
      : "";
    return patch ? hashlineTargetPaths(patch) : [];
  }

  if (name === "ast_edit") {
    const paths = args.paths;
    if (!Array.isArray(paths)) return [];
    return [...new Set(paths.filter((p): p is string => typeof p === "string" && p !== ""))];
  }

  const single = args.path ?? args.file_path;
  return typeof single === "string" && single ? [single] : [];
}
