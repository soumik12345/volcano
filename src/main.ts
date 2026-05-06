import { Plugin } from 'obsidian';
import { AgentView, VOLCANO_VIEW_TYPE } from './view/AgentView';
import { VaultAdapter } from './vault/VaultAdapter';
import { DEFAULT_SETTINGS, VolcanoSettings, VolcanoSettingTab } from './settings';

export default class VolcanoPlugin extends Plugin {
	settings: VolcanoSettings;
	vaultAdapter: VaultAdapter;

	async onload() {
		await this.loadSettings();

		// Initialize vault adapter
		this.vaultAdapter = new VaultAdapter(this.app);

		// Register the agent view
		this.registerView(
			VOLCANO_VIEW_TYPE,
			(leaf) => new AgentView(leaf, this)
		);

		// Add ribbon icon to open the agent pane
		this.addRibbonIcon('bot', 'Open Volcano Agent', () => {
			this.activateView();
		});

		// Add command to open agent pane
		this.addCommand({
			id: 'open-volcano-agent',
			name: 'Open Volcano Agent',
			callback: () => {
				this.activateView();
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
