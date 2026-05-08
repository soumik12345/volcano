import { Editor, MarkdownFileInfo, Menu, Plugin } from 'obsidian';
import { AgentView, VOLCANO_VIEW_TYPE } from './view/AgentView';
import type { MentionChip } from './view/AgentView';
import { VaultAdapter } from './vault/VaultAdapter';
import { DEFAULT_SETTINGS, VolcanoSettings, VolcanoSettingTab } from './settings';
import { DiffEngine } from './diff/DiffEngine';
import { volcanoDiffExtension } from './diff/cmDecorations';
import { SessionStore } from './session/SessionStore';

export default class VolcanoPlugin extends Plugin {
	settings: VolcanoSettings;
	vaultAdapter: VaultAdapter;
	diffEngine: DiffEngine;
	sessionStore: SessionStore | null = null;

	async onload() {
		await this.loadSettings();

		// Initialize vault adapter and diff engine
		this.vaultAdapter = new VaultAdapter(this.app);
		this.diffEngine = new DiffEngine(this.vaultAdapter);

		try {
			this.sessionStore = await SessionStore.load(this.app);
		} catch (err) {
			console.error('[Volcano] Failed to load session store:', err);
			// Plugin continues without session history if WASM or DB fails to load
		}

		// Register the CM6 extension on every markdown editor so diffs can be visualized inline.
		this.registerEditorExtension(volcanoDiffExtension);

		// Register the agent view
		this.registerView(
			VOLCANO_VIEW_TYPE,
			(leaf) => new AgentView(leaf, this)
		);

		// Add ribbon icon to toggle the agent pane
		this.addRibbonIcon('bot', 'Toggle agent', () => {
			void this.toggleView();
		});

		// Add command to toggle agent pane
		this.addCommand({
			id: 'open-agent',
			name: 'Toggle agent',
			callback: () => {
				void this.toggleView();
			}
		});

		this.addCommand({
			id: 'add-selection',
			name: 'Add selection',
			editorCallback: (editor: Editor, ctx: MarkdownFileInfo) => {
				const chip = this.buildSelectionChip(editor, ctx);
				if (!chip) return;
				void this.addSelectionToVolcano(chip);
			},
		});

		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, info: MarkdownFileInfo) => {
				const chip = this.buildSelectionChip(editor, info);
				if (!chip) return;
				menu.addItem(item =>
					item
						.setTitle('Add selection to volcano')
						.setIcon('bot')
						.onClick(() => void this.addSelectionToVolcano(chip))
				);
			})
		);

		// Add settings tab
		this.addSettingTab(new VolcanoSettingTab(this.app, this));
	}

	onunload() {
		
		this.sessionStore?.close();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<VolcanoSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async toggleView() {
		const leaves = this.app.workspace.getLeavesOfType(VOLCANO_VIEW_TYPE);
		if (leaves.length > 0) {
			this.app.workspace.detachLeavesOfType(VOLCANO_VIEW_TYPE);
			return;
		}
		await this.activateView();
	}

	private buildSelectionChip(editor: Editor, info: MarkdownFileInfo): MentionChip | null {
		const text = editor.getSelection();
		if (!text) return null;

		const basename = info.file?.basename ?? 'untitled';
		const from = editor.getCursor('from');
		const to = editor.getCursor('to');
		const fromLine = from.line + 1;
		const toLine = to.line + 1;
		const label = fromLine === toLine
			? `${basename}:${fromLine}`
			: `${basename}:${fromLine}-${toLine}`;

		return { type: 'selection', label, value: text };
	}

	private async addSelectionToVolcano(chip: MentionChip): Promise<void> {
		await this.activateView();
		const leaf = this.app.workspace.getLeavesOfType(VOLCANO_VIEW_TYPE)[0];
		const view = leaf?.view instanceof AgentView ? leaf.view : null;
		view?.addSelectionChip(chip);
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(VOLCANO_VIEW_TYPE)[0];

		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				leaf = rightLeaf;
				await leaf.setViewState({ type: VOLCANO_VIEW_TYPE, active: true });
			} else {
				return;
			}
		}

		void workspace.revealLeaf(leaf);
	}
}
