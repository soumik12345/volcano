/* eslint-disable import/no-nodejs-modules, no-undef, no-restricted-globals -- Node.js https/http and Buffer are intentional: this file bypasses Electron's renderer fetch to fix Authorization header stripping. See makeNodeFetch. */
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
import { jsonrepair } from 'jsonrepair';
import type { RequestOptions } from 'https';
import type { IncomingMessage } from 'http';

setTracingDisabled(true);

// Electron's renderer fetch can silently drop the Authorization header for cross-origin requests.
// Node.js built-ins are externalized by esbuild and available in Obsidian's Electron renderer
// (nodeIntegration is enabled), so we use https.request() which bypasses all browser-level
// CORS and header-stripping behaviour entirely.
function makeNodeFetch(apiKey: string): typeof fetch {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const httpsModule = (typeof require !== 'undefined' ? require('https') : null) as {
		request: (opts: RequestOptions, cb: (res: IncomingMessage) => void) => {
			on: (ev: string, cb: (e: Error) => void) => void;
			write: (b: string) => void;
			destroy: (e?: Error) => void;
			end: () => void;
		};
	} | null;

	console.error('[Volcano] makeNodeFetch — httpsModule available:', !!httpsModule, '| apiKey prefix:', apiKey.slice(0, 8));

	if (!httpsModule) {
		// Fallback: renderer fetch (may fail auth in some Electron builds)
		return (input, init) => {
			const headers = new Headers(init?.headers);
			headers.set('Authorization', `Bearer ${apiKey}`);
			return fetch(input, { ...init, headers });
		};
	}

	return (input, init): Promise<Response> => {
		return new Promise((resolve, reject) => {
			const url = new URL(typeof input === 'string' ? input : (input as Request).url);
			const reqHeaders: Record<string, string> = {};

			if (init?.headers instanceof Headers) {
				init.headers.forEach((v, k) => { reqHeaders[k] = v; });
			} else if (init?.headers) {
				new Headers(init.headers as HeadersInit).forEach((v, k) => { reqHeaders[k] = v; });
			}
			// Force Authorization regardless of what the SDK built
			reqHeaders['authorization'] = `Bearer ${apiKey}`;

			console.error(
				'[Volcano] Node.js fetch →', url.hostname + url.pathname,
				'| method:', init?.method,
				'| apiKey prefix:', apiKey.slice(0, 8),
				'| auth header present:', !!reqHeaders['authorization'],
				'| body type:', typeof init?.body,
			);

			const body = typeof init?.body === 'string' ? init.body : undefined;
			const signal = init?.signal;
			let done = false;

			const req = httpsModule.request(
				{
					hostname: url.hostname,
					port: Number(url.port) || 443,
					path: url.pathname + url.search,
					method: (init?.method ?? 'GET').toUpperCase(),
					headers: reqHeaders,
				},
				(res) => {
					const status = res.statusCode ?? 200;
					console.error('[Volcano] Node.js response ← status:', status);
					const resHeaders = new Headers();
					for (const [k, v] of Object.entries(res.headers)) {
						if (typeof v === 'string') resHeaders.append(k, v);
						else if (Array.isArray(v)) v.forEach(h => resHeaders.append(k, h));
					}

					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							res.on('data', (chunk: Buffer) => {
								if (!done) controller.enqueue(new Uint8Array(chunk));
							});
							res.on('end', () => {
								if (!done) { done = true; controller.close(); }
							});
							res.on('error', (err: Error) => {
								if (!done) { done = true; controller.error(err); }
							});
						},
						cancel() { done = true; req.destroy(); },
					});

					resolve(new Response(stream, { status, headers: resHeaders }));
				}
			);

			req.on('error', (err: Error) => { if (!done) { done = true; reject(err); } });

			if (signal) {
				signal.addEventListener('abort', () => {
					if (!done) { done = true; req.destroy(new Error('Aborted')); }
				}, { once: true });
			}

			if (body) req.write(body);
			req.end();
		});
	};
}

// Some providers (notably Gemini via its OpenAI-compatibility layer) emit malformed JSON
// in `delta.tool_calls[].function.arguments` — e.g. unescaped newlines inside strings.
// The agents SDK then throws InvalidToolInputError. We buffer the per-tool-call argument
// fragments ourselves, blank them out on the chunks the SDK sees, and re-emit a single
// repaired-arguments delta before the finish_reason chunk arrives.
async function* tapToolCallArgs(stream: AsyncIterable<unknown>): AsyncIterable<unknown> {
	type Chunk = {
		choices?: Array<{
			delta?: { tool_calls?: Array<{ index?: number; function?: { arguments?: string } }> };
			finish_reason?: string | null;
		}>;
	};

	const buffers = new Map<number, string>();

	const emitRepaired = (): unknown[] => {
		const out: unknown[] = [];
		for (const [idx, full] of buffers) {
			const repaired = repairJson(full);
			out.push({
				choices: [{
					index: 0,
					delta: { tool_calls: [{ index: idx, function: { arguments: repaired } }] },
					finish_reason: null,
				}],
			});
		}
		buffers.clear();
		return out;
	};

	for await (const raw of stream) {
		const chunk = raw as Chunk;
		const choice = chunk.choices?.[0];
		const tcs = choice?.delta?.tool_calls;
		if (tcs?.length) {
			for (const tc of tcs) {
				const frag = tc.function?.arguments;
				if (typeof frag === 'string' && frag.length) {
					const idx = tc.index ?? 0;
					buffers.set(idx, (buffers.get(idx) ?? '') + frag);
					if (tc.function) tc.function.arguments = '';
				}
			}
		}

		if (choice?.finish_reason === 'tool_calls' && buffers.size) {
			for (const repaired of emitRepaired()) yield repaired;
		}

		yield raw;
	}

	for (const repaired of emitRepaired()) yield repaired;
}

function repairJson(s: string): string {
	try { JSON.parse(s); return s; } catch { /* fall through */ }
	try {
		const fixed = jsonrepair(s);
		JSON.parse(fixed);
		return fixed;
	} catch {
		return s;
	}
}

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
			fetch: makeNodeFetch(apiKey),
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
			return (result as Promise<AsyncIterable<unknown>>).then(stream => tapReasoningStream(tapToolCallArgs(stream), getReasoningCb));
		};

		setDefaultOpenAIClient(openaiClient);

		const tools: Tool[] = [
			...buildReadOnlyTools(vault),
			...buildWriteTools(vault, diffEngine)
		];
		const webProvider = createWebSearchProvider(settings);
		if (webProvider) tools.push(...buildWebTools(webProvider));

		const instructions = webProvider
			? VOLCANO_SYSTEM_PROMPT
			: VOLCANO_SYSTEM_PROMPT
				.replace(/Web tools \(only available[\s\S]*?web_fetch:[^\n]*\n/, '')
				.replace(/- For factual claims about the world,[^\n]*\n/, '');

		this.agent = new Agent({
			name: 'Volcano',
			instructions,
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
