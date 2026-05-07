export interface WebSearchHit {
	url: string;
	title: string;
	snippet: string;
	score?: number;
	publishedDate?: string;
}

export interface WebFetchResult {
	url: string;
	title?: string;
	content: string;
	contentType: 'markdown' | 'text';
}

export interface WebSearchOptions {
	query: string;
	limit?: number;
	signal?: AbortSignal;
}

export interface WebFetchOptions {
	url: string;
	signal?: AbortSignal;
}

export interface WebSearchProvider {
	readonly name: string;
	search(opts: WebSearchOptions): Promise<WebSearchHit[]>;
	fetch(opts: WebFetchOptions): Promise<WebFetchResult>;
}
