import { ItemView, WorkspaceLeaf } from 'obsidian';
import type VolcanoPlugin from '../main';

export const VOLCANO_VIEW_TYPE = 'volcano-agent-view';

export class AgentView extends ItemView {
	plugin: VolcanoPlugin;

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

		const messages = root.createDiv({ cls: 'volcano-messages' });
		messages.createDiv({
			cls: 'volcano-empty-state',
			text: 'Start a conversation with Volcano Agent…'
		});

		const inputRow = root.createDiv({ cls: 'volcano-input' });
		const textarea = inputRow.createEl('textarea', {
			attr: {
				rows: '3',
				placeholder: 'Type your message… (Cmd+Enter to send)'
			}
		});
		const sendButton = inputRow.createEl('button', { text: 'Send' });
		sendButton.disabled = true;

		const updateDisabled = () => {
			sendButton.disabled = textarea.value.trim().length === 0;
		};
		textarea.addEventListener('input', updateDisabled);

		textarea.addEventListener('keydown', (event) => {
			event.stopPropagation();
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				this.handleSend(textarea, messages, sendButton);
			}
		});
		textarea.addEventListener('keyup', (e) => e.stopPropagation());
		textarea.addEventListener('keypress', (e) => e.stopPropagation());

		sendButton.addEventListener('click', () => {
			this.handleSend(textarea, messages, sendButton);
		});
	}

	async onClose() {
		this.contentEl.empty();
	}

	private handleSend(
		textarea: HTMLTextAreaElement,
		messagesEl: HTMLElement,
		sendButton: HTMLButtonElement
	) {
		const text = textarea.value.trim();
		if (!text) return;

		const empty = messagesEl.querySelector('.volcano-empty-state');
		if (empty) empty.remove();

		const messageEl = messagesEl.createDiv({ cls: 'volcano-message volcano-message-user' });
		messageEl.createDiv({ cls: 'volcano-message-content', text });

		textarea.value = '';
		sendButton.disabled = true;
		messagesEl.scrollTop = messagesEl.scrollHeight;

		console.log('[Volcano] User message:', text);
	}
}
