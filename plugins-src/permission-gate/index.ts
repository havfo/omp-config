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
//   blockReason: standing note; when you reject a command (click "No") a note
//             prompt opens — what you type there (or, if you leave it empty,
//             this setting) is appended to the block reason the model sees, so
//             you can steer the next attempt (e.g. "use the edit tool, not bash").
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
  /** Standing note: fallback for the note prompt when you reject without typing one. */
  blockReason: string | null;
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
  const blockReason = typeof raw.blockReason === "string" ? raw.blockReason.trim() : "";
  return { approvalTimeout: timeout, whitelist: parseWhitelist(raw.whitelist), blockReason: blockReason.length > 0 ? blockReason : null };
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
  // flow/no-ops that make compound commands parse. Loop PAYLOADS are checked
  // separately in segmentSafe — a bare `do` entry must never whitelist a body.
  "cd ", "sleep", "for", "while", "do", "done", "true", "false", ":",
  // read-only inspection
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "date",
  "which", "type", "printenv", "uname", "whoami", "id",
  "base64", "cmp", "tac", "nproc", "hostname", "seq", "yes", "mktemp",
  "touch", "pgrep", "tree", "stat ", "file ",
  "basename ", "dirname ", "realpath ", "readlink ",
  "sha1sum ", "sha224sum ", "sha256sum ", "sha384sum ", "sha512sum ",
  "b2sum ", "md5sum ", "xxd ", "nl ",
  "df ", "du ", "free ", "top -bn", "ps ",
  // git: read forms only (mutating flags are gated in hasGitMutation)
  "git log", "git status", "git diff", "git show", "git branch",
  "git remote", "git stash list", "git tag",
  // network inspection
  "curl", "wget", "netcat", "nc", "netstat", "ping", "ping6", "traceroute", "traceroute6",
  // search (find's mutating flags are gated in hasFindMutation)
  "find ", "grep ", "rg ", "ag ", "fd ",
  // text capture and transforms (tee targets gated in hasTeeNonScratch,
  // sed -i in hasSedInPlace)
  "mkdir ", "sed ", "diff ", "sort ", "uniq ", "cut ", "tr ",
  "comm ", "jq ", "tee",
  // introspection + installs (pip install deliberately excluded: it can run
  // arbitrary setup code — add it via the whitelist setting if you want it)
  "pip show", "pip list", "cargo metadata",
  "cargo add", "cargo install", "cargo fetch", "cargo update",
  "go get", "go install", "go mod download", "go mod tidy",
  "gem install", "bundle install", "bundle add",
  "npm install", "npm ci", "pnpm install", "pnpm add", "yarn install",
  "bun install", "bun add",
  // build / test / run
  "pytest", "python -m pytest", "python -m unittest", "tox",
  "make", "cmake ", "ctest",
  "cargo build", "cargo test", "cargo check", "cargo run", "cargo clippy", "cargo fmt",
  "go test", "go build", "go run", "go vet",
  "go doc", "go list", "go env", "go version",
  "gradle ", "./gradlew", "mvn ", "dotnet test", "dotnet build",
  "jest", "vitest", "mocha", "tsc",
  "pnpm test", "pnpm run", "yarn test", "yarn run", "bun test", "bun run",
  "rustc ", "gcc ", "g++ ", "clang ", "javac ",
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

// `find` can mutate the filesystem without any visible redirect: `-delete`
// removes files, `-exec`/`-ok` run an arbitrary command per match. The plain
// listing forms stay allowed.
function hasFindMutation(seg: string): boolean {
  const toks = seg.trim().split(/\s+/);
  if (toks[0] !== "find") return false;
  return toks.some((t) =>
    t === "-delete" || t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir");
}

// `sed -i` rewrites a file in place — a write that bypasses Write/Edit exactly
// like a bad redirect does. The non-in-place forms are read transforms.
function hasSedInPlace(seg: string): boolean {
  const toks = seg.trim().split(/\s+/);
  if (toks[0] !== "sed") return false;
  return toks.some((t) => t === "-i" || t === "--in-place" || (t.startsWith("-i.") && t.length > 3));
}

// `git branch`/`git tag`/`git remote` list refs and config by default, but
// their mutating forms delete or rewrite them (`git branch -d x`,
// `git tag -d v1`, `git remote add origin x`).
function hasGitMutation(seg: string): boolean {
  const toks = seg.trim().split(/\s+/);
  if (toks[0] !== "git") return false;
  const sub = toks[1];
  if (sub === "branch") return toks.slice(2).some((t) => ["-d", "-D", "-m", "-M", "-c"].includes(t));
  if (sub === "tag") return toks.slice(2).includes("-d");
  if (sub === "remote") return ["add", "remove", "rename", "set-url", "set-head"].includes(toks[2]);
  return false;
}

// `tee` writes its file arguments — the same class as a redirect. Only the
// null/std devices and scratch targets are safe. (None of tee's flags take an
// argument, so every non-flag token is a file.)
function hasTeeNonScratch(seg: string): boolean {
  const toks = seg.trim().split(/\s+/);
  if (toks[0] !== "tee") return false;
  return toks.slice(1).some((t) => !t.startsWith("-") && !isAllowedRedirectTarget(t));
}

// Loop constructs hide the real command in their payload: `while true; do
// rm -rf /; done` splits into `while true` / `do rm -rf /` / `done`, and a
// bare `do` entry would whitelist the segment regardless of the payload. A
// loop segment is only safe when its payload (the command after `do`, or the
// condition after `while`/`until`) is itself safe. `for <spec>` carries no
// executable command (the spec cannot run; substitution is caught above),
// and `done` has no payload.
function segmentSafe(seg: string, list: readonly string[]): boolean {
  if (hasCommandSubstitution(seg)) return false;
  if (hasFileRedirect(seg)) return false;
  if (hasFindMutation(seg)) return false;
  if (hasSedInPlace(seg)) return false;
  if (hasGitMutation(seg)) return false;
  if (hasTeeNonScratch(seg)) return false;
  const toks = seg.trim().split(/\s+/);
  const head = toks[0];
  if (head === "do" || head === "while" || head === "until") {
    const payload = toks.slice(1).join(" ");
    return payload.length > 0 && segmentSafe(payload, list);
  }
  return list.some((p) => prefixMatches(seg, p));
}

// ── Static variable analysis ─────────────────────────────────────────────
// The bash tool runs a PERSISTENT shell, so the model writes `c=/path` in one
// call and `ls $c` in another. Within one command line that is checkable
// statically: a pure assignment segment executes nothing, so it is safe when
// its value is a literal, and the value is recorded so later `$c`/`${c}` uses
// are expanded and validated like inline text.
//
// Deliberately conservative:
//   - values containing `$` or backticks are rejected — they could expand or
//     run something we cannot see;
//   - assignments glued to a command (`LD_PRELOAD=x ls`) are NOT resolved —
//     env-prefixed commands can load arbitrary code, and the bash tool has a
//     dedicated `env` argument for the legit case;
//   - loop iteration variables take values we cannot see (globs, command
//     output), so segments that use them are left to the prompt;
//   - expansions we otherwise cannot resolve ($HOME, $?, variables from
//     EARLIER calls — persistent-shell state is invisible) are left to the
//     prompt too.
const ASSIGN_TOKEN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

// True when the whole segment is one or more NAME=value assignments with
// literal values (applied to vars); false for commands, mixed shapes, or a
// value that would expand.
function applyAssignment(seg: string, vars: Record<string, string>): boolean {
  for (const t of seg.trim().split(/\s+/)) {
    const m = ASSIGN_TOKEN.exec(t);
    if (!m) return false;
    const raw = m[2];
    let value: string;
    if (raw.length >= 2 && raw[0] === "'" && raw.endsWith("'")) {
      value = raw.slice(1, -1); // single-quoted: no expansion, taken as-is
    } else if (raw.length >= 2 && raw[0] === '"' && raw.endsWith('"')) {
      if (raw.includes("$") || raw.includes("`")) return false; // would expand
      value = raw.slice(1, -1);
    } else {
      if (raw.includes("$") || raw.includes("`")) return false; // would expand
      value = raw;
    }
    vars[m[1]] = value;
  }
  return true;
}

// Expand $c/${c} from known literal values; null when anything remains that
// we cannot resolve (loop variables, unknown variables, $?, $$, backticks,
// escaped $, ...).
function resolveSegment(
  seg: string,
  vars: Record<string, string>,
  loopVars: Set<string>,
): string | null {
  let unknown = false;
  const resolved = seg.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (match, id: string) => {
    if (loopVars.has(id)) { unknown = true; return match; } // invisible value
    if (id in vars) return vars[id];
    unknown = true;
    return match;
  });
  if (unknown || resolved.includes("$") || resolved.includes("`")) return null;
  return resolved;
}

// Returns the first sub-command that fails the whitelist, or null if all pass.
export function firstUnsafeSegment(command: string, list: readonly string[] = SAFE_PREFIXES): string | null {
  const c = command.trim();
  if (!c) return c;
  const segs = splitSegments(c);
  if (segs.length === 0) return c;
  const vars: Record<string, string> = {};
  const loopVars = new Set<string>();
  for (const seg of segs) {
    if (applyAssignment(seg, vars)) continue; // literal assignment: executes nothing
    const resolved = resolveSegment(seg, vars, loopVars);
    if (resolved === null) return seg; // unresolvable expansion: ask the user
    if (!segmentSafe(resolved, list)) return seg;
    // `for NAME in ...`: register the iteration variable (its values are
    // invisible: globs, file lists, command output).
    const forMatch = /^for ([A-Za-z_][A-Za-z0-9_]*) in /.exec(resolved);
    if (forMatch) loopVars.add(forMatch[1]);
  }
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
  awk:   "awk can run shell commands (system(), |) and write files. Use grep/jq/cut for text transforms, or ask for approval.",
  env:   "Don't prefix commands with `env` — pass variables via bash's `env` argument: {\"command\":\"...\",\"env\":{\"NAME\":\"value\"}}.",
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
  userReason: string | null = null,
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

  // A segment whose variables the static analysis could not resolve: say
  // exactly that — the fix is to inline the value.
  if (/\$/.test(bad)) {
    return `${prefix} the segment uses shell variables the gate cannot resolve statically — inline the value literally (e.g. "ls /tmp/data", not "ls $c") and try again.`;
  }

  const head = bad.split(/\s+/)[0] ?? "";
  let body: string;
  if (hasCommandSubstitution(bad)) {
    body = "Command substitution ($(...) or backticks) isn't allowed — " +
      "it can run arbitrary commands. Run the inner command directly if it's whitelisted.";
  } else if (hasFileRedirect(bad)) {
    body = "Output redirection writes a file outside the checkpointed " +
      "Write/Edit tools. Redirect to a scratch path (e.g. > /tmp/out.txt) if you " +
      "just need to capture output; otherwise use Write to create a file or Edit " +
      "to change one.";
  } else if (hasFindMutation(bad)) {
    body = "find's mutating flags (-delete, -exec, -ok, ...) remove files or run arbitrary " +
      "commands per match. List the files first, then delete via the Edit tool's REM op or ask the user.";
  } else if (hasSedInPlace(bad)) {
    body = "sed -i rewrites the file in place, bypassing the Edit tool's read-before-edit guard. " +
      "Transform to stdout into a scratch file and use Write, or use Edit directly.";
  } else if (hasGitMutation(bad)) {
    body = "git ref/config mutations (branch/tag delete or rename, remote changes) aren't " +
      "whitelisted. Ask the user.";
  } else if (hasTeeNonScratch(bad)) {
    body = "tee writes its file arguments, like a redirect. Point it at a scratch path " +
      "(| tee /tmp/out.txt) or /dev/null.";
  } else if (head === "do" || head === "while" || head === "until") {
    body = `loops are checked segment by segment — "${bad}" isn't whitelisted, so a loop can't hide it.`;
  } else {
    const intent = INTENT_HINTS[head];
    if (intent) {
      body = `"${head}" — ${intent}`;
    } else {
      const exact = suggestNearestPrefix(bad, list);
      if (exact) {
        body = `"${head}" is not in SAFE_PREFIXES. Try "${exact.trim()}" instead.`;
      } else {
        // For a blocked subcommand of a known multi-subcommand tool, list the actual
        // whitelisted siblings rather than picking one (which could be destructive).
        const siblings = headSiblings(head, list);
        const tailLine = siblings.length
          ? `Whitelisted "${head}" subcommands: ${siblings.join(", ")}.`
          : `Whitelisted starts: ${list.slice(0, 12).map((p) => p.trim()).join(", ")} ...`;
        body = `"${head}" is not in SAFE_PREFIXES. ${tailLine}`;
      }
    }
  }
  const reason = `${prefix} ${body}`;
  // The user's note — typed at the "No" prompt, or the standing blockReason
  // setting when that prompt is left empty — is appended verbatim, quoted, at
  // the end; the model should treat it as an instruction for the next attempt.
  return userReason ? `${reason} The user's note: "${userReason}"` : reason;
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
// an explicit move to "Yes" that times out approves. An explicit "No" opens a
// follow-up note prompt — the user's one-line guidance for the model, appended
// to the block reason. In "forever" mode no timeout is armed and the prompts
// stay open until the user answers (Esc is treated as a block). "immediate"
// mode never calls this (the handler blocks up front); it returns false
// defensively. The prompt and option labels are plain text — no ANSI colors,
// no markdown — because the same strings are broadcast verbatim to the collab
// browser client, which renders them raw; the terminal TUI paints the title's
// extra lines in the accent color on its own. Options carry one-line
// descriptions. Any failure (no UI, dialog error, notification error) resolves
// false, so the safe default remains "block", with explicitDenial true only
// when the user actively chose "No".
export interface ApprovalOutcome {
  approved: boolean;
  /** True only when the user actively chose "No" (a timeout or Esc does not count). */
  explicitDenial: boolean;
  /** Note typed at the denial prompt; null when the prompt was left empty. */
  note: string | null;
}

export async function askApproval(
  ctx: ExtensionContext,
  cmd: string,
  bad: string,
  timeout: ApprovalTimeout = "30s",
): Promise<ApprovalOutcome> {
  if (!ctx.hasUI) return { approved: false, explicitDenial: false, note: null };
  if (timeout === "immediate") return { approved: false, explicitDenial: false, note: null };
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
        { label: noLabel, description: "keep it blocked, with an optional note for the model" },
      ],
      { timeout: timeout === "forever" ? undefined : APPROVAL_TIMEOUT_MS, initialIndex: 1 },
    );
    if (result === yesLabel) return { approved: true, explicitDenial: false, note: null };
    if (result === noLabel) {
      return { approved: false, explicitDenial: true, note: await askDenialNote(ctx, timeout) };
    }
    return { approved: false, explicitDenial: false, note: null };
  } catch {
    return { approved: false, explicitDenial: false, note: null };
  }
}

// After an explicit "No", offer a one-line note for the model — it is appended
// to the block reason and steers the next attempt. Esc or an empty line means
// no note; any failure leaves the denial standing without guidance.
async function askDenialNote(ctx: ExtensionContext, timeout: ApprovalTimeout): Promise<string | null> {
  try {
    const typed = await ctx.ui.input(
      "Note to the model (optional) — added to the block reason it receives.",
      "e.g. use the Edit tool, not bash — Esc leaves it empty",
      { timeout: timeout === "forever" ? undefined : APPROVAL_TIMEOUT_MS },
    );
    const note = typeof typed === "string" ? typed.trim() : "";
    return note.length > 0 ? note : null;
  } catch {
    return null;
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
          // "immediate": no dialog, no notification — reject up front so an
          // unattended session never burns 30s per non-whitelisted call.
          const outcome = settings.approvalTimeout === "immediate"
            ? { approved: false, explicitDenial: false, note: null }
            : await askApproval(ctx, cmd, bad, settings.approvalTimeout);
          if (outcome.approved) {
            try { ctx.ui.notify("permission-gate: approved non-whitelisted command", "info"); } catch {}
            return; // user approved — let the tool run
          }
          // The user's note — typed at the "No" prompt, or the standing
          // blockReason setting when that prompt is left empty — is attached
          // only on an explicit "No": a timeout or Esc is silence, not guidance.
          const note = outcome.explicitDenial ? (outcome.note ?? settings.blockReason) : null;
          const reason = buildBlockReason(cmd, mode === "manual" ? "manual" : "auto", list, settings.approvalTimeout, note);
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
