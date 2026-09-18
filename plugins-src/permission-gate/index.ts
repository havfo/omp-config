import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { tmpdir, homedir } from "node:os";
import * as path from "node:path";
import { readFile } from "node:fs/promises";

// Bash commands not matching the whitelist are asked of the user for approval
// in "auto"/"manual" mode. The dialog shows the FULL command (no truncation),
// starts the cursor on "No", and a timeout (when armed) applies the highlighted
// option — so silence still blocks. Showing the prompt also fires the
// harness' "work done" terminal notification (desktop toast + bell) to pull
// the user to the terminal. Headless runs with no UI still block.
// Write/Edit confirmations are deferred to the TUI's own prompt; this only
// adds an extra guardrail on bash.
//
// ── Settings (plugin mechanism) ──────────────────────────────────────────
// This extension ships as a plugin (see package.json#omp.settings), so its
// settings live in /settings → Plugins → permission-gate and are persisted
// in <agentDir>/plugins/omp-plugins.lock.json, with per-project overrides in
// <cwd>/.omp/plugin-overrides.json. The gate reads both files on every gated
// call (they are small, and calls that need them are the exception), so a
// change in the UI applies to the NEXT prompt without a restart.
//
//   approvalTimeout: "30s" (default, prompt + 30s auto-reject) |
//                   "immediate" (block without prompting — you are away) |
//                   "forever"   (prompt, no timeout — you are at the keyboard)
//   whitelist: comma-separated prefixes; when non-empty it REPLACES the
//             built-in SAFE_PREFIXES below.
//
// The lockfile is read directly (fs, not a host-module import): extensions
// run in-process, and importing @oh-my-pi/pi-coding-agent at runtime would
// pull a second copy of the host module graph. The dynamic pi-utils import
// only resolves the agent directory (profile/env aware); any failure falls
// back to the canonical path and the gate keeps working with defaults.

export const PLUGIN_NAME = "permission-gate";

export type ApprovalTimeout = "30s" | "immediate" | "forever";

const APPROVAL_TIMEOUTS: readonly ApprovalTimeout[] = ["30s", "immediate", "forever"];

export interface GateSettings {
  approvalTimeout: ApprovalTimeout;
  /** When non-null, replaces the built-in SAFE_PREFIXES entirely. */
  whitelist: readonly string[] | null;
}

function parseWhitelist(raw: unknown): readonly string[] | null {
  if (typeof raw !== "string") return null;
  const list = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return list.length > 0 ? list : null;
}

// Project values override global values. Unknown/missing values fall back to
// the schema defaults ("30s", built-in whitelist) rather than failing — the
// gate must never crash a session over its own config.
export function mergeGateSettings(
  global: Record<string, unknown> | undefined,
  project: Record<string, unknown> | undefined,
): GateSettings {
  const raw: Record<string, unknown> = { ...(global ?? {}), ...(project ?? {}) };
  const timeout = APPROVAL_TIMEOUTS.includes(raw.approvalTimeout as ApprovalTimeout)
    ? (raw.approvalTimeout as ApprovalTimeout)
    : "30s";
  return { approvalTimeout: timeout, whitelist: parseWhitelist(raw.whitelist) };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

async function readPluginSettingsFile(p: string): Promise<Record<string, unknown> | undefined> {
  try {
    const root = asRecord(JSON.parse(await readFile(p, "utf8")));
    const settings = asRecord(root?.settings);
    return asRecord(settings?.[PLUGIN_NAME]);
  } catch {
    return undefined; // missing/corrupt file → defaults
  }
}

// Dynamic import (not static): a resolution failure at module-evaluation time
// would fail the whole extension load and silently remove the gate. The guarded
// import below keeps the gate alive on the canonical path instead.
async function defaultLockPath(): Promise<string> {
  try {
    const { getPluginsLockfile } = await import("@oh-my-pi/pi-utils");
    return getPluginsLockfile();
  } catch {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".omp", "agent");
    return path.join(agentDir, "plugins", "omp-plugins.lock.json");
  }
}

export async function loadGateSettings(
  cwd: string,
  opts: { lockPath?: string; overridesPath?: string } = {},
): Promise<GateSettings> {
  const [global, project] = await Promise.all([
    readPluginSettingsFile(opts.lockPath ?? (await defaultLockPath())),
    readPluginSettingsFile(opts.overridesPath ?? path.join(cwd, ".omp", "plugin-overrides.json")),
  ]);
  return mergeGateSettings(global, project);
}

const SAFE_PREFIXES: readonly string[] = [
  "cd ", "sleep", "for", "while", "do", "done",
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "date",
  "which", "type", "env", "printenv", "uname", "whoami", "id",
  "git log", "git status", "git diff", "git show", "git branch",
  "git remote", "git stash list", "git tag",
  "curl", "wget", "netcat", "nc", "netstat", "ping", "ping6", "traceroute", "traceroute6",
  "find ", "grep ", "rg ", "ag ", "fd ",
  "pip show", "pip list", "cargo metadata",
  "cargo add", "cargo install", "cargo fetch", "cargo update",
  "go get", "go install", "go mod download", "go mod tidy",
  "gem install", "bundle install", "bundle add",
  "df ", "du ", "free ", "top -bn", "ps ",
  "pytest", "python -m pytest", "python -m unittest", "tox",
  "make", "cmake ", "ctest",
  "cargo build", "cargo test", "cargo check", "cargo run", "cargo clippy", "cargo fmt",
  "go test", "go build", "go run", "go vet",
  "go doc", "go list", "go env", "go version",
  "gradle ", "./gradlew", "mvn ", "dotnet test", "dotnet build",
  "jest", "vitest", "mocha", "tsc",
  "pnpm test", "pnpm run", "yarn test", "yarn run", "bun test", "bun run",
  "rustc ", "gcc ", "g++ ", "clang ", "javac ",
  "mkdir ", "sed ", "awk ", "diff ", "sort ", "uniq ", "cut ", "tr ",
  "comm ", "jq ", "tree", "stat ", "file ", "basename ", "dirname ",
  "realpath ", "readlink ", "sha256sum ", "md5sum ", "xxd ", "nl ",
];

// Split a command line into the sub-commands that bash will actually run,
// breaking at top-level operators (&&, ||, ;, |, newline, and background &)
// that are NOT inside quotes. This is what lets us allow `cd /x && pytest`
// while still blocking `ls && rm -rf` or `cd /x; rm -rf` — every segment must
// be whitelisted, not just the first token.
export function splitSegments(command: string): string[] {
  const segs: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  const flush = () => { if (buf.trim()) segs.push(buf.trim()); buf = ""; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) { flush(); i++; continue; }
    if (ch === ";" || ch === "|" || ch === "\n") { flush(); continue; }
    // Background `&` (single, space-separated) starts a new command; but `2>&1`
    // / `&>` redirections have no space before the `&`, so don't split those.
    if (ch === "&" && next !== "&" && /\s$/.test(buf)) { flush(); continue; }
    buf += ch;
  }
  flush();
  return segs;
}

// Command substitution executes arbitrary commands regardless of the visible
// prefix (`echo $(rm -rf x)`), so a segment containing it is never safe.
function hasCommandSubstitution(s: string): boolean {
  return /\$\(|`/.test(s);
}

// A whitelist entry matches a segment at a COMMAND boundary, not as a raw
// substring — otherwise `ls` allows `lsof`/`lspci` and `cat` allows `catnip`.
// Single-token entries (e.g. "ls", "make") must match the whole command word;
// multi-token entries with flags (e.g. "top -bn", "git log") keep prefix
// semantics so `top -bn1` still passes.
function prefixMatches(seg: string, prefix: string): boolean {
  const p = prefix.trim();
  if (p.includes(" ")) return seg.startsWith(p);
  return seg === p || seg.startsWith(p + " ") || seg.startsWith(p + "\t");
}

// Redirect targets that are safe to write: the null/std devices, plus scratch
// locations (/tmp, the OS tempdir, or an explicit OMPX_SCRATCH_DIR).
// This lets the model capture output (`pytest > /tmp/out.txt`) while still
// refusing to clobber source files via redirection.
const SCRATCH_PREFIXES: readonly string[] = (() => {
  const dirs = ["/tmp/", tmpdir().replace(/\/?$/, "/")];
  const env = process.env.OMPX_SCRATCH_DIR;
  if (env) dirs.push(env.replace(/\/?$/, "/"));
  return Array.from(new Set(dirs));
})();

function isAllowedRedirectTarget(target: string): boolean {
  if (target === "/dev/null" || target === "/dev/stdout" || target === "/dev/stderr") return true;
  return SCRATCH_PREFIXES.some((d) => target.startsWith(d));
}

// Output redirection to a file is a write that bypasses read-before-edit
// (`echo evil > src.go`). Allow fd-dups (2>&1),
// the null/std devices, and scratch dirs; block writes anywhere else. Quotes
// are stripped first so `grep ">" file` isn't mistaken for a redirect.
// This guard applies on TOP of any custom whitelist.
function hasFileRedirect(seg: string): boolean {
  const bare = seg.replace(/"[^"]*"|'[^']*'/g, "");
  const re = /\d*>>?\s*([^\s|&>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare)) !== null) {
    if (isAllowedRedirectTarget(m[1])) continue;
    return true;
  }
  return false;
}

function segmentSafe(seg: string, list: readonly string[]): boolean {
  if (hasCommandSubstitution(seg)) return false;
  if (hasFileRedirect(seg)) return false;
  return list.some((p) => prefixMatches(seg, p));
}

// Returns the first sub-command that fails the whitelist, or null if all pass.
export function firstUnsafeSegment(command: string, list: readonly string[] = SAFE_PREFIXES): string | null {
  const c = command.trim();
  if (!c) return c;
  const segs = splitSegments(c);
  if (segs.length === 0) return c;
  for (const seg of segs) if (!segmentSafe(seg, list)) return seg;
  return null;
}

export function isSafeBash(command: string, list: readonly string[] = SAFE_PREFIXES): boolean {
  return firstUnsafeSegment(command, list) === null;
}

// ── Anti-stall: bash calls that do nothing but wait ─────────────────────
// omp auto-backgrounds a long command (~60s) and PUSHES the result back as an
// async-result <system-notice>. Local models routinely miss that and try to
// wait out the job by hand — `sleep 30`, `while true; do sleep 5; done` — which
// burns a full turn (plus a prefill) and delivers nothing. Blocking the
// wait-only shape is the only feedback that reliably lands.
//
// Deliberately narrow: only a command whose EVERY segment is a no-op/wait is
// blocked. A readiness probe (`sleep 2 && curl localhost:8080/health`) still
// runs, because there the sleep is paired with work that produces a fact.
const WAIT_HEADS: Record<string, true> = { sleep: true, wait: true, "true": true, ":": true };
const FILLER_HEADS: Record<string, true> = { echo: true, printf: true, date: true, "false": true };
// Shell keywords that wrap a segment without changing what it runs; stripped so
// `while true; do sleep 1; done` classifies on `true` / `sleep 1`.
const LOOP_KEYWORDS: Record<string, true> = { while: true, until: true, for: true, do: true, done: true, then: true, fi: true, else: true };

function stripLoopKeywords(seg: string): string {
  let toks = seg.trim().split(/\s+/);
  while (toks.length > 0 && LOOP_KEYWORDS[toks[0]]) toks = toks.slice(1);
  return toks.join(" ");
}

export function isWaitOnlyBash(command: string): boolean {
  const segs = splitSegments(command.trim());
  if (segs.length === 0) return false;
  let sawWait = false;
  for (const raw of segs) {
    const seg = stripLoopKeywords(raw);
    if (!seg) continue; // bare `done`/`fi`
    const head = seg.split(/\s+/)[0] ?? "";
    if (WAIT_HEADS[head]) { sawWait = true; continue; }
    if (FILLER_HEADS[head]) continue;
    return false;
  }
  return sawWait;
}

export const WAIT_ONLY_REASON =
  "anti-stall: this command only waits, so it cannot make progress. Background jobs " +
  "deliver themselves — when the job settles you are re-invoked with a <system-notice> " +
  "carrying its full output. Sleeping does not make that arrive sooner; it just spends a " +
  "turn. Do the next piece of work that does not depend on the job, or end your turn with " +
  "one line saying which job you are waiting for. (Need a settled job's output on demand? " +
  "`hub jobs` / `hub wait`.)";

function getPermissionMode(): "auto" | "accept-all" | "manual" {
  const v = process.env.OMPX_PERMISSION_MODE;
  if (v === "accept-all" || v === "manual") return v;
  return "auto";
}

// Hints for commands the model commonly reaches for that don't work here.
// These are MORE useful than a fuzzy prefix match because the right answer is
// usually "use a different tool entirely", not "use a similarly-spelled bash
// command".
const INTENT_HINTS: Record<string, string> = {
  // omp 17.4.0 runs a PERSISTENT shell and `bash` takes a `cwd` argument, so
  // the old "bash is stateless, chain with &&" advice was wrong on both counts.
  cd:    "Don't `cd` — bash takes a `cwd` argument: {\"command\":\"go test ./...\",\"cwd\":\"/path\"}. For a one-off chain `cd /path && make` also works.",
  rm:    "Destructive ops are not whitelisted. To delete a FILE use a hashline edit whose only op is `REM` under the [PATH#TAG] header. Anything else: ask the user.",
  mv:    "`mv` is not whitelisted. To rename/move a file use a hashline edit ending in `MV <new path>` under its [PATH#TAG] header.",
  cp:    "`cp` is not whitelisted. Use Read + Write instead.",
  sudo:  "The harness cannot sudo. Pick a path that doesn't require elevated permissions.",
  vim:   "Interactive editors aren't supported. Use Edit to change files in place.",
  vi:    "Interactive editors aren't supported. Use Edit to change files in place.",
  nano:  "Interactive editors aren't supported. Use Edit to change files in place.",
  open:  "GUI launchers aren't supported in this harness.",
  source:"`source` isn't whitelisted. Pass what you need via bash's `env` argument: {\"command\":\"...\",\"env\":{\"NAME\":\"value\"}}.",
  export:"`export` isn't whitelisted. Pass vars via bash's `env` argument: {\"command\":\"...\",\"env\":{\"NAME\":\"value\"}}.",
  kill:  "Process management isn't whitelisted. Ask the user.",
  apt:   "Package install isn't whitelisted. Ask the user to install dependencies.",
  brew:  "Package install isn't whitelisted. Ask the user to install dependencies.",
};

function suggestNearestPrefix(cmd: string, list: readonly string[]): string | undefined {
  const toks = cmd.trim().split(/\s+/);
  const head = toks[0] ?? "";
  if (!head) return undefined;
  // Only suggest a whitelisted entry the command's first 1–2 tokens EXACTLY
  // equal at the subcommand level — never a different sibling. Returning the
  // first same-head entry produced misleading advice like `go doc` → "go get"
  // (recommending a network-mutating command to fix a read-only one).
  const candidates = [toks.slice(0, 2).join(" "), head];
  for (const c of candidates) {
    for (const p of list) {
      if (p.trim() === c) return p;
    }
  }
  return undefined;
}

// Whitelisted entries that share a multi-subcommand head (e.g. all `go …` or
// `cargo …` forms). Used to list the real alternatives when a subcommand of a
// known tool is blocked, instead of guessing a single (possibly wrong) sibling.
function headSiblings(head: string, list: readonly string[]): string[] {
  if (!head) return [];
  return list.filter((p) => {
    const t = p.trim().split(/\s+/);
    return t.length > 1 && t[0] === head;
  }).map((p) => p.trim());
}

export function buildBlockReason(
  cmd: string,
  mode: "auto" | "manual",
  list: readonly string[] = SAFE_PREFIXES,
  approval: ApprovalTimeout = "30s",
): string {
  // Report the specific offending sub-command, not the whole line's head —
  // for `cd /x && rm -rf` the problem is `rm`, not `cd`.
  const bad = (firstUnsafeSegment(cmd, list) ?? cmd).trim();
  const base = mode === "manual"
    ? "manual permission mode: not pre-approved"
    : "bash whitelist: not whitelisted";
  const tail = approval === "immediate"
    ? `blocked without prompting (approvalTimeout is "immediate"). If the user is present, switch it to 30s or forever in /settings → Plugins → ${PLUGIN_NAME}.`
    : approval === "forever"
      ? "the user did not approve at the prompt (explicit No)."
      : "the user did not approve at the prompt (no response within 30s or explicit No).";
  const prefix = `${base}, ${tail}`;

  if (hasCommandSubstitution(bad)) {
    return `${prefix} Command substitution ($(...) or backticks) isn't allowed — ` +
      `it can run arbitrary commands. Run the inner command directly if it's whitelisted.`;
  }

  if (hasFileRedirect(bad)) {
    return `${prefix} Output redirection writes a file outside the checkpointed ` +
      `Write/Edit tools. Redirect to a scratch path (e.g. > /tmp/out.txt) if you ` +
      `just need to capture output; otherwise use Write to create a file or Edit ` +
      `to change one.`;
  }

  const head = bad.split(/\s+/)[0] ?? "";
  const intent = INTENT_HINTS[head];
  if (intent) return `${prefix} "${head}" — ${intent}`;

  const exact = suggestNearestPrefix(bad, list);
  if (exact) return `${prefix} "${head}" is not in SAFE_PREFIXES. Try "${exact.trim()}" instead.`;
  // For a blocked subcommand of a known multi-subcommand tool, list the actual
  // whitelisted siblings rather than picking one (which could be destructive).
  const siblings = headSiblings(head, list);
  const tailLine = siblings.length
    ? `Whitelisted "${head}" subcommands: ${siblings.join(", ")}.`
    : `Whitelisted starts: ${list.slice(0, 12).map((p) => p.trim()).join(", ")} ...`;
  return `${prefix} "${head}" is not in SAFE_PREFIXES. ${tailLine}`;
}

// How long the approval dialog stays open before the highlighted option takes
// effect (approvalTimeout "30s" mode). The cursor starts on "No", so a silent
// terminal still means "blocked" — auto-reject after 30s without a reply. Any
// keypress (including moving the cursor) restarts the countdown, so an
// engaged user is never cut off by the timer.
const APPROVAL_TIMEOUT_MS = 30 * 1000;

// The user has to be pulled to the terminal, so the prompt rides the same
// channel as the harness' "work done" notice — TERMINAL.sendNotification with
// the completion shape (desktop toast + bell, per the terminal's notify
// protocol). The specifier is host-resolved by the extension loader; the
// dynamic, guarded import means a resolution failure can never take the gate
// itself down.
async function sendApprovalNotification(): Promise<void> {
  try {
    const mod = await import("@oh-my-pi/pi-tui");
    mod.TERMINAL?.sendNotification?.({
      title: "Oh My Pi",
      body: "Permission required",
      type: "completion",
      actions: "focus",
    });
  } catch {
    // No notification surface — the on-screen dialog is the signal.
  }
}

// Ask the user whether to run a non-whitelisted command. The TUI dialog is a
// Yes/No selector; in "30s" mode its timeout applies the currently highlighted
// option, so the cursor starts on "No": doing nothing for 30s rejects, while
// an explicit move to "Yes" that times out approves. In "forever" mode no
// timeout is armed and the prompt stays open until the user answers (Esc is
// treated as a block). "immediate" mode never calls this (the handler blocks
// up front); it returns false defensively. The prompt and option labels are
// plain text — no ANSI colors, no markdown — because the same strings are
// broadcast verbatim to the collab browser client, which renders them raw;
// the terminal TUI paints the title's extra lines in the accent color on
// its own. Options carry one-line descriptions. Any failure (no UI, dialog
// error, notification error) resolves false, so the safe default remains
// "block".
export async function askApproval(
  ctx: ExtensionContext,
  cmd: string,
  bad: string,
  timeout: ApprovalTimeout = "30s",
): Promise<boolean> {
  if (!ctx.hasUI) return false;
  if (timeout === "immediate") return false;
  const shown = cmd.trim();
  const prompt = [
    "permission-gate: run non-whitelisted command?",
    `"${bad.trim()}" is not on the bash whitelist.`,
    "",
    shown,
  ].join("\n");
  await sendApprovalNotification();
  const yesLabel = "Yes — run it";
  const noLabel = "No — block it";
  try {
    const result = await ctx.ui.select(
      prompt,
      [
        { label: yesLabel, description: "execute the command above" },
        { label: noLabel, description: "keep it blocked (the model is told why)" },
      ],
      { timeout: timeout === "forever" ? undefined : APPROVAL_TIMEOUT_MS, initialIndex: 1 },
    );
    return result === yesLabel;
  } catch {
    return false;
  }
}

interface GatedToolInput {
  command?: string;
  op?: string;
  application?: string;
  args?: string[];
}

// The tool_call event is a per-tool discriminated union; the gate only needs a
// couple of optional string fields. Narrow once at this boundary so bash and
// hub can be treated uniformly without per-member union access.
function asGatedInput(v: unknown): GatedToolInput {
  if (typeof v !== "object" || v === null) return {};
  const o = v as Record<string, unknown>; // boundary: host event payload
  return {
    command: typeof o.command === "string" ? o.command : undefined,
    op: typeof o.op === "string" ? o.op : undefined,
    application: typeof o.application === "string" ? o.application : undefined,
    args: Array.isArray(o.args) ? o.args.filter((x): x is string => typeof x === "string") : undefined,
  };
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const mode = getPermissionMode();
    if (mode === "accept-all") return;

    const toolName = event.toolName;
    const input = asGatedInput(event.input);

    // Gate bash-family tools AND `hub`'s process-launch ops — otherwise the
    // whitelist is trivially bypassed by routing a command through
    // `hub {op:"start", application, args}`, which is exactly the old `launch`
    // tool (v17.0.0 merged irc/job/launch into `hub`; the `ShellSession` tool
    // this branch used to name no longer exists). omp tiers those ops as
    // `exec`, but the default approvalMode is `yolo`, so nothing prompts.
    // pi has its own confirmation flow for destructive edits via the TUI.
    const isBash = toolName === "bash" || toolName === "Bash";
    const isHubLaunch = (toolName === "hub" || toolName === "Hub")
      && (input?.op === "start" || input?.op === "restart");

    if (isBash || isHubLaunch) {
      // `hub` carries the command as {application, args[]} rather than one
      // shell string; join it so the same whitelist and per-segment checks
      // apply. Nothing is shell-parsed on that path, so a joined string is a
      // conservative over-approximation, which is the right direction here.
      const cmd = isHubLaunch
        ? [input.application, ...(input.args ?? [])].filter((x) => x.length > 0).join(" ")
        : input.command;
      if (typeof cmd === "string") {
        // Checked before the whitelist: `sleep` IS whitelisted (it's harmless),
        // so the wait-only shape would otherwise sail through unremarked.
        if (isBash && isWaitOnlyBash(cmd)) {
          try { ctx.ui.notify("permission-gate: blocked wait-only command (anti-stall)", "warning"); } catch {}
          return { block: true, reason: WAIT_ONLY_REASON };
        }
        const settings = await loadGateSettings(ctx.cwd);
        const list = settings.whitelist ?? SAFE_PREFIXES;
        const bad = firstUnsafeSegment(cmd, list);
        if (bad !== null) {
          const reason = buildBlockReason(cmd, mode === "manual" ? "manual" : "auto", list, settings.approvalTimeout);
          // "immediate": no dialog, no notification — reject up front so an
          // unattended session never burns 30s per non-whitelisted call.
          const approved = settings.approvalTimeout === "immediate"
            ? false
            : await askApproval(ctx, cmd, bad, settings.approvalTimeout);
          if (approved) {
            try { ctx.ui.notify("permission-gate: approved non-whitelisted command", "info"); } catch {}
            return; // user approved — let the tool run
          }
          const head = bad.trim().split(/\s+/)[0] ?? "";
          try {
            const tag = hasCommandSubstitution(bad)
              ? "(command substitution)"
              : INTENT_HINTS[head] ? `(${INTENT_HINTS[head].split(".")[0]})` : "";
            ctx.ui.notify(`permission-gate: blocked "${head}" ${tag}`.trim(), "warning");
          } catch {}
          return { block: true, reason };
        }
      }
    }
  });
}
