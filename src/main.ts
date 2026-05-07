import { Plugin } from 'obsidian';
import { AgentView, VOLCANO_VIEW_TYPE } from './view/AgentView';
import { VaultAdapter } from './vault/VaultAdapter';
import { DEFAULT_SETTINGS, VolcanoSettings, VolcanoSettingTab } from './settings';
import { DiffEngine } from './diff/DiffEngine';
import { volcanoDiffExtension } from './diff/cmDecorations';

export default class VolcanoPlugin extends Plugin {
	settings: VolcanoSettings;
	vaultAdapter: VaultAdapter;
	diffEngine: DiffEngine;

	async onload() {
		await this.loadSettings();

		// Initialize vault adapter and diff engine
		this.vaultAdapter = new VaultAdapter(this.app);
		this.diffEngine = new DiffEngine(this.vaultAdapter);

		// Register the CM6 extension on every markdown editor so diffs can be visualized inline.
		this.registerEditorExtension(volcanoDiffExtension);

		// Register the agent view
		this.registerView(
			VOLCANO_VIEW_TYPE,
			(leaf) => new AgentView(leaf, this)
		);

		// Add ribbon icon to toggle the agent pane
		this.addRibbonIcon('bot', 'Toggle Volcano Agent', () => {
			this.toggleView();
		});

		// Add command to toggle agent pane
		this.addCommand({
			id: 'open-volcano-agent',
			name: 'Toggle Volcano Agent',
			callback: () => {
				this.toggleView();
			}
		});

		// Add settings tab
		this.addSettingTab(new VolcanoSettingTab(this.app, this));
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(VOLCANO_VIEW_TYPE);
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

		workspace.revealLeaf(leaf);
	}
}
