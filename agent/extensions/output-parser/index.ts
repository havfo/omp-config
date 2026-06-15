import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseTextToolCalls } from "./parser.ts";
import { extractMessageParts } from "../_shared/text.ts";
import { submitFollowUp, FollowUpPriority } from "../_shared/followup-bus.ts";

// Detects malformed/fenced tool calls in assistant text and nudges the model
// back onto native tool-calling. The headline Qwen3.6-35B-A3B (MoE) path
// uses native tool calling reliably, so we only emit a passive followUp
// nudge there. The dense Qwen3.6-27B fences far more often, so when that
// model is active we emit a STRICTER directive plus a `steer` (delivered
// before the next user input) so the correction lands on the very next
// turn rather than after a round-trip. Gate via env OMPX_PARSER_ACTIVE=1
// or auto-detect by model id containing "27b".

let currentModelId: string | undefined;
function activeRepairOn(): boolean {
  if (process.env.OMPX_PARSER_ACTIVE === "1") return true;
  if (process.env.OMPX_PARSER_ACTIVE === "0") return false;
  return /27b|dense/i.test(currentModelId ?? "");
}

export default function (pi: ExtensionAPI) {
  pi.on("model_select", async (event) => {
    const m = (event as any).model;
    currentModelId = m?.id ?? m?.modelId ?? currentModelId;
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = (event as any).message;
    if (!message) return;
    // extractMessageParts handles canonical AND provider-native blocks
    // (output_text/function_call), so native tool calls on the openai-responses
    // path are detected instead of being mistaken for fenced text calls. Text is
    // already <think>-stripped — the trace's example <tool_call> blocks won't trip us.
    const { text, toolCalls } = extractMessageParts(message);
    if (toolCalls.length > 0) return;
    if (!text) return;

    const calls = parseTextToolCalls(text);
    if (calls.length === 0) return;

    const names = calls.map((c) => c.name).join(", ");
    const active = activeRepairOn();
    ctx.ui.notify(
      `output-parser: ${calls.length} fenced call(s) [${names}] — ${active ? "ACTIVE repair (steer)" : "passive nudge"}`,
      "warning",
    );

    const callList = calls.map((c) => `${c.name}(${JSON.stringify(c.input)})`).join("; ");

    if (active) {
      // Dense-model path: stricter directive + steer so it preempts the
      // next assistant turn instead of waiting for follow-up scheduling.
      submitFollowUp(
        pi, "output-parser", FollowUpPriority.FENCED_CALLS,
        "STOP. Your previous response embedded tool calls inside text (fenced or <tool_call> tags). " +
        "Pi cannot dispatch these — they were ignored. Re-issue them RIGHT NOW as native tool calls " +
        "via your tool-call channel. The intended calls were: " + callList + ". " +
        "Do not write any text. Emit ONLY the native tool calls.",
        "steer",
      );
      return;
    }

    submitFollowUp(
      pi, "output-parser", FollowUpPriority.FENCED_CALLS,
      "Your previous response embedded tool calls inside text (e.g. fenced ```tool blocks or <tool_call> tags). " +
      "Please re-issue them as NATIVE tool calls. If the intended calls were: " + callList +
      " — please execute them now using your tool-call channel, not text.",
      "followUp",
    );
  });
}
