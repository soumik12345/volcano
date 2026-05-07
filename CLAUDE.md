# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `npm run dev` — watch mode build with source maps
- `npm run build` — type-check then production bundle (`main.js`)
- `npm run lint` — ESLint
- `npm run version` — bump `manifest.json` + `versions.json` and stage both

No automated test runner. Type-checking (`tsc -noEmit`) is the primary validation step, run automatically as part of `npm run build`.

To test: copy `main.js`, `manifest.json`, `styles.css` to your vault's `.obsidian/plugins/volcano/` and reload Obsidian. The `sql-wasm.wasm` binary is copied to the plugin root by esbuild automatically during build.

## Architecture

### Plugin Bootstrap (`src/main.ts`)

Four systems are instantiated at `onload()` and shared across the plugin as `VolcanoPlugin` properties:

- `VaultAdapter` — thin wrapper over the Obsidian vault API
- `DiffEngine` — event-emitter staging layer for proposed edits
- `SessionStore` — optional sql.js SQLite store for conversation persistence (null if WASM fails to load)
- A CodeMirror 6 state extension registered globally for diff decoration

The `AgentView` receives references to all four via the plugin instance.

### Agent Pipeline

**`AgentClient`** owns conversation state (`history: AgentInputItem[]`) and wraps the `@openai/agents` SDK. One architectural constraint: the SDK only emits `reasoning_item` events *after* the full stream ends, making live thinking blocks impossible. To work around this, `AgentClient` patches `openaiClient.chat.completions.create` to intercept each raw chunk and forward `delta.reasoning` / `delta.reasoning_content` (DeepSeek) immediately via `onReasoningDelta`. The downstream `onReasoningItem` callback is kept as a fallback for providers that don't stream reasoning.

`RunCallbacks` interface:
```
onTextDelta      — streaming response text
onReasoningDelta — streaming thinking (real-time, via patch)
onReasoningItem  — full reasoning block (post-stream fallback)
onToolCall       — tool invocation fired
onToolResult     — tool output available
```

Clearing history (`clearHistory()`) resets the `history` array. A "New thread" creates a fresh `AgentClient` instance. After the first exchange in a session, `AgentClient` fires an auto-title call as a fire-and-forget background request to generate a session title from the conversation.

**`AgentView`** (`src/view/AgentView.ts`) is pure vanilla DOM — the Svelte files in `src/view/components/` are unused. The streaming rendering model:

- Each text run is a `TextSeg` object `{ el, rawText, timerId, rendering, hasEverRendered }`. `appendText` is used for immediate feedback until the first markdown render, after which the element is swapped via a temp div to avoid blank flashes.
- Markdown renders are debounced at 50ms via `doRender`, which renders into a temp `div`, then atomically replaces the live element's children.
- Reasoning blocks follow the same `TextSeg` pattern but target the `volcano-reasoning-body` element; they start expanded during streaming.
- Tool cards are inserted inline at call time; results are appended to the card when available.
- `finalizeActiveSeg()` is called on `onReasoningDelta`/`onToolCall` to close the current text segment before inserting a new block.
- `fixLinks()` post-processes rendered HTML to convert backtick-wrapped URLs to `<a>` elements and wire `window.open` click handlers (required in Electron).

### Session Persistence

`SessionStore` (`src/session/SessionStore.ts`) wraps `sql.js` (in-memory SQLite compiled to WASM). The binary `sql-wasm.wasm` is loaded from the plugin directory at runtime via `vault.adapter.readBinary`. The database file `sessions.db` is persisted at `<vault>/.obsidian/plugins/volcano/sessions.db` via `vault.adapter.writeBinary` after each write.

Schema:
- `sessions(id, title, created_at, updated_at, history_json)` — one row per conversation thread
- `messages(id, session_id, role, type, content, tool_name, created_at)` — individual turns for display

Key methods: `appendMessage()` saves each user/assistant turn; `updateHistory()` stores the full `AgentInputItem[]` array; `listSessions()` returns sessions with message counts; `loadSession()` restores history for replay.

`AgentView` opens a session history modal (history button in the toolbar) listing past sessions. Clicking a session calls `loadSession()` to restore both the `history` array and the visual conversation.

### Tool System

Tools are registered in `AgentClient`'s constructor and passed to the `@openai/agents` `Agent`. Three sets:

- **Read-only** (`src/agent/tools/index.ts`): `read_note`, `outline_note`, `search_vault`, `list_files`  
  Note: `search_vault` in `VaultAdapter` is currently a stub — it returns the first N files with a generic snippet, not actual full-text search.
- **Write** (`src/agent/tools/write.ts`): `propose_edit` (exact substring match required), `create_note`. Both stage to `DiffEngine`, never write directly.
- **Web** (`src/agent/tools/web.ts`): `web_search`, `web_fetch` — only registered if a Tavily API key is configured. `web_fetch` uses a 30k-char truncation limit.

All tools return JSON-stringified objects with an `error` field on failure (not thrown), so the agent can handle errors in-context.

### Citations

`src/agent/citations.ts` handles web research attribution. When the agent uses web tools, citations are extracted from search results and formatted as inline footnotes. Sources are tracked in note frontmatter when writing to the vault.

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

The input editor is a `contentEditable` div. Typing `@` triggers a fuzzy picker over vault files, folders, tags, and a "Search the web" action. Selected items become `volcano-mention-chip` spans (`contentEditable=false`) embedded in the editor. On send, `extractEditorContent()` separates plain text from chips; `buildContextPreamble()` resolves each chip to actual content (note text, folder listing, etc.) and appends it as a fenced section to the message sent to the agent.

### Provider Configuration

All providers use the OpenAI SDK pointed at different `baseURL` values (`PROVIDER_PRESETS` in `settings.ts`). Anthropic and OpenRouter are accessed via their OpenAI-compatible endpoints — no Anthropic SDK. This means provider-specific features not exposed via the Chat Completions shape are unavailable. `validateSettings()` checks URL format, model name, and API key requirements. `testConnection()` calls `models.list()` to verify connectivity.
