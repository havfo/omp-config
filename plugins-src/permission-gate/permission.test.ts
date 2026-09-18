import { describe, it, expect, vi } from "vitest";
import {
  isSafeBash,
  buildBlockReason,
  isWaitOnlyBash,
  askApproval,
  firstUnsafeSegment,
  mergeGateSettings,
  loadGateSettings,
} from "./index.ts";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

// The approval notification rides the harness' pi-tui TERMINAL channel; mock
// it so the best-effort dynamic import inside askApproval hits a known shape
// (and stays observable) in the test environment.
const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn() }));
vi.mock("@oh-my-pi/pi-tui", () => ({ TERMINAL: { sendNotification } }));

describe("isSafeBash", () => {
  it("allows whitelisted read-only commands", () => {
    expect(isSafeBash("ls")).toBe(true);
    expect(isSafeBash("cat src/foo.ts")).toBe(true);
    expect(isSafeBash("git status")).toBe(true);
    expect(isSafeBash("head -20 log.txt")).toBe(true);
  });
  it("blocks non-whitelisted commands", () => {
    expect(isSafeBash("rm -rf /tmp/x")).toBe(false);
    expect(isSafeBash("sudo apt update")).toBe(false);
    expect(isSafeBash("vim file.txt")).toBe(false);
  });
  it("allows package-manager installs that the built-in list ships", () => {
    // Note: `pip install` is deliberately NOT in the built-in list (it can
    // execute arbitrary setup code); add it via the `whitelist` plugin
    // setting if you want it. `pip show`/`pip list` are the read-only pair.
    expect(isSafeBash("pip show numpy")).toBe(true);
    expect(isSafeBash("pip list")).toBe(true);
    expect(isSafeBash("pip install numpy")).toBe(false);
    expect(isSafeBash("cargo install ripgrep")).toBe(true);
    expect(isSafeBash("go get golang.org/x/tools")).toBe(true);
    expect(isSafeBash("gem install jekyll")).toBe(true);
    expect(isSafeBash("bundle install")).toBe(true);
  });
  it("handles leading whitespace", () => {
    expect(isSafeBash("   ls")).toBe(true);
  });
  it("git subcommand gating is strict", () => {
    expect(isSafeBash("git log")).toBe(true);
    expect(isSafeBash("git status")).toBe(true);
    expect(isSafeBash("git diff")).toBe(true);
    expect(isSafeBash("git push")).toBe(false);
    expect(isSafeBash("git push origin main")).toBe(false);
    expect(isSafeBash("git checkout main")).toBe(false);
    expect(isSafeBash("git commit -m x")).toBe(false);
    expect(isSafeBash("git reset --hard")).toBe(false);
    expect(isSafeBash("git stash drop")).toBe(false);
  });

  it("allows cd and cd-chained whitelisted commands", () => {
    expect(isSafeBash("cd /tmp")).toBe(true);
    expect(isSafeBash("cd /tmp && ls")).toBe(true);
    expect(isSafeBash("cd /tmp && pytest")).toBe(true);
  });

  it("checks EVERY segment of a compound command", () => {
    expect(isSafeBash("ls && rm -rf x")).toBe(false);
    expect(isSafeBash("cd /x; rm -rf x")).toBe(false);
    expect(isSafeBash("ls | tee log")).toBe(false);
    expect(isSafeBash("ls && rm")).toBe(false);
    expect(isSafeBash("ls; rm")).toBe(false);
    expect(isSafeBash("ls | rm")).toBe(false);
  });

  it("blocks command substitution", () => {
    expect(isSafeBash("echo $(rm -rf x)")).toBe(false);
    expect(isSafeBash("echo `rm -rf x`")).toBe(false);
  });

  it("does not split operators inside quotes", () => {
    expect(isSafeBash('echo "a && b"')).toBe(true);
    expect(isSafeBash("grep 'x | y' file")).toBe(true);
  });

  it("does not split redirection &", () => {
    expect(isSafeBash("pytest 2>&1")).toBe(true);
    expect(isSafeBash("echo x >&2")).toBe(true);
  });

  it("matches commands at a word boundary (no lsof via ls)", () => {
    expect(isSafeBash("lsof -i")).toBe(false);
    expect(isSafeBash("lspci")).toBe(false);
    expect(isSafeBash("catnip")).toBe(false);
    expect(isSafeBash("pytest-something")).toBe(false);
    expect(isSafeBash("top")).toBe(false); // needs "top -bn"
  });

  it("blocks output redirection to a source file (write bypass)", () => {
    expect(isSafeBash("echo evil > src.go")).toBe(false);
    expect(isSafeBash("echo evil >> src.go")).toBe(false);
    expect(isSafeBash("ls > out.txt")).toBe(false);
    expect(isSafeBash("grep x file > result.md")).toBe(false);
  });

  it("allows redirection to scratch / null targets", () => {
    expect(isSafeBash("pytest > /tmp/out.txt")).toBe(true);
    expect(isSafeBash("ls > /dev/null")).toBe(true);
    expect(isSafeBash("echo hi > /dev/stdout")).toBe(true);
  });

  it("allows read-only go introspection subcommands", () => {
    expect(isSafeBash("go doc fmt")).toBe(true);
    expect(isSafeBash("go list ./...")).toBe(true);
    expect(isSafeBash("go env GOPATH")).toBe(true);
    expect(isSafeBash("go version")).toBe(true);
    expect(isSafeBash("go generate ./...")).toBe(false);
    expect(isSafeBash("go mod vendor")).toBe(false);
  });
});

describe("buildBlockReason", () => {
  it("lists whitelisted siblings instead of singling out a destructive one", () => {
    // `go generate` is blocked; the hint must NOT single out `go get` as THE
    // fix (the old `Try "go get" instead.` bug), but list the real siblings.
    const reason = buildBlockReason("go generate ./...", "auto");
    expect(reason).not.toMatch(/Try "go get" instead/);
    expect(reason).toMatch(/Whitelisted "go" subcommands/);
    expect(reason).toMatch(/go build/);
    expect(reason).toMatch(/go doc/);
  });
  it("suggests the exact match when the subcommand is whitelisted at 2 tokens", () => {
    // A typo'd flag on an allowed subcommand still resolves to that subcommand.
    expect(buildBlockReason("git push origin main", "auto")).toMatch(/git/);
  });
  it("names immediate mode instead of blaming a prompt that never happened", () => {
    const reason = buildBlockReason("git push origin main", "auto", undefined, "immediate");
    expect(reason).toMatch(/approvalTimeout is "immediate"/);
    expect(reason).toMatch(/blocked without prompting/);
    expect(reason).not.toMatch(/did not approve at the prompt/);
  });
  it("says explicit-No only in forever mode (no silent timeout there)", () => {
    expect(buildBlockReason("git push origin main", "auto", undefined, "forever")).toMatch(/explicit No/);
    expect(buildBlockReason("git push origin main", "auto", undefined, "30s")).toMatch(/no response within 30s or explicit No/);
  });
});

describe("isWaitOnlyBash", () => {
  it("blocks commands that only wait", () => {
    expect(isWaitOnlyBash("sleep 30")).toBe(true);
    expect(isWaitOnlyBash("sleep 5; sleep 5")).toBe(true);
    expect(isWaitOnlyBash("wait")).toBe(true);
    expect(isWaitOnlyBash("while true; do sleep 5; done")).toBe(true);
    expect(isWaitOnlyBash("echo waiting; sleep 10; echo done")).toBe(true);
  });
  it("allows a sleep paired with work that produces a fact", () => {
    expect(isWaitOnlyBash("sleep 2 && curl -s localhost:8080/health")).toBe(false);
    expect(isWaitOnlyBash("go test ./...")).toBe(false);
    expect(isWaitOnlyBash("echo hi")).toBe(false); // no wait segment at all
    expect(isWaitOnlyBash("")).toBe(false);
  });
});

describe("askApproval", () => {
  const cmd = "rm -rf build/";
  const bad = "rm -rf build/";
  // askApproval reads hasUI and ui.select; the full ExtensionContext surface
  // is wide, so mocks are cast once at this boundary.
  const makeCtx = (
    hasUI: boolean,
    select: (
      title: string,
      options: Array<{ label: string; description: string }>,
      opts?: { timeout?: number; initialIndex?: number },
    ) => Promise<string | undefined>,
  ) => ({ hasUI, ui: { select } }) as unknown as ExtensionContext;

  it("denies when no UI is available (headless stays a hard block)", async () => {
    const select = vi.fn();
    await expect(askApproval(makeCtx(false, select), cmd, bad)).resolves.toBe(false);
    expect(select).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });
  it("forwards the user's explicit choice", async () => {
    await expect(askApproval(makeCtx(true, vi.fn().mockResolvedValue("Yes — run it")), cmd, bad)).resolves.toBe(true);
    await expect(askApproval(makeCtx(true, vi.fn().mockResolvedValue("No — block it")), cmd, bad)).resolves.toBe(false);
    // Esc / cancel (undefined) is a block too.
    await expect(askApproval(makeCtx(true, vi.fn().mockResolvedValue(undefined)), cmd, bad)).resolves.toBe(false);
  });
  it("denies when the dialog throws (safety default is block)", async () => {
    await expect(
      askApproval(makeCtx(true, vi.fn().mockRejectedValue(new Error("session ended"))), cmd, bad),
    ).resolves.toBe(false);
  });
  it("shows the FULL command (no truncation), starts the cursor on No, and times out at 30s", async () => {
    const longCmd = `curl -s "http://example.com/api?token=${"a".repeat(500)}" | grep secret`;
    const select = vi.fn().mockResolvedValue(undefined);
    await askApproval(makeCtx(true, select), longCmd, longCmd);
    const [title, options, opts] = select.mock.calls[0] as unknown as [string, Array<{ label: string }>, { timeout?: number; initialIndex?: number }];
    expect(title).toContain(longCmd); // the old 300-char clip is gone
    expect(opts).toMatchObject({ timeout: 30_000, initialIndex: 1 });
    expect(options.map((o) => o.label)).toEqual(["Yes — run it", "No — block it"]);
  });
  it("sends plain text with no ANSI codes or markdown (the collab browser renders it verbatim)", async () => {
    const fg = (color: string, text: string) => `«${color}:${text}»`;
    const select = vi.fn().mockResolvedValue(undefined);
    const ctx = { hasUI: true, ui: { select, theme: { fg } } } as unknown as ExtensionContext;
    await askApproval(ctx, cmd, bad);
    const title = select.mock.calls[0][0] as string;
    expect(title).toContain(bad); // the unsafe segment, readable in a browser
    expect(title).not.toMatch(/[\u001b\u009b]/); // no escape bytes — the browser shows them verbatim
    expect(title).not.toContain("**"); // no markdown markers
    expect(title.startsWith("permission-gate:")).toBe(true); // title line stays plain (countdown suffix lands there)
  });
  it("fires the work-done-shaped terminal notification when prompting", async () => {
    sendNotification.mockClear();
    await askApproval(makeCtx(true, vi.fn().mockResolvedValue(undefined)), cmd, bad);
    expect(sendNotification).toHaveBeenCalledWith({
      title: "Oh My Pi",
      body: "Permission required",
      type: "completion",
      actions: "focus",
    });
  });
});

describe("approvalTimeout modes", () => {
  const cmd = "rm -rf build/";
  const bad = "rm -rf build/";
  const makeCtx = (
    select: (
      title: string,
      options: Array<{ label: string; description: string }>,
      opts?: { timeout?: number; initialIndex?: number },
    ) => Promise<string | undefined>,
  ) => ({ hasUI: true, ui: { select } }) as unknown as ExtensionContext;

  it("immediate: no dialog, no notification, hard block", async () => {
    const select = vi.fn();
    sendNotification.mockClear();
    await expect(askApproval(makeCtx(select), cmd, bad, "immediate")).resolves.toBe(false);
    expect(select).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });
  it("forever: dialog opens with NO timeout armed", async () => {
    const select = vi.fn().mockResolvedValue(undefined);
    await askApproval(makeCtx(select), cmd, bad, "forever");
    const opts = select.mock.calls[0][2] as { timeout?: number; initialIndex?: number };
    expect(opts.initialIndex).toBe(1); // cursor still starts on No — Esc blocks
    expect(opts.timeout).toBeUndefined(); // the TUI only starts a countdown when timeout > 0
  });
  it("30s (default): dialog opens with the 30s countdown", async () => {
    const select = vi.fn().mockResolvedValue(undefined);
    await askApproval(makeCtx(select), cmd, bad);
    const opts = select.mock.calls[0][2] as { timeout?: number };
    expect(opts.timeout).toBe(30_000);
  });
});

describe("mergeGateSettings", () => {
  it("defaults to 30s prompt and the built-in whitelist", () => {
    const s = mergeGateSettings(undefined, undefined);
    expect(s.approvalTimeout).toBe("30s");
    expect(s.whitelist).toBeNull();
  });
  it("project override beats global", () => {
    const s = mergeGateSettings({ approvalTimeout: "immediate" }, { approvalTimeout: "forever" });
    expect(s.approvalTimeout).toBe("forever");
  });
  it("keeps global values the project file does not set", () => {
    const s = mergeGateSettings({ approvalTimeout: "immediate", whitelist: "ls" }, { approvalTimeout: "forever" });
    expect(s.approvalTimeout).toBe("forever");
    expect(s.whitelist).toEqual(["ls"]);
  });
  it("rejects unknown enum values back to the default", () => {
    expect(mergeGateSettings({ approvalTimeout: "sometimes" }, undefined).approvalTimeout).toBe("30s");
    expect(mergeGateSettings({}, { approvalTimeout: 42 }).approvalTimeout).toBe("30s");
  });
  it("parses the whitelist string (commas, trims, drops empties)", () => {
    const s = mergeGateSettings({ whitelist: "ls ,  git status ,, rm -rf" }, undefined);
    expect(s.whitelist).toEqual(["ls", "git status", "rm -rf"]);
  });
  it("empty/whitespace-only whitelist falls back to the built-in list", () => {
    expect(mergeGateSettings({ whitelist: "" }, undefined).whitelist).toBeNull();
    expect(mergeGateSettings({ whitelist: "  , " }, undefined).whitelist).toBeNull();
  });
  it("ignores non-string whitelist values", () => {
    expect(mergeGateSettings({ whitelist: ["ls"] }, undefined).whitelist).toBeNull();
    expect(mergeGateSettings({ whitelist: 7 }, undefined).whitelist).toBeNull();
  });
});

describe("whitelist override", () => {
  it("a custom whitelist fully REPLACES the built-in one", () => {
    const list = ["dangerous-thing", "ls"];
    expect(isSafeBash("dangerous-thing --now", list)).toBe(true);
    expect(isSafeBash("git status", list)).toBe(false); // normally whitelisted, replaced away
    expect(firstUnsafeSegment("git status && ls", list)).toBe("git status");
    expect(firstUnsafeSegment("ls && git status", list)).toBe("git status");
  });
  it("keeps word-boundary semantics on custom entries", () => {
    const list = ["ls"];
    expect(isSafeBash("lsof -i", list)).toBe(false);
    expect(isSafeBash("ls -la", list)).toBe(true);
  });
  it("redirect and substitution guards survive a custom whitelist", () => {
    const list = ["echo"];
    expect(isSafeBash("echo x > src.go", list)).toBe(false);
    expect(isSafeBash("echo $(rm -rf x)", list)).toBe(false);
    expect(isSafeBash("echo hi", list)).toBe(true);
  });
});

describe("loadGateSettings", () => {
  function tempDir(): string {
    return mkdtempSync(path.join(tmpdir(), "pg-"));
  }

  it("reads global lockfile settings and merges project overrides", async () => {
    const dir = tempDir();
    const lock = path.join(dir, "omp-plugins.lock.json");
    const overrides = path.join(dir, ".omp", "plugin-overrides.json");
    writeFileSync(lock, JSON.stringify({ plugins: {}, settings: { "permission-gate": { approvalTimeout: "immediate" } } }));

    let s = await loadGateSettings(dir, { lockPath: lock, overridesPath: overrides });
    expect(s.approvalTimeout).toBe("immediate");
    expect(s.whitelist).toBeNull();
    // project override wins; unset keys still fall through to global
    mkdirSync(path.dirname(overrides), { recursive: true });
    writeFileSync(overrides, JSON.stringify({ settings: { "permission-gate": { approvalTimeout: "forever", whitelist: "ls, wc" } } }));
    s = await loadGateSettings(dir, { lockPath: lock, overridesPath: overrides });
    expect(s.approvalTimeout).toBe("forever");
    expect(s.whitelist).toEqual(["ls", "wc"]);
  });

  it("missing or corrupt files fall back to defaults", async () => {
    const dir = tempDir();
    const lock = path.join(dir, "omp-plugins.lock.json");
    writeFileSync(lock, "{ not json");
    const s = await loadGateSettings(dir, { lockPath: lock, overridesPath: path.join(dir, "nope.json") });
    expect(s.approvalTimeout).toBe("30s");
    expect(s.whitelist).toBeNull();
  });

  it("ignores settings for other plugins", async () => {
    const dir = tempDir();
    const lock = path.join(dir, "omp-plugins.lock.json");
    writeFileSync(lock, JSON.stringify({ settings: { "other-plugin": { approvalTimeout: "forever" } } }));
    const s = await loadGateSettings(dir, { lockPath: lock, overridesPath: path.join(dir, "nope.json") });
    expect(s.approvalTimeout).toBe("30s");
  });
});
