import { tool } from '@openai/agents';
import { z } from 'zod';
import type { VaultAdapter } from '../../vault/VaultAdapter';

export function buildReadOnlyTools(vault: VaultAdapter) {
	const readNote = tool({
		name: 'read_note',
		description: 'Read the full content of a note in the vault by its path. Use when you need the actual text of a note.',
		parameters: z.object({
			path: z.string().describe('The vault-relative path to the note, e.g. "Daily/2026-05-07.md".')
		}),
		execute: async ({ path }) => {
			try {
				const { content, lines } = await vault.readNote(path);
				return JSON.stringify({ path, lines, content });
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	});

	const outlineNote = tool({
		name: 'outline_note',
		description: 'Get the heading outline of a note (level, text, line number). Cheap way to understand a note before reading it fully.',
		parameters: z.object({
			path: z.string().describe('The vault-relative path to the note.')
		}),
		execute: async ({ path }) => {
			try {
				const headings = await vault.getHeadings(path);
				return JSON.stringify({ path, headings });
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	});

	const searchVault = tool({
		name: 'search_vault',
		description: 'Search the vault for notes matching a query. Returns a list of paths with snippets.',
		parameters: z.object({
			query: z.string().describe('The search query. Plain text or Obsidian search syntax.'),
			limit: z.number().int().min(1).max(50).default(10).describe('Max number of results to return.')
		}),
		execute: async ({ query, limit }) => {
			try {
				const hits = await vault.searchVault(query, limit);
				return JSON.stringify({ query, hits });
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	});

	const listFiles = tool({
		name: 'list_files',
		description: 'List markdown files in a folder of the vault, sorted by most-recently-modified first. Pass an empty string to list the vault root.',
		parameters: z.object({
			folder: z.string().default('').describe('The vault-relative folder path. Empty string means the vault root.')
		}),
		execute: async ({ folder }) => {
			try {
				const files = await vault.listFiles(folder);
				return JSON.stringify({ folder, files });
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	});

	return [readNote, outlineNote, searchVault, listFiles];
}
