import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { bootstrapPluginInstall, type BootstrapRoots } from "./index.ts";

interface Fixture {
  root: string;
  sourceDir: string;
  roots: BootstrapRoots;
  linkPath: string;
}

const fixtures: string[] = [];

// Temp config-root layout: <root>/plugins-src/<name> source package plus the
// plugins data root paths the bootstrap reads and writes.
async function fixture(name = "demo-plugin", version = "1.2.3"): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "plugin-bootstrap-"));
  fixtures.push(root);
  const sourceDir = path.join(root, "plugins-src", name);
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    path.join(sourceDir, "package.json"),
    JSON.stringify({ name, version, omp: { extensions: ["./index.ts"] } }, null, 2),
  );
  await writeFile(path.join(sourceDir, "index.ts"), "export default () => {};");
  return {
    root,
    sourceDir,
    linkPath: path.join(root, "plugins", "node_modules", name),
    roots: {
      sourcesDir: path.join(root, "plugins-src"),
      nodeModulesDir: path.join(root, "plugins", "node_modules"),
      lockfilePath: path.join(root, "plugins", "omp-plugins.lock.json"),
    },
  };
}

afterAll(async () => {
  for (const root of fixtures) await rm(root, { recursive: true, force: true });
});

describe("bootstrapPluginInstall", () => {
  test("missing sources dir is a no-op", async () => {
    const f = await fixture();
    await rm(f.roots.sourcesDir, { recursive: true });
    const report = await bootstrapPluginInstall(f.roots);
    expect(report.changed).toBe(false);
    expect(report.linked).toEqual([]);
    expect(report.registered).toEqual([]);
  });

  test("bare copy (source only) gets a relative link and a lockfile entry", async () => {
    const f = await fixture("gate", "1.0.0");
    const report = await bootstrapPluginInstall(f.roots);
    expect(report.linked).toEqual(["gate"]);
    expect(report.registered).toEqual(["gate"]);
    expect(report.changed).toBe(true);

    const target = await readlink(f.linkPath);
    expect(target.startsWith("..")).toBe(true); // relative: survives root moves
    await stat(f.linkPath); // link resolves through to the source

    const lock = JSON.parse(await readFile(f.roots.lockfilePath, "utf8"));
    expect(lock.plugins.gate).toEqual({ version: "1.0.0", enabledFeatures: null, enabled: true });
  });

  test("broken symlink is replaced; existing entry and settings are preserved", async () => {
    const f = await fixture();
    await mkdir(f.roots.nodeModulesDir, { recursive: true });
    await symlink(path.join(f.root, "does-not-exist"), f.linkPath);
    await writeFile(
      f.roots.lockfilePath,
      JSON.stringify(
        {
          plugins: { "demo-plugin": { version: "9.9.9", enabledFeatures: null, enabled: true } },
          settings: { "demo-plugin": { approvalTimeout: "immediate" } },
        },
        null,
        2,
      ),
    );

    const report = await bootstrapPluginInstall(f.roots);
    expect(report.linked).toEqual(["demo-plugin"]);
    expect(report.registered).toEqual([]);
    await stat(f.linkPath); // resolves again after repair

    const lock = JSON.parse(await readFile(f.roots.lockfilePath, "utf8"));
    expect(lock.plugins["demo-plugin"].version).toBe("9.9.9"); // entry not rewritten
    expect(lock.settings["demo-plugin"]).toEqual({ approvalTimeout: "immediate" });
  });

  test("lockfile-disabled plugin is left completely alone", async () => {
    const f = await fixture();
    const lockfile =
      JSON.stringify(
        {
          plugins: { "demo-plugin": { version: "1.2.3", enabledFeatures: null, enabled: false } },
          settings: {},
        },
        null,
        2,
      ) + "\n";
    await mkdir(path.dirname(f.roots.lockfilePath), { recursive: true });
    await writeFile(f.roots.lockfilePath, lockfile);

    const report = await bootstrapPluginInstall(f.roots);
    expect(report.changed).toBe(false);
    expect(report.skipped[0]).toEqual({ name: "demo-plugin", reason: "disabled in lockfile" });
    await expect(stat(f.linkPath)).rejects.toThrow();
    expect(await readFile(f.roots.lockfilePath, "utf8")).toBe(lockfile);
  });

  test("real directory (npm install) is not re-linked; missing entry is registered", async () => {
    const f = await fixture();
    await mkdir(f.linkPath, { recursive: true });
    await writeFile(
      path.join(f.linkPath, "package.json"),
      JSON.stringify({ name: "demo-plugin", version: "2.0.0", omp: {} }),
    );

    const report = await bootstrapPluginInstall(f.roots);
    expect(report.linked).toEqual([]);
    expect(report.registered).toEqual(["demo-plugin"]);

    const st = await lstat(f.linkPath);
    expect(st.isDirectory()).toBe(true); // still a real dir, untouched
    expect(st.isSymbolicLink()).toBe(false);
    const lock = JSON.parse(await readFile(f.roots.lockfilePath, "utf8"));
    expect(lock.plugins["demo-plugin"].enabled).toBe(true);
  });

  test("source without an omp/pi manifest is skipped", async () => {
    const f = await fixture();
    await writeFile(path.join(f.sourceDir, "package.json"), JSON.stringify({ name: "demo-plugin", version: "1.2.3" }));

    const report = await bootstrapPluginInstall(f.roots);
    expect(report.changed).toBe(false);
    await expect(stat(f.linkPath)).rejects.toThrow();
    await expect(readFile(f.roots.lockfilePath, "utf8")).rejects.toThrow();
  });

  test("healthy install is a byte-identical no-op", async () => {
    const f = await fixture();
    await bootstrapPluginInstall(f.roots);
    const before = await readFile(f.roots.lockfilePath, "utf8");

    const report = await bootstrapPluginInstall(f.roots);
    expect(report.changed).toBe(false);
    expect(await readFile(f.roots.lockfilePath, "utf8")).toBe(before);
  });
});
