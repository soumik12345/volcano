import type { VolcanoSettings } from '../../settings';
import { TavilyProvider } from './tavily';
import type { WebSearchProvider } from './types';

export type { WebSearchProvider, WebSearchHit, WebFetchResult } from './types';

export function createWebSearchProvider(settings: VolcanoSettings): WebSearchProvider | null {
	if (!settings.webSearchApiKey?.trim()) return null;
	switch (settings.webSearchProvider) {
		case 'tavily':
			return new TavilyProvider(settings.webSearchApiKey);
		default:
			return null;
	}
}
