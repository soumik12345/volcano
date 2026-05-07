# Streaming Order & Thinking Display — Design Spec

**Date:** 2026-05-07  
**Status:** Approved

---

## Problem

Two related UX bugs in the Volcano agent stream:

1. **Wrong order.** Tool calls and response text are rendered out of sequence. The pre-created assistant bubble (`contentEl`) collects all text deltas, while tool cards are appended separately after it in the DOM. Result: the response appears before the tool calls that produced it.

2. **Thinking not shown.** Reasoning tokens (`reasoning_item_created` events) are never captured or rendered — the agent appears to silently pause then respond.

---

## Event Model

The `@openai/agents` SDK emits two event categories through `stream`:

| SDK event | When | Payload |
|---|---|---|
| `raw_model_stream_event` / `output_text_delta` | Each streaming text token | `data.delta: string` |
| `run_item_stream_event` / `reasoning_item_created` | Full reasoning block complete | `item.rawItem.content[].text` |
| `run_item_stream_event` / `tool_call_item` | Tool call complete | `rawItem.name`, `rawItem.arguments` |
| `run_item_stream_event` / `tool_call_output_item` | Tool result available | `rawItem.name`, `item.output` |

Reasoning arrives as a **complete item** (not streaming), fired in correct causal order before the tool call that follows it. Text arrives as deltas via `raw_model_stream_event`.

---

## Solution: Inline Streaming Segments (Approach A)

### AgentClient.ts

Add `onReasoningItem` to `RunCallbacks`:

```typescript
export interface RunCallbacks {
    onTextDelta?: (delta: string) => void;
    onReasoningItem?: (text: string) => void;   // NEW
    onToolCall?: (toolName: string, args: string) => void;
    onToolResult?: (toolName: string, result: string) => void;
    onError?: (err: Error) => void;
}
```

In the `run_item_stream_event` branch, add before the `tool_call_item` check:

```typescript
} else if (item.type === 'reasoning_item') {
    const raw = item.rawItem as { content?: Array<{ text: string }> };
    const text = (raw.content ?? []).map(c => c.text).join('');
    if (text) callbacks.onReasoningItem?.(text);
}
```

No other changes to `AgentClient.ts`.

---

### AgentView.ts — streaming state machine

**Remove** the pre-created single `assistantEl` / `contentEl` pattern from `handleSend`.

**Add** two local variables scoped to the send call:

```
streamContainerEl: HTMLElement   — one div inside the assistant message bubble
currentTextEl:     HTMLElement | null — the active text segment (null between phases)
```

**Assistant message structure (new):**

```
.volcano-message.volcano-message-assistant
  .volcano-message-role  ("Volcano")
  .volcano-stream-container
    [segments in arrival order, e.g.:]
    .volcano-reasoning-block   ← thinking disclosure widget
    .volcano-stream-text       ← first text segment
    .volcano-tool-card         ← tool card (inline)
    .volcano-stream-text       ← text segment after tool
```

**Callback rules:**

| Callback | Action |
|---|---|
| `onReasoningItem(text)` | `currentTextEl = null`; append `.volcano-reasoning-block` to `streamContainerEl` |
| `onTextDelta(delta)` | If `currentTextEl` is null, create new `.volcano-stream-text` div in `streamContainerEl`; append delta |
| `onToolCall(name, args)` | `currentTextEl = null`; append tool card into `streamContainerEl` (not `messagesEl`) |
| `onToolResult(name, result)` | Look up tool card by `data-tool-name` within `streamContainerEl`; update in place |

`toolCardEls` map key stays `name` (string). The lookup changes from `messagesEl` to `streamContainerEl`.

After stream completion: if `streamContainerEl.childElementCount === 0`, append "(no response)" text.

---

### Reasoning block UI (`.volcano-reasoning-block`)

A disclosure widget, collapsed by default:

- **Header:** "Thinking…" label + approximate word count (e.g. "~42 words") + `▶ show` toggle button
- **Body (hidden by default):** scrollable `<div>` containing the reasoning text, max-height ~200px with overflow-y scroll
- **Toggle:** clicking header or button expands/collapses; button text flips between `▶ show` / `▲ hide`
- **Visual treatment:** left border accent (muted indigo, `--color-base-30` range), slightly reduced font size, italic text, subtle background tint — clearly distinct from response text

New CSS classes added to `styles.css`:
- `.volcano-reasoning-block`
- `.volcano-reasoning-header`
- `.volcano-reasoning-toggle`
- `.volcano-reasoning-body`
- `.volcano-stream-text` (replaces the implicit single contentEl)

---

## Out of scope

- Streaming reasoning deltas token-by-token (the SDK delivers reasoning as a complete item; this spec does not change that)
- Markdown rendering of response text (already not implemented; not changed here)
- Thinking support for providers that don't emit `reasoning_item_created` through the Agents SDK (future work)

---

## Files changed

| File | Change |
|---|---|
| `src/agent/AgentClient.ts` | Add `onReasoningItem` callback + one event branch |
| `src/view/AgentView.ts` | Refactor `handleSend` streaming state machine; move tool cards into stream container |
| `styles.css` | Add reasoning block + stream-text CSS rules |
