import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
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

// Numeric/boolean args omp actually has (17.4.0): glob.limit, bash.timeout,
// grep.skip / ast_grep.skip, web_search.limit, and the boolean flags on
// glob/grep/bash. Local models routinely send these as strings.
const NUMERIC_KEYS = new Set([
  "limit", "timeout", "skip", "max_tokens", "num_search_results",
]);
const BOOL_KEYS = new Set([
  "hidden", "gitignore", "case", "pty", "async",
]);

// Arg names whose values are paths. We tilde-expand them.
const PATH_VALUE_KEYS = new Set([
  "path", "file_path", "filepath", "filename",
]);

// The SEMICOLON-delimited path-scope arg per canonical tool. omp's `grep` and
// `glob` both take their scope as ONE string where multiple targets are joined
// with `;` ("internal/bwe/**;cmd/"). Models trained on array-shaped search
// tools send a real array, or a JSON-stringified one ('["a/","b/"]'), and the
// tool then reads the whole thing as a single broken glob → "unclosed
// character class". We normalize all of those back to one `;` string.
// `grep.pattern` is a REGEX and is deliberately excluded — quotes and brackets
// can be legitimate there. `glob` has no pattern arg at all (the taxonomy
// aliases a stray `pattern` onto `path` before we get here).
const PATH_LIST_ARGS: Record<string, string> = {
  grep: "path",
  glob: "path",
};

// Spellings of the OLD ignore-case flag. omp replaced `i` with `case`, whose
// meaning is INVERTED (case === true means case-SENSITIVE, and it is the
// default), so a straight alias would silently flip the model's intent.
const IGNORE_CASE_KEYS = ["i", "ignore_case", "ignorecase", "ignoreCase"];

// Strip JSON-array/string artifacts a model wrongly put in a glob. Only fires
// when a quote is present, which never happens in a valid glob — so character
// classes like [0-9] (no quotes) are untouched.
function repairGlobPattern(p: string): string {
  if (!/["']/.test(p)) return p;
  return p.replace(/["'[\]]/g, "");
}

// Coerce a path-scope arg into omp's single `;`-delimited string. Handles: a
// real array (clean each element, join), a JSON-stringified array (parse it),
// a stringified array that is itself malformed/truncated (e.g. missing the
// closing ']') by stripping brackets/quotes and splitting on commas, and a
// plain string carrying JSON artifacts. Returns undefined when the value is
// already a clean string needing no change.
function repairPathList(value: unknown): string | undefined {
  const clean = (parts: unknown[]): string =>
    parts
      .filter((el): el is string => typeof el === "string")
      .map((el) => repairGlobPattern(el).trim())
      .filter((el) => el.length > 0)
      .join(";");

  if (Array.isArray(value)) return clean(value);

  if (typeof value !== "string") return undefined;
  const s = value.trim();

  if (s.startsWith("[")) {
    const parsed = relaxedJson(s);
    if (Array.isArray(parsed)) return clean(parsed);
    // Malformed/truncated array string — salvage by stripping brackets/quotes
    // and splitting on commas.
    return clean(s.replace(/[[\]"']/g, "").split(","));
  }

  // A bare string: the model may still have comma-joined several paths, which
  // omp would read as one literal glob. Only split when a comma is present AND
  // no `;` already is, so an intentional `;` list is left alone and a filename
  // legitimately containing a comma in a single-path call is not mangled.
  if (s.includes(",") && !s.includes(";")) {
    const fixed = clean(s.split(","));
    return fixed === s ? undefined : fixed;
  }

  const fixed = repairGlobPattern(s);
  return fixed === s ? undefined : fixed;
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

// LEGACY DIALECT. omp 17.4.0 (hashline 17.4.0) replaced the SWAP/DEL/INS.*
// ops with PUT/CUT/REM/MV. `grammar.lark` carries NO alias for the old
// keywords, so a carried-over `SWAP 39.=39:` is a hard parse error, not a
// warning. These rules translate each old keyword+operand shape into the
// current form; a trailing colon is preserved so the CUT/PUT colon rules
// below can still sort out delete-vs-replace.
const LEGACY_OPS: { re: RegExp; to: (m: RegExpMatchArray) => string; fix: string }[] = [
  { re: /^(\s*)INS\.BLK\.POST(\s+)([1-9]\d*)\s*:(.*)$/i,
    to: m => `${m[1]}PUT >${m[3]}*:${m[4]}`, fix: "ins.blk.post→put" },
  { re: /^(\s*)INS\.PRE(\s+)([1-9]\d*)\s*:(.*)$/i,
    to: m => `${m[1]}PUT <${m[3]}:${m[4]}`, fix: "ins.pre→put" },
  { re: /^(\s*)INS\.POST(\s+)([1-9]\d*)\s*:(.*)$/i,
    to: m => `${m[1]}PUT >${m[3]}:${m[4]}`, fix: "ins.post→put" },
  { re: /^(\s*)INS\.HEAD\s*:(.*)$/i, to: m => `${m[1]}PUT <1:${m[2]}`, fix: "ins.head→put" },
  { re: /^(\s*)INS\.TAIL\s*:(.*)$/i, to: m => `${m[1]}PUT >$:${m[2]}`, fix: "ins.tail→put" },
  { re: /^(\s*)SWAP\.BLK(\s+)([1-9]\d*)\s*:(.*)$/i,
    to: m => `${m[1]}PUT ${m[3]}*:${m[4]}`, fix: "swap.blk→put" },
  { re: /^(\s*)DEL\.BLK(\s+)([1-9]\d*)\s*(:?)\s*$/i,
    to: m => `${m[1]}CUT ${m[3]}*${m[4]}`, fix: "del.blk→cut" },
  { re: /^(\s*)SWAP(\s+[<>1-9].*)$/i, to: m => `${m[1]}PUT${m[2]}`, fix: "swap→put" },
  { re: /^(\s*)DEL(\s+[<>1-9].*)$/i, to: m => `${m[1]}CUT${m[2]}`, fix: "del→cut" },
];

// Current-dialect op lines whose leading keyword may have been lowercased.
// Matched case-insensitively but only when followed by the expected operand
// shape, so a lowercase keyword in a bare body line is far less likely to be
// clobbered. Body rows start with `+` and never match any of these.
const HASHLINE_OP_PUTCUT = /^(\s*)(PUT|CUT)(\s+[<>1-9].*)$/i;
const HASHLINE_OP_REM = /^(\s*)(REM)(\s*)$/i;
const HASHLINE_OP_MV = /^(\s*)(MV)(\s+\S.*)$/i;

// A locator with no register and no trailing colon: `39.=41`, `12*`, `<7`,
// `>7`, `>7*`, `>$`. Used to spot a `PUT` that dropped its colon.
const PUT_LOCATOR = /(?:[1-9]\d*\.=[1-9]\d*|[1-9]\d*\*|<[1-9]\d*|>[1-9]\d*\*?|>\$)/;
const PUT_MISSING_COLON = new RegExp(`^(\\s*)PUT(\\s+)(${PUT_LOCATOR.source})\\s*$`);
const REGISTER_PASTE = /^(\s*)(PUT|CUT)(\s+\S.*\s@[A-Za-z0-9_-]+):\s*$/;

// Repair the most common hashline syntax mistakes small models make in an
// `edit` patch. Applied per line:
//   1. Header: normalize `[[PATH#TAG]` / `[PATH#TAG]]` / `[PATH#TAG` / `#a2a9`
//      (lowercase tag) to the canonical `[PATH#TAG]` with an uppercase tag.
//   2. Legacy dialect: SWAP/DEL/INS.* → PUT/CUT (see LEGACY_OPS).
//   3. Op keyword case: `put`/`cut`/`rem`/`mv` → uppercase.
//   3b. Range separator: read ranges are `N-M`, edit ranges are `N.=M`. Models
//      carry the read form into a hunk header (`PUT 560-571:`), which won't
//      parse → "payload line has no preceding hunk header". Convert `-` → `.=`.
//   4. CUT/PUT confusion: a `CUT` has NO colon and NO body; a `PUT` range op
//      has both. Models write `CUT N.=M:` + `+body` when they mean REPLACE.
//        - CUT header ending in `:` WITH `+body` after it → convert to PUT
//        - CUT header ending in `:` WITHOUT body          → strip the stray colon
//        - PUT locator with NO colon but `+body` after it → add the colon
//        - register paste (`PUT >40 @fn`) is bodyless     → strip a stray colon
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

    // 2. Legacy op keywords → current dialect.
    for (const rule of LEGACY_OPS) {
      const m = lines[i].match(rule.re);
      if (!m) continue;
      lines[i] = rule.to(m);
      fixes.push(rule.fix);
      break;
    }

    // 3. Op keyword case-normalization.
    const op = lines[i].match(HASHLINE_OP_PUTCUT)
      ?? lines[i].match(HASHLINE_OP_REM)
      ?? lines[i].match(HASHLINE_OP_MV);
    if (op && op[2] !== op[2].toUpperCase()) {
      lines[i] = `${op[1]}${op[2].toUpperCase()}${op[3]}`;
      fixes.push("op-keyword-uppercase");
    }

    // 3b. Range separator: `PUT 560-571:` / `CUT 8-10` → `.=` form. Gap and
    //     block locators start with `<`/`>` or end in `*`, so a bare `N-M`
    //     after `PUT`/`CUT` is unambiguously a mis-typed range.
    const rng = lines[i].match(/^(\s*)(PUT|CUT)(\s+)(\d+)-(\d+)(.*)$/);
    if (rng) {
      lines[i] = `${rng[1]}${rng[2]}${rng[3]}${rng[4]}.=${rng[5]}${rng[6]}`;
      fixes.push("range-sep-fix");
    }

    const hasBody = /^\s*\+/.test(lines[i + 1] ?? "");

    // 4a. A register paste takes no body — drop a stray trailing colon.
    const reg = lines[i].match(REGISTER_PASTE);
    if (reg && !hasBody) {
      lines[i] = `${reg[1]}${reg[2]}${reg[3]}`;
      fixes.push("register-strip-colon");
      continue;
    }

    // 4b. A `PUT` locator that lost its colon but has body rows under it.
    const noColon = lines[i].match(PUT_MISSING_COLON);
    if (noColon && hasBody) {
      lines[i] = `${noColon[1]}PUT${noColon[2]}${noColon[3]}:`;
      fixes.push("put-add-colon");
      continue;
    }

    // 4c. CUT-with-body → PUT, or strip a stray trailing colon from a CUT.
    const m = lines[i].match(/^(\s*)CUT(\s+\S.*?):\s*$/);
    if (!m) continue;
    if (hasBody) {
      lines[i] = `${m[1]}PUT${m[2]}:`;
      fixes.push("cut-with-body→put");
    } else {
      lines[i] = `${m[1]}CUT${m[2]}`; // strip the stray trailing colon
      fixes.push("cut-strip-colon");
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
        // Treat a present-but-null/undefined canonical key as absent: models
        // (and upstream JSON repair) emit `{"pattern":"**/*.go","path":null}`,
        // and `good in input` alone would refuse the alias and leave the value
        // stranded on the wrong key.
        const canonicalEmpty = input[good] === undefined || input[good] === null;
        if (k.toLowerCase() === lower && k !== good && canonicalEmpty) {
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

  // 4b. Repair common hashline op-syntax mistakes in an `edit` patch (the dead
  //     SWAP/DEL/INS.* dialect, CUT used where PUT was meant, stray colons).
  if (spec.canonical === "edit" && typeof input.input === "string") {
    const { patch, fixes } = repairHashlinePatch(input.input);
    if (fixes.length) {
      input.input = patch;
      for (const f of fixes) report.coerced.push(`input:${f}`);
    }
  }

  // 5. Repair the path-scope arg of `grep`/`glob`, which omp takes as ONE
  //    `;`-delimited string, when the model sent an array, a stringified
  //    array, or a comma-joined list.
  const pathListArg = PATH_LIST_ARGS[spec.canonical];
  if (pathListArg && pathListArg in input) {
    const fixed = repairPathList(input[pathListArg]);
    if (fixed !== undefined) {
      input[pathListArg] = fixed;
      report.coerced.push(`${pathListArg}:path-list`);
    }
  }

  // 6. Translate a stray ignore-case flag onto omp's `case`, negating it:
  //    `case` means case-SENSITIVE, the opposite of the `i` it replaced.
  if (spec.canonical === "grep" && !("case" in input)) {
    for (const key of IGNORE_CASE_KEYS) {
      if (!(key in input)) continue;
      const v = input[key];
      const b = typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined;
      if (b !== undefined) {
        input.case = !b;
        report.coerced.push(`${key}→case:negated`);
      }
      delete input[key];
      break;
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
