import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { lstat, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

// plugin-bootstrap: self-heals the install state of local (link-installed)
// plugins that live in the config directory.
//
// A link-installed plugin is three artifacts inside the config root:
//   1. source tree     <configRoot>/plugins-src/<dir>/
//   2. node_modules    <pluginsDir>/node_modules/<pkg.name>  -> source
//   3. lockfile entry  <pluginsDir>/omp-plugins.lock.json    plugins[<pkg.name>]
//
// The harness never auto-installs from (1): runtime plugin discovery only
// reads the plugins data root (2+3). If a config dir is copied to a new path,
// an absolute symlink in (2) breaks and (3) may be missing entirely — the
// plugin then loads silently-not at all. This extension runs once at
// session_start — the startup event, not every turn, because install
// self-healing is a one-shot need — finds every plugin source under
// plugins-src/, and re-establishes (2) as a RELATIVE symlink plus (3) if
// missing, so a fresh copy of the config dir self-heals on the first start.
// The plugin itself only becomes active from the next session start
// (discovery happens at startup, before this handler can run).
//
// Deliberately conservative:
//   - Only sources with a loadable manifest (package.json with a name and an
//     omp/pi field) are considered — the same gate the runtime loader applies.
//   - Never touches a healthy install: a real directory in node_modules is an
//     npm install, a resolving symlink is left alone.
//   - Never re-enables a plugin the lockfile marks enabled: false — that is a
//     user decision.
//   - Never overwrites an existing lockfile entry; missing entries are added
//     with default features (null) and enabled: true. Settings are untouched.
//   - Silently no-ops on any failure: a bootstrap bug must never block an
//     agent run.

const SOURCES_DIRNAME = "plugins-src";

export interface BootstrapRoots {
  sourcesDir: string;
  nodeModulesDir: string;
  lockfilePath: string;
}

export interface BootstrapReport {
  linked: string[];
  registered: string[];
  skipped: { name: string; reason: string }[];
  changed: boolean;
}

interface PluginSource {
  dir: string;
  name: string;
  version: string;
}

async function readPluginSource(dir: string): Promise<PluginSource | null> {
  try {
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    if (typeof pkg?.name !== "string" || pkg.name.length === 0) return null;
    if (pkg.omp === undefined && pkg.pi === undefined) return null;
    const version = typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : "0.0.0";
    return { dir, name: pkg.name, version };
  } catch {
    return null;
  }
}

type LinkState = "healthy" | "missing" | "broken" | "opaque";

async function linkState(linkPath: string): Promise<LinkState> {
  let st;
  try {
    st = await lstat(linkPath);
  } catch {
    return "missing";
  }
  if (st.isSymbolicLink()) {
    try {
      await stat(linkPath);
      return "healthy";
    } catch {
      return "broken";
    }
  }
  // A real directory is an npm-installed package: healthy, never touch.
  return st.isDirectory() ? "healthy" : "opaque";
}

export async function bootstrapPluginInstall(roots: BootstrapRoots): Promise<BootstrapReport> {
  const report: BootstrapReport = { linked: [], registered: [], skipped: [], changed: false };

  let names: string[];
  try {
    names = await readdir(roots.sourcesDir);
  } catch {
    return report; // no sources dir: nothing to do
  }

  const sources: PluginSource[] = [];
  for (const name of names) {
    const src = await readPluginSource(path.join(roots.sourcesDir, name));
    if (src) sources.push(src);
  }
  if (sources.length === 0) return report;

  // Lockfile: read once, mutate, write once. Missing/corrupt lockfile is not
  // an error — start from the empty shape (the runtime loader treats a
  // missing lockfile the same way).
  let lock: { plugins?: Record<string, unknown>; settings?: unknown } = { plugins: {}, settings: {} };
  try {
    const parsed = JSON.parse(await readFile(roots.lockfilePath, "utf8"));
    if (parsed && typeof parsed === "object") lock = parsed as typeof lock;
  } catch {}
  if (lock.plugins === undefined || typeof lock.plugins !== "object" || lock.plugins === null) {
    lock.plugins = {};
  }
  if (lock.settings === undefined) lock.settings = {};

  const seen = new Set<string>();
  for (const src of sources) {
    if (seen.has(src.name)) {
      report.skipped.push({ name: src.name, reason: "duplicate package name in plugins-src" });
      continue;
    }
    seen.add(src.name);

    const entry = lock.plugins[src.name] as { enabled?: boolean } | undefined;
    if (entry && entry.enabled === false) {
      report.skipped.push({ name: src.name, reason: "disabled in lockfile" });
      continue;
    }

    const linkPath = path.join(roots.nodeModulesDir, src.name);
    const state = await linkState(linkPath);
    if (state === "missing" || state === "broken") {
      await mkdir(roots.nodeModulesDir, { recursive: true });
      if (state === "broken") await rm(linkPath); // removes the link only
      // Relative target: survives the config root moving to another path.
      await symlink(path.relative(roots.nodeModulesDir, src.dir), linkPath);
      report.linked.push(src.name);
    } else if (state === "opaque") {
      report.skipped.push({ name: src.name, reason: "node_modules entry is neither a symlink nor a directory" });
      continue; // unclear state: leave registration to the user too
    }

    if (!entry) {
      lock.plugins[src.name] = { version: src.version, enabledFeatures: null, enabled: true };
      report.registered.push(src.name);
    }
  }

  if (report.registered.length > 0) {
    await mkdir(path.dirname(roots.lockfilePath), { recursive: true });
    await writeFile(roots.lockfilePath, JSON.stringify(lock, null, 2) + "\n");
  }
  report.changed = report.linked.length > 0 || report.registered.length > 0;
  return report;
}

export async function resolveRoots(): Promise<BootstrapRoots> {
  try {
    // Dynamic (not static), same pattern as the gate: a host-specifier
    // resolution failure at module-evaluation time would drop the whole
    // extension silently; the guarded import keeps the canonical fallback alive.
    const { getConfigRootDir, getPluginsLockfile, getPluginsNodeModules } =
      await import("@oh-my-pi/pi-utils");
    return {
      sourcesDir: path.join(getConfigRootDir(), SOURCES_DIRNAME),
      nodeModulesDir: getPluginsNodeModules(),
      lockfilePath: getPluginsLockfile(),
    };
  } catch {
    // Canonical fallback: keeps the bootstrap alive even if the host module
    // is unresolvable (same pattern as the gate's lockfile resolution).
    const root = process.env.PI_CODING_AGENT_DIR
      ? path.dirname(process.env.PI_CODING_AGENT_DIR)
      : path.join(homedir(), ".omp");
    return {
      sourcesDir: path.join(root, SOURCES_DIRNAME),
      nodeModulesDir: path.join(root, "plugins", "node_modules"),
      lockfilePath: path.join(root, "plugins", "omp-plugins.lock.json"),
    };
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const report = await bootstrapPluginInstall(await resolveRoots());
      if (report.changed) {
        const what = [
          report.linked.length > 0 ? `link: ${report.linked.join(", ")}` : "",
          report.registered.length > 0 ? `lockfile: ${report.registered.join(", ")}` : "",
        ]
          .filter((s) => s !== "")
          .join("; ");
        try {
          ctx.ui.notify(
            `plugin-bootstrap: restored install state (${what}). Active from the next session start.`,
            "warning",
          );
        } catch {}
      }
    } catch {
      // A bootstrap bug must never block an agent run.
    }
  });
}
