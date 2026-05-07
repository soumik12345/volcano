import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import OpenAI from 'openai';
import type VolcanoPlugin from './main';

export interface VolcanoSettings {
	// Provider configuration
	providerPreset: 'openai' | 'openrouter' | 'anthropic' | 'ollama' | 'custom';
	baseUrl: string;
	apiKey: string;
	model: string;

	// Agent behavior
	maxTurns: number;

	// Web search
	webSearchProvider: 'tavily';
	webSearchApiKey: string;
}

export const PROVIDER_PRESETS = {
	openai: {
		baseUrl: 'https://api.openai.com/v1',
		model: 'gpt-5',
		name: 'OpenAI'
	},
	openrouter: {
		baseUrl: 'https://openrouter.ai/api/v1',
		model: 'anthropic/claude-sonnet-4-6',
		name: 'OpenRouter'
	},
	anthropic: {
		baseUrl: 'https://api.anthropic.com/v1',
		model: 'claude-sonnet-4-6',
		name: 'Anthropic (OpenAI-compatible)'
	},
	ollama: {
		baseUrl: 'http://localhost:11434/v1',
		model: 'llama3.2:latest',
		name: 'Ollama (local)'
	},
	custom: {
		baseUrl: '',
		model: '',
		name: 'Custom'
	}
};

export interface SettingsValidation {
	ok: boolean;
	errors: string[];
}

export function validateSettings(settings: VolcanoSettings): SettingsValidation {
	const errors: string[] = [];

	if (!settings.baseUrl.trim()) {
		errors.push('Base URL is required.');
	} else {
		try {
			const url = new URL(settings.baseUrl);
			if (url.protocol !== 'http:' && url.protocol !== 'https:') {
				errors.push('Base URL must use http or https.');
			}
		} catch {
			errors.push('Base URL is not a valid URL.');
		}
	}

	if (!settings.model.trim()) {
		errors.push('Model name is required.');
	}

	const isLocalProvider = settings.providerPreset === 'ollama';
	if (!isLocalProvider && !settings.apiKey.trim()) {
		errors.push('API key is required for the selected provider.');
	}

	return { ok: errors.length === 0, errors };
}

export async function testConnection(settings: VolcanoSettings): Promise<{ ok: boolean; message: string }> {
	const validation = validateSettings(settings);
	if (!validation.ok) {
		return { ok: false, message: validation.errors.join(' ') };
	}

	try {
		const client = new OpenAI({
			baseURL: settings.baseUrl,
			apiKey: settings.apiKey || 'unused',
			dangerouslyAllowBrowser: true
		});
		await client.models.list();
		return { ok: true, message: 'Connection successful.' };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, message: `Connection failed: ${msg}` };
	}
}

export const DEFAULT_SETTINGS: VolcanoSettings = {
	providerPreset: 'openai',
	baseUrl: PROVIDER_PRESETS.openai.baseUrl,
	apiKey: '',
	model: PROVIDER_PRESETS.openai.model,
	maxTurns: 100,
	webSearchProvider: 'tavily',
	webSearchApiKey: ''
}

export class VolcanoSettingTab extends PluginSettingTab {
	plugin: VolcanoPlugin;

	constructor(app: App, plugin: VolcanoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl('h2', { text: 'Volcano Agent Settings' });

		const validation = validateSettings(this.plugin.settings);
		const statusEl = containerEl.createDiv({ cls: 'volcano-settings-status' });
		statusEl.style.padding = '8px 12px';
		statusEl.style.marginBottom = '12px';
		statusEl.style.borderRadius = '4px';
		if (validation.ok) {
			statusEl.style.backgroundColor = 'var(--background-modifier-success)';
			statusEl.setText('✓ Configuration looks valid.');
		} else {
			statusEl.style.backgroundColor = 'var(--background-modifier-error)';
			statusEl.setText('⚠ ' + validation.errors.join(' '));
		}

		// Provider preset dropdown
		new Setting(containerEl)
			.setName('Provider preset')
			.setDesc('Choose a preset to auto-fill connection details')
			.addDropdown(dropdown => {
				Object.entries(PROVIDER_PRESETS).forEach(([key, preset]) => {
					dropdown.addOption(key, preset.name);
				});
				dropdown
					.setValue(this.plugin.settings.providerPreset)
					.onChange(async (value: keyof typeof PROVIDER_PRESETS) => {
						this.plugin.settings.providerPreset = value;

						if (value !== 'custom') {
							const preset = PROVIDER_PRESETS[value];
							this.plugin.settings.baseUrl = preset.baseUrl;
							this.plugin.settings.model = preset.model;
						}

						await this.plugin.saveSettings();
						this.display(); // Refresh the settings tab
					});
			});

		// Base URL
		new Setting(containerEl)
			.setName('Base URL')
			.setDesc('OpenAI-compatible API endpoint')
			.addText(text => text
				.setPlaceholder('https://api.openai.com/v1')
				.setValue(this.plugin.settings.baseUrl)
				.onChange(async (value) => {
					this.plugin.settings.baseUrl = value;
					await this.plugin.saveSettings();
				}));

		// API Key
		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Your API key for the selected provider')
			.addText(text => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('Enter your API key')
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value;
						await this.plugin.saveSettings();
					});
			});

		// Model
		new Setting(containerEl)
			.setName('Model')
			.setDesc('Model name to use for conversations')
			.addText(text => text
				.setPlaceholder('gpt-5')
				.setValue(this.plugin.settings.model)
				.onChange(async (value) => {
					this.plugin.settings.model = value;
					await this.plugin.saveSettings();
				}));

		// Test connection
		new Setting(containerEl)
			.setName('Test connection')
			.setDesc('Verify the API endpoint and key work.')
			.addButton(button => button
				.setButtonText('Test')
				.onClick(async () => {
					button.setButtonText('Testing…').setDisabled(true);
					const result = await testConnection(this.plugin.settings);
					new Notice(result.message, result.ok ? 4000 : 8000);
					button.setButtonText('Test').setDisabled(false);
				}));

		// Max turns
		new Setting(containerEl)
			.setName('Max turns')
			.setDesc('Maximum number of agent turns per conversation (default: 100).')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.style.width = '80px';
				text
					.setValue(String(this.plugin.settings.maxTurns))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n >= 1) {
							this.plugin.settings.maxTurns = n;
							await this.plugin.saveSettings();
						}
					});
			});

		containerEl.createEl('h3', { text: 'Web Search' });

		// Web search provider
		new Setting(containerEl)
			.setName('Web search provider')
			.setDesc('Search provider for web research')
			.addDropdown(dropdown => {
				dropdown
					.addOption('tavily', 'Tavily')
					.setValue(this.plugin.settings.webSearchProvider)
					.onChange(async (value: 'tavily') => {
						this.plugin.settings.webSearchProvider = value;
						await this.plugin.saveSettings();
					});
			});

		// Web search API key
		new Setting(containerEl)
			.setName('Web search API key')
			.setDesc('API key for web search provider')
			.addText(text => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('Enter web search API key')
					.setValue(this.plugin.settings.webSearchApiKey)
					.onChange(async (value) => {
						this.plugin.settings.webSearchApiKey = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
