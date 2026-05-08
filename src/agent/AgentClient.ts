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

async function* tapReasoningStream(
	stream: AsyncIterable<unknown>,
	getCb: () => ((delta: string) => void) | null
): AsyncIterable<unknown> {
	for await (const chunk of stream) {
		const delta = (chunk as { choices?: Array<{ delta?: Record<string, unknown> }> })
			?.choices?.[0]?.delta;
		if (delta) {
			// OpenRouter / Claude / OpenAI o-series: `reasoning`
			// DeepSeek: `reasoning_content`
			const r = (typeof delta.reasoning === 'string' && delta.reasoning)
				|| (typeof delta.reasoning_content === 'string' && delta.reasoning_content)
				|| '';
			if (r) getCb()?.(r);
		}
		yield chunk;
	}
}

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
	onReasoningDelta?: (delta: string) => void;
	onReasoningItem?: (text: string) => void;
	onToolCall?: (toolName: string, args: string) => void;
	onToolResult?: (toolName: string, result: string) => void;
	onError?: (err: Error) => void;
}

export class AgentClient {
	private agent: Agent;
	private history: AgentInputItem[] = [];
	private currentReasoningDeltaCb: ((delta: string) => void) | null = null;
	private openaiClient: OpenAI;
	private settings: VolcanoSettings;

	constructor(settings: VolcanoSettings, vault: VaultAdapter, diffEngine: DiffEngine) {
		const apiKey = settings.apiKey || 'unused';
		console.debug('[Volcano] Creating OpenAI client — baseURL:', settings.baseUrl, '| apiKey set:', apiKey !== 'unused');
		const openaiClient = new OpenAI({
			baseURL: settings.baseUrl,
			apiKey,
			dangerouslyAllowBrowser: true,
			// Belt-and-suspenders: Electron's renderer fetch can drop the Authorization header
			// in some CORS paths. Setting it via defaultHeaders forces it onto every request.
			defaultHeaders: {
				Authorization: `Bearer ${apiKey}`,
			},
		});

		this.openaiClient = openaiClient;
		this.settings = settings;

		// Tap chat.completions.create to forward streaming reasoning deltas.
		// The agents SDK silently accumulates `delta.reasoning` into a single
		// reasoning_item emitted post-stream; we intercept the raw chunks so
		// the UI can render the thinking block as it arrives.
		const completions = openaiClient.chat.completions;
		const originalCreate = completions.create.bind(completions);
		const getReasoningCb = () => this.currentReasoningDeltaCb;
		(completions as unknown as { create: (...args: unknown[]) => unknown }).create = function (...args: unknown[]) {
			const result = originalCreate(...(args as Parameters<typeof originalCreate>));
			const params = args[0] as { stream?: boolean } | undefined;
			if (!params?.stream) return result;
			return (result as Promise<AsyncIterable<unknown>>).then(stream => tapReasoningStream(stream, getReasoningCb));
		};

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

	setHistory(history: AgentInputItem[]): void {
		this.history = [...history];
	}

	getHistory(): AgentInputItem[] {
		return [...this.history];
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

		this.currentReasoningDeltaCb = callbacks.onReasoningDelta ?? null;

		try {
			const stream = await run(this.agent, turnInput, { stream: true, signal, maxTurns: this.settings.maxTurns });

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
					if (item.type === 'reasoning_item') {
						const raw = item.rawItem as { rawContent?: Array<{ text: string }>; content?: Array<{ text: string }> };
						const text = (raw.rawContent ?? raw.content ?? []).map(c => c.text).join('');
						if (text) callbacks.onReasoningItem?.(text);
					} else if (item.type === 'tool_call_item') {
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

			this.history = stream.history;

			return assistantText;
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			callbacks.onError?.(e);
			throw e;
		} finally {
			this.currentReasoningDeltaCb = null;
		}
	}
}
