import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Shared arbiter so the several extensions that inject a corrective user
// message on a turn (output-parser, quality-monitor, skill-inject,
// syntax-guard) don't pile 2-3 contradictory steers onto a small model at
// once. Each submits its intent here instead of calling pi.sendUserMessage
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
}

let pending: Pending | undefined;
let scheduled = false;
let api: ExtensionAPI | undefined;

function flush(): void {
  scheduled = false;
  const p = pending;
  pending = undefined;
  if (!p || !api) return;
  // Deferred to a macrotask, so the session may have settled/ended — pi
  // re-drains stranded queued messages, but guard against a late throw.
  try {
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
): boolean {
  api = pi;
  const wins = !pending || priority > pending.priority;
  if (wins) pending = { priority, message, deliverAs, source };
  if (!scheduled) {
    scheduled = true;
    // Flush after the current turn's synchronous + awaited handlers settle.
    setTimeout(flush, 0);
  }
  return wins;
}
