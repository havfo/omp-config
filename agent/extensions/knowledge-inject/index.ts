import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseSkillFile } from "../skill-inject/frontmatter.ts";
import { skillsRoot } from "../skill-inject/index.ts";

// ── Knowledge-entry registry ────────────────────────────────────────────
// Loads skills/knowledge/*.md plus the protocol skills (skills/protocols/*.md),
// scores entries against the user's prompt, selects the top ones within budget,
// and publishes `requires_tools` on systemPromptOptions so skill-inject can
// include them.

interface KnowledgeEntry {
  topic: string;
  body: string;
  tokenCost: number;
  keywords: string[];
  requiresTools: string[];
}

const entries = new Map<string, KnowledgeEntry>();
const cache = new Map<string, string>();
let loaded = false;

const MIN_SCORE_THRESHOLD = 2.0;
const PER_ENTRY_CAP = 150;

function dirs(): string[] {
  const root = skillsRoot();
  if (!root) return [];
  return [join(root, "knowledge"), join(root, "protocols")];
}

function loadEntries(): void {
  if (loaded) return;
  loaded = true;
  for (const dir of dirs()) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      const parsed = parseSkillFile(readFileSync(join(dir, file), "utf-8"));
      if (!parsed) continue;
      const fm = parsed.frontmatter;
      const topic = (typeof fm.topic === "string" ? fm.topic : "") ||
                    (typeof fm.name === "string" ? fm.name : "");
      if (!topic || !parsed.body) continue;
      let cost = typeof fm.token_cost === "number" ? fm.token_cost : 150;
      if (cost > PER_ENTRY_CAP) cost = PER_ENTRY_CAP;
      const keywords = Array.isArray(fm.keywords)
        ? (fm.keywords as string[]).map((k) => k.toLowerCase())
        : [];
      const requiresTools = Array.isArray(fm.requires_tools)
        ? (fm.requires_tools as string[])
        : [];
      entries.set(topic, { topic, body: parsed.body, tokenCost: cost, keywords, requiresTools });
    }
  }
}

// ── Scoring (word=1.0, bigram/phrase=2.0) ───────────────────────────────
function scoreEntry(userText: string, e: KnowledgeEntry): number {
  if (e.keywords.length === 0) return 0;
  const textLower = userText.toLowerCase();
  const words = new Set(textLower.split(/\s+/).filter(Boolean));
  let score = 0;
  for (const kw of e.keywords) {
    if (kw.includes(" ")) {
      if (textLower.includes(kw)) score += 2.0;
    } else {
      if (words.has(kw)) score += 1.0;
    }
  }
  return score;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function buildBlock(selected: KnowledgeEntry[]): string {
  let out = "\n\n## Algorithm Reference\n";
  for (const e of selected) out += `\n### ${e.topic}\n${e.body}\n`;
  return out;
}

// Knowledge entries are selected by scoring against the CURRENT prompt, so the
// injected block changes every turn — which varies the system-prompt tail and
// (on a recurrent/prompt-cached backend) forces a full prefix reprocess each
// turn. Unlike skill-inject it can't be made deterministic without losing its
// point, so it's OFF by default. Set OMPX_KNOWLEDGE_INJECT=1 to opt in
// (only sensible with a small window and no prompt caching).
function enabled(): boolean {
  return process.env.OMPX_KNOWLEDGE_INJECT === "1";
}

export default function (pi: ExtensionAPI) {
  if (!enabled()) return;
  pi.on("before_agent_start", async (event, ctx) => {
    loadEntries();
    if (entries.size === 0) return;

    const opts: any = (event as any).systemPromptOptions ?? {};
    const extOpts = opts.ompx ?? {};
    const budget: number = extOpts.knowledgeTokenBudget ?? 200;
    if (budget <= 0) return;
    if (extOpts.isSubtask) return;

    // systemPrompt is a string[] (segments). Treat it as such — concatenating
    // an array as a string joins it with commas and corrupts the prompt.
    const base = event.systemPrompt ?? [];
    const baseArr: string[] = Array.isArray(base) ? base : [String(base)];
    // Default to the local Qwen window (150k); the 0.4 gate below is relative
    // to this, so it must match the real context size to fire as intended.
    const contextLimit: number = extOpts.contextLimit ?? 150000;
    if (estimateTokens(baseArr.join("\n")) > contextLimit * 0.4) return;

    const prompt = event.prompt ?? "";
    if (!prompt) return;

    const scored: Array<{ score: number; entry: KnowledgeEntry }> = [];
    for (const e of entries.values()) {
      const s = scoreEntry(prompt, e);
      if (s >= MIN_SCORE_THRESHOLD) scored.push({ score: s, entry: e });
    }
    if (scored.length === 0) return;
    scored.sort((a, b) => b.score - a.score);

    const selected: KnowledgeEntry[] = [];
    let used = 0;
    for (const { entry } of scored) {
      if (used + entry.tokenCost > budget) continue;
      selected.push(entry);
      used += entry.tokenCost;
    }
    if (selected.length === 0) return;

    // Publish required tools on systemPromptOptions. skill-inject reads this
    // to include the requires_tools' skill cards in its own selection.
    const requiredTools = Array.from(
      new Set(selected.flatMap((e) => e.requiresTools)),
    );
    if (requiredTools.length > 0) {
      if (!opts.ompx) opts.ompx = {};
      opts.ompx.requiredTools = requiredTools;
    }

    const key = selected.map((e) => e.topic).sort().join("|");
    let block = cache.get(key);
    if (block === undefined) {
      block = buildBlock(selected);
      cache.set(key, block);
    }

    try {
      ctx.ui.notify(
        `knowledge-inject: +${selected.length} [${selected.map((e) => e.topic).join(",")}]`,
        "info",
      );
    } catch {
      // best-effort
    }

    return { systemPrompt: [...baseArr, block] };
  });
}
