// Pure-function JSON repair + text-based
// tool-call extraction. Used by the output-parser extension to DETECT
// malformed tool calls (fenced, <tool_call> tags, raw JSON) in assistant
// text. Active repair (executing the extracted calls) is handled by the
// extension via session.followUp() to nudge the model back onto native
// tool-calling for subsequent turns.

export function escapeNewlinesInJsonStrings(text: string): string {
  const out: string[] = [];
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && inString && i + 1 < text.length) {
      out.push(ch, text[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out.push(ch);
    } else if (inString && ch === "\n") {
      out.push("\\n");
    } else if (inString && ch === "\t") {
      out.push("\\t");
    } else if (inString && ch === "\r") {
      out.push("\\r");
    } else {
      out.push(ch);
    }
    i++;
  }
  return out.join("");
}

export function repairJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  // 0. direct parse
  try {
    return JSON.parse(trimmed);
  } catch {}
  // 1. re-escape literal newlines/tabs in strings
  let fixed = escapeNewlinesInJsonStrings(trimmed);
  try {
    return JSON.parse(fixed);
  } catch {}
  // 2. trailing commas
  fixed = fixed.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
  // 3. single quotes → double, only if no doubles present
  if (!fixed.includes('"') && fixed.includes("'")) fixed = fixed.replace(/'/g, '"');
  // 4. unquoted keys — skip if content already has quoted string keys
  if (!fixed.includes('": ') && !fixed.includes('":"')) {
    fixed = fixed.replace(/(?<=[{,\s])(\w+)\s*:/g, '"$1":');
  }
  // 5. missing closing braces / brackets
  const openB = (fixed.match(/\{/g) || []).length - (fixed.match(/\}/g) || []).length;
  if (openB > 0) fixed += "}".repeat(openB);
  const openS = (fixed.match(/\[/g) || []).length - (fixed.match(/\]/g) || []).length;
  if (openS > 0) fixed += "]".repeat(openS);
  try {
    return JSON.parse(fixed);
  } catch {}
  // 6. extract first JSON object
  const m = fixed.match(/\{[^{}]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  return { _raw: raw };
}

export interface ExtractedCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function extractInput(data: Record<string, unknown>): Record<string, unknown> {
  const raw = data.input ?? data.parameters ?? data.arguments ?? data.args ?? {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return { _raw: raw }; }
  }
  return raw as Record<string, unknown>;
}

function pushCall(calls: ExtractedCall[], data: Record<string, unknown>): void {
  if (typeof data.name === "string" && data.name) {
    calls.push({
      id: `call_text_${calls.length}`,
      name: data.name,
      input: extractInput(data),
    });
  }
}

export function parseTextToolCalls(text: string): ExtractedCall[] {
  const calls: ExtractedCall[] = [];

  // Pattern 1: ```tool ... ``` or ```json ... ``` (may contain multiple calls)
  const fenceRe = /```(?:tool|json)\s*\n([\s\S]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text))) {
    const block = m[1].trim();
    // Try as array of calls first
    if (block.startsWith("[")) {
      try {
        const arr = JSON.parse(block);
        if (Array.isArray(arr)) { for (const item of arr) pushCall(calls, item); continue; }
      } catch {}
    }
    // Try as multiple JSON objects separated by newlines
    const objects = block.split(/\n(?=\s*\{)/);
    if (objects.length > 1) {
      let allParsed = true;
      for (const obj of objects) {
        const data = repairJson(obj.trim());
        if (typeof data.name === "string") pushCall(calls, data);
        else allParsed = false;
      }
      if (allParsed) continue;
    }
    // Single object
    const data = repairJson(block);
    pushCall(calls, data);
  }

  // Pattern 2: <tool_call> ... </tool_call> (Qwen standard)
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  while ((m = tagRe.exec(text))) {
    const data = repairJson(m[1]);
    pushCall(calls, data);
  }

  // Pattern 3: Qwen special token variants rendered as text
  const qwenTagRe = /<\|tool_call\|>\s*([\s\S]*?)\s*(?:<\|\/tool_call\|>|<\|end\|>)/g;
  while ((m = qwenTagRe.exec(text))) {
    const data = repairJson(m[1]);
    pushCall(calls, data);
  }

  // Pattern 4: Hermes/ChatML function_call format
  const hermesRe = /<function_call>\s*([\s\S]*?)\s*<\/function_call>/g;
  while ((m = hermesRe.exec(text))) {
    const data = repairJson(m[1]);
    pushCall(calls, data);
  }

  // Pattern 4b: Qwen-Agent ✿FUNCTION✿ / ✿ARGS✿ format
  const qwenAgentRe = /✿FUNCTION✿:\s*([\w.-]+)\s*\n\s*✿ARGS✿:\s*([\s\S]*?)(?=\n\s*✿|$)/g;
  while ((m = qwenAgentRe.exec(text))) {
    const args = repairJson(m[2].trim());
    pushCall(calls, { name: m[1], arguments: args });
  }

  // Pattern 5: bare JSON object with "name"+"input"/"arguments"/"parameters"
  if (calls.length === 0) {
    const bareRe = /\{[^{}]*"name"\s*:\s*"(\w+)"[^{}]*\}/g;
    while ((m = bareRe.exec(text))) {
      const data = repairJson(m[0]);
      pushCall(calls, data);
    }
  }

  return calls;
}
