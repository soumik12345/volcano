import { tool } from '@openai/agents';
import { z } from 'zod';
import type { WebSearchProvider } from '../web';

const MAX_FETCH_CHARS = 30_000;

export function buildWebTools(provider: WebSearchProvider) {
	const webSearch = tool({
		name: 'web_search',
		description: 'Search the public web for a query. Returns a list of hits with url, title, and snippet. Use before web_fetch to discover sources.',
		parameters: z.object({
			query: z.string().describe('The search query.'),
			limit: z.number().int().min(1).max(10).default(5).describe('Max number of results.')
		}),
		execute: async ({ query, limit }) => {
			try {
				const hits = await provider.search({ query, limit });
				return JSON.stringify({ query, hits });
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	});

	const webFetch = tool({
		name: 'web_fetch',
		description: 'Fetch the contents of a URL and return it as clean markdown. Use after web_search to read a specific page. The content is truncated if very long; ask for a specific section if you need more.',
		parameters: z.object({
			url: z.string().url().describe('The fully-qualified URL to fetch.')
		}),
		execute: async ({ url }) => {
			try {
				const result = await provider.fetch({ url });
				const truncated = result.content.length > MAX_FETCH_CHARS;
				const body = truncated ? result.content.slice(0, MAX_FETCH_CHARS) : result.content;
				return JSON.stringify({
					url: result.url,
					title: result.title,
					contentType: result.contentType,
					truncated,
					content: body
				});
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	});

	return [webSearch, webFetch];
}
