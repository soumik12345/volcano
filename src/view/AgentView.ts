import { ItemView, MarkdownRenderer, MarkdownView, Notice, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
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
	private pickerEl!: HTMLElement;
	private editorEl!: HTMLElement;
	private sendButton!: HTMLButtonElement;
	private stopButton!: HTMLButtonElement;
	private unsubscribeDiff: (() => void) | null = null;
	private toolCardEls = new Map<string, HTMLElement>();
	private pendingCollapsed = false;
	private pickerActiveIndex = -1;
	private _closePickerOnOutsideClick: ((e: MouseEvent) => void) | null = null;
	private _pickerDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _mentionAnchorNode: Node | null = null;
	private _mentionAtOffset: number = -1;
	private _mentionCursorOffset: number = -1;

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
			if (!this.pickerEl.contains(e.target as Node) && !this.editorEl.contains(e.target as Node)) {
				this.closePicker();
			}
		};
		document.addEventListener('mousedown', this._closePickerOnOutsideClick);

		this.editorEl = inputRow.createDiv({ cls: 'volcano-input-editor' });
		this.editorEl.contentEditable = 'true';
		this.editorEl.setAttribute('role', 'textbox');
		this.editorEl.setAttribute('aria-multiline', 'true');
		this.editorEl.setAttribute('aria-haspopup', 'listbox');
		this.editorEl.setAttribute('aria-expanded', 'false');
		this.editorEl.setAttribute('data-placeholder', 'Type your message… (Cmd+Enter to send, @ to mention)');
		this.sendButton = inputRow.createEl('button', { text: 'Send', cls: 'volcano-send' });
		this.stopButton = inputRow.createEl('button', { text: 'Stop', cls: 'volcano-stop' });
		this.sendButton.disabled = true;
		this.stopButton.hide();

		const updateDisabled = () => {
			this.sendButton.disabled = this.editorEl.textContent!.trim().length === 0;
			this.updateMentionPicker();
		};
		this.editorEl.addEventListener('input', updateDisabled);

		this.editorEl.addEventListener('keydown', (event) => {
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

			// Prevent bare Enter from inserting <br>/<div> in contenteditable
			// (Cmd+Enter sends; Shift+Enter is allowed for newlines)
			if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
				event.preventDefault();
				return;
			}

			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				void this.handleSend();
			}
		});
		this.editorEl.addEventListener('keyup', (e) => e.stopPropagation());
		this.editorEl.addEventListener('keypress', (e) => e.stopPropagation());

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
		this._mentionAnchorNode = null;
		this._mentionAtOffset = -1;
		this._mentionCursorOffset = -1;
		if (this.editorEl) {
			this.editorEl.setAttribute('aria-expanded', 'false');
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
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) { this.closePicker(); return; }

		const anchorNode = sel.anchorNode;
		// Only trigger when caret is in a plain text node inside editorEl
		if (!anchorNode || anchorNode.nodeType !== Node.TEXT_NODE || !this.editorEl.contains(anchorNode)) {
			this.closePicker();
			return;
		}

		const offset = sel.anchorOffset;
		const textBefore = (anchorNode.textContent ?? '').slice(0, offset);
		const atMatch = textBefore.match(/@([^\s]*)$/);

		if (!atMatch) { this.closePicker(); return; }

		const atIdx = textBefore.lastIndexOf('@');
		const token = atMatch[1] ?? '';
		const results = this.buildPickerResults(token);

		if (results.length === 0) { this.closePicker(); return; }

		// Record position for use in addChipAndClean
		this._mentionAnchorNode = anchorNode;
		this._mentionAtOffset = atIdx;
		this._mentionCursorOffset = offset;

		this.pickerEl.empty();
		this.pickerActiveIndex = -1;

		for (const item of results) {
			const itemEl = this.pickerEl.createDiv({ cls: 'volcano-mention-item' });
			itemEl.setAttribute('role', 'option');
			itemEl.createSpan({ cls: 'volcano-mention-item-icon', text: item.icon });
			itemEl.createSpan({ cls: 'volcano-mention-item-label', text: item.display });
			itemEl.createSpan({ cls: 'volcano-mention-item-type', text: item.typeLabel });
			itemEl.addEventListener('click', () => {
				this.selectMentionItem(item);
			});
		}

		this.pickerEl.show();
		this.editorEl.setAttribute('aria-expanded', 'true');
	}

	/**
	 * Score how well `name` matches `query`. Higher = better.
	 *   2 = name starts with query
	 *   1 = name contains query (substring)
	 *   0 = no match
	 * Both inputs are lowercased before comparison.
	 */
	private scoreMatch(name: string, query: string): number {
		if (query === '') return 1; // empty query matches everything equally
		const n = name.toLowerCase();
		const q = query.toLowerCase();
		if (n.startsWith(q)) return 2;
		if (n.includes(q)) return 1;
		return 0;
	}

	private buildPickerResults(token: string): Array<{
		icon: string;
		display: string;
		typeLabel: 'note' | 'folder' | 'tag' | 'action';
		chip: MentionChip;
	}> {
		const MAX = 10;
		type Row = {
			icon: string;
			display: string;
			typeLabel: 'note' | 'folder' | 'tag' | 'action';
			chip: MentionChip;
			score: number;
			sortKey: string;
		};

		// Empty query: recent notes + web action.
		if (token === '') {
			const rows: Row[] = [];
			const recentPaths = this.plugin.app.workspace.getLastOpenFiles();
			const seen = new Set<string>();
			for (const path of recentPaths) {
				if (rows.length >= 5) break;
				if (seen.has(path)) continue;
				seen.add(path);
				const file = this.plugin.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile) || file.extension !== 'md') continue;
				rows.push({
					icon: '📄',
					display: file.path,
					typeLabel: 'note',
					chip: { type: 'note', label: file.path, value: file.path },
					score: 1,
					sortKey: file.path.toLowerCase(),
				});
			}
			rows.push({
				icon: '🌐',
				display: 'Search the web',
				typeLabel: 'action',
				chip: { type: 'web', label: 'Web search', value: 'web' },
				score: 1,
				sortKey: 'zzz_web',
			});
			return rows.map(({ icon, display, typeLabel, chip }) => ({ icon, display, typeLabel, chip }));
		}

		// Non-empty query: score across all four sources.
		const candidates: Row[] = [];

		// Notes — match basename.
		for (const file of this.plugin.app.vault.getMarkdownFiles()) {
			const score = this.scoreMatch(file.basename, token);
			if (score === 0) continue;
			candidates.push({
				icon: '📄',
				display: file.path,
				typeLabel: 'note',
				chip: { type: 'note', label: file.path, value: file.path },
				score,
				sortKey: file.basename.toLowerCase(),
			});
		}

		// Folders — match full folder path.
		const collectFolders = (folder: TFolder, out: TFolder[]) => {
			out.push(folder);
			for (const child of folder.children) {
				if (child instanceof TFolder) collectFolders(child, out);
			}
		};
		const folders: TFolder[] = [];
		collectFolders(this.plugin.app.vault.getRoot(), folders);
		for (const folder of folders) {
			if (folder.path === '' || folder.path === '/') continue;
			const score = this.scoreMatch(folder.path, token);
			if (score === 0) continue;
			candidates.push({
				icon: '📁',
				display: folder.path,
				typeLabel: 'folder',
				chip: { type: 'folder', label: folder.path, value: folder.path },
				score,
				sortKey: folder.path.toLowerCase(),
			});
		}

		// Tags — match name without leading '#'.
		const tagsRecord = (this.plugin.app.metadataCache as unknown as { getTags(): Record<string, number> }).getTags();
		for (const tagKey of Object.keys(tagsRecord)) {
			const tagName = tagKey.startsWith('#') ? tagKey.slice(1) : tagKey;
			const score = this.scoreMatch(tagName, token);
			if (score === 0) continue;
			candidates.push({
				icon: '🏷️',
				display: tagName,
				typeLabel: 'tag',
				chip: { type: 'tag', label: tagName, value: tagName },
				score,
				sortKey: tagName.toLowerCase(),
			});
		}

		// Web action — match aliases.
		const webAliases = ['web', 'search', 'internet'];
		let webScore = 0;
		for (const alias of webAliases) {
			webScore = Math.max(webScore, this.scoreMatch(alias, token));
		}
		if (webScore > 0) {
			candidates.push({
				icon: '🌐',
				display: 'Search the web',
				typeLabel: 'action',
				chip: { type: 'web', label: 'Web search', value: 'web' },
				score: webScore,
				sortKey: 'zzz_web',
			});
		}

		candidates.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return a.sortKey.localeCompare(b.sortKey);
		});

		return candidates.slice(0, MAX).map(({ icon, display, typeLabel, chip }) => ({
			icon, display, typeLabel, chip,
		}));
	}

	private selectMentionItem(item: {
		icon: string;
		display: string;
		typeLabel: 'note' | 'folder' | 'tag' | 'action';
		chip: MentionChip;
	}) {
		this.addChipAndClean(item.chip);
	}

	private addChipAndClean(chip: MentionChip) {
		const anchorNode = this._mentionAnchorNode;
		const atOffset = this._mentionAtOffset;
		const cursorOffset = this._mentionCursorOffset;

		// Avoid duplicate chips
		const alreadyPresent = Array.from(this.editorEl.querySelectorAll('.volcano-mention-chip'))
			.some(el => (el as HTMLElement).dataset.type === chip.type &&
						(el as HTMLElement).dataset.value === chip.value);
		if (alreadyPresent) {
			this.closePicker();
			this.editorEl.focus();
			return;
		}

		if (anchorNode && atOffset >= 0 && cursorOffset >= atOffset) {
			try {
				// Delete @token from the text node
				const range = document.createRange();
				range.setStart(anchorNode, atOffset);
				range.setEnd(anchorNode, Math.min(cursorOffset, anchorNode.textContent?.length ?? 0));
				range.deleteContents();

				// Build chip span
				const chipEl = document.createElement('span');
				chipEl.className = 'volcano-mention-chip';
				chipEl.contentEditable = 'false';
				chipEl.dataset.type = chip.type;
				chipEl.dataset.value = chip.value;
				chipEl.dataset.label = chip.label;

				const textSpan = document.createElement('span');
				textSpan.textContent = '@' + chip.label;
				chipEl.appendChild(textSpan);

				const removeBtn = document.createElement('button');
				removeBtn.className = 'volcano-mention-chip-remove';
				removeBtn.setAttribute('aria-label', 'Remove mention');
				removeBtn.textContent = '×';
				removeBtn.addEventListener('mousedown', (e) => {
					e.preventDefault();
				});
				removeBtn.addEventListener('click', (e) => {
					e.preventDefault();
					e.stopPropagation();
					const before = document.createRange();
					before.setStartBefore(chipEl);
					before.collapse(true);
					chipEl.remove();
					try {
						const sel = window.getSelection();
						if (sel) {
							sel.removeAllRanges();
							sel.addRange(before);
						}
					} catch {
						// ignore — cursor restoration is best-effort
					}
					this.editorEl.focus();
					this.sendButton.disabled = this.editorEl.textContent!.trim().length === 0;
				});
				chipEl.appendChild(removeBtn);

				// Insert chip at collapsed range
				range.insertNode(chipEl);

				// Insert empty text node after chip so next keystroke goes there
				const spacer = document.createTextNode('');
				chipEl.after(spacer);
				const afterRange = document.createRange();
				afterRange.setStart(spacer, 0);
				afterRange.collapse(true);
				const sel = window.getSelection();
				if (sel) {
					sel.removeAllRanges();
					sel.addRange(afterRange);
				}
			} catch {
				// Ignore range errors
			}
		}

		this.closePicker();
		this.editorEl.focus();
		this.sendButton.disabled = this.editorEl.textContent!.trim().length === 0;
	}

	// ── Send ──────────────────────────────────────────────────────────────────

	private extractEditorContent(): { displayText: string; chips: MentionChip[] } {
		const chips: MentionChip[] = [];
		let displayText = '';

		for (const node of Array.from(this.editorEl.childNodes)) {
			if (node.nodeType === Node.TEXT_NODE) {
				displayText += node.textContent ?? '';
			} else if (node instanceof HTMLElement && node.classList.contains('volcano-mention-chip')) {
				const type = (node.dataset.type ?? 'note') as MentionChip['type'];
				const value = node.dataset.value ?? '';
				const label = node.dataset.label ?? value;
				chips.push({ type, label, value });
				const textSpan = node.querySelector('span');
				displayText += (textSpan?.textContent ?? label);
			}
		}

		return { displayText: displayText.trim(), chips };
	}

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
		this.editorEl.innerHTML = '';
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

	private async buildContextPreamble(chips: MentionChip[]): Promise<string> {
		if (chips.length === 0) return '';

		const blocks: string[] = [];

		for (const chip of chips) {
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
		if (this.abortController) return; // already in flight

		const { displayText, chips } = this.extractEditorContent();
		if (!displayText && chips.length === 0) return;

		const client = this.ensureAgentClient();
		if (!client) return;

		this.abortController = new AbortController();
		const signal = this.abortController.signal;
		this.setBusy(true);

		this.messagesEl.querySelector('.volcano-empty-state')?.remove();
		this.appendMessage('user', displayText);
		this.editorEl.innerHTML = '';

		const contextPreamble = await this.buildContextPreamble(chips);
		const fullMessage = contextPreamble ? displayText + contextPreamble : displayText;

		const assistantEl = this.appendMessage('assistant', '');
		this.toolCardEls.clear();
		const streamContainerEl = assistantEl.querySelector<HTMLElement>('.volcano-message-content');
		if (!streamContainerEl) {
			this.setBusy(false);
			return;
		}

		interface TextSeg { el: HTMLElement; rawText: string; timerId: ReturnType<typeof setTimeout> | null; rendering: boolean; hasEverRendered: boolean; setWordCount?: (text: string) => void; }
		const segments: TextSeg[] = [];
		let activeSeg: TextSeg | null = null;
		let reasoningSeg: TextSeg | null = null;

		const getOrCreateSeg = (): TextSeg => {
			if (!activeSeg) {
				const el = streamContainerEl.createDiv({ cls: 'volcano-stream-text' });
				activeSeg = { el, rawText: '', timerId: null, rendering: false, hasEverRendered: false };
				segments.push(activeSeg);
			}
			return activeSeg;
		};

		const doRender = async (seg: TextSeg) => {
			if (seg.rendering || !seg.rawText) return;
			seg.rendering = true;
			const snapshot = seg.rawText;
			const tmp = document.createElement('div');
			await MarkdownRenderer.render(this.plugin.app, snapshot, tmp, '', this);
			this.fixLinks(tmp);
			seg.rendering = false;
			seg.hasEverRendered = true;
			seg.el.empty();
			seg.el.style.whiteSpace = 'normal';
			while (tmp.firstChild) seg.el.appendChild(tmp.firstChild);
			seg.setWordCount?.(snapshot);
			if (seg.rawText.length > snapshot.length) {
				seg.timerId = setTimeout(() => void doRender(seg), 50);
			}
		};

		const scheduleSeg = (seg: TextSeg) => {
			if (seg.timerId !== null) clearTimeout(seg.timerId);
			seg.timerId = setTimeout(() => { seg.timerId = null; void doRender(seg); }, 50);
		};

		const finalizeActiveSeg = () => {
			if (!activeSeg) return;
			if (activeSeg.timerId !== null) { clearTimeout(activeSeg.timerId); activeSeg.timerId = null; }
			const seg = activeSeg;
			activeSeg = null;
			void doRender(seg);
		};

		try {
			await client.sendMessage(fullMessage, signal, {
				onTextDelta: (delta) => {
					const seg = getOrCreateSeg();
					seg.rawText += delta;
					if (!seg.hasEverRendered && !seg.rendering) {
						seg.el.appendText(delta);
					}
					scheduleSeg(seg);
					this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
				},
				onReasoningDelta: (delta) => {
					if (!reasoningSeg) {
						const anchorEl = activeSeg?.el ?? null;
						finalizeActiveSeg();
						const { block, body, setWordCount } = this.buildStreamingReasoningBlock(true);
						if (anchorEl && anchorEl.parentElement === streamContainerEl) {
							streamContainerEl.insertBefore(block, anchorEl);
						} else {
							streamContainerEl.appendChild(block);
						}
						reasoningSeg = {
							el: body,
							rawText: '',
							timerId: null,
							rendering: false,
							hasEverRendered: false,
							setWordCount
						};
						segments.push(reasoningSeg);
					}
					reasoningSeg.rawText += delta;
					reasoningSeg.setWordCount?.(reasoningSeg.rawText);
					if (!reasoningSeg.hasEverRendered && !reasoningSeg.rendering) {
						reasoningSeg.el.appendText(delta);
					}
					if (reasoningSeg.timerId !== null) clearTimeout(reasoningSeg.timerId);
					reasoningSeg.timerId = setTimeout(() => {
						if (reasoningSeg) { reasoningSeg.timerId = null; void doRender(reasoningSeg); }
					}, 50);
					this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
				},
				onReasoningItem: (text) => {
					if (reasoningSeg) {
						// Streaming path already built the block — finalize and reset for next turn.
						const seg = reasoningSeg;
						reasoningSeg = null;
						if (seg.timerId !== null) { clearTimeout(seg.timerId); seg.timerId = null; }
						void doRender(seg);
						return;
					}
					// Fallback: provider didn't emit reasoning deltas — render the full item.
					const anchorEl = activeSeg?.el ?? null;
					finalizeActiveSeg();
					const block = this.buildReasoningBlock(text);
					if (anchorEl && anchorEl.parentElement === streamContainerEl) {
						streamContainerEl.insertBefore(block, anchorEl);
					} else {
						streamContainerEl.appendChild(block);
					}
					this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
				},
				onToolCall: (name, args) => {
					finalizeActiveSeg();
					this.appendToolCard(streamContainerEl, name, args);
					this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
				},
				onToolResult: (name, result) => {
					this.appendToolResultPreview(name, result);
				}
			});

			if (streamContainerEl.childElementCount === 0) {
				streamContainerEl.createDiv({ cls: 'volcano-stream-text' }).setText('(no response)');
			}

			// Final render pass
			for (const seg of segments) {
				if (seg.timerId !== null) { clearTimeout(seg.timerId); seg.timerId = null; }
				await doRender(seg);
			}
		} catch (err) {
			for (const seg of segments) {
				if (seg.timerId !== null) { clearTimeout(seg.timerId); seg.timerId = null; }
			}
			console.error('[Volcano] Agent run failed:', err);
			if (signal.aborted) {
				for (const seg of segments) await doRender(seg);
				streamContainerEl.createDiv({ cls: 'volcano-stream-text' }).appendText('[stopped]');
			} else {
				assistantEl.addClass('volcano-message-error');
				const apiDetail = (err as Record<string, unknown>).error;
				const msg = err instanceof Error ? err.message : String(err);
				const detail = apiDetail ? '\n' + JSON.stringify(apiDetail, null, 2) : '';
				streamContainerEl.createDiv({ cls: 'volcano-stream-text' }).setText('Error: ' + msg + detail);
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
		this.editorEl.contentEditable = (!busy).toString();
		this.sendButton.disabled = busy || this.editorEl.textContent!.trim().length === 0;
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

	private buildReasoningBlock(text: string): HTMLElement {
		const { block, body, setWordCount } = this.buildStreamingReasoningBlock(false);
		setWordCount(text);
		void MarkdownRenderer.render(this.plugin.app, text, body, '', this);
		return block;
	}

	private buildStreamingReasoningBlock(startExpanded: boolean): {
		block: HTMLElement;
		body: HTMLElement;
		setWordCount: (text: string) => void;
	} {
		const block = document.createElement('div');
		block.className = 'volcano-reasoning-block';

		const header = block.createDiv({ cls: 'volcano-reasoning-header' });
		header.createSpan({ cls: 'volcano-reasoning-label', text: 'Thinking…' });
		const wordCountEl = header.createSpan({ cls: 'volcano-reasoning-wordcount', text: '~0 words' });
		const toggle = header.createEl('button', {
			cls: 'volcano-reasoning-toggle',
			text: startExpanded ? '▲ hide' : '▶ show'
		});

		const body = block.createDiv({ cls: 'volcano-reasoning-body' });
		body.style.display = startExpanded ? '' : 'none';

		let expanded = startExpanded;
		header.addEventListener('click', () => {
			expanded = !expanded;
			body.style.display = expanded ? '' : 'none';
			toggle.setText(expanded ? '▲ hide' : '▶ show');
		});

		const setWordCount = (text: string) => {
			const wc = text.trim().split(/\s+/).filter(Boolean).length;
			wordCountEl.setText(`~${wc} words`);
		};

		return { block, body, setWordCount };
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

	private appendToolCard(containerEl: HTMLElement, name: string, args: string) {
		const { icon, cssClass } = this.classifyTool(name);
		const card = containerEl.createDiv({ cls: `volcano-tool-card ${cssClass}` });
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

	private fixLinks(el: HTMLElement) {
		// Convert code-wrapped bare URLs (model sometimes backtick-wraps them) to real links
		el.querySelectorAll('code').forEach(code => {
			const text = code.textContent?.trim() ?? '';
			if (/^https?:\/\/\S+$/.test(text)) {
				const a = document.createElement('a');
				a.href = text;
				a.textContent = text;
				a.className = 'external-link';
				a.rel = 'noopener noreferrer';
				a.addEventListener('click', (e) => { e.preventDefault(); window.open(text, '_blank'); });
				code.replaceWith(a);
			}
		});
		// Ensure all external links open in the system browser
		el.querySelectorAll('a[href^="http"]').forEach(link => {
			const a = link as HTMLAnchorElement;
			a.rel = 'noopener noreferrer';
			a.addEventListener('click', (e) => { e.preventDefault(); window.open(a.href, '_blank'); });
		});
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
		// Iterate all open markdown leaves — getActiveViewOfType would miss the
		// file when the Volcano pane itself is the active leaf (e.g. just after
		// clicking Accept/Reject).
		for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view as MarkdownView;
			if (view.file?.path !== path) continue;
			const cm = (view.editor as unknown as { cm?: EditorView }).cm;
			if (cm) applyDiffToEditor(cm, null);
		}
	}
}
