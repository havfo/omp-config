import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { assessResponse, buildCorrectionMessage, resetStallCounter, type ToolCall } from "./quality.ts";
import { extractMessageParts } from "../_shared/text.ts";
import { submitFollowUp, FollowUpPriority } from "../_shared/followup-bus.ts";

// Hooks turn_end, inspects the assistant message
// + previous turn's tool calls, and — if we detect a failure mode — queues
// a correction user message via session.followUp() so the model gets a
// chance to recover on its next turn.

// Session-scoped state. Pi reuses extensions across turns within a session;
// a fresh extension instance is loaded per session via the session lifecycle.
let previousToolCalls: ToolCall[] = [];
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_CORRECTIONS = 3; // bumped from 2 — small local models often need a third try
// Per-failure-signature backoff: nudge on attempts 1, 2, then 4, 8 — i.e.
// suppress repeats of the SAME failure signature using exponential gaps.
const sigCounts = new Map<string, number>();
function shouldNudgeForSignature(sig: string): boolean {
  const n = (sigCounts.get(sig) ?? 0) + 1;
  sigCounts.set(sig, n);
  // attempts 1 and 2 always nudge; after that only at powers of 2.
  if (n <= 2) return true;
  return (n & (n - 1)) === 0; // power-of-two gate
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    previousToolCalls = [];
    consecutiveFailures = 0;
    sigCounts.clear();
    resetStallCounter();
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = (event as any).message;
    if (!message) return;

    // Extract assistant text + tool calls. extractMessageParts tolerates BOTH
    // pi's canonical blocks (text/toolCall/thinking) and the provider-native
    // shapes (output_text/function_call/reasoning) that reach turn_end before
    // normalization on the openai-responses path — matching only "text"/"toolCall"
    // was the root cause of the bogus empty_response nudge. It also strips <think>
    // reasoning so stall/narration heuristics don't trip on the trace.
    const { text, toolCalls, hasReasoning } = extractMessageParts(message);
    const currentCalls: ToolCall[] = toolCalls;

    const verdict = assessResponse(text, currentCalls, previousToolCalls, { hasReasoning });

    // DIAGNOSTIC: if we're about to flag a turn as empty, dump the raw message
    // so any remaining shape that defeats extractMessageParts can be inspected
    // (the false-positive empty_response nudge has been a moving target). Cheap:
    // only fires on the rare empty verdict. Disable with OMPX_QM_DEBUG=0.
    if (!verdict.ok && verdict.reason === "empty_response"
        && process.env.OMPX_QM_DEBUG !== "0") {
      try {
        const fs = await import("node:fs");
        const os = await import("node:os");
        const path = await import("node:path");
        const file = path.join(os.tmpdir(),
          `qm-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
        fs.writeFileSync(file, JSON.stringify({
          reason: verdict.reason,
          extracted: { text, toolCalls: currentCalls, hasReasoning },
          rawMessage: message,
        }, null, 2));
        ctx.ui.notify(`quality-monitor: empty_response — raw message dumped to ${file}`, "warning");
      } catch { /* best-effort */ }
    }

    // Update rolling state for next turn regardless of verdict
    previousToolCalls = currentCalls;

    if (verdict.ok) {
      consecutiveFailures = 0;
      return;
    }

    // The "urgent steer" verdicts (stalled_text_only / narrating_not_acting)
    // auto-inject a "stop explaining and START ACTING" user message. That is
    // appropriate for an autonomous coding loop but harmful in interactive
    // Q&A, where text-only answers are exactly what the user asked for.
    // Suppress those two; keep the substantive corrections (tool errors etc).
    if (verdict.reason === "stalled_text_only" || verdict.reason === "narrating_not_acting") {
      consecutiveFailures = 0;
      return;
    }

    // Cap consecutive corrections AND apply per-signature backoff so we
    // don't burn turns repeating the same nudge.
    consecutiveFailures++;
    if (consecutiveFailures > MAX_CONSECUTIVE_CORRECTIONS) {
      ctx.ui.notify(
        `quality-monitor: ${verdict.reason} (suppressed after ${consecutiveFailures} in a row)`,
        "warning",
      );
      return;
    }
    if (!shouldNudgeForSignature(verdict.reason)) {
      ctx.ui.notify(
        `quality-monitor: ${verdict.reason} (backoff — same signature seen ${sigCounts.get(verdict.reason)}x)`,
        "warning",
      );
      return;
    }

    const correction = buildCorrectionMessage(verdict.reason);
    const urgent = verdict.reason === "stalled_text_only" || verdict.reason === "narrating_not_acting";
    ctx.ui.notify(
      `quality-monitor: ${verdict.reason} → queued ${urgent ? "steer" : "correction"}`,
      "warning",
    );
    // Route through the shared bus so we don't pile onto output-parser /
    // syntax-guard corrections in the same turn (one message wins).
    submitFollowUp(pi, "quality-monitor", FollowUpPriority.QUALITY, correction, urgent ? "steer" : "followUp");
  });
}
