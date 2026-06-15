// Shared helpers for handling assistant text from reasoning models.
//
// Qwen3.6 (27B + 35B-A3B) are reasoning:true models. When llama.cpp is run
// with inline thinking (e.g. --chat-template-kwargs '{"preserve_thinking":true}'
// or --reasoning-format none) the <think>…</think> block arrives INSIDE the
// assistant text content block. Several extensions inspect that text to decide
// whether the model stalled, narrated, or emitted a fenced tool call — and the
// reasoning trace routinely contains exactly those patterns ("let me call…",
// example <tool_call> blocks). Strip reasoning before any such heuristic.

const THINK_BLOCK = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
// An unterminated <think> with no closing tag (truncated/streaming) — drop to EOL of buffer.
const THINK_OPEN_TO_END = /<think\b[^>]*>[\s\S]*$/i;
// Some templates use these alternates.
const ALT_BLOCKS = [
  /<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi,
  /<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi,
];

export function stripReasoning(text: string): string {
  if (!text) return text;
  let out = text.replace(THINK_BLOCK, "");
  for (const re of ALT_BLOCKS) out = out.replace(re, "");
  out = out.replace(THINK_OPEN_TO_END, "");
  return out.trim();
}

// Pull the assistant text, tool calls and reasoning-presence out of a turn_end
// message, tolerating BOTH pi's canonical content blocks and the provider-native
// shapes that reach extensions before normalization.
//
// THE BUG THIS EXISTS FOR: on the openai-responses path (llama.cpp here), the
// turn_end message carries provider-native blocks — text as `output_text`, tool
// calls as `function_call`/`custom_tool_call`, reasoning as `reasoning` — whereas
// pi only rewrites those to the canonical `text`/`toolCall`/`thinking` when it
// PERSISTS the message to the session jsonl. Extensions that matched only
// `type:"text"` / `type:"toolCall"` therefore saw an empty turn even when the
// model had produced real text (and thinking), which made quality-monitor fire a
// bogus "your previous response was empty" nudge. Match every shape.
const TEXT_TYPES = new Set(["text", "output_text"]);
const REASONING_TYPES = new Set(["thinking", "reasoning"]);
const TOOLCALL_TYPES = new Set(["toolCall", "tool_call", "function_call", "custom_tool_call"]);
// Wrapper blocks whose real payload is a NESTED `content` array. The
// openai-responses path wraps the visible answer as
// `{type:"message", content:[{type:"output_text", text:"…"}]}`; a top-level-only
// scan misses that text → a text-only turn (no reasoning to trip hasReasoning)
// reads as empty → bogus empty_response nudge. Recurse into these.
const WRAPPER_TYPES = new Set(["message", "response", "output", "content"]);
// Keys whose string values are real prose (used by the last-resort deep scan).
const TEXTISH_KEYS = new Set(["text", "output_text", "value", "refusal", "content"]);

export interface MessageParts {
  text: string; // reasoning stripped, trimmed
  toolCalls: { name: string; input: unknown }[];
  hasReasoning: boolean;
}

function blockText(c: any): string {
  if (typeof c?.text === "string") return c.text;
  if (typeof c?.content === "string") return c.content;
  if (typeof c?.refusal === "string") return c.refusal;
  return "";
}

// Last-resort: harvest any prose string anywhere under text-ish keys, ignoring
// reasoning/think markup. Used only when typed-block extraction found nothing —
// so an unknown shape can never again produce a false empty_response. Bounded
// depth to avoid pathological structures. Returns the concatenated prose.
function deepCollectText(node: any, depth = 0): string {
  if (depth > 6 || node == null) return "";
  if (Array.isArray(node)) return node.map((n) => deepCollectText(n, depth + 1)).filter(Boolean).join("\n");
  if (typeof node === "object") {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string") {
        if (TEXTISH_KEYS.has(k) && stripReasoning(v).length > 0) parts.push(v);
      } else {
        const nested = deepCollectText(v, depth + 1);
        if (nested) parts.push(nested);
      }
    }
    return parts.join("\n");
  }
  return "";
}

function walkBlocks(
  content: any[],
  acc: { text: string; toolCalls: { name: string; input: unknown }[]; hasReasoning: boolean },
  depth = 0,
): void {
  if (depth > 6) return;
  for (const c of content) {
    const type = c?.type;
    if (TEXT_TYPES.has(type)) {
      const t = blockText(c);
      if (t) acc.text += (acc.text ? "\n" : "") + t;
    } else if (REASONING_TYPES.has(type)) {
      const r = c?.thinking ?? c?.text ?? "";
      if (typeof r === "string" && r.trim().length > 0) acc.hasReasoning = true;
    } else if (TOOLCALL_TYPES.has(type)) {
      const call = c?.call ?? c; // some shapes nest under `call`
      acc.toolCalls.push({
        name: call?.name ?? call?.function?.name ?? "",
        input: call?.arguments ?? call?.input ?? call?.function?.arguments ?? {},
      });
    } else if (WRAPPER_TYPES.has(type) && Array.isArray(c?.content)) {
      // Nested payload (e.g. openai-responses {type:"message", content:[…]}).
      walkBlocks(c.content, acc, depth + 1);
    }
  }
}

export function extractMessageParts(message: any): MessageParts {
  const raw = message?.content;
  // Some providers hand back a bare string body.
  if (typeof raw === "string") {
    return { text: stripReasoning(raw), toolCalls: [], hasReasoning: false };
  }
  const content = Array.isArray(raw) ? raw : [];

  const acc = { text: "", toolCalls: [] as { name: string; input: unknown }[], hasReasoning: false };
  walkBlocks(content, acc);

  let text = stripReasoning(acc.text);

  // Last-resort safety net: typed-block extraction found no text, no calls and
  // no reasoning. Before declaring the turn empty, deep-scan for prose under any
  // text-ish key in an unrecognized shape and use whatever real text we find, so
  // a novel content shape can never again produce a false empty_response.
  if (!text && acc.toolCalls.length === 0 && !acc.hasReasoning) {
    text = stripReasoning(deepCollectText(raw));
  }

  return { text, toolCalls: acc.toolCalls, hasReasoning: acc.hasReasoning };
}
