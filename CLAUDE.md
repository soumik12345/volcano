# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `npm run dev` — watch mode build with source maps
- `npm run build` — type-check then production bundle (`main.js`)
- `npm run lint` — ESLint
- `npm run version` — bump `manifest.json` + `versions.json` and stage both

No automated test runner. Type-checking is the primary validation step, run automatically as part of `npm run build` (uses `-skipLibCheck`).

**Known pre-existing tsc error:** Running `npx tsc --noEmit` directly (without `-skipLibCheck`) always produces one error from `node_modules/@openai/agents-core` about `asyncDispose` not existing on `SymbolConstructor`. This is caused by the `tsconfig.json` `lib` array only going to ES7, which predates that symbol. Ignore this error — it is not introduced by local changes and does not affect the build.

To test: copy `main.js`, `manifest.json`, `styles.css` to your vault's `.obsidian/plugins/volcano/` and reload Obsidian.

**esbuild externals:** All `@codemirror/*`, `@lezer/*`, and Node.js built-in modules (`builtinModules`) are marked external in `esbuild.config.mjs`. Node built-ins (`https`, `http`, etc.) are available at runtime in Obsidian's Electron renderer via `require()` because Obsidian runs with `nodeIntegration: true`. Importing a new `@codemirror` sub-package will compile but fail at runtime unless added to the `external` list.

## Release Process

The CI workflow (`.github/workflows/release.yml`) triggers on `release: published`, runs `npm run build`, and uploads `main.js`, `manifest.json`, `styles.css` to the GitHub release. Cutting a release: delete and re-create the tag pointing to the desired commit using `release.sh`, which triggers CI. The tag must point to the commit with all changes — run `release.sh` only after pushing all commits.

## Architecture

### Plugin Bootstrap (`src/main.ts`)

Four systems are instantiated at `onload()` and shared across the plugin as `VolcanoPlugin` properties:

- `VaultAdapter` — thin wrapper over the Obsidian vault API
- `DiffEngine` — event-emitter staging layer for proposed edits
- `SessionStore` — optional sql.js SQLite store for conversation persistence (null if WASM fails to load)
- A CodeMirror 6 state extension registered globally for diff decoration

`main.ts` also imports `sql-wasm.wasm` as a base64 string (bundled by esbuild's `loader: { '.wasm': 'base64' }`) and passes it to `SessionStore.load()`. This means the WASM binary is embedded in `main.js` — no separate file is needed, which allows BRAT installs to work since BRAT only downloads `main.js`, `manifest.json`, and `styles.css`.

The `AgentView` receives references to all four systems via the plugin instance.

### Agent Pipeline

**`AgentClient`** (`src/agent/AgentClient.ts`) owns conversation state (`history: AgentInputItem[]`) and wraps the `@openai/agents` SDK.

**HTTP / Auth:** Obsidian's Electron renderer `fetch` can silently drop the `Authorization` header for cross-origin requests. `AgentClient` bypasses this by passing a custom `fetch` (built by `makeNodeFetch()`) to the OpenAI constructor that uses Node.js's `https.request()` directly, which has no browser CORS machinery. The `https` module is available via `require('https')` at runtime (it's in `builtinModules`, externalized by esbuild). If `require` is unavailable, it falls back to renderer `fetch` with an explicit `Authorization` header set.

**Streaming reasoning:** The `@openai/agents` SDK only emits `reasoning_item` events *after* the full stream ends. `AgentClient` patches `openaiClient.chat.completions.create` to intercept raw SSE chunks and forward `delta.reasoning` / `delta.reasoning_content` (DeepSeek) immediately via `onReasoningDelta`. The `onReasoningItem` callback is kept as a post-stream fallback.

**Client lifecycle:** `AgentView.ensureAgentClient()` computes a key from `baseUrl|apiKey|model` and recreates the `AgentClient` instance whenever any of those change. This ensures settings updates (e.g., entering an API key after install) are always picked up before sending a message.

`RunCallbacks` interface:
```
onTextDelta      — streaming response text
onReasoningDelta — streaming thinking (real-time, via patch)
onReasoningItem  — full reasoning block (post-stream fallback)
onToolCall       — tool invocation fired
onToolResult     — tool output available
```

**`AgentView`** (`src/view/AgentView.ts`) is pure vanilla DOM — the Svelte files in `src/view/components/` are unused. The streaming rendering model:

- Each text run is a `TextSeg` object `{ el, rawText, timerId, rendering, hasEverRendered }`. `appendText` is used for immediate feedback until the first markdown render, after which the element is swapped via a temp div to avoid blank flashes.
- Markdown renders are debounced at 50ms via `doRender`, which renders into a temp `div`, then atomically replaces the live element's children.
- Reasoning blocks follow the same `TextSeg` pattern but target the `volcano-reasoning-body` element; they start expanded during streaming.
- Tool cards are inserted inline at call time; results are appended to the card when available.
- `finalizeActiveSeg()` is called on `onReasoningDelta`/`onToolCall` to close the current text segment before inserting a new block.
- `fixLinks()` post-processes rendered HTML to convert backtick-wrapped URLs to `<a>` elements and wire `window.open` click handlers (required in Electron).

### Session Persistence

`SessionStore` (`src/session/SessionStore.ts`) wraps `sql.js` (in-memory SQLite compiled to WASM). The WASM binary is received as a base64 string parameter to `SessionStore.load()` (imported in `main.ts` via esbuild's base64 loader), decoded with `atob()`, and passed to `initSqlJs({ wasmBinary })`. The database file `sessions.db` is persisted at `<vault>/.obsidian/plugins/volcano/sessions.db` via `vault.adapter.writeBinary` after each write.

Schema:
- `sessions(id, title, created_at, updated_at, history_json)` — one row per conversation thread
- `messages(id, session_id, role, type, content, tool_name, created_at)` — individual turns for display

Key methods: `appendMessage()` saves each user/assistant turn; `updateHistory()` stores the full `AgentInputItem[]` array; `listSessions()` returns sessions with message counts; `loadSession()` restores history for replay.

### Tool System

Tools are registered in `AgentClient`'s constructor and passed to the `@openai/agents` `Agent`. Three sets:

- **Read-only** (`src/agent/tools/index.ts`): `read_note`, `outline_note`, `search_vault`, `list_files`.  
  Note: `search_vault` in `VaultAdapter` is currently a stub — it returns the first N files with a generic snippet, not actual full-text search.
- **Write** (`src/agent/tools/write.ts`): `propose_edit` (exact substring match required), `create_note`. Both stage to `DiffEngine`, never write directly.
- **Web** (`src/agent/tools/web.ts`): `web_search`, `web_fetch` — only registered if a Tavily API key is configured. `web_fetch` uses a 30k-char truncation limit. Web tools use Obsidian's `requestUrl()` (not `fetch`) to avoid CORS in the Electron context.

All tools return JSON-stringified objects with an `error` field on failure (not thrown), so the agent can handle errors in-context.

### Diff / Pending Changes System

`DiffEngine` (`src/diff/DiffEngine.ts`) is an immutable staging store (`Map<string, StagedDiff>`). Diffs are never mutated after creation.

- `stageEdit(path, baseContent, proposed)` — diffs via the `diff` npm package, groups lines into hunks
- `stageCreate(path, content)` — stages a full-file creation
- `accept(id)` — checks conflict (file modified since staging via content equality), then calls `VaultAdapter.writeNote/createNote`
- If accept fails, diff status becomes `conflicted`; user must reject and re-propose
- Subscribers notified on every state change; `AgentView` rerenders the pending panel on each event

CodeMirror integration (`src/diff/cmDecorations.ts`) uses a stateful field `volcanoDiffField` with a `setVolcanoDiff` effect. Decorations are rebuilt on each doc change. Removed lines get CSS strikethrough; added lines get `AddedBlockWidget` DOM widgets inserted after the removed block.

### Web Search

`createWebSearchProvider(settings)` in `src/agent/web/` returns a `TavilyProvider` if a key is present, otherwise `null`. The provider uses Obsidian's `requestUrl()` instead of `fetch` to avoid CORS in the Electron context. `search()` → Tavily `/search`, `fetch()` → Tavily `/extract`.

### Mention System

The input editor is a `contentEditable` div. Typing `@` triggers a fuzzy picker over vault files, folders, tags, and a "Search the web" action. Selected items become `volcano-mention-chip` spans (`contentEditable=false`) embedded in the editor. On send, `extractEditorContent()` separates plain text from chips; `buildContextPreamble()` resolves each chip to actual content and appends it as a fenced section to the message sent to the agent.

`MentionChip` is an exported interface with `type: 'note' | 'folder' | 'tag' | 'web' | 'selection'`. The `'selection'` type is added externally (not via the picker) when a user right-clicks selected text in a note or runs the "Add selection to Volcano" command — handled in `main.ts` via `buildSelectionChip()` / `addSelectionToVolcano()`, then inserted into the input by `AgentView.addSelectionChip()`. Selection chips deduplicate by label (file+line), not by value (raw text), unlike other chip types.

`AgentView.insertChip()` appends chips directly to `editorEl` without anchor state (contrast with `addChipAndClean()`, which splices at the `@` cursor position).

### Provider Configuration

All providers use the OpenAI SDK pointed at different `baseURL` values (`PROVIDER_PRESETS` in `settings.ts`). Anthropic and OpenRouter are accessed via their OpenAI-compatible endpoints — no Anthropic SDK. `validateSettings()` checks URL format, model name, and API key requirements (including a guard against accidentally entering the base URL in the API key field). `testConnection()` calls `models.list()` to verify connectivity.
