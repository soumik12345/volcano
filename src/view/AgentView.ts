import { ItemView, MarkdownView, Notice, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import type { EditorView } from '@codemirror/view';
import type VolcanoPlugin from '../main';
import { AgentClient } from '../agent/AgentClient';
import { validateSettings } from '../settings';
import type { StagedDiff } from '../diff/DiffEngine';
import { applyDiffToEditor } from '../diff/cmDecorations';

export const VOLCANO_VIEW_TYPE = 'volcano-agent-view';

interface MentionChip {
	type: 'note' | 'folder' | 'tag' | 'web';
	label: string;  // display text e.g. "Note: daily.md"
	value: string;  // the path/tag/url for context resolution
}

export class AgentView extends ItemView {
	plugin: VolcanoPlugin;
	private agentClient: AgentClient | null = null;
	private abortController: AbortController | null = null;

	private messagesEl!: HTMLElement;
	private pendingEl!: HTMLElement;
	private chipsEl!: HTMLElement;
	private pickerEl!: HTMLElement;
	private textarea!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	private stopButton!: HTMLButtonElement;
	private unsubscribeDiff: (() => void) | null = null;
	private toolCardEls = new Map<string, HTMLElement>();
	private pendingCollapsed = false;
	private mentions: MentionChip[] = [];
	private pickerActiveIndex = -1;
	private _closePickerOnOutsideClick: ((e: MouseEvent) => void) | null = null;
	private _pickerDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _mentionAtIdx: number = -1;
	private _mentionCursorIdx: number = -1;

	constructor(leaf: WorkspaceLeaf, plugin: VolcanoPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VOLCANO_VIEW_TYPE;
	}

	getDisplayText() {
		return 'Volcano';
	}

	getIcon() {
		return 'bot';
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass('volcano-pane');

		const header = root.createDiv({ cls: 'volcano-header' });
		header.createEl('h2', { text: '🌋 Volcano Agent' });

		const newThreadBtn = header.createEl('button', {
			cls: 'volcano-header-button',
			text: 'New thread'
		});
		newThreadBtn.addEventListener('click', () => {
			this.resetThread();
		});

		this.pendingEl = root.createDiv({ cls: 'volcano-pending-panel' });
		this.renderPendingPanel();

		this.chipsEl = root.createDiv({ cls: 'volcano-chips-bar' });
		this.chipsEl.hide();

		this.messagesEl = root.createDiv({ cls: 'volcano-messages' });
		this.renderEmptyState();

		this.unsubscribeDiff = this.plugin.diffEngine.subscribe(() => {
			this.renderPendingPanel();
		});

		const inputRow = root.createDiv({ cls: 'volcano-input' });
		// Make input row position:relative so picker's bottom:100% works
		inputRow.style.position = 'relative';

		// Create picker dropdown (hidden initially)
		this.pickerEl = inputRow.createDiv({ cls: 'volcano-mention-picker' });
		this.pickerEl.setAttribute('role', 'listbox');
		this.pickerEl.hide();

		this._closePickerOnOutsideClick = (e: MouseEvent) => {
			if (!this.pickerEl.contains(e.target as Node) && e.target !== this.textarea) {
				this.closePicker();
			}
		};
		document.addEventListener('mousedown', this._closePickerOnOutsideClick);

		this.textarea = inputRow.createEl('textarea', {
			attr: {
				rows: '3',
				placeholder: 'Type your message… (Cmd+Enter to send, @ to mention)'
			}
		});
		this.textarea.setAttribute('aria-haspopup', 'listbox');
		this.textarea.setAttribute('aria-expanded', 'false');
		this.sendButton = inputRow.createEl('button', { text: 'Send', cls: 'volcano-send' });
		this.stopButton = inputRow.createEl('button', { text: 'Stop', cls: 'volcano-stop' });
		this.sendButton.disabled = true;
		this.stopButton.hide();

		const updateDisabled = () => {
			this.sendButton.disabled = this.textarea.value.trim().length === 0;
			this.updateMentionPicker();
		};
		this.textarea.addEventListener('input', updateDisabled);

		this.textarea.addEventListener('keydown', (event) => {
			event.stopPropagation();

			// Handle picker keyboard navigation when picker is open
			if (this.pickerEl.style.display !== 'none') {
				const items = Array.from(this.pickerEl.querySelectorAll('.volcano-mention-item')) as HTMLElement[];
				if (items.length > 0) {
					if (event.key === 'ArrowDown') {
						event.preventDefault();
						this.pickerActiveIndex = Math.min(this.pickerActiveIndex + 1, items.length - 1);
						this.updatePickerActiveClass(items);
						return;
					}
					if (event.key === 'ArrowUp') {
						event.preventDefault();
						this.pickerActiveIndex = Math.max(this.pickerActiveIndex - 1, 0);
						this.updatePickerActiveClass(items);
						return;
					}
					if (event.key === 'Enter' || event.key === 'Tab') {
						event.preventDefault();
						const activeItem = this.pickerActiveIndex >= 0 ? items[this.pickerActiveIndex] : items[0];
						if (activeItem) {
							activeItem.click();
						}
						return;
					}
					if (event.key === 'Escape') {
						event.preventDefault();
						this.closePicker();
						return;
					}
				}
			}

			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				void this.handleSend();
			}
		});
		this.textarea.addEventListener('keyup', (e) => e.stopPropagation());
		this.textarea.addEventListener('keypress', (e) => e.stopPropagation());

		this.sendButton.addEventListener('click', () => {
			void this.handleSend();
		});
		this.stopButton.addEventListener('click', () => {
			this.handleStop();
		});
	}

	async onClose() {
		this.abortController?.abort();
		this.unsubscribeDiff?.();
		this.unsubscribeDiff = null;
		if (this._closePickerOnOutsideClick) {
			document.removeEventListener('mousedown', this._closePickerOnOutsideClick);
			this._closePickerOnOutsideClick = null;
		}
		this.contentEl.empty();
	}

	// ── Chips bar ─────────────────────────────────────────────────────────────

	private renderChipsBar() {
		this.chipsEl.empty();
		if (this.mentions.length === 0) {
			this.chipsEl.hide();
			return;
		}
		this.chipsEl.show();
		const iconMap: Record<MentionChip['type'], string> = {
			note: '📄',
			folder: '📁',
			tag: '🏷️',
			web: '🌐'
		};
		for (let i = 0; i < this.mentions.length; i++) {
			const chip = this.mentions[i];
			if (!chip) continue;
			const chipEl = this.chipsEl.createDiv({ cls: 'volcano-chip' });
			chipEl.createSpan({ text: iconMap[chip.type] + ' ' + chip.label });
			const removeBtn = chipEl.createEl('button', { cls: 'volcano-chip-remove', text: '×' });
			const idx = i;
			removeBtn.addEventListener('click', () => {
				this.mentions.splice(idx, 1);
				this.closePicker();
				this.renderChipsBar();
			});
		}
	}

	// ── Mention picker ────────────────────────────────────────────────────────

	private updatePickerActiveClass(items: HTMLElement[]) {
		for (let i = 0; i < items.length; i++) {
			const el = items[i];
			if (!el) continue;
			if (i === this.pickerActiveIndex) {
				el.addClass('volcano-mention-item-active');
			} else {
				el.removeClass('volcano-mention-item-active');
			}
		}
	}

	private closePicker() {
		this.pickerEl.hide();
		this.pickerEl.empty();
		this.pickerActiveIndex = -1;
		if (this.textarea) {
			this.textarea.setAttribute('aria-expanded', 'false');
		}
	}

	private updateMentionPicker(): void {
		if (this._pickerDebounceTimer !== null) clearTimeout(this._pickerDebounceTimer);
		this._pickerDebounceTimer = setTimeout(() => {
			this._pickerDebounceTimer = null;
			this._doUpdateMentionPicker();
		}, 80);
	}

	private _doUpdateMentionPicker(): void {
		const text = this.textarea.value;
		const cursor = this.textarea.selectionStart ?? text.length;

		// Find the last @ before the cursor with no space between it and the cursor
		const textBeforeCursor = text.slice(0, cursor);
		const atMatch = textBeforeCursor.match(/@([^\s]*)$/);

		if (!atMatch) {
			this.closePicker();
			return;
		}

		const atIdx = textBeforeCursor.lastIndexOf('@');
		const token = atMatch[1] ?? ''; // text after @, e.g. "note:daily" or "" or "web"
		const results = this.buildPickerResults(token);

		if (results.length === 0) {
			this.closePicker();
			return;
		}

		// Record cursor position and @ index for use in addChipAndClean (Fix 4)
		this._mentionAtIdx = atIdx;
		this._mentionCursorIdx = cursor;

		this.pickerEl.empty();
		this.pickerActiveIndex = -1;

		for (const item of results) {
			const itemEl = this.pickerEl.createDiv({ cls: 'volcano-mention-item' });
			itemEl.setAttribute('role', 'option');
			itemEl.createSpan({ cls: 'volcano-mention-item-icon', text: item.icon });
			itemEl.createSpan({ cls: 'volcano-mention-item-label', text: item.display });

			itemEl.addEventListener('click', () => {
				this.selectMentionItem(item);
			});
		}

		this.pickerEl.show();
		this.textarea.setAttribute('aria-expanded', 'true');
	}

	private buildPickerResults(token: string): Array<{
		icon: string;
		display: string;
		chip: MentionChip;
	}> {
		const MAX = 8;
		const results: Array<{ icon: string; display: string; chip: MentionChip }> = [];

		if (token === '' || token === 'n' || token === 'no' || token === 'nod' || token === 'note' ||
			token === 'f' || token === 'fo' || token === 'fol' || token === 'fold' || token === 'folde' || token === 'folder' ||
			token === 't' || token === 'ta' || token === 'tag' ||
			token === 'w' || token === 'we' || token === 'web') {
			// Check if it's a pure prefix (no colon yet)
			if (!token.includes(':')) {
				// Show type options
				const typeOptions: Array<{ prefix: string; icon: string; label: string }> = [];
				if ('note'.startsWith(token))   typeOptions.push({ prefix: '@note',   icon: '📄', label: '@note: — search notes' });
				if ('folder'.startsWith(token)) typeOptions.push({ prefix: '@folder', icon: '📁', label: '@folder: — search folders' });
				if ('tag'.startsWith(token))    typeOptions.push({ prefix: '@tag',    icon: '🏷️', label: '@tag: — search tags' });
				if ('web'.startsWith(token))    typeOptions.push({ prefix: '@web',    icon: '🌐', label: '@web — enable web search' });

				for (const opt of typeOptions) {
					results.push({
						icon: opt.icon,
						display: opt.label,
						chip: { type: 'note', label: '', value: '__type_prefix__:' + opt.prefix }
					});
				}
				return results.slice(0, MAX);
			}
		}

		if (token.startsWith('note:')) {
			const query = token.slice('note:'.length).toLowerCase();
			const files = this.plugin.app.vault.getMarkdownFiles();
			for (const file of files) {
				if (results.length >= MAX) break;
				if (!query || file.basename.toLowerCase().includes(query)) {
					results.push({
						icon: '📄',
						display: file.basename,
						chip: { type: 'note', label: 'Note: ' + file.basename, value: file.path }
					});
				}
			}
			return results;
		}

		if (token.startsWith('folder:')) {
			const query = token.slice('folder:'.length).toLowerCase();
			const folders: TFolder[] = [];
			const collectFolders = (folder: TFolder) => {
				folders.push(folder);
				for (const child of folder.children) {
					if (child instanceof TFolder) collectFolders(child);
				}
			};
			collectFolders(this.plugin.app.vault.getRoot());
			for (const folder of folders) {
				if (results.length >= MAX) break;
				if (!query || folder.path.toLowerCase().includes(query)) {
					const displayPath = folder.path === '/' ? '(root)' : folder.path;
					results.push({
						icon: '📁',
						display: displayPath,
						chip: { type: 'folder', label: 'Folder: ' + displayPath, value: folder.path }
					});
				}
			}
			return results;
		}

		if (token.startsWith('tag:')) {
			const query = token.slice('tag:'.length).toLowerCase();
			const tagsRecord = (this.plugin.app.metadataCache as unknown as { getTags(): Record<string, number> }).getTags();
			for (const tagKey of Object.keys(tagsRecord)) {
				if (results.length >= MAX) break;
				// Keys include '#' prefix — strip it for display/matching
				const tagName = tagKey.startsWith('#') ? tagKey.slice(1) : tagKey;
				if (!query || tagName.toLowerCase().includes(query)) {
					results.push({
						icon: '🏷️',
						display: tagName,
						chip: { type: 'tag', label: 'Tag: ' + tagName, value: tagName }
					});
				}
			}
			return results;
		}

		if (token === 'web') {
			results.push({
				icon: '🌐',
				display: 'Search web',
				chip: { type: 'web', label: 'Web search', value: 'web' }
			});
			return results;
		}

		return results;
	}

	private selectMentionItem(item: { icon: string; display: string; chip: MentionChip }) {
		// Handle type-prefix placeholder selections (e.g. clicking "@note: — search notes")
		if (item.chip.value.startsWith('__type_prefix__:')) {
			const prefix = item.chip.value.slice('__type_prefix__:'.length);
			// prefix is like "@note:" or "@web" — insert it after the @ in the textarea
			const newPrefix = prefix.startsWith('@') ? prefix.slice(1) : prefix;
			const atIdx = this._mentionAtIdx;
			const oldCursor = this._mentionCursorIdx;
			if (atIdx < 0) return;
			const text = this.textarea.value;
			const newText = text.slice(0, atIdx) + newPrefix + text.slice(oldCursor);
			this.textarea.value = newText;
			const newCursor = atIdx + newPrefix.length;
			this.textarea.setSelectionRange(newCursor, newCursor);
			this.closePicker();
			this.textarea.focus();
			this.updateMentionPicker();
			return;
		}

		// Web chip: add directly
		if (item.chip.type === 'web') {
			this.addChipAndClean(item.chip);
			return;
		}

		// Regular chip
		this.addChipAndClean(item.chip);
	}

	private addChipAndClean(chip: MentionChip) {
		// Remove @token from textarea using the recorded position from when the picker opened
		const text = this.textarea.value;
		const atIdx = this._mentionAtIdx;
		const cursor = this._mentionCursorIdx;
		if (atIdx >= 0) {
			const newText = text.slice(0, atIdx) + text.slice(cursor);
			this.textarea.value = newText;
			this.textarea.setSelectionRange(atIdx, atIdx);
		}

		// Avoid duplicate chips
		const already = this.mentions.some(m => m.type === chip.type && m.value === chip.value);
		if (!already) {
			this.mentions.push(chip);
		}

		this.closePicker();
		this.renderChipsBar();
		this.textarea.focus();
	}

	// ── Send ──────────────────────────────────────────────────────────────────

	private renderEmptyState() {
		this.messagesEl.empty();
		this.messagesEl.createDiv({
			cls: 'volcano-empty-state',
			text: 'Start a conversation with Volcano Agent…'
		});
	}

	private resetThread() {
		this.abortController?.abort();
		this.agentClient?.clearHistory();
		this.toolCardEls.clear();
		this.mentions = [];
		this.renderChipsBar();
		this.renderEmptyState();
	}

	private ensureAgentClient(): AgentClient | null {
		const validation = validateSettings(this.plugin.settings);
		if (!validation.ok) {
			new Notice('Volcano: ' + validation.errors.join(' '), 8000);
			return null;
		}
		if (!this.agentClient) {
			this.agentClient = new AgentClient(
				this.plugin.settings,
				this.plugin.vaultAdapter,
				this.plugin.diffEngine
			);
		}
		return this.agentClient;
	}

	private async buildContextPreamble(): Promise<string> {
		if (this.mentions.length === 0) return '';

		const blocks: string[] = [];

		for (const chip of this.mentions) {
			try {
				if (chip.type === 'note') {
					const { content } = await this.plugin.vaultAdapter.readNote(chip.value);
					const truncated = content.length > 2000 ? content.slice(0, 2000) + '…(truncated)' : content;
					blocks.push(`## @note: ${chip.value}\n${truncated}`);
				} else if (chip.type === 'folder') {
					const files = await this.plugin.vaultAdapter.listFiles(chip.value === '/' ? '' : chip.value);
					const fileList = files.map(f => f.title).join('\n');
					blocks.push(`## @folder: ${chip.value}\n${fileList}`);
				} else if (chip.type === 'tag') {
					const tag = chip.value;
					const allFiles = this.plugin.app.vault.getMarkdownFiles();
					const taggedFiles: string[] = [];
					for (const file of allFiles) {
						if (taggedFiles.length >= 20) break;
						const cache = this.plugin.app.metadataCache.getFileCache(file);
						if (cache?.tags?.some(t => {
							const name = t.tag.startsWith('#') ? t.tag.slice(1) : t.tag;
							return name === tag;
						})) {
							taggedFiles.push(file.basename);
						}
					}
					blocks.push(`## @tag: ${tag}\n${taggedFiles.join('\n')}`);
				} else if (chip.type === 'web') {
					blocks.push('[Web search enabled for this message]');
				}
			} catch (err) {
				console.warn('[Volcano] @-mention context error:', err);
			}
		}

		if (blocks.length === 0) return '';
		return '\n\n---\n[Context pinned by @-mentions]\n' + blocks.join('\n\n');
	}

	private async handleSend() {
		const text = this.textarea.value.trim();
		if (!text) return;

		const client = this.ensureAgentClient();
		if (!client) return;

		// Build context from @-mention chips
		const contextPreamble = await this.buildContextPreamble();
		const fullMessage = contextPreamble ? text + contextPreamble : text;

		this.messagesEl.querySelector('.volcano-empty-state')?.remove();

		this.appendMessage('user', text);
		this.textarea.value = '';
		this.mentions = [];
		this.renderChipsBar();
		this.setBusy(true);

		const assistantEl = this.appendMessage('assistant', '');
		const contentEl = assistantEl.querySelector('.volcano-message-content') as HTMLElement;

		this.abortController = new AbortController();

		try {
			await client.sendMessage(fullMessage, this.abortController.signal, {
				onTextDelta: (delta) => {
					contentEl.appendText(delta);
					this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
				},
				onToolCall: (name, args) => {
					this.appendToolCard(name, args);
				},
				onToolResult: (name, result) => {
					this.appendToolResultPreview(name, result);
				}
			});

			if (!contentEl.textContent) {
				contentEl.setText('(no response)');
			}
		} catch (err) {
			console.error('[Volcano] Agent run failed:', err);
			const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
			if (this.abortController?.signal.aborted) {
				contentEl.appendText('\n\n_[stopped]_');
			} else {
				assistantEl.addClass('volcano-message-error');
				contentEl.setText('Error: ' + msg);
			}
		} finally {
			this.abortController = null;
			this.setBusy(false);
		}
	}

	private handleStop() {
		this.abortController?.abort();
	}

	private setBusy(busy: boolean) {
		this.textarea.disabled = busy;
		this.sendButton.disabled = busy || this.textarea.value.trim().length === 0;
		if (busy) {
			this.sendButton.hide();
			this.stopButton.show();
		} else {
			this.stopButton.hide();
			this.sendButton.show();
		}
	}

	private appendMessage(role: 'user' | 'assistant', text: string): HTMLElement {
		const el = this.messagesEl.createDiv({
			cls: `volcano-message volcano-message-${role}`
		});
		el.createDiv({ cls: 'volcano-message-role', text: role === 'user' ? 'You' : 'Volcano' });
		const content = el.createDiv({ cls: 'volcano-message-content' });
		if (text) content.setText(text);
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		return el;
	}

	private classifyTool(name: string): { icon: string; cssClass: string } {
		const READ  = ['read_note', 'outline_note', 'search_vault', 'list_files'];
		const WRITE = ['propose_edit', 'create_note'];
		const WEB   = ['web_search', 'web_fetch'];
		if (READ.includes(name))  return { icon: '📖', cssClass: 'volcano-tool-read' };
		if (WRITE.includes(name)) return { icon: '✏️',  cssClass: 'volcano-tool-write' };
		if (WEB.includes(name))   return { icon: '🌐', cssClass: 'volcano-tool-web' };
		return { icon: '🔧', cssClass: 'volcano-tool-unknown' };
	}

	private appendToolCard(name: string, args: string) {
		const { icon, cssClass } = this.classifyTool(name);
		const card = this.messagesEl.createDiv({ cls: `volcano-tool-card ${cssClass}` });
		card.dataset.toolName = name;
		this.toolCardEls.set(name, card);

		const header = card.createDiv({ cls: 'volcano-tool-header' });
		header.createDiv({ cls: 'volcano-tool-name', text: `${icon} ${name}` });

		if (args) {
			const fullArgs = args;
			const pre = card.createEl('pre', { cls: 'volcano-tool-args volcano-tool-args-collapsed', text: this.truncate(fullArgs, 400) });

			// Only show toggle when content actually overflows (checked after paint via rAF)
			const toggle = card.createEl('button', { cls: 'volcano-tool-args-toggle', text: '▼ show more' });
			let isCollapsed = true;

			const checkOverflow = () => {
				if (pre.scrollHeight <= pre.clientHeight + 2) {
					toggle.hide();
				}
			};
			// Use requestAnimationFrame to check after layout
			window.requestAnimationFrame(checkOverflow);

			toggle.addEventListener('click', () => {
				if (isCollapsed) {
					pre.setText(fullArgs);
					pre.removeClass('volcano-tool-args-collapsed');
					toggle.setText('▲ show less');
				} else {
					pre.setText(this.truncate(fullArgs, 400));
					pre.addClass('volcano-tool-args-collapsed');
					toggle.setText('▼ show more');
				}
				isCollapsed = !isCollapsed;
			});
		}

		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private appendToolResultPreview(name: string, result: string) {
		const card = this.toolCardEls.get(name);
		if (!card) return;

		// Add status indicator to header
		const header = card.querySelector('.volcano-tool-header') as HTMLElement | null;
		if (header) {
			const isError = (() => {
				try { return (JSON.parse(result) as Record<string, unknown>)?.error !== undefined; }
				catch { return false; }
			})();
			const statusEl = header.createSpan({
				cls: isError ? 'volcano-tool-status-err' : 'volcano-tool-status-ok',
				text: isError ? '✗' : '✓'
			});
			statusEl.setAttribute('aria-label', isError ? 'Tool error' : 'Tool completed');
		}

		const preview = card.createDiv({ cls: 'volcano-tool-result' });
		preview.setText(this.truncate(result, 400));
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private truncate(s: string, max: number): string {
		return s.length > max ? s.slice(0, max) + '…' : s;
	}

	private renderPendingPanel() {
		if (!this.pendingEl) return;
		this.pendingEl.empty();
		const diffs = this.plugin.diffEngine.list().filter((d) => d.status === 'pending' || d.status === 'conflicted');
		if (diffs.length === 0) {
			this.pendingEl.hide();
			return;
		}
		this.pendingEl.show();

		const diffRows: HTMLElement[] = [];

		const header = this.pendingEl.createDiv({ cls: 'volcano-pending-header' });
		header.addEventListener('click', () => {
			this.pendingCollapsed = !this.pendingCollapsed;
			chevron.setText(this.pendingCollapsed ? '▶' : '▼');
			for (const row of diffRows) {
				row.style.display = this.pendingCollapsed ? 'none' : '';
			}
		});

		const headerLeft = header.createDiv({ cls: 'volcano-pending-header-left' });
		const chevron = headerLeft.createSpan({
			cls: 'volcano-pending-chevron',
			text: this.pendingCollapsed ? '▶' : '▼'
		});
		headerLeft.createSpan({ text: `Pending changes (${diffs.length})` });

		const pendingDiffs = diffs.filter((d) => d.status === 'pending');
		if (pendingDiffs.length >= 2) {
			const bulkEl = header.createDiv({ cls: 'volcano-pending-bulk' });

			const acceptAllBtn = bulkEl.createEl('button', { text: 'Accept all', cls: 'volcano-pending-bulk-btn' });
			const rejectAllBtn = bulkEl.createEl('button', { text: 'Reject all', cls: 'volcano-pending-bulk-btn' });

			acceptAllBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				acceptAllBtn.disabled = true;
				rejectAllBtn.disabled = true;
				void (async () => {
					try {
						for (const diff of pendingDiffs) {
							// Skip if already accepted/rejected by a previous iteration's re-render
							if (this.plugin.diffEngine.get(diff.id)?.status !== 'pending') continue;
							await this.acceptDiff(diff);
						}
					} finally {
						acceptAllBtn.disabled = false;
						rejectAllBtn.disabled = false;
					}
				})();
			});

			rejectAllBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				for (const diff of pendingDiffs) {
					if (this.plugin.diffEngine.get(diff.id)?.status !== 'pending') continue;
					this.rejectDiff(diff);
				}
			});
		}

		for (const diff of diffs) {
			const row = this.pendingEl.createDiv({
				cls: `volcano-pending-row${diff.status === 'conflicted' ? ' volcano-pending-conflict' : ''}`
			});
			if (this.pendingCollapsed) {
				row.style.display = 'none';
			}
			diffRows.push(row);

			const meta = row.createDiv({ cls: 'volcano-pending-meta' });
			const tag = diff.isCreate ? '＋ create' : `± edit · ${diff.hunks.length} hunk${diff.hunks.length === 1 ? '' : 's'}`;
			meta.createDiv({ cls: 'volcano-pending-tag', text: tag });
			meta.createDiv({ cls: 'volcano-pending-path', text: diff.notePath });
			if (diff.summary) {
				meta.createDiv({ cls: 'volcano-pending-summary', text: diff.summary });
			}
			if (diff.status === 'conflicted') {
				meta.createDiv({
					cls: 'volcano-pending-status',
					text: '⚠️ Conflicted — file changed since the proposal was staged.'
				});
			}

			const actions = row.createDiv({ cls: 'volcano-pending-actions' });
			const jumpBtn = actions.createEl('button', { text: 'Jump', cls: 'volcano-pending-button' });
			jumpBtn.addEventListener('click', () => {
				void this.previewDiff(diff);
			});
			const acceptBtn = actions.createEl('button', { text: 'Accept', cls: 'volcano-pending-button volcano-pending-accept' });
			acceptBtn.addEventListener('click', () => {
				acceptBtn.disabled = true;
				void this.acceptDiff(diff).finally(() => { acceptBtn.disabled = false; });
			});
			const rejectBtn = actions.createEl('button', { text: 'Reject', cls: 'volcano-pending-button volcano-pending-reject' });
			rejectBtn.addEventListener('click', () => {
				this.rejectDiff(diff);
			});
		}
	}

	private async previewDiff(diff: StagedDiff): Promise<void> {
		try {
			const file = this.plugin.app.vault.getAbstractFileByPath(diff.notePath);
			if (file instanceof TFile) {
				const leaf = this.plugin.app.workspace.getLeaf(false);
				await leaf.openFile(file, { active: true });
			} else if (diff.isCreate) {
				new Notice(`Volcano: ${diff.notePath} will be created on accept.`);
				return;
			} else {
				new Notice(`Volcano: cannot find ${diff.notePath} to preview.`);
				return;
			}

			const view = this.getActiveCmView();
			if (view) applyDiffToEditor(view, diff);
		} catch (err) {
			console.error('[Volcano] preview failed:', err);
			new Notice(`Volcano: preview failed — ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async acceptDiff(diff: StagedDiff): Promise<void> {
		try {
			await this.plugin.diffEngine.accept(diff.id);
			this.clearPreviewIfActive(diff.notePath);
			this.plugin.diffEngine.discard(diff.id);
			new Notice(`Volcano: applied changes to ${diff.notePath}.`);
		} catch (err) {
			console.error('[Volcano] accept failed:', err);
			new Notice(`Volcano: ${err instanceof Error ? err.message : String(err)}`, 8000);
		}
	}

	private rejectDiff(diff: StagedDiff): void {
		this.clearPreviewIfActive(diff.notePath);
		this.plugin.diffEngine.reject(diff.id);
	}

	private getActiveCmView(): EditorView | null {
		const mdView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!mdView) return null;
		const cm = (mdView.editor as unknown as { cm?: EditorView }).cm;
		return cm ?? null;
	}

	private clearPreviewIfActive(path: string): void {
		const mdView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (!mdView || mdView.file?.path !== path) return;
		const cm = (mdView.editor as unknown as { cm?: EditorView }).cm;
		if (cm) applyDiffToEditor(cm, null);
	}
}
