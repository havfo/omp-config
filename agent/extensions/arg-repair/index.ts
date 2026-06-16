import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { specOf } from "../_shared/taxonomy.ts";

// Coerce common arg-shape mistakes from local models BEFORE pi rejects them.
// `tool_call`'s event.input is mutable per pi types — mutate in place.
//
// SAFE-BY-DEFAULT POLICY:
//   - alias keys to canonical names (file_path → path, cmd → command, ...)
//   - coerce stringified booleans / numbers ("true" → true, "5" → 5) when
//     the canonical key looks numeric/bool by name
//   - expand ~/ in path-like args (omp already does this internally for
//     read/edit, but doing it here means dedupe-calls and path-preflight
//     see the resolved path)
//   - re-parse `_raw` when upstream JSON repair gave up
//
// OPT-IN ONLY (OMPX_ARG_REPAIR_DROP_UNKNOWN=1):
//   - drop unknown keys. Default OFF — silently deleting a load-bearing
//     key (e.g. when the taxonomy is wrong about the canonical name) is
//     much worse than letting pi reject the call with a clear error.
//
// We log every repair via ctx.ui.notify so quality-monitor can attribute
// recoveries.

const NUMERIC_KEYS = new Set([
  "offset", "limit", "timeout", "head_limit", "context",
]);
const BOOL_KEYS = new Set([
  "replaceAll", "run_in_background", "ignoreCase", "literal",
]);

// Arg names whose values are paths. We tilde-expand them.
const PATH_VALUE_KEYS = new Set([
  "path", "file_path", "filepath", "filename",
]);

// The single-string glob-pattern arg per canonical tool. `search.pattern` is a
// REGEX and is deliberately excluded — quotes/brackets can be legitimate there
// (its glob-array scope arg `paths` is handled separately below).
const GLOB_PATTERN_ARGS: Record<string, string> = {
  find: "pattern",
};

// The ARRAY-of-globs arg per canonical tool. The model frequently serializes
// these as a JSON-stringified array ('["a/","b/"]'); the tool then splits the
// raw string on commas into broken globs ('["a/') → "unclosed character class".
const GLOB_ARRAY_ARGS: Record<string, string> = {
  search: "paths",
};

// Strip JSON-array/string artifacts a model wrongly put in a glob. Only fires
// when a quote is present, which never happens in a valid glob — so character
// classes like [0-9] (no quotes) are untouched.
function repairGlobPattern(p: string): string {
  if (!/["']/.test(p)) return p;
  return p.replace(/["'[\]]/g, "");
}

// Coerce a glob-array arg into a clean string[]. Handles: a real array (clean
// each element), a JSON-stringified array (parse it), and a stringified array
// that is itself malformed/truncated (e.g. missing the closing ']') by
// stripping brackets/quotes and splitting on commas. Returns undefined when the
// value is already a clean array needing no change.
function repairGlobArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((el) => {
      if (typeof el !== "string") return el;
      const fixed = repairGlobPattern(el);
      if (fixed !== el) changed = true;
      return fixed;
    });
    return changed ? (out as string[]) : undefined;
  }
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (!s.startsWith("[")) return undefined; // not an array-shaped string
  const parsed = relaxedJson(s);
  if (Array.isArray(parsed)) {
    return parsed.map((el) => (typeof el === "string" ? repairGlobPattern(el) : el)) as string[];
  }
  // Malformed/truncated array string — salvage by stripping brackets/quotes
  // and splitting on commas.
  return s
    .replace(/[[\]"']/g, "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function relaxedJson(s: string): unknown | undefined {
  // Strip trailing commas inside ] and }; collapse smart quotes.
  const cleaned = s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
  try { return JSON.parse(cleaned); } catch { return undefined; }
}

// A hashline section header is `[PATH#TAG]` where TAG is 4 uppercase hex
// (`computeFileHash` always emits uppercase; the tokenizer matches `[0-9A-F]{4}`
// only). Models copying the header from `read`/`search` output mangle it in a
// few mechanical ways: re-wrapping in extra brackets (`[[PATH#TAG]`), doubling
// the closer (`[PATH#TAG]]`), dropping the closer (`[PATH#TAG`), or lowercasing
// the tag (`#a2a9`). This matches any such header line and rebuilds the
// canonical form. The greedy `.*` backtracks so the trailing `#XXXX` anchors as
// the tag. Body rows (`+…`) never start with `[`, so they can't match.
const HASHLINE_HEADER = /^\s*\[+\s*(.*?)\s*#([0-9A-Fa-f]{4})\s*\]*\s*$/;

// Op lines whose leading keyword may have been lowercased. Each keyword is
// matched case-insensitively but only when followed by its expected operand
// shape (a line number, or a colon for HEAD/TAIL), so a lowercase keyword in a
// bare body line like `del 3 rows` is far less likely to be clobbered.
const HASHLINE_OP_NUMBERED =
  /^(\s*)(SWAP\.BLK|DEL\.BLK|INS\.BLK\.POST|INS\.PRE|INS\.POST|SWAP|DEL)(\s+[1-9].*)$/i;
const HASHLINE_OP_HEADTAIL = /^(\s*)(INS\.HEAD|INS\.TAIL)(\s*:.*)$/i;

// Repair the most common hashline syntax mistakes small models make in an
// `edit` patch. Applied per line:
//   1. Header: normalize `[[PATH#TAG]` / `[PATH#TAG]]` / `[PATH#TAG` / `#a2a9`
//      (lowercase tag) to the canonical `[PATH#TAG]` with an uppercase tag.
//   2. Op keyword case: `swap`/`del`/`ins.post` → `SWAP`/`DEL`/`INS.POST`.
//   2b. Range separator: read ranges are `N-M`, edit ranges are `N.=M`. Models
//      carry the read form into a hunk header (`SWAP 560-571:`), which won't
//      parse → "payload line has no preceding hunk header". Convert `-` → `.=`.
//   3. DEL/SWAP confusion: a `DEL` has NO colon and NO body; `SWAP` has both.
//      Models write `DEL N.=M:` + `+body` when they mean REPLACE — that's a SWAP.
//        - DEL header ending in `:` WITH `+body` after it → convert to SWAP
//        - DEL header ending in `:` WITHOUT body          → strip the stray colon
export function repairHashlinePatch(patch: string): { patch: string; fixes: string[] } {
  const lines = patch.split("\n");
  const fixes: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    // 1. Header normalization (brackets + tag case).
    const h = lines[i].match(HASHLINE_HEADER);
    if (h) {
      const canonical = `[${h[1]}#${h[2].toUpperCase()}]`;
      if (canonical !== lines[i]) {
        const bracketsChanged = !/^\[[^[\]]*\]$/.test(lines[i].trim());
        if (bracketsChanged) fixes.push("header-normalize-brackets");
        if (h[2] !== h[2].toUpperCase()) fixes.push("header-tag-uppercase");
        lines[i] = canonical;
      }
      continue;
    }

    // 2. Op keyword case-normalization.
    const op = lines[i].match(HASHLINE_OP_NUMBERED) ?? lines[i].match(HASHLINE_OP_HEADTAIL);
    if (op && op[2] !== op[2].toUpperCase()) {
      lines[i] = `${op[1]}${op[2].toUpperCase()}${op[3]}`;
      fixes.push("op-keyword-uppercase");
    }

    // 2b. Range separator: `SWAP 560-571:` / `DEL 8-10` → `.=` form. Only the
    //     concrete SWAP/DEL ops take a range; `.BLK`/`INS` forms don't (a `-`
    //     after `SWAP`/`DEL` + whitespace is unambiguously a mis-typed range).
    const rng = lines[i].match(/^(\s*)(SWAP|DEL)(\s+)(\d+)-(\d+)(.*)$/);
    if (rng) {
      lines[i] = `${rng[1]}${rng[2]}${rng[3]}${rng[4]}.=${rng[5]}${rng[6]}`;
      fixes.push("range-sep-fix");
    }

    // 3. DEL-with-body → SWAP, or strip a stray trailing colon from a bodyless DEL.
    const m = lines[i].match(/^(\s*)(DEL(?:\.BLK)?)(\s+\S.*?):\s*$/);
    if (!m) continue;
    const hasBody = /^\s*\+/.test(lines[i + 1] ?? "");
    if (hasBody) {
      lines[i] = `${m[1]}${m[2].replace(/^DEL/, "SWAP")}${m[3]}:`;
      fixes.push("del-with-body→swap");
    } else {
      lines[i] = `${m[1]}${m[2]}${m[3]}`; // strip the stray trailing colon
      fixes.push("del-strip-colon");
    }
  }
  return { patch: lines.join("\n"), fixes };
}

function coerceScalar(key: string, val: unknown): unknown {
  if (typeof val === "string") {
    if (BOOL_KEYS.has(key)) {
      if (val === "true") return true;
      if (val === "false") return false;
    }
    if (NUMERIC_KEYS.has(key)) {
      const n = Number(val);
      if (!Number.isNaN(n)) return n;
    }
  }
  return val;
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

// Strip a hashline snapshot tag the model wrongly appended to a READ path.
// omp's edit format anchors hunks as `[PATH#TAG]` where TAG is a 4-hex content
// hash that changes after every edit. Models conflate that with the read
// line-range selector and read `gcc.go:29:0DB3` (or `gcc.go#0DB3`) trying to
// "refresh the tag" — but the read grammar is `path:LINE-RANGE`, so the tag is
// junk, the read fails to return a clean new tag, and the model loops re-reading.
// Strip the tag so the read succeeds; the result carries the fresh tag anyway.
//   - `#XXXX` at end → always a tag (that's the anchor separator).
//   - `:XXXX` at end where XXXX is 4 hex WITH a letter → a tag, not a line range
//     (ranges are digits, optionally `L`-prefixed), so it's safe to drop.
function stripHashlineTag(p: string): string {
  const hashForm = p.replace(/#[0-9a-fA-F]{4}$/, "");
  if (hashForm !== p) return hashForm;
  const m = p.match(/^(.*):([0-9a-fA-F]{4})$/);
  if (m && /[a-fA-F]/.test(m[2]) && !/^L/i.test(m[2])) return m[1];
  return p;
}

// Convert a hashline edit-range separator the model leaked into a READ path
// selector. Read ranges are `path:START-END` (e.g. `server.go:130-160`), but
// models conflate this with the edit-hunk range `130.=160` and read
// `server.go:130.=160` → "file does not exist". A `digit.=digit` sequence is
// unambiguous (real paths never contain it), so rewrite `.=` → `-`.
function repairReadRangeSep(p: string): string {
  return p.replace(/(\d)\.=(\d)/g, "$1-$2");
}

function dropUnknownEnabled(): boolean {
  return process.env.OMPX_ARG_REPAIR_DROP_UNKNOWN === "1";
}

export interface RepairReport {
  aliased: string[];
  dropped: string[];
  coerced: string[];
  expanded: string[];
  parsedRaw: boolean;
}

export function repairArgs(
  toolName: string,
  input: Record<string, unknown>,
  options?: { dropUnknown?: boolean },
): RepairReport {
  const report: RepairReport = {
    aliased: [], dropped: [], coerced: [], expanded: [], parsedRaw: false,
  };
  const spec = specOf(toolName);
  if (!spec) return report;

  // 0. _raw rescue
  if (typeof input._raw === "string") {
    const parsed = relaxedJson(input._raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      delete input._raw;
      Object.assign(input, parsed as Record<string, unknown>);
      report.parsedRaw = true;
    }
  }

  // 0b. Unwrap nested "arguments"/"parameters" wrapper — Qwen sometimes
  // emits {name: "edit", arguments: {path: "...", ...}} where the actual
  // args are nested one level too deep.
  for (const wrapper of ["arguments", "parameters", "args"]) {
    if (wrapper in input && typeof input[wrapper] === "object" && input[wrapper] !== null) {
      const inner = input[wrapper] as Record<string, unknown>;
      // Only unwrap if the wrapper key is NOT a known arg itself
      if (!spec.knownArgs.includes(wrapper)) {
        delete input[wrapper];
        Object.assign(input, inner);
        report.aliased.push(`unwrap:${wrapper}`);
      }
    }
  }

  // 0c. Stringified arguments — model sent the args as a JSON string
  for (const wrapper of ["arguments", "parameters", "input"]) {
    if (typeof input[wrapper] === "string" && !spec.knownArgs.includes(wrapper)) {
      const parsed = relaxedJson(input[wrapper] as string);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        delete input[wrapper];
        Object.assign(input, parsed as Record<string, unknown>);
        report.parsedRaw = true;
      }
    }
  }

  // 1. Alias unknown keys to canonical
  if (spec.argAliases) {
    for (const [bad, good] of Object.entries(spec.argAliases)) {
      const lower = bad.toLowerCase();
      for (const k of Object.keys(input)) {
        if (k.toLowerCase() === lower && k !== good && !(good in input)) {
          input[good] = input[k];
          delete input[k];
          report.aliased.push(`${k}→${good}`);
        }
      }
    }
  }

  // 2. Drop unknown keys (opt-in only — see header comment)
  const drop = options?.dropUnknown ?? dropUnknownEnabled();
  if (drop) {
    const known = new Set(spec.knownArgs);
    for (const k of Object.keys(input)) {
      if (!known.has(k)) {
        delete input[k];
        report.dropped.push(k);
      }
    }
  }

  // 3. Coerce scalars + tilde-expand path-like values
  for (const k of Object.keys(input)) {
    const before = input[k];
    const after = coerceScalar(k, before);
    if (after !== before) {
      input[k] = after;
      report.coerced.push(`${k}:${typeof after}`);
    }
    if (PATH_VALUE_KEYS.has(k) && typeof input[k] === "string") {
      const orig = input[k] as string;
      const exp = expandTilde(orig);
      if (exp !== orig) {
        input[k] = exp;
        report.expanded.push(k);
      }
    }
  }

  // 4. Repair glob patterns where the model serialized a JSON array/string
  //    into the pattern, e.g. {["src/","lib/**/*"]} instead of brace
  //    alternation {src,lib/**/*}. pi's native glob auto-closes braces but not
  //    the character class that the stray `[` opens → "unclosed character
  //    class". Real globs never contain quotes, so a quote is an unambiguous
  //    signal; legit char classes like [0-9] are left untouched.
  // 3b. Strip a stray hashline tag the model appended to a READ path
  //     (e.g. "gcc.go:29:0DB3" → "gcc.go:29"), which otherwise breaks the read
  //     and sends the model into a tag-refresh re-read loop.
  if (spec.family === "file-read" && spec.pathArg && typeof input[spec.pathArg] === "string") {
    const before = input[spec.pathArg] as string;
    const tagStripped = stripHashlineTag(before);
    if (tagStripped !== before) {
      input[spec.pathArg] = tagStripped;
      report.coerced.push(`${spec.pathArg}:hashline-tag`);
    }
    const rangeFixed = repairReadRangeSep(input[spec.pathArg] as string);
    if (rangeFixed !== input[spec.pathArg]) {
      input[spec.pathArg] = rangeFixed;
      report.coerced.push(`${spec.pathArg}:read-range-sep`);
    }
  }

  const globArg = GLOB_PATTERN_ARGS[spec.canonical];
  if (globArg && typeof input[globArg] === "string") {
    const before = input[globArg] as string;
    const after = repairGlobPattern(before);
    if (after !== before) {
      input[globArg] = after;
      report.coerced.push(`${globArg}:glob-array`);
    }
  }

  // 4b. Repair common hashline op-syntax mistakes in an `edit` patch (DEL used
  //     where SWAP was meant, or a DEL with a stray trailing colon).
  if (spec.canonical === "edit" && typeof input.input === "string") {
    const { patch, fixes } = repairHashlinePatch(input.input);
    if (fixes.length) {
      input.input = patch;
      for (const f of fixes) report.coerced.push(`input:${f}`);
    }
  }

  // 5. Repair ARRAY-of-globs args (e.g. search.paths) that the model serialized
  //    as a JSON-stringified array, or as a malformed/truncated array string.
  const globArrayArg = GLOB_ARRAY_ARGS[spec.canonical];
  if (globArrayArg && globArrayArg in input) {
    const fixed = repairGlobArray(input[globArrayArg]);
    if (fixed !== undefined) {
      input[globArrayArg] = fixed;
      report.coerced.push(`${globArrayArg}:glob-array[]`);
    }
  }

  return report;
}

function summarize(r: RepairReport): string | undefined {
  const parts: string[] = [];
  if (r.parsedRaw) parts.push("re-parsed _raw");
  if (r.aliased.length) parts.push(`aliased ${r.aliased.join(",")}`);
  if (r.dropped.length) parts.push(`dropped ${r.dropped.join(",")}`);
  if (r.coerced.length) parts.push(`coerced ${r.coerced.join(",")}`);
  if (r.expanded.length) parts.push(`expanded ${r.expanded.join(",")}`);
  return parts.length ? parts.join("; ") : undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const toolName = (event as any).toolName;
    const input = (event as any).input;
    if (!toolName || !input || typeof input !== "object") return;
    const report = repairArgs(toolName, input as Record<string, unknown>);
    const msg = summarize(report);
    if (msg) {
      try { ctx.ui.notify(`arg-repair[${toolName}]: ${msg}`, "info"); } catch {}
    }
  });
}
