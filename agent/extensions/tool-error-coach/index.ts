import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

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
  // omp's `edit` is a line-anchored hashline patch — there is no old_string to
  // match, so the fix is always "re-read and re-anchor", never "copy more
  // context". (Only the non-default replace/patch edit modes use old_string.)
  { match: /string not found|old_string.*not.*found|no match/i,
    hint: "Hint: the anchor didn't match. Re-`read` the exact lines you want to touch and rebuild the patch on the [PATH#TAG] and line numbers that read returns." },
  { match: /not in SAFE_PREFIXES|whitelist/i,
    hint: "Hint: bash command not whitelisted. Use the tools instead — `read` for file contents and directory listings, `glob` for filenames, `grep` for content search — or pick a whitelisted prefix (git status, go test, npm run, ...)." },
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
  // Ordered specific-first: the first match wins. Every pattern below is keyed
  // to a real diagnostic string emitted by omp 18.0.1's hashline packages
  // (messages.ts / parser.ts / patcher.ts / execute.ts), verified against the
  // shipped binary — 18.x grew a much richer diagnostic set than 17.x, and an
  // unmatched error falls through to a generic hint that often misdirects.
  edit: [
    // ── Wrong patch dialect entirely ──────────────────────────────────
    // Covers the apply_patch sentinel, `@@ -N,M +N,M @@` and `@@ … @@` headers.
    { match: /is not valid in hashline|apply_patch sentinel|hunk header \(`?@@/i,
      hint: "Hint: that is a different patch format. hashline sections are `[path#TAG]` followed by `PUT N.=M:` / `CUT N.=M` / `PUT <N:` / `PUT >N:` — no `@@` hunk headers, no `Update File:` sentinels, no `-`/`+` diff rows." },
    { match: /no preceding hunk header|payload line/i,
      hint: "Hint: each `+body` row must be on its OWN line, after a hunk header. Shape:\n[path#TAG]\\nPUT N.=M:\\n+line one\\n+line two\n(the op is `PUT`, the range separator is `.=` not `-`, and the leading `+` starts each literal line)." },
    { match: /`-` rows are not valid|unified-diff/i,
      hint: "Hint: hashline is not a diff. Never write `-old` rows — the RANGE removes the old lines, and the `+` rows are the final content. A literal leading `-` doubles up: `+- item`." },

    // ── Range arithmetic ──────────────────────────────────────────────
    { match: /invalid absolute range/i,
      hint: "Hint: in `PUT N.=M:` the M is the ABSOLUTE last source line to replace — not a line count and not how many `+` rows you wrote. To change one line use `PUT N.=N:`. Body length is irrelevant to the range." },
    { match: /restating the \d+ line|boundary echo/i,
      hint: "Hint: your body retypes lines that sit OUTSIDE the range. The range must cover exactly the lines that change, and the body must be their complete final content — never echo the surrounding keeper lines." },
    { match: /selected boundary row is required/i,
      hint: "Hint: the range swallowed an unchanged structural line (a closer or opener) and it is ambiguous where it belongs. Re-issue with a range that excludes every unchanged boundary row." },

    // ── Block (`N*`) resolution ───────────────────────────────────────
    { match: /could not resolve a syntactic block|block locator|block resolver/i,
      hint: "Hint: `N*` must anchor on the OPENING line of a construct (and on the first decorator/attribute if there is one). It cannot resolve on a blank line, a closing line, or in an unparsed language — use an explicit `PUT N.=M:` range instead." },
    { match: /anchors on a closing delimiter/i,
      hint: "Hint: you anchored `*` on a CLOSING line, so it degraded to the plain op. Anchor `N*` on the line that OPENS the construct; to append after a closer use plain `PUT >M:`." },

    // ── Registers (CUT @name → PUT @name) ─────────────────────────────
    { match: /`@[\w-]+` (?:was|is) empty|no persisted register/i,
      hint: "Hint: that register is empty. A paste needs a matching `CUT N.=M @name` earlier in the SAME call (or a persisted one) — capture first, then `PUT >K @name`. Register pastes take NO body rows." },
    { match: /unlabeled `CUT`s are pending/i,
      hint: "Hint: several unlabeled `CUT`s are open, so an unlabeled paste cannot tell which you meant. Label the moves: `CUT N.=M @name` → `PUT >K @name`." },

    // ── Header / section shape ────────────────────────────────────────
    { match: /missing hashline snapshot tag/i,
      hint: "Hint: the section header carries no `#TAG`. It must be `[path#TAG]` with the 4-hex tag from your latest `read`/`grep` or the previous edit's response. To create a NEW file use `write`, not `edit`." },
    { match: /conflicting hashline snapshot tags/i,
      hint: "Hint: you used two different tags for the same file in one patch. Re-`read` the file and rebuild the whole patch on the single current tag." },
    { match: /multiple hashline sections resolve to the same file/i,
      hint: "Hint: you opened two `[PATH#TAG]` sections for one file. Merge every op for that file under ONE header, in ascending line order." },
    { match: /is itself a valid hunk header/i,
      hint: "Hint: you `+`-prefixed an OP, so it was written into the file as literal text. Ops are never `+`-prefixed — drop the `+` to execute it, and issue a correcting edit to remove the line that landed." },
    { match: /read-output rows name line/i,
      hint: "Hint: do not paste `N:TEXT` read output as the body. Write one `PUT N.=M:` header for the changed range, then `+TEXT` rows carrying the final content with NO line-number prefixes." },
    { match: /`REM`|`MV DEST`/,
      hint: "Hint: `REM` (delete file) and `MV DEST` (rename) take no body rows. Put any line edits above the `MV` row, under the same [PATH#TAG] header." },

    // Generic staleness — keep LAST of the tag rules so the specific
    // missing/conflicting-tag cases above win.
    { match: /stale|snapshot|hash mismatch|out of date/i,
      hint: "Hint: the [PATH#TAG] snapshot is stale — the file changed since you read it. Re-`read` the range you want to touch and rebuild the patch on the tag that read returns." },
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

// Edit-family results that SUCCEED but change nothing — the model believes it
// edited the file but its replacement equalled the existing lines, or it
// anchored the wrong occurrence. These aren't tool errors (isError is false),
// so they bypass the error path; coach them anyway to stop the no-op→ast_edit
// flailing seen in practice.
const NOOP_EDIT_TOOLS = new Set(["edit", "ast_edit"]);
const NOOP_HINTS: Hint[] = [
  { match: /produced no change|byte[- ]identical|no replacements made|no change(s)? (were )?made/i,
    hint: "Hint: the call applied but changed nothing — your new text equals the existing lines, or you targeted the wrong occurrence. Re-Read the exact lines, confirm the replacement actually differs, and anchor by line number." },

  // 18.x advisories on edits that DID apply. They arrive with isError=false, so
  // without these they scroll past unacted-on. The syntax-regression warning in
  // particular is new in 18.0.1 and means the file is now broken on disk.
  { match: /introduced a syntax error/i,
    hint: "Hint: the patch applied but BROKE the parse — a range endpoint or line number is almost certainly off. Re-`read` the touched region and issue a correcting edit now, before doing anything else." },
  { match: /body indented (?:shallower|deeper)|indentation claims a position/i,
    hint: "Hint: the insert landed by INDENTATION, not where you assumed. Indent the `+` body to the depth you actually want — match the anchor line's indent to stay inside its block, and use `PUT >N*:` to land after a whole construct." },
  { match: /auto-repaired (?:a )?replacement boundar/i,
    hint: "Hint: omp had to repair your range/body boundaries to make this parse. Re-issue future edits with the range covering exactly the changed lines and the body as their complete final content — do not retype neighbouring lines." },
];

export function pickNoopHint(errorText: string): string | undefined {
  for (const h of NOOP_HINTS) if (h.match.test(errorText)) return h.hint;
  return undefined;
}

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
    const toolName = (event as any).toolName;
    const text = asText((event as any).content);

    if (!(event as any).isError) {
      // Successful no-op edit: coach without flagging a failure (so skill-inject
      // doesn't refresh) and leave lastFailedTool untouched.
      if (typeof toolName === "string" && NOOP_EDIT_TOOLS.has(toolName)) {
        const noopHint = pickNoopHint(text);
        if (noopHint) {
          return { content: [{ type: "text" as const, text: text + "\n\n" + noopHint }] };
        }
      }
      return;
    }

    const hint = pickHint(toolName, text);
    lastFailedTool.name = typeof toolName === "string" ? toolName : null;
    if (!hint) return;
    return {
      content: [{ type: "text" as const, text: text + "\n\n" + hint }],
      isError: true,
    };
  });
}
