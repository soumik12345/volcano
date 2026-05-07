import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type VolcanoPlugin from '../main';
import { AgentClient } from '../agent/AgentClient';
import { validateSettings } from '../settings';

export const VOLCANO_VIEW_TYPE = 'volcano-agent-view';

export class AgentView extends ItemView {
	plugin: VolcanoPlugin;
	private agentClient: AgentClient | null = null;
	private abortController: AbortController | null = null;

	private messagesEl!: HTMLElement;
	private textarea!: HTMLTextAreaElement;
	private sendButton!: HTMLButtonElement;
	private stopButton!: HTMLButtonElement;

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

		this.messagesEl = root.createDiv({ cls: 'volcano-messages' });
		this.renderEmptyState();

		const inputRow = root.createDiv({ cls: 'volcano-input' });
		this.textarea = inputRow.createEl('textarea', {
			attr: {
				rows: '3',
				placeholder: 'Type your message… (Cmd+Enter to send)'
			}
		});
		this.sendButton = inputRow.createEl('button', { text: 'Send', cls: 'volcano-send' });
		this.stopButton = inputRow.createEl('button', { text: 'Stop', cls: 'volcano-stop' });
		this.sendButton.disabled = true;
		this.stopButton.hide();

		const updateDisabled = () => {
			this.sendButton.disabled = this.textarea.value.trim().length === 0;
		};
		this.textarea.addEventListener('input', updateDisabled);

		this.textarea.addEventListener('keydown', (event) => {
			event.stopPropagation();
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
		this.contentEl.empty();
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
		this.renderEmptyState();
	}

	private ensureAgentClient(): AgentClient | null {
		const validation = validateSettings(this.plugin.settings);
		if (!validation.ok) {
			new Notice('Volcano: ' + validation.errors.join(' '), 8000);
			return null;
		}
		if (!this.agentClient) {
			this.agentClient = new AgentClient(this.plugin.settings, this.plugin.vaultAdapter);
		}
		return this.agentClient;
	}

	private async handleSend() {
		const text = this.textarea.value.trim();
		if (!text) return;

		const client = this.ensureAgentClient();
		if (!client) return;

		this.messagesEl.querySelector('.volcano-empty-state')?.remove();

		this.appendMessage('user', text);
		this.textarea.value = '';
		this.setBusy(true);

		const assistantEl = this.appendMessage('assistant', '');
		const contentEl = assistantEl.querySelector('.volcano-message-content') as HTMLElement;

		this.abortController = new AbortController();

		try {
			await client.sendMessage(text, this.abortController.signal, {
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

	private appendToolCard(name: string, args: string) {
		const card = this.messagesEl.createDiv({ cls: 'volcano-tool-card' });
		card.createDiv({ cls: 'volcano-tool-name', text: `🔧 ${name}` });
		if (args) {
			card.createEl('pre', { cls: 'volcano-tool-args', text: this.truncate(args, 400) });
		}
		this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
	}

	private appendToolResultPreview(name: string, result: string) {
		const last = this.messagesEl.lastElementChild as HTMLElement | null;
		if (last && last.classList.contains('volcano-tool-card')) {
			const preview = last.createDiv({ cls: 'volcano-tool-result' });
			preview.setText(this.truncate(result, 400));
			this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
		}
	}

	private truncate(s: string, max: number): string {
		return s.length > max ? s.slice(0, max) + '…' : s;
	}
}
