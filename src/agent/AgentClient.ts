import OpenAI from 'openai';
import type { VolcanoSettings } from '../settings';

export class AgentClient {
	private client: OpenAI;

	constructor(settings: VolcanoSettings) {
		this.client = new OpenAI({
			baseURL: settings.baseUrl,
			apiKey: settings.apiKey,
			dangerouslyAllowBrowser: true // Required for browser environments
		});
	}

	async createChatCompletion(messages: OpenAI.Chat.ChatCompletionMessageParam[]) {
		// Placeholder implementation - will be expanded in Phase 2
		return this.client.chat.completions.create({
			model: 'gpt-3.5-turbo',
			messages: messages,
			stream: false
		});
	}

	// More methods will be added in Phase 2 for streaming, tool calls, etc.
}