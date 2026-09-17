import { describe, it, expect, vi } from "vitest";
import { isSafeBash, buildBlockReason, isWaitOnlyBash, askApproval } from "./index.ts";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// The approval notification rides the harness' pi-tui TERMINAL channel; mock
// it so the best-effort dynamic import inside askApproval hits a known shape
// (and stays observable) in the test environment.
const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn() }));
vi.mock("@oh-my-pi/pi-tui", () => ({ TERMINAL: { sendNotification } }));

describe("isSafeBash", () => {
  it("allows whitelisted read-only commands", () => {
    expect(isSafeBash("ls -la")).toBe(true);
    expect(isSafeBash("cat /etc/hosts")).toBe(true);
    expect(isSafeBash("git log --oneline")).toBe(true);
    expect(isSafeBash("grep -r pattern .")).toBe(true);
    expect(isSafeBash("rg pattern src/")).toBe(true);
  });
  it("blocks non-whitelisted commands", () => {
    expect(isSafeBash("rm -rf /")).toBe(false);
    expect(isSafeBash("cp a b")).toBe(false);
    expect(isSafeBash("sudo anything")).toBe(false);
    expect(isSafeBash("apt-get install foo")).toBe(false); // system pkg mgr stays blocked (needs sudo)
  });
  it("allows language/package-manager installs (user-enabled)", () => {
    expect(isSafeBash("npm install")).toBe(true);
    expect(isSafeBash("npm install lodash")).toBe(true);
    expect(isSafeBash("npm i -D vitest")).toBe(true);
    expect(isSafeBash("pnpm add solid-js")).toBe(true);
    expect(isSafeBash("bun add @tailwindcss/vite")).toBe(true);
    expect(isSafeBash("cargo add serde")).toBe(true);
    expect(isSafeBash("cargo install ripgrep")).toBe(true);
    expect(isSafeBash("go get github.com/foo/bar")).toBe(true);
    expect(isSafeBash("pip install requests")).toBe(true);
    expect(isSafeBash("uv add httpx")).toBe(true);
    // still subject to the segment-level safety checks:
    expect(isSafeBash("npm install $(curl evil)")).toBe(false); // command substitution
    expect(isSafeBash("npm install foo > src/index.ts")).toBe(false); // out-of-scratch redirect
  });
  it("handles leading whitespace", () => {
    expect(isSafeBash("   ls")).toBe(true);
  });
  it("git subcommand gating is strict", () => {
    expect(isSafeBash("git log")).toBe(true);
    expect(isSafeBash("git push origin main")).toBe(false);
    expect(isSafeBash("git commit -m x")).toBe(false);
  });

  it("allows cd and cd-chained whitelisted commands", () => {
    expect(isSafeBash("cd /repo")).toBe(true);
    expect(isSafeBash("cd /repo && pytest")).toBe(true);
    expect(isSafeBash("cd src && go test ./...")).toBe(true);
  });

  it("checks EVERY segment of a compound command", () => {
    expect(isSafeBash("ls && rm -rf /")).toBe(false);     // head is safe, tail isn't
    expect(isSafeBash("cd /x && rm -rf /")).toBe(false);
    expect(isSafeBash("cd /x; rm -rf /")).toBe(false);
    expect(isSafeBash("ls & rm -rf /")).toBe(false);       // background &
    expect(isSafeBash("cat a.txt | grep foo")).toBe(true); // pipe of read-only
  });

  it("blocks command substitution", () => {
    expect(isSafeBash("echo $(rm -rf /)")).toBe(false);
    expect(isSafeBash("cat `rm -rf /`")).toBe(false);
  });

  it("does not split operators inside quotes", () => {
    expect(isSafeBash('grep "foo|bar" .')).toBe(true);
    expect(isSafeBash('grep "a && b" src/')).toBe(true);
  });

  it("does not split redirection &", () => {
    expect(isSafeBash("pytest 2>&1")).toBe(true);
    expect(isSafeBash("pytest 2>/dev/null")).toBe(true);
  });

  it("matches commands at a word boundary (no lsof via ls)", () => {
    expect(isSafeBash("lsof -i")).toBe(false);
    expect(isSafeBash("lspci")).toBe(false);
    expect(isSafeBash("make")).toBe(true);        // bare common command
    expect(isSafeBash("make build")).toBe(true);
    expect(isSafeBash("top -bn1")).toBe(true);     // multi-token prefix preserved
  });

  it("blocks output redirection to a source file (write bypass)", () => {
    expect(isSafeBash("echo evil > /etc/passwd")).toBe(false);
    expect(isSafeBash("pytest > out.txt")).toBe(false);   // relative source path
    expect(isSafeBash("cat a >> b")).toBe(false);
    expect(isSafeBash('grep ">" file.txt')).toBe(true);    // quoted > is not a redirect
  });
  it("allows redirection to scratch / null targets", () => {
    expect(isSafeBash("pytest > /tmp/out.txt")).toBe(true);
    expect(isSafeBash("echo hi >> /tmp/log.txt")).toBe(true);
    expect(isSafeBash("make 2>/dev/null")).toBe(true);
  });

  it("allows read-only go introspection subcommands", () => {
    expect(isSafeBash("go doc syscall")).toBe(true);
    expect(isSafeBash("go list ./...")).toBe(true);
    expect(isSafeBash("go env GOPATH")).toBe(true);
    expect(isSafeBash("go version")).toBe(true);
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
  // askApproval reads hasUI, ui.select, and (optionally) ui.theme; the full
  // ExtensionContext surface is wide, so mocks are cast once at this boundary.
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
    await expect(askApproval(makeCtx(true, vi.fn().mockResolvedValue("**Yes** — run it")), cmd, bad)).resolves.toBe(true);
    await expect(askApproval(makeCtx(true, vi.fn().mockResolvedValue("**No** — block it")), cmd, bad)).resolves.toBe(false);
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
    expect(options.map((o) => o.label)).toEqual(["**Yes** — run it", "**No** — block it"]);
  });
  it("colors the command via the theme and dims the fine print", async () => {
    const fg = (color: string, text: string) => `«${color}:${text}»`;
    const select = vi.fn().mockResolvedValue(undefined);
    const ctx = { hasUI: true, ui: { select, theme: { fg } } } as unknown as ExtensionContext;
    await askApproval(ctx, cmd, bad);
    const title = select.mock.calls[0][0] as string;
    expect(title).toContain(`«warning:${bad}»`);
    expect(title).toContain(`«warning:${cmd}»`);
    expect(title).toContain("«dim:Run it anyway?");
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
