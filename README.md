# Volcano

Volcano is an AI writing assistant for [Obsidian](https://obsidian.md). It can read your vault, search the web, and propose edits to your notes — but it can't touch a single character without you saying yes first.

I built this because I wanted an assistant that actually *knew* my notes, not one that I had to copy-paste context into every time. And I wanted to stay in control of what ends up on disk.

## What it does

**It reads your vault.** The agent can pull up a note by path, get a quick heading outline, search across everything, or browse a folder sorted by recency. So when you ask "what did I write about X last month," it can actually go look.

**It proposes edits, it doesn't make them.** Every change shows up in a pending changes panel as a diff. You accept or reject hunk by hunk. If you've edited the file in the meantime, the diff gets flagged as conflicted instead of silently overwriting your work. New notes work the same way — staged, then approved.

**It can search the web (if you want).** Drop in a [Tavily](https://tavily.com) API key and the agent gets `web_search` and `web_fetch` tools. Sources are cited inline as footnotes and tracked in the note's frontmatter, so you can trace any claim back to where it came from.

**`@` mentions for context.** Type `@` in the input and you get a fuzzy picker over notes, folders, tags, and web URLs. Whatever you pick gets resolved to actual content and handed to the agent. No more pasting.

There's also a selection mention: highlight text in a note, right-click, **Add selection to Volcano**. The exact lines you picked show up as a `@NoteName:12-15` chip in the input. Useful when you want the agent to look at *this paragraph specifically* instead of the whole note.

**Streaming.** Responses stream in as the agent works, including tool calls as they fire. You see what it's doing in real time.

## Providers

Volcano talks to anything with an OpenAI-compatible API. Presets out of the box:

| Provider    | Default model                  |
|-------------|--------------------------------|
| OpenAI      | `gpt-5`                        |
| OpenRouter  | `anthropic/claude-sonnet-4-6`  |
| Anthropic   | `claude-sonnet-4-6`            |
| Ollama      | `llama3.2:latest` (local)      |
| Custom      | whatever you point it at       |

## Installing

### With BRAT (easiest)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) installs community plugins straight from GitHub:

1. Install and enable **Obsidian42 - BRAT**
2. Command palette → **BRAT: Add a beta plugin for testing**
3. Paste `https://github.com/soumik12345/volcano`
4. Settings → Community plugins → enable **Volcano**

### Manually

Grab `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/soumik12345/volcano/releases/latest), drop them into `<your-vault>/.obsidian/plugins/volcano/`, and reload Obsidian.

## Configuring

Open **Settings → Volcano**:

- **Provider** — pick a preset or go Custom
- **Base URL** — the OpenAI-compatible endpoint
- **API Key** — your key (skip this for Ollama)
- **Model** — model name, e.g. `gpt-5` or `claude-sonnet-4-6`

If you want web search, paste in a Tavily API key under **Web search API key**.

Hit **Test Connection** before you start chatting — it'll catch a wrong base URL or a typo'd key right away, instead of you finding out mid-conversation.
