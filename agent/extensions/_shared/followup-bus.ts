import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Shared arbiter so the several extensions that inject a corrective user
// message on a turn (output-parser, quality-monitor, syntax-guard) don't pile
// 2-3 contradictory steers onto a small model at once. Each submits its intent
// here instead of calling pi.sendUserMessage
// directly; the bus delivers at most ONE message per turn — the highest
// priority — flushed on a macrotask after all of that turn's handlers settle.

export const FollowUpPriority = {
  // Nothing was dispatched at all (model fenced its tool calls) — top priority,
  // no other correction matters until it emits native calls.
  FENCED_CALLS: 100,
  // The edit/write broke the file — fix before anything else proceeds.
  SYNTAX_ERROR: 80,
  // Loop / stall / narration / malformed-arg corrections.
  QUALITY: 60,
  // Nice-to-have refresher of a just-failed tool's usage.
  REFRESHER: 20,
} as const;

interface Pending {
  priority: number;
  message: string;
  deliverAs: "steer" | "followUp";
  source: string;
  /**
   * Re-checked immediately before the message is handed to pi. Return false to
   * drop it — the condition it describes has already been resolved. Corrections
   * about on-disk state MUST supply this: `deliverAs: "followUp"` messages are
   * only drained when the agent loop goes idle, which in a long autonomous run
   * is hours after the tool call that raised them, and a "fix this now" steer
   * about an already-fixed file costs the model a whole verification detour.
   */
  validate?: () => boolean | Promise<boolean>;
}

let pending: Pending | undefined;
let scheduled = false;
let api: ExtensionAPI | undefined;

async function flush(): Promise<void> {
  scheduled = false;
  const p = pending;
  pending = undefined;
  if (!p || !api) return;
  // Deferred to a macrotask, so the session may have settled/ended — pi
  // re-drains stranded queued messages, but guard against a late throw.
  try {
    if (p.validate && !(await p.validate())) return;
    api.sendUserMessage(p.message, { deliverAs: p.deliverAs });
  } catch {
    // best-effort — a dropped correction is better than an unhandled rejection
  }
}

// Highest priority wins; ties keep the first submission. Returns true if this
// submission is currently the winning one (useful for telemetry/notify).
export function submitFollowUp(
  pi: ExtensionAPI,
  source: string,
  priority: number,
  message: string,
  deliverAs: "steer" | "followUp" = "followUp",
  validate?: () => boolean | Promise<boolean>,
): boolean {
  api = pi;
  const wins = !pending || priority > pending.priority;
  if (wins) pending = { priority, message, deliverAs, source, validate };
  if (!scheduled) {
    scheduled = true;
    // Flush after the current turn's synchronous + awaited handlers settle.
    setTimeout(() => void flush(), 0);
  }
  return wins;
}
