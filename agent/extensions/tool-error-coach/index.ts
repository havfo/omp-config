import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// On tool error, append a short hint mapping the error signature to a
// corrective action. Runs at tool_result and rewrites the result content
// so the model sees the hint as part of the same tool_result message —
// which is the highest-signal place because the very next turn sees it
// without needing a follow-up roundtrip.
//
// Hints are intentionally one line each. Verbose recipes belong in
// skill-inject's pre-prompt block; this is just-in-time correction.

interface Hint {
  match: RegExp;
  hint: string;
}

const GENERIC_HINTS: Hint[] = [
  { match: /ENOENT|no such file/i,
    hint: "Hint: file does not exist. Use Glob to discover the correct path before Read/Edit." },
  { match: /string not found|old_string.*not.*found|no match/i,
    hint: "Hint: old_string did not match. Re-Read the file and copy EXACT bytes (whitespace, indentation) into old_string." },
  { match: /not in SAFE_PREFIXES|whitelist/i,
    hint: "Hint: bash command not whitelisted. Prefer Read/Glob/Grep instead, or pick a whitelisted prefix (ls, cat, git status, find, grep, ...)." },
  { match: /already exists/i,
    hint: "Hint: Write only creates new files. Use Edit to modify the existing file." },
  { match: /timeout|timed out/i,
    hint: "Hint: operation timed out. Narrow the scope (smaller path, more specific pattern) or split into smaller calls." },
  { match: /permission denied|EACCES/i,
    hint: "Hint: filesystem permission denied. The harness can't sudo — pick a different path or ask the user." },
  { match: /malformed|invalid json|unexpected token/i,
    hint: "Hint: argument JSON malformed. Re-emit the call with strict JSON (double quotes, no trailing commas)." },
  { match: /invalid glob|error parsing glob|unclosed character|unclosed char/i,
    hint: "Hint: the glob pattern is a SINGLE string, not a JSON array. To match multiple dirs use brace alternation like \"internal/bwe/{gcc,gcchybrid}/**/*.go\" — no [], no quotes inside the pattern." },
  { match: /not in _allowed_tools|not allowed/i,
    hint: "Hint: this tool is gated. See the allowed-tools list at the top of your system prompt." },
];

const PER_TOOL_HINTS: Record<string, Hint[]> = {
  edit: [
    { match: /old_string.*(not.*found|no.*match)|string.*(not.*found|did not match)/i,
      hint: "Hint: include 2-3 lines of surrounding context in old_string to make it unique and exact." },
  ],
  bash: [
    { match: /command not found/i,
      hint: "Hint: command not installed. Try a different approach or check available tools with `which`." },
  ],
  grep: [
    { match: /no matches/i,
      hint: "Hint: 0 matches — broaden the regex or check the path. Try Glob to find candidate files first." },
  ],
};

export function pickHint(toolName: string, errorText: string): string | undefined {
  const t = toolName?.toLowerCase() ?? "";
  for (const h of PER_TOOL_HINTS[t] ?? []) if (h.match.test(errorText)) return h.hint;
  for (const h of GENERIC_HINTS) if (h.match.test(errorText)) return h.hint;
  return undefined;
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

// Module-level signal that skill-inject can subscribe to so it re-injects
// guidance for the failing tool on the next turn.
const lastFailedTool: { name: string | null } = { name: null };
export function getLastFailedTool(): string | null { return lastFailedTool.name; }
export function clearLastFailedTool(): void { lastFailedTool.name = null; }

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event) => {
    if (!(event as any).isError) return;
    const toolName = (event as any).toolName;
    const text = asText((event as any).content);
    const hint = pickHint(toolName, text);
    lastFailedTool.name = typeof toolName === "string" ? toolName : null;
    if (!hint) return;
    return {
      content: [{ type: "text" as const, text: text + "\n\n" + hint }],
      isError: true,
    };
  });
}
