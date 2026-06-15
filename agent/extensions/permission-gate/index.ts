import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { tmpdir } from "node:os";

// Bash commands not matching the whitelist are blocked in "auto" mode. In
// "accept-all" mode all commands pass. Write/Edit confirmations are deferred
// to the TUI's own prompt; this only adds an extra guardrail on bash.

const SAFE_PREFIXES: readonly string[] = [
  // Navigation: harmless on its own; a destructive *following* segment is
  // caught by the per-segment check, so `cd /x && pytest` works but
  // `cd /x && rm -rf` does not. Also restores ShellSession's persistent cwd.
  "cd ",
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "date",
  "which", "type", "env", "printenv", "uname", "whoami", "id",
  "git log", "git status", "git diff", "git show", "git branch",
  "git remote", "git stash list", "git tag",
  "find ", "grep ", "rg ", "ag ", "fd ",
  "python ", "python3 ", "node ", "ruby ", "perl ",
  // npm/pnpm/yarn/bun run/test/list subcommands.
  "npm test", "npm run", "npm ci", "npm ls", "npm list",
  "pip show", "pip list", "cargo metadata",
  // Package installation (user-enabled). NOTE: install commands run arbitrary
  // postinstall/build scripts and hit the network — this is a deliberate trust
  // tradeoff. Command-substitution and out-of-scratch redirects are still
  // blocked by the per-segment checks below.
  "npm install", "npm i ", "npm i", "npm add", "npx ",
  "pnpm install", "pnpm i ", "pnpm i", "pnpm add",
  "yarn install", "yarn add", "yarn dlx ",
  "bun install", "bun i ", "bun i", "bun add", "bun x ", "bunx ",
  "cargo add", "cargo install", "cargo fetch", "cargo update",
  "go get", "go install", "go mod download", "go mod tidy",
  "pip install", "pip3 install", "python -m pip install", "python3 -m pip install",
  "uv add", "uv pip install", "uv sync",
  "pipx install", "poetry add", "poetry install",
  "gem install", "bundle install", "bundle add",
  "df ", "du ", "free ", "top -bn", "ps ",
  "curl -I", "curl --head",
  // Test / build runners — local coding models need to run their own tests.
  "pytest", "python -m pytest", "python -m unittest", "tox",
  "make", "cmake ", "ctest",
  "cargo build", "cargo test", "cargo check", "cargo run", "cargo clippy", "cargo fmt",
  "go test", "go build", "go run", "go vet",
  "gradle ", "./gradlew", "mvn ", "dotnet test", "dotnet build",
  "jest", "vitest", "mocha", "tsc",
  "pnpm test", "pnpm run", "yarn test", "yarn run", "bun test", "bun run",
  "rustc ", "gcc ", "g++ ", "clang ", "javac ",
  // Read-only text/inspection utilities.
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

function segmentSafe(seg: string): boolean {
  if (hasCommandSubstitution(seg)) return false;
  if (hasFileRedirect(seg)) return false;
  return SAFE_PREFIXES.some((p) => prefixMatches(seg, p));
}

// Returns the first sub-command that fails the whitelist, or null if all pass.
export function firstUnsafeSegment(command: string): string | null {
  const c = command.trim();
  if (!c) return c;
  const segs = splitSegments(c);
  if (segs.length === 0) return c;
  for (const seg of segs) if (!segmentSafe(seg)) return seg;
  return null;
}

export function isSafeBash(command: string): boolean {
  return firstUnsafeSegment(command) === null;
}

function getPermissionMode(): "auto" | "accept-all" | "manual" {
  const v = process.env.OMPX_PERMISSION_MODE;
  if (v === "accept-all" || v === "manual") return v;
  return "auto";
}

// Hints for commands the model commonly reaches for that don't work in
// pi's stateless bash. These are MORE useful than a fuzzy prefix match
// because the right answer is usually "use a different tool entirely",
// not "use a similarly-spelled bash command".
const INTENT_HINTS: Record<string, string> = {
  cd:    "Bash is stateless — `cd` does not persist between calls. Chain with && (e.g. `cd /path && ls`) or pass absolute paths to subsequent calls.",
  rm:    "Destructive ops are not whitelisted. Ask the user, or use a tool that doesn't need rm (Edit to clear file content, Write to overwrite a missing file).",
  mv:    "`mv` is not whitelisted. Read the source, Write to the destination, then ask the user to clean up the original.",
  cp:    "`cp` is not whitelisted. Use Read + Write instead.",
  sudo:  "The harness cannot sudo. Pick a path that doesn't require elevated permissions.",
  vim:   "Interactive editors aren't supported. Use Edit to change files in place.",
  vi:    "Interactive editors aren't supported. Use Edit to change files in place.",
  nano:  "Interactive editors aren't supported. Use Edit to change files in place.",
  open:  "GUI launchers aren't supported in this harness.",
  source:"`source` and shell-state ops don't persist. Inline the env: `VAR=val command ...`.",
  export:"Env vars don't persist between bash calls. Inline them on the same command line.",
  kill:  "Process management isn't whitelisted. Ask the user.",
  apt:   "Package install isn't whitelisted. Ask the user to install dependencies.",
  brew:  "Package install isn't whitelisted. Ask the user to install dependencies.",
};

function suggestNearestPrefix(cmd: string): string | undefined {
  const head = cmd.trim().split(/\s+/)[0] ?? "";
  if (!head) return undefined;
  // Only suggest a whitelisted prefix when its FIRST TOKEN exactly matches
  // the requested command head. Anything looser (same first letter, edit
  // distance, etc.) produces nonsense like cd → "cargo metadata".
  for (const p of SAFE_PREFIXES) {
    const ph = p.trim().split(/\s+/)[0];
    if (ph === head) return p;
  }
  return undefined;
}

function buildBlockReason(cmd: string, mode: "auto" | "manual"): string {
  // Report the specific offending sub-command, not the whole line's head —
  // for `cd /x && rm -rf` the problem is `rm`, not `cd`.
  const bad = (firstUnsafeSegment(cmd) ?? cmd).trim();
  const prefix = mode === "manual"
    ? `manual permission mode: not pre-approved.`
    : `bash whitelist: blocked.`;

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

  const exact = suggestNearestPrefix(bad);
  const tail = exact
    ? `Try "${exact.trim()}" instead.`
    : `Whitelisted starts: ${SAFE_PREFIXES.slice(0, 12).map((p) => p.trim()).join(", ")} ...`;
  return `${prefix} "${head}" is not in SAFE_PREFIXES. ${tail}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const mode = getPermissionMode();
    if (mode === "accept-all") return;

    const toolName = (event as any).toolName;
    const input: any = (event as any).input ?? (event as any).args;

    // Gate bash-family tools AND the persistent ShellSession tool — otherwise
    // the whitelist is trivially bypassed by routing commands through
    // ShellSession (same `command` arg). pi has its own confirmation flow for
    // destructive edits via the TUI.
    if (toolName === "bash" || toolName === "Bash" || toolName === "ShellSession") {
      const cmd = input?.command;
      if (typeof cmd === "string") {
        const bad = firstUnsafeSegment(cmd);
        if (bad !== null) {
          const head = bad.trim().split(/\s+/)[0] ?? "";
          try {
            const tag = hasCommandSubstitution(bad)
              ? "(command substitution)"
              : INTENT_HINTS[head] ? `(${INTENT_HINTS[head].split(".")[0]})` : "";
            ctx.ui.notify(`permission-gate: blocked "${head}" ${tag}`.trim(), "warning");
          } catch {}
          return { block: true, reason: buildBlockReason(cmd, mode === "manual" ? "manual" : "auto") };
        }
      }
    }
  });
}
