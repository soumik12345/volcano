# Volcano

An AI writing assistant for [Obsidian](https://obsidian.md) that combines vault awareness, web research, and safe diff-first editing.

## Features

### Vault-Aware Agent
The agent can read and search your notes to ground its answers in your actual content:
- **Read notes** — fetch full content of any note by path
- **Outline notes** — get a heading outline for quick previews
- **Search vault** — full-text search across all notes with snippets
- **List files** — browse markdown files in any folder, sorted by recency

### Safe, Diff-First Editing
The agent cannot modify your notes directly. All writes are staged as diffs and require your explicit approval:
- **Propose edits** — targeted find-and-replace changes appear in a pending changes panel
- **Create notes** — stage new notes for review before they're written
- **Accept or reject** — review each change individually before it touches your vault

### Web Research (Optional)
When configured with a Tavily API key, the agent can search the web and fetch URLs:
- **Web search** — query the public web for current information
- **Web fetch** — retrieve and parse any URL as clean markdown
- Sources are automatically cited with inline footnotes and tracked in note frontmatter

### @ Mentions
Type `@` in the input to reference vault context:
- Notes, folders, tags, and web URLs
- Smart autocomplete picker with keyboard navigation
- Provides targeted context to the agent without pasting content manually

### Streaming Responses
Responses stream in real-time as the agent works, with live display of tool calls as they execute.

## Supported Providers

Volcano uses OpenAI-compatible APIs. Built-in presets:

| Provider | Default Model |
|----------|--------------|
| OpenAI | `gpt-5` |
| OpenRouter | `anthropic/claude-sonnet-4-6` |
| Anthropic | `claude-sonnet-4-6` |
| Ollama (local) | `llama3.2:latest` |
| Custom | Any OpenAI-compatible endpoint |

## Installation

### BRAT (Recommended)
[BRAT](https://github.com/TfTHacker/obsidian42-brat) lets you install Volcano directly from GitHub:

1. Install and enable the **Obsidian42 - BRAT** community plugin
2. Open the command palette and run **BRAT: Add a beta plugin for testing**
3. Paste `https://github.com/soumik12345/volcano` and confirm
4. Go to **Settings → Community plugins** and enable **Volcano**
5. Download `sql-wasm.wasm` from the [latest release](https://github.com/soumik12345/volcano/releases/latest) and place it in `<your-vault>/.obsidian/plugins/volcano/` — BRAT does not download this file automatically, and without it conversation history will not be saved across sessions.

### Manual Install
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
2. Copy them to `<your-vault>/.obsidian/plugins/volcano/`
3. Reload Obsidian and enable **Volcano** in Settings → Community plugins

## Configuration

Open Settings → Volcano to configure:

**Required**
- **Provider** — select a preset or choose Custom
- **Base URL** — OpenAI-compatible API endpoint
- **API Key** — your API key (not required for Ollama)
- **Model** — model name (e.g. `gpt-5`, `claude-sonnet-4-6`)

**Optional**
- **Auto-title model** — cheaper model for generating thread titles; falls back to the main model if unset
- **Web search API key** — Tavily API key to enable web search and fetch tools

Use the **Test Connection** button to verify your settings before starting a conversation.

## Usage

1. Click the Volcano ribbon icon (or run **Toggle Volcano** from the command palette) to open the agent pane
2. Type your request in the input box
3. Use `@` to mention notes or folders as context
4. Send with `Cmd+Enter` (macOS) / `Ctrl+Enter` (Windows/Linux); `Shift+Enter` inserts a newline
5. Review any proposed edits in the **Pending Changes** panel and accept or reject them
6. Use **New Thread** to start a fresh conversation
