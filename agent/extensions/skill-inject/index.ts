import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFile } from "./frontmatter.ts";

// ── Tool-skill registry ─────────────────────────────────────────────────
// Loads skills/tools/*.md once, hooks `before_agent_start` to append a
// `## Tool Usage Guidance` block to the system prompt. Per-user-prompt
// selection using a 3-priority algorithm (error recovery > recency > intent).
// Budget-guarded, cached.

interface ToolSkill {
  targetTool: string;
  body: string;
  tokenCost: number;
}

const skills = new Map<string, ToolSkill>();
const selectionCache = new Map<string, string>();
let loaded = false;

// Session-stable injected block. The per-turn adaptive selection (below) varies
// the system-prompt tail every turn — which on a recurrent or prompt-cached
// backend diverges the cached prefix and forces a full reprocess EVERY turn.
// So by default we compute ONE deterministic block per session and reuse it,
// keeping the prefix append-only.
// Set OMPX_ADAPTIVE_SKILLS=1 to restore the old per-turn behavior.
let sessionStableBlock: string | undefined;
function adaptiveMode(): boolean {
  return process.env.OMPX_ADAPTIVE_SKILLS === "1";
}

// State tracked across the session so we have error-recovery + recency
// signals by the time the next `before_agent_start` fires.
const recentToolCalls: string[] = []; // most-recent-first, capped at 8
let lastFailedTool: string | null = null;

// ── Intent keywords → likely tools ──────────────────────────────────────
const INTENT_MAP: Record<string, string[]> = {
  read: ["Read"], show: ["Read"], view: ["Read"], cat: ["Read"],
  write: ["Write"], create: ["Write", "Bash"],
  implement: ["Write", "Read"], code: ["Write", "Read"],
  function: ["Write", "Edit"], class: ["Write", "Edit"],
  edit: ["Edit"], change: ["Edit"], modify: ["Edit"],
  fix: ["Edit"], update: ["Edit"], replace: ["Edit"],
  add: ["Edit", "Write"], refactor: ["Edit", "Read"],
  run: ["Bash"], execute: ["Bash"], install: ["Bash"],
  build: ["Bash"], test: ["Bash"],
  // Skills are keyed by target_tool, matched against displayName(toolName) —
  // so `search` → "Search", carried by search.md. Only intents with a matching
  // skills/tools/*.md doc are listed.
  find: ["Search"], search: ["Search"], grep: ["Search"],
  agent: ["Agent"], delegate: ["Agent"], spawn: ["Agent"],
};

// Resolve the skills/ root robustly. The extension was relocated from
// .pi/extensions/<ext>/ (skills 3 levels up) to .omp/agent/extensions/<ext>/
// (skills 2 levels up, under agent/), which silently broke loading. Honor an
// explicit override, then probe both known layouts.
export function skillsRoot(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.OMPX_SKILLS_DIR,
    join(here, "..", "..", "skills"),       // .omp/agent/skills (current)
    join(here, "..", "..", "..", "skills"), // legacy .pi layout
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined;
}

function skillsDir(): string | undefined {
  const root = skillsRoot();
  return root ? join(root, "tools") : undefined;
}

function loadSkills(): void {
  if (loaded) return;
  loaded = true;
  const dir = skillsDir();
  if (!dir || !existsSync(dir)) {
    console.warn(
      "[skill-inject] skills/tools dir not found — tool-usage guidance disabled. " +
      "Set OMPX_SKILLS_DIR to your skills/ path.",
    );
    return;
  }
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const parsed = parseSkillFile(readFileSync(join(dir, file), "utf-8"));
    if (!parsed) continue;
    const target = parsed.frontmatter.target_tool;
    if (typeof target !== "string" || !target) continue;
    const cost = typeof parsed.frontmatter.token_cost === "number"
      ? parsed.frontmatter.token_cost
      : 150;
    skills.set(target, { targetTool: target, body: parsed.body, tokenCost: cost });
  }
}

function predictTools(userText: string): string[] {
  const words = new Set(userText.toLowerCase().split(/\s+/).filter(Boolean));
  const predicted: string[] = [];
  for (const [kw, toolNames] of Object.entries(INTENT_MAP)) {
    if (!words.has(kw)) continue;
    for (const tn of toolNames) if (!predicted.includes(tn)) predicted.push(tn);
  }
  return predicted;
}

function selectSkills(prompt: string, budget: number, allowed?: Set<string>): ToolSkill[] {
  const selected: ToolSkill[] = [];
  let used = 0;
  const tryAdd = (name: string): void => {
    // Skills are keyed by frontmatter target_tool (TitleCase, e.g. "Read"),
    // but recency/error-recovery names come from tool_result as pi's canonical
    // lowercase ("read"). Probe both so those signals actually match.
    const sk = skills.get(name) ?? skills.get(displayName(name));
    if (!sk || selected.includes(sk)) return;
    if (allowed && !allowed.has(sk.targetTool)) return;
    if (used + sk.tokenCost > budget) return;
    selected.push(sk);
    used += sk.tokenCost;
  };

  // 1. Error recovery — last failed tool
  if (lastFailedTool) tryAdd(lastFailedTool);

  // 2. Recency — last 2 tool calls
  for (const name of recentToolCalls.slice(0, 4)) {
    if (used >= budget) break;
    tryAdd(name);
  }

  // 3. Intent prediction on the user's current prompt
  if (used < budget) {
    for (const name of predictTools(prompt)) {
      if (used >= budget) break;
      tryAdd(name);
    }
  }

  return selected;
}

// Skills are keyed by both lowercase ("read") and TitleCase ("Read") in
// different code paths. Probe both when looking up by failed-tool name.
function displayName(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function buildBlock(selected: ToolSkill[]): string {
  let out = "\n\n## Tool Usage Guidance\n";
  for (const s of selected) out += `\n### ${s.targetTool}\n${s.body}\n`;
  return out;
}

// Deterministic, prompt/recency-INDEPENDENT selection used in stable mode:
// every loaded + allowed card, in sorted order, up to a generous cap. Because
// it ignores the turn's prompt/recency, the resulting block is identical every
// turn → the system-prompt tail stays constant → the prompt prefix is reusable.
function stableSelect(budget: number, allowed?: Set<string>): ToolSkill[] {
  const out: ToolSkill[] = [];
  let used = 0;
  for (const name of Array.from(skills.keys()).sort()) {
    const sk = skills.get(name)!;
    if (allowed && !allowed.has(sk.targetTool)) continue;
    if (used + sk.tokenCost > budget) continue;
    out.push(sk);
    used += sk.tokenCost;
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    sessionStableBlock = undefined;
    recentToolCalls.length = 0;
    lastFailedTool = null;
  });

  // Track tool usage across the whole session so recency + error-recovery
  // state is available on the next before_agent_start. A failed tool's skill is
  // re-injected there (selectSkills prioritizes `lastFailedTool`) — fresh each
  // turn, budget-aware, and part of the prompt rather than a queued message.
  //
  // We deliberately do NOT also push a `turn_end` follow-up refresher: a
  // `followUp` is a queued user message, consumed only when the agent next
  // pauses for input. During a long autonomous run it strands and gets drained
  // at the very end, surfacing a stale "Tool 'edit' just failed" AFTER the task
  // is already done and green. The before_agent_start injection above + the
  // inline one-line hint from tool-error-coach cover the failure without that
  // delivery hazard.
  pi.on("tool_result", async (event) => {
    const name = (event as any).toolName || (event as any).name;
    if (typeof name === "string") {
      // prepend, keep deduplicated recency list capped
      const idx = recentToolCalls.indexOf(name);
      if (idx !== -1) recentToolCalls.splice(idx, 1);
      recentToolCalls.unshift(name);
      if (recentToolCalls.length > 8) recentToolCalls.length = 8;
    }
    const isError = (event as any).isError === true;
    lastFailedTool = isError && typeof name === "string" ? name : null;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    loadSkills();
    if (skills.size === 0) return;

    const opts: any = (event as any).systemPromptOptions ?? {};
    const extOpts = opts.ompx ?? {};
    const budget: number = extOpts.skillTokenBudget ?? 300;
    if (budget <= 0) return;

    // Restrict injected skills to tools actually LOADED this session. With
    // `tools.discoveryMode: all`, omp defers most built-ins behind a search
    // tool; injecting their usage skills (browser, agent, …) would waste ~2k of
    // prompt on guidance for tools that aren't even present. `getActiveTools()`
    // gives the live set; intersect it with any explicit OMPX_ALLOWED_TOOLS.
    // Tool names come back canonical (lowercase) but skills are keyed by
    // target_tool (TitleCase), so admit both forms.
    const expand = (names: string[]): string[] => names.flatMap((n) => [n, displayName(n)]);
    const envAllowed = process.env.OMPX_ALLOWED_TOOLS
      ?.split(",").map((s) => s.trim()).filter(Boolean);
    let active: string[] | undefined;
    try { const a = pi.getActiveTools?.(); if (Array.isArray(a) && a.length) active = a; } catch { /* unavailable in some run modes */ }
    let allowList: string[] | undefined = active ? expand(active) : undefined;
    if (envAllowed && envAllowed.length) {
      const env = new Set(expand(envAllowed));
      allowList = allowList ? allowList.filter((n) => env.has(n)) : expand(envAllowed);
    }
    const allowed = allowList ? new Set(allowList) : undefined;

    // Knowledge-inject may publish required_tools on systemPromptOptions —
    // pre-add those before selecting so they win even when budget is tight.
    const preferred: string[] = Array.isArray(extOpts.requiredTools) ? extOpts.requiredTools : [];
    for (const t of preferred) {
      if (!recentToolCalls.includes(t)) recentToolCalls.unshift(t);
    }

    let block: string;
    let label: string;
    if (!adaptiveMode()) {
      // STABLE (default): one deterministic block per session, reused verbatim
      // so the system-prompt tail never changes turn-to-turn.
      if (sessionStableBlock === undefined) {
        // Generous cap: the block is injected once, so its tokens are a
        // one-time prefix cost, and we want the full core guidance present.
        const selected = stableSelect(Math.max(budget, 2000), allowed);
        sessionStableBlock = selected.length ? buildBlock(selected) : "";
        label = `skill-inject: stable +${selected.length} [${selected.map((s) => s.targetTool).join(",")}]`;
      } else {
        label = "skill-inject: stable (cached)";
      }
      if (!sessionStableBlock) return;
      block = sessionStableBlock;
    } else {
      const selected = selectSkills(event.prompt ?? "", budget, allowed);
      if (selected.length === 0) return;
      const key = selected.map((s) => s.targetTool).sort().join("|");
      let cached = selectionCache.get(key);
      if (cached === undefined) {
        cached = buildBlock(selected);
        selectionCache.set(key, cached);
      }
      block = cached;
      label = `skill-inject: +${selected.length} [${selected.map((s) => s.targetTool).join(",")}]`;
    }

    // Fire-and-forget notify so skill injections can be observed per-turn
    // without having to reconstruct the system prompt.
    try {
      ctx.ui.notify(label, "info");
    } catch {
      // UI unavailable in some run modes — silent best-effort
    }

    // systemPrompt is a string[] — append our block as a new segment rather
    // than string-concatenating (which would join the array with commas).
    const base = event.systemPrompt ?? [];
    const baseArr: string[] = Array.isArray(base) ? base : [String(base)];
    return { systemPrompt: [...baseArr, block] };
  });
}
