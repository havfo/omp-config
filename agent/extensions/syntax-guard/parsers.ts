// Language registry — maps file extensions to tree-sitter WASM grammar files.
// Lazily loads parsers on first use. Reuses web-tree-sitter WASM grammars
// bundled with pi-lens (installed globally alongside pi-coding-agent).

import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

// ── Grammar file discovery ──────────────────────────────────────────────

const require = createRequire(import.meta.url);

/** Resolve the grammars directory from pi-lens's web-tree-sitter dependency. */
function findGrammarsDir(): string | null {
  const candidates: string[] = [];
  
  try {
    candidates.push(join(dirname(require.resolve("web-tree-sitter/package.json")), "grammars"));
  } catch {}

  try {
    candidates.push(join(
      dirname(require.resolve("pi-lens/package.json")),
      "node_modules", "web-tree-sitter", "grammars"
    ));
  } catch {}

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }

  // Last resort: probe nvm global lib for any installed node version
  const nvmBase = join(process.env.HOME ?? homedir(), ".nvm", "versions", "node");
  try {
    for (const ver of readdirSync(nvmBase).reverse()) {
      const candidate = join(nvmBase, ver, "lib", "node_modules", "pi-lens", "node_modules", "web-tree-sitter", "grammars");
      if (existsSync(candidate)) return candidate;
    }
  } catch {}

  return null;
}

// ── Language → grammar mapping ──────────────────────────────────────────

interface LanguageEntry {
  /** File extensions (without dot) */
  extensions: string[];
  /** WASM grammar filename */
  wasmFile: string;
}

const LANGUAGES: LanguageEntry[] = [
  { extensions: ["ts"], wasmFile: "tree-sitter-typescript.wasm" },
  { extensions: ["tsx"], wasmFile: "tree-sitter-tsx.wasm" },
  { extensions: ["js", "mjs", "cjs", "jsx"], wasmFile: "tree-sitter-javascript.wasm" },
  { extensions: ["py"], wasmFile: "tree-sitter-python.wasm" },
  { extensions: ["go"], wasmFile: "tree-sitter-go.wasm" },
  { extensions: ["rs"], wasmFile: "tree-sitter-rust.wasm" },
  { extensions: ["c", "h"], wasmFile: "tree-sitter-c.wasm" },
  { extensions: ["cpp", "cc", "cxx", "hpp"], wasmFile: "tree-sitter-cpp.wasm" },
  { extensions: ["java"], wasmFile: "tree-sitter-java.wasm" },
  { extensions: ["rb"], wasmFile: "tree-sitter-ruby.wasm" },
  { extensions: ["kt", "kts"], wasmFile: "tree-sitter-kotlin.wasm" },
  { extensions: ["dart"], wasmFile: "tree-sitter-dart.wasm" },
  { extensions: ["ex", "exs"], wasmFile: "tree-sitter-elixir.wasm" },
];

/** Build extension → wasmFile lookup */
const extToWasm = new Map<string, string>();
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions) {
    extToWasm.set(ext, lang.wasmFile);
  }
}

// ── Parser cache ────────────────────────────────────────────────────────

let Parser: any = null;
let Language: any = null;
let tsInitialized = false;
const parserCache = new Map<string, any>(); // wasmFile → Language
let grammarsDir: string | null | undefined = undefined;

/**
 * Initialize web-tree-sitter. Must be called before any parsing.
 * Safe to call multiple times — only initializes once.
 */
async function ensureInitialized(): Promise<boolean> {
  if (tsInitialized) return true;
  try {
    let mod: any;
    try {
      const piLensDir = dirname(require.resolve("pi-lens/package.json"));
      const webTsPath = require.resolve("web-tree-sitter/tree-sitter.js", { paths: [piLensDir] });
      mod = require(webTsPath);
    } catch {
      try {
        mod = require("web-tree-sitter");
      } catch {
        const nvmBase = join(process.env.HOME ?? homedir(), ".nvm", "versions", "node");
        let found = false;
        for (const ver of readdirSync(nvmBase).reverse()) {
          const candidate = join(nvmBase, ver, "lib", "node_modules", "pi-lens", "node_modules", "web-tree-sitter", "tree-sitter.js");
          if (existsSync(candidate)) { mod = require(candidate); found = true; break; }
        }
        if (!found) throw new Error("web-tree-sitter not found");
      }
    }

    Parser = mod.Parser || mod.default;
    Language = mod.Language;
    
    if (Parser && Parser.init) {
      await Parser.init();
    }
    tsInitialized = true;
    return true;
  } catch (e) {
    console.error("Syntax guard initialization failed:", e);
    return false;
  }
}

/**
 * Get a tree-sitter Language for the given file extension.
 * Returns null if the language is not supported or the grammar is unavailable.
 */
async function getLanguage(ext: string): Promise<any | null> {
  const wasmFile = extToWasm.get(ext);
  if (!wasmFile) return null;

  // Check cache
  if (parserCache.has(wasmFile)) return parserCache.get(wasmFile);

  // Find grammars dir
  if (grammarsDir === undefined) {
    grammarsDir = findGrammarsDir();
  }
  if (!grammarsDir) return null;

  const wasmPath = join(grammarsDir, wasmFile);
  if (!existsSync(wasmPath)) return null;

  try {
    const lang = await Language.load(wasmPath);
    parserCache.set(wasmFile, lang);
    return lang;
  } catch (e) {
    console.error("Syntax guard failed to load grammar:", e);
    // Grammar failed to load — mark as unavailable
    parserCache.set(wasmFile, null);
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Check if a file extension is supported for syntax checking.
 */
export function isSupported(ext: string): boolean {
  return extToWasm.has(ext);
}

/**
 * Parse source code and return the tree-sitter Tree, or null if the
 * language isn't supported / initialization failed.
 */
export async function parseSource(
  source: string,
  fileExtension: string,
): Promise<{ tree: any; parser: any } | null> {
  if (!(await ensureInitialized())) return null;

  const lang = await getLanguage(fileExtension);
  if (!lang) return null;

  try {
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(source);
    return { tree, parser };
  } catch {
    return null;
  }
}

/**
 * Get the file extension (without dot) from a file path.
 */
export function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "";
  return filePath.slice(lastDot + 1).toLowerCase();
}
