import OpenAI from 'openai';
import {
	Agent,
	OpenAIChatCompletionsModel,
	run,
	setDefaultOpenAIClient,
	setTracingDisabled,
	user,
	type AgentInputItem,
	type Tool
} from '@openai/agents';

setTracingDisabled(true);
import type { VolcanoSettings } from '../settings';
import type { VaultAdapter } from '../vault/VaultAdapter';
import type { DiffEngine } from '../diff/DiffEngine';
import { VOLCANO_SYSTEM_PROMPT } from './systemPrompt';
import { buildReadOnlyTools } from './tools';
import { buildWebTools } from './tools/web';
import { buildWriteTools } from './tools/write';
import { createWebSearchProvider } from './web';

export interface RunCallbacks {
	onTextDelta?: (delta: string) => void;
	onToolCall?: (toolName: string, args: string) => void;
	onToolResult?: (toolName: string, result: string) => void;
	onError?: (err: Error) => void;
}

export class AgentClient {
	private agent: Agent;
	private history: AgentInputItem[] = [];

	constructor(settings: VolcanoSettings, vault: VaultAdapter, diffEngine: DiffEngine) {
		const openaiClient = new OpenAI({
			baseURL: settings.baseUrl,
			apiKey: settings.apiKey || 'unused',
			dangerouslyAllowBrowser: true
		});
		setDefaultOpenAIClient(openaiClient);

		const tools: Tool[] = [
			...buildReadOnlyTools(vault),
			...buildWriteTools(vault, diffEngine)
		];
		const webProvider = createWebSearchProvider(settings);
		if (webProvider) tools.push(...buildWebTools(webProvider));

		this.agent = new Agent({
			name: 'Volcano',
			instructions: VOLCANO_SYSTEM_PROMPT,
			model: new OpenAIChatCompletionsModel(openaiClient, settings.model),
			tools
		});
	}

	clearHistory() {
		this.history = [];
	}

	/**
	 * Run a turn with streaming. Returns the final assistant text.
	 * `signal` lets the caller cancel the in-flight run.
	 */
	async sendMessage(
		message: string,
		signal: AbortSignal,
		callbacks: RunCallbacks = {}
	): Promise<string> {
		const turnInput: AgentInputItem[] = [...this.history, user(message)];

		try {
			const stream = await run(this.agent, turnInput, { stream: true, signal });

			let assistantText = '';

			for await (const event of stream) {
				if (event.type === 'raw_model_stream_event') {
					const data = event.data as { type?: string; delta?: string };
					if (data?.type === 'output_text_delta' && typeof data.delta === 'string') {
						assistantText += data.delta;
						callbacks.onTextDelta?.(data.delta);
					}
				} else if (event.type === 'run_item_stream_event') {
					const item = event.item;
					if (item.type === 'tool_call_item') {
						const raw = item.rawItem as { name?: string; arguments?: string };
						callbacks.onToolCall?.(raw.name ?? 'tool', raw.arguments ?? '');
					} else if (item.type === 'tool_call_output_item') {
						const raw = item.rawItem as { name?: string };
						const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
						callbacks.onToolResult?.(raw.name ?? 'tool', output);
					}
				}
			}

			await stream.completed;

			this.history = stream.history as AgentInputItem[];

			return assistantText;
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			callbacks.onError?.(e);
			throw e;
		}
	}
}
