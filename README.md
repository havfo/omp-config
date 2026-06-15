# omp harness config

Configuration, custom extensions, and skills for a local
[**oh-my-pi**](https://github.com/can1357/oh-my-pi) (`omp`) coding-agent install,
driving a **llama.cpp** server running **Qwen3.6-35B-A3B** on an AMD Radeon RX 7900.

This repo is the contents of `~/.omp` — the agent's home directory. It tracks only
the **config** (settings, model wiring, extensions, skills); all runtime state
(SQLite databases, session transcripts, logs, caches) is gitignored.

---

## What is this?

`omp` is the oh-my-pi coding agent (`@oh-my-pi/pi-coding-agent`). It ships a large
set of built-in tools and an **extension API** that lets you hook the agent loop.
This install adds a stack of custom TypeScript extensions tuned for one specific,
demanding setup:

- **Local model, not a frontier API.** Qwen3.6-35B-A3B (MoE) is the default role;
  a dense 27B variant is also used. Small local models make tool-arg mistakes,
  fence tool calls in prose, duplicate lines, and stall — most extensions here
  exist to catch and auto-correct those failure modes.
- **Single-slot llama.cpp.** The server runs `-np 1` with a ~180k context, so
  every prompt-cache miss costs a full, slow reprocess. The stack is built to be
  **prompt-cache-friendly** (see [Prompt-cache discipline](#prompt-cache-discipline)).

```
You ── omp (Bun) ──HTTP──> llama-server (Qwen3.6, openai-responses API) @ 127.0.0.1:8080
            │
            └── extensions/ (hook the agent loop)  +  skills/ (just-in-time prompt docs)
```

---

## Repo layout

```
.
├── README.md
├── .gitignore
└── agent/
    ├── config.yml          # agent settings (theme, model role, compaction, providers)
    ├── models.yml          # provider/model wiring (llama.cpp endpoint)
    ├── extensions/         # custom TypeScript extensions (loaded at startup)
    │   ├── _shared/        # taxonomy, text extraction, follow-up arbiter (+ tests)
    │   └── <extension>/    # one dir per extension, entry = index.ts
    └── skills/             # markdown skill docs injected on demand
        ├── tools/          # per-tool usage guides
        ├── knowledge/      # algorithmic technique notes
        └── protocols/      # multi-step behavioral protocols
```

### Tracked vs. ignored

**Tracked:** `config.yml`, `models.yml`, `extensions/` (source), `skills/`.

**Ignored** (runtime / machine-local, see `.gitignore`):

| Pattern | What it is |
|---|---|
| `*.db`, `*.db-shm`, `*.db-wal` | SQLite state: `agent.db`, `history.db`, `models.db` + WAL/SHM sidecars |
| `agent/sessions/` | per-workspace conversation transcripts |
| `agent/terminal-sessions/` | live PTY/terminal state |
| `logs/` | daily `omp.YYYY-MM-DD.log` files |
| `gpu_cache.json` | cached GPU probe result |
| `agent/last-changelog-version` | "changelog seen" marker |
| `node_modules/` | extension dependencies |
| `.claude/` | Claude Code local state — not part of the harness config |

---

## `config.yml`

```yaml
symbolPreset: nerd            # nerd-font glyphs in the TUI
theme:
  dark: titanium
setupVersion: 1
modelRoles:
  default: llama.cpp/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf   # the model behind the "default" role
compaction:
  supersedeReads: false       # don't drop superseded read results on compaction
  dropUseless: false          # don't auto-drop "useless" turns
memory:
  backend: "off"              # omp's built-in memory subsystem disabled
providers:
  webSearch: kagi             # web_search tool routes through Kagi
```

`compaction.*` are kept conservative on purpose: aggressive compaction rewrites
message history, which is hostile to the prompt cache on this single-slot setup.

## `models.yml`

```yaml
providers:
  llama.cpp:
    baseUrl: http://127.0.0.1:8080   # local llama-server
    api: openai-responses            # llama.cpp discovery forces this API shape
    auth: none
    discovery:
      type: llama.cpp
```

The `openai-responses` API shape matters: at `turn_end` the model's message arrives
as **provider-native content blocks** (`output_text`, `function_call`, `reasoning`,
often nested under a `message` wrapper) rather than omp's canonical
`text`/`toolCall`/`thinking`. Extensions that inspect responses must handle both
shapes — see `_shared/text.ts`.

---

## Running the llama.cpp server

omp talks to a local `llama-server` at `http://127.0.0.1:8080`. The server is
launched outside this repo (these commands are recorded here for reference). All
three variants below target the AMD GPU via ROCm and share the same prompt-cache
and sampler discipline; they differ only in the model and batch/context sizing.
Set `$LLM` to the directory holding your GGUF files.

**Default — Qwen3.6-35B-A3B (MoE), matches `config.yml`'s `default` role:**

```bash
ROCBLAS_USE_HIPBLASLT=1 HIP_VISIBLE_DEVICES=1 ./llama-server \
  -m $LLM/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf \
  -fa on --temp 0.6 --top-p 0.95 --top-k 20 --min-p 0.00 \
  -ngl 99 -np 1 --jinja --cache-prompt --cache-reuse 256 \
  --host 0.0.0.0 -b 2048 -ub 1024 --ctx-size 180000 \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --mmproj $LLM/qwen3.6-35B-A3B-mmproj-F16.gguf --no-mmproj-offload \
  --chat-template-kwargs '{"preserve_thinking":true}'
```

**Dense — Qwen3.6-27B** (larger batch since it's dense; used to exercise the
fence-prone path that `output-parser` targets):

```bash
ROCBLAS_USE_HIPBLASLT=1 HIP_VISIBLE_DEVICES=1 ./llama-server \
  -m $LLM/Qwen3.6-27B-Q4_K_M.gguf \
  -fa on --temp 0.6 --top-p 0.95 --top-k 20 --min-p 0.00 \
  -ngl 99 -np 1 --jinja --cache-prompt --cache-reuse 256 \
  --chat-template-kwargs '{"preserve_thinking": true}' \
  --host 0.0.0.0 -b 4096 -ub 2048 --ctx-size 180000 \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --mmproj $LLM/mmproj-F16.gguf --no-mmproj-offload
```

**Dense + speculative decoding — Qwen3.6-27B with an MTP draft head** (faster
decode; smaller batch and context to fit the extra draft model):

```bash
ROCBLAS_USE_HIPBLASLT=1 HIP_VISIBLE_DEVICES=1 ./llama-server \
  -m $LLM/Qwen3.6-27B-Q4_K_M-mtp.gguf \
  -fa on --temp 0.6 --top-p 0.95 --top-k 20 --min-p 0.00 \
  -ngl 99 -np 1 --jinja --cache-prompt --cache-reuse 256 \
  --chat-template-kwargs '{"preserve_thinking": true}' \
  --host 0.0.0.0 -b 2048 -ub 1024 --ctx-size 150000 \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --mmproj $LLM/mmproj-F16.gguf --no-mmproj-offload \
  --spec-type draft-mtp --spec-draft-n-max 2
```

### Flag reference

| Flag | Why |
|---|---|
| `ROCBLAS_USE_HIPBLASLT=1` | use the hipBLASLt backend for ROCm GEMMs |
| `HIP_VISIBLE_DEVICES=1` | pin to GPU index 1 (the Radeon RX 7900) |
| `-fa on` | flash attention |
| `--temp 0.6 --top-p 0.95 --top-k 20 --min-p 0.00` | Qwen3's recommended sampler |
| `-ngl 99` | offload all layers to the GPU |
| **`-np 1`** | **single slot** — the constraint the whole extension stack is tuned around |
| `--jinja` | render the GGUF's own jinja chat template |
| `--cache-prompt --cache-reuse 256` | prompt caching + partial-prefix reuse |
| **`--chat-template-kwargs '{"preserve_thinking":true}'`** | **keep historical `<think>` blocks** so the prompt stays append-only (the big cache fix) |
| `--ctx-size 180000` (150000 w/ MTP) | context window |
| `--cache-type-k/-v q8_0` | quantized KV cache to fit the long context in VRAM |
| `-b` / `-ub` | logical / physical batch sizes (larger for the dense 27B) |
| `--mmproj … --no-mmproj-offload` | multimodal projector for image input, kept off-GPU |
| `--spec-type draft-mtp --spec-draft-n-max 2` | (3rd variant) speculative decoding via the model's MTP draft head, up to 2 drafted tokens |

> `preserve_thinking` is **required** here — without it Qwen3's template drops
> reasoning from all but the latest turn, diverging the cached prefix and forcing a
> full reprocess on every follow-up. See the next section.

---

## Prompt-cache discipline

This is the single most important constraint for the stack. The llama.cpp server
runs **one slot**; any change to the *prefix* of the prompt forces a reprocess of
tens of thousands of tokens (10–25s stalls). Two rules follow:

1. **Keep history append-only.** Any extension that mutates message history mid-stream
   busts the cache, so the stack never rewrites interior messages — additions go at
   the tail only.
2. **Preserve historical reasoning.** Qwen3's chat template strips `<think>` blocks
   from all but the most recent turn, which diverges the rendered prefix after any
   turn that had reasoning. The server is launched with
   `--chat-template-kwargs '{"preserve_thinking": true}'` to keep them (see
   [Running the llama.cpp server](#running-the-llamacpp-server)), and `PI_NO_TITLE=1`
   is exported (in `~/.bashrc`) to suppress omp's between-turn `set_title` call,
   which otherwise evicted the single slot.

---

## Extensions

Extensions are plain TypeScript modules under `agent/extensions/<name>/index.ts`,
each `export default (pi: ExtensionAPI) => { … }` and registering handlers via
`pi.on("<event>", …)`. **They are discovered and loaded at omp startup** — editing
a `.ts` file requires restarting omp to take effect.

### Hook events used here

| Event | When | Used by |
|---|---|---|
| `session_start` | session begins | quality-monitor, skill-inject, syntax-guard, read-before-edit |
| `before_agent_start` | before each agent run | knowledge-inject, skill-inject |
| `tool_call` | a tool is about to run (input mutable; can block) | arg-repair, path-preflight, permission-gate, read-before-edit, syntax-guard |
| `tool_result` | a tool returned (result rewritable) | tool-error-coach, syntax-guard, read-before-edit, skill-inject |
| `turn_end` | model finished a turn | quality-monitor, output-parser, skill-inject |
| `model_select` | active model resolved | output-parser |

### The follow-up arbiter

Several extensions want to inject a corrective user message on the same turn.
Firing 2–3 contradictory "steers" at a small model at once is counterproductive,
so they don't call `pi.sendUserMessage` directly — they submit through
`_shared/followup-bus.ts`, which delivers **at most one** message per turn (highest
priority wins, flushed after all handlers settle).

### Inventory

| Extension | Hook(s) | What it does | Default |
|---|---|---|---|
| **arg-repair** | `tool_call` | Coerces local-model tool-arg mistakes in place: alias keys → canonical, stringified bools/nums, `~` expansion, unwrap nested `arguments`, repair stringified glob arrays, fix mechanical hashline-patch errors. Keyed off `_shared/taxonomy.ts`. | on |
| **path-preflight** | `tool_call` | Blocks read/edit/write on obvious *guessed* paths (bracketed placeholders, `example.com`) or resolved-but-missing targets. Skips `scheme://` reads (web/sqlite/archive). | on |
| **read-before-edit** | `session_start`, `tool_call`, `tool_result` | Tracks which files were read this session; blocks an `edit` to an unread file. (`write` is exempt — it can create new files.) | on |
| **syntax-guard** | `session_start`, `tool_call`, `tool_result` | After an edit/write, re-parses the file with tree-sitter and reports **newly introduced** syntax errors, queuing a follow-up to fix them. | on |
| **tool-error-coach** | `tool_result` | On a tool error, appends a one-line corrective hint to the result (highest-signal place — the next turn sees it without a round-trip). | on |
| **output-parser** | `model_select`, `turn_end` | Detects fenced/malformed tool calls in assistant prose and nudges the model back to native tool-calling. Stricter for the dense 27B (which fences more). | auto (27B / `OMPX_PARSER_ACTIVE`) |
| **quality-monitor** | `session_start`, `turn_end` | Assesses each turn for failure modes and queues a corrective steer. The aggressive "stop explaining, start acting" steers are suppressed for interactive Q&A; substantive corrections still fire. | on |
| **skill-inject** | `session_start`, `before_agent_start`, `tool_result`, `turn_end` | Selects relevant `skills/` docs within a token budget and injects them; re-surfaces a tool's skill (once, with backoff) after that tool fails. | on |
| **knowledge-inject** | `before_agent_start` | Scores `skills/knowledge/*` + `skills/protocols/*` against the prompt and publishes required tools to skill-inject. | off (`OMPX_KNOWLEDGE_INJECT=1`) |
| **permission-gate** | `tool_call` | Whitelist gate for `bash`: allows safe run/test/list + package installs, blocks command-substitution and out-of-scratch redirects; system package managers stay blocked. | on (`auto`) |

### `_shared/`

| Module | Purpose |
|---|---|
| `taxonomy.ts` | Canonical tool specs (arg names, aliases, families, path args) keyed to omp's *actual* schemas. `specOf()` returning `undefined` makes arg-repair / path-preflight / read-before-edit skip a tool. The spine the gating extensions share. |
| `text.ts` | `extractMessageParts()` — pulls text / tool-calls / reasoning out of a turn_end message in **both** canonical and provider-native (`output_text`/`function_call`/`reasoning`, nested wrappers) shapes. Prevents false "empty response" verdicts. |
| `followup-bus.ts` | One-message-per-turn arbiter (see above). |
| `*.test.ts` | Bun tests for taxonomy and text extraction. |

---

## Skills

`skills/` holds markdown injected just-in-time by **skill-inject** / **knowledge-inject**
(omp's built-in `manage_skill` machinery is not used for these):

- **`tools/`** — per-tool usage guides (e.g. `edit.md` teaches the hashline patch
  format; `read.md`, `search.md`, `bash.md`, `write.md`, …).
- **`knowledge/`** — algorithmic technique notes (binary search, DP, two-pointers,
  tree re-rooting, …) scored against the prompt.
- **`protocols/`** — multi-step behavioral protocols (research, task decomposition).

`skills/tools/*.md` mirror the tools the agent can actually call; keep them in sync
when the tool surface changes.

---

## Environment-variable reference

All knobs are opt-in unless noted.

| Variable | Effect |
|---|---|
| `OMPX_ARG_REPAIR_DROP_UNKNOWN=1` | arg-repair also drops unknown arg keys (default: keep, let omp reject with a clear error) |
| `OMPX_PARSER_ACTIVE=1` / `=0` | force output-parser active-repair on/off (default: auto-detect 27B) |
| `OMPX_KNOWLEDGE_INJECT=1` | enable knowledge-inject |
| `OMPX_PERMISSION_MODE=auto\|accept-all\|manual` | permission-gate mode (default `auto`) |
| `OMPX_SCRATCH_DIR` | scratch dir permission-gate allows redirects into |
| `OMPX_ADAPTIVE_SKILLS=1` | skill-inject adaptive selection |
| `OMPX_SKILLS_DIR` | override skills directory |
| `OMPX_ALLOWED_TOOLS=a,b,c` | restrict the agent to a tool subset; skill-inject filters its skills to match |
| `OMPX_QM_DEBUG=0` | disable quality-monitor's empty-response diagnostic dump |
| `PI_NO_TITLE=1` | suppress omp's between-turn title generation (prompt-cache fix) |
| `PI_REQ_DEBUG=1` | dump each request as `rr-session-N.json` in the cwd (diagnostics) |

---

## Development

Extensions are TypeScript run by omp's Bun runtime; there is no project-level
`tsconfig.json` (modules are loaded loose).

```bash
# run the extension tests (from agent/extensions/)
bun test _shared/ arg-repair/        # or any extension dir with *.test.ts

# after editing any extension .ts, restart omp — extensions load at startup
```

When changing `_shared/taxonomy.ts`, keep specs in lockstep with omp's real tool
schemas (ground truth: the `oh-my-pi` source, `packages/coding-agent/src/tools/`).
A wrong canonical arg name can make arg-repair silently corrupt a valid call.

### Built-in tool surface (for reference)

omp already ships these tools, so extensions should **not** re-register them:
`read`, `write`, `edit` (hashline patch — **no** `old_string`/`new_string`),
`bash`, `find`, `search` (regex content search; there is **no** `grep`),
`ast_grep`, `ast_edit`, `browser`, `web_search`, `fetch`, `checkpoint`, `task`,
`todo`, `lsp`, `job`, `irc`, `debug`, `eval`, `ssh`, and more. There is no `ls`
(directory listing is folded into `read`) and no standalone `glob` (use `find`).
