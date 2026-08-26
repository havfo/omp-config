import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isFileReadTool, pathArgOf, specOf } from "../_shared/taxonomy.ts";
import { stripReadSelector } from "../_shared/paths.ts";

// Suppress the body of a READ that re-delivers content the model already holds
// this session, replacing it with a compact pointer to the snapshot it already
// has. Targets the harness's dominant waste under `-np 1` + prompt cache: the
// model re-reads a file "to refresh the tag" after almost every edit (observed
// 57 reads / 39 edits, same files 6-10x), re-injecting large bodies that bloat
// history and bust the cache prefix.
//
// SAFETY: we compare the ACTUAL 4-hex tag the read returned. If the file
// changed (externally or by an edit), the tag differs → the body flows through
// unchanged and state resets. We never hide content the model hasn't already
// been shown verbatim, and never hide a real change. We only collapse a read
// whose tag matches a prior delivery AND whose line span is a subset of what
// was already shown at that tag — i.e. the model gains literally nothing.
//
// Line numbers shift after an insert/delete, so an edit RESETS the per-path
// shown-set to just the changed region it echoed (carrying old line numbers
// across an edit would be unsafe). A read of that region is then redundant;
// a read elsewhere flows.
//
// LIVENESS: "already holds" is only true while the delivering tool result is
// still in the context window. Compaction, shake, rewind and branching all drop
// old tool results, after which the model genuinely needs the body back — and a
// suppression note there is actively harmful (the model has nothing to reuse and
// either loops or escapes to `cat`). So on every `context` event we re-verify
// each remembered delivery against the messages actually being sent, and forget
// any path whose bodies are no longer there. That covers every removal path at
// once, without having to enumerate compaction events.

interface Shown {
  tag: string;
  lines: Set<number>;
  /** How many tool-result bodies at this tag we believe are live in context. */
  deliveries: number;
}

const shown = new Map<string, Shown>();

function normalize(p: unknown): string | undefined {
  if (typeof p !== "string" || !p) return undefined;
  // Strip a read line-range/tag selector before resolving (`f.go:29-67` → `f.go`).
  const bare = stripReadSelector(p);
  let resolved = bare;
  if (resolved === "~") resolved = homedir();
  else if (resolved.startsWith("~/")) resolved = homedir() + resolved.slice(1);
  return resolve(resolved);
}

function asText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text ?? "")
      .join("\n");
  }
  return "";
}

// The 4-hex snapshot tag from the `[PATH#TAG]` header line of read/edit output.
const HEADER_RE = /\[[^\]\n]*#([0-9A-Fa-f]{4})\]/;
export function parseTag(text: string): string | undefined {
  const m = text.match(HEADER_RE);
  return m ? m[1].toUpperCase() : undefined;
}

// Line numbers whose ACTUAL content the body displayed. A single-line row
// `29:const (` (or anchored `*734: ...`) is real content. A collapsed range row
// `88-207:func newWebRtcServer(...) ( .. )` is a STRUCTURAL SUMMARY — the body
// is hidden, so those lines were NOT shown. Counting them as shown wrongly
// suppresses the targeted re-read the model issues to expand that body (the
// model then loops or escapes to `cat`). So we deliberately match only the
// single-line form `N:` and never the collapsed `N-M:` form.
const ROW_RE = /^\s*\*?(\d+):/gm;
export function parseShownLines(text: string): Set<number> {
  const out = new Set<number>();
  let m: RegExpExecArray | null;
  ROW_RE.lastIndex = 0;
  while ((m = ROW_RE.exec(text))) out.add(Number(m[1]));
  return out;
}

export function isSubset(a: Set<number>, b: Set<number>): boolean {
  if (a.size === 0) return false; // nothing parsed → can't claim redundancy
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function rangeDesc(lines: Set<number>): string {
  if (lines.size === 0) return "the same range";
  const nums = [...lines].sort((x, y) => x - y);
  return `lines ${nums[0]}-${nums[nums.length - 1]}`;
}

// Marks our own note so the liveness scan never mistakes it for a real body.
export const NOTE_MARKER = " — unchanged.";

export function compactNote(path: string, tag: string, lines: Set<number>): string {
  return (
    `[${path}#${tag}]${NOTE_MARKER} You already have ${rangeDesc(lines)} at tag ` +
    `${tag} earlier in this conversation; full content suppressed to save context. ` +
    `Reuse that tag to edit (no re-read needed). Re-read only a DIFFERENT range, ` +
    `or after a stale-tag rejection.`
  );
}

// Below this many content lines, a redundant re-read is left alone. The model
// re-reads a small region right before editing it to bring it into recent
// context; for a local model, content tens of messages back is effectively
// gone, and the token saving on a few lines is negligible. We only suppress
// big re-injects (full-file / large post-edit re-reads) — the actual problem.
export const MIN_SUPPRESS_LINES = 30;

// Decide whether a read result is redundant and update state. Pure except for
// the module `shown` map; exported for tests.
export function evaluateRead(
  key: string,
  tag: string,
  lines: Set<number>,
): { redundant: boolean } {
  const prev = shown.get(key);
  if (prev && prev.tag === tag && isSubset(lines, prev.lines)) {
    return { redundant: true };
  }
  if (prev && prev.tag === tag) {
    for (const x of lines) prev.lines.add(x); // same snapshot, widen coverage
  } else {
    shown.set(key, { tag, lines: new Set(lines), deliveries: 0 }); // new/changed snapshot
  }
  return { redundant: false };
}

// Record that one more body at this tag is now sitting in the context window.
function noteDelivered(key: string, tag: string): void {
  const entry = shown.get(key);
  if (entry && entry.tag === tag) entry.deliveries++;
}

// Policy wrapper: suppress only a redundant read whose body is large enough to
// be worth stripping from history. Advances state via {@link evaluateRead}.
export function shouldSuppress(key: string, tag: string, lines: Set<number>): boolean {
  const { redundant } = evaluateRead(key, tag, lines);
  const suppress = redundant && lines.size >= MIN_SUPPRESS_LINES;
  if (!suppress) noteDelivered(key, tag); // the body itself reaches the model
  return suppress;
}

// An edit advances the tag and echoes the changed region; reset the path's
// shown-set to exactly that region under the new tag.
export function recordEdit(key: string, tag: string, lines: Set<number>): void {
  shown.set(key, { tag, lines: new Set(lines), deliveries: 1 });
}

// --- liveness -------------------------------------------------------------

// A `[PATH#TAG]` header that is NOT one of our suppression notes, i.e. a result
// that actually carried content.
const BODY_HEADER_RE = new RegExp(
  `\\[([^\\]\\n]*)#([0-9A-Fa-f]{4})\\](?!${NOTE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
  "g",
);

function eachString(value: unknown, visit: (s: string) => void): void {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) for (const v of value) eachString(v, visit);
  else if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) eachString(v, visit);
  }
}

// Count, per `key#tag`, the content-bearing deliveries present in `messages`.
export function collectLiveDeliveries(messages: unknown): Map<string, number> {
  const live = new Map<string, number>();
  eachString(messages, (s) => {
    if (!s.includes("#")) return;
    BODY_HEADER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BODY_HEADER_RE.exec(s))) {
      const key = normalize(m[1]);
      if (!key) continue;
      const id = `${key}#${m[2].toUpperCase()}`;
      live.set(id, (live.get(id) ?? 0) + 1);
    }
  });
  return live;
}

// Forget any path whose remembered bodies are no longer all present in the
// context being sent — after compaction/shake/rewind the model no longer holds
// what we would otherwise refuse to re-deliver.
export function pruneToLiveContext(live: Map<string, number>): void {
  for (const [key, entry] of [...shown]) {
    if ((live.get(`${key}#${entry.tag}`) ?? 0) < entry.deliveries) shown.delete(key);
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => { shown.clear(); });
  pi.on("session_switch", async () => { shown.clear(); });
  pi.on("session_branch", async () => { shown.clear(); });

  // Ground truth: whatever is about to be sent is exactly what the model holds.
  pi.on("context", async (event) => {
    pruneToLiveContext(collectLiveDeliveries((event as any).messages));
  });

  pi.on("tool_result", async (event) => {
    if ((event as any).isError) return;
    const name = (event as any).toolName;
    const text = asText((event as any).content);

    // Record what an edit just made current (path lives in the hashline header).
    if (specOf(name)?.canonical === "edit") {
      const tag = parseTag(text);
      const headerPath = text.match(/\[([^\]\n]*)#[0-9A-Fa-f]{4}\]/)?.[1];
      const key = normalize(headerPath);
      if (tag && key) recordEdit(key, tag, parseShownLines(text));
      return;
    }

    if (!isFileReadTool(name)) return;
    const arg = pathArgOf(name);
    if (!arg) return;
    const key = normalize((event as any).input?.[arg]);
    const tag = parseTag(text);
    if (!key || !tag) return;

    const lines = parseShownLines(text);
    if (shouldSuppress(key, tag, lines)) {
      const display = (event as any).input?.[arg] ?? key;
      return {
        content: [{ type: "text" as const, text: compactNote(String(display), tag, lines) }],
      };
    }
  });
}

// exported for tests
export const _state = { shown };
