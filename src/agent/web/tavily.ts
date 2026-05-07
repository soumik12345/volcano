import { requestUrl } from 'obsidian';
import type {
	WebFetchOptions,
	WebFetchResult,
	WebSearchHit,
	WebSearchOptions,
	WebSearchProvider
} from './types';

const TAVILY_BASE_URL = 'https://api.tavily.com';

interface TavilySearchResult {
	url: string;
	title: string;
	content: string;
	score?: number;
	published_date?: string;
}

interface TavilySearchResponse {
	results?: TavilySearchResult[];
	answer?: string;
}

interface TavilyExtractResult {
	url: string;
	raw_content?: string;
	content?: string;
}

interface TavilyExtractResponse {
	results?: TavilyExtractResult[];
	failed_results?: Array<{ url: string; error?: string }>;
}

export class TavilyProvider implements WebSearchProvider {
	readonly name = 'tavily';

	constructor(private apiKey: string) {}

	async search({ query, limit = 5 }: WebSearchOptions): Promise<WebSearchHit[]> {
		if (!this.apiKey) throw new Error('Tavily API key not configured.');

		const res = await requestUrl({
			url: `${TAVILY_BASE_URL}/search`,
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify({
				api_key: this.apiKey,
				query,
				max_results: limit,
				search_depth: 'basic',
				include_answer: false
			}),
			throw: false
		});

		if (res.status >= 400) {
			throw new Error(`Tavily search failed (${res.status}): ${res.text.slice(0, 200)}`);
		}

		const data = res.json as TavilySearchResponse;
		return (data.results ?? []).map((r) => ({
			url: r.url,
			title: r.title,
			snippet: r.content,
			score: r.score,
			publishedDate: r.published_date
		}));
	}

	async fetch({ url }: WebFetchOptions): Promise<WebFetchResult> {
		if (!this.apiKey) throw new Error('Tavily API key not configured.');

		const res = await requestUrl({
			url: `${TAVILY_BASE_URL}/extract`,
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify({
				api_key: this.apiKey,
				urls: [url],
				format: 'markdown'
			}),
			throw: false
		});

		if (res.status >= 400) {
			throw new Error(`Tavily extract failed (${res.status}): ${res.text.slice(0, 200)}`);
		}

		const data = res.json as TavilyExtractResponse;
		const first = data.results?.[0];
		if (!first) {
			const failure = data.failed_results?.[0];
			throw new Error(`Tavily could not extract ${url}: ${failure?.error ?? 'no content returned'}`);
		}

		const body = first.raw_content ?? first.content ?? '';
		return {
			url: first.url ?? url,
			content: body,
			contentType: 'markdown'
		};
	}
}
