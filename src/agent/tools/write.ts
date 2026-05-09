import { tool } from '@openai/agents';
import { z } from 'zod';
import type { DiffEngine } from '../../diff/DiffEngine';
import type { VaultAdapter } from '../../vault/VaultAdapter';

export function buildWriteTools(vault: VaultAdapter, diffEngine: DiffEngine) {
	const proposeEdit = tool({
		name: 'propose_edit',
		description: [
			'Propose an edit to an existing note as a unified diff for the user to review.',
			'The change is NOT applied immediately — it is staged in the pending-changes panel and the user will accept or reject it.',
			'Provide the exact `find` text (must match a substring of the current note verbatim, including whitespace) and the `replace` text.',
			'Special case: pass `find` as an empty string to replace the entire file content with `replace` (use this for empty files or whole-file rewrites).',
			'Prefer targeted changes; only do a whole-file rewrite when truly necessary.'
		].join(' '),
		parameters: z.object({
			path: z.string().describe('The vault-relative path to the note.'),
			find: z.string().describe('Exact substring of the current note content to replace. Pass an empty string to replace the entire file content.'),
			replace: z.string().describe('The text to substitute in place of `find` (or the entire new content when `find` is empty).'),
			summary: z.string().optional().describe('One-line description of the change for the pending panel.')
		}),
		execute: async ({ path, find, replace, summary }) => {
			try {
				const { content } = await vault.readNote(path);
				let proposed: string;
				if (find === '') {
					proposed = replace;
				} else {
					const idx = content.indexOf(find);
					if (idx < 0) {
						return JSON.stringify({
							error: `Could not find the \`find\` text in ${path}. Use read_note to inspect the current content and try again with an exact match, or pass an empty \`find\` to replace the whole file.`
						});
					}
					const lastIdx = content.lastIndexOf(find);
					if (lastIdx !== idx) {
						return JSON.stringify({
							error: `The \`find\` text appears more than once in ${path}. Provide a longer, unique snippet so the edit is unambiguous.`
						});
					}
					proposed = content.slice(0, idx) + replace + content.slice(idx + find.length);
				}
				if (proposed === content) {
					return JSON.stringify({ error: 'The proposed content is identical to the current content.' });
				}
				const diff = diffEngine.stageEdit(path, content, proposed, summary);
				return JSON.stringify({
					ok: true,
					diffId: diff.id,
					path: diff.notePath,
					hunks: diff.hunks.length,
					summary: diff.summary,
					note: 'Diff staged. The user will review it in the pending-changes panel and accept or reject it.'
				});
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	});

	const createNote = tool({
		name: 'create_note',
		description: [
			'Stage the creation of a new note. The file is NOT created immediately — the proposal goes into the pending-changes panel and the user will accept or reject it.',
			'Fails if a file already exists at the given path; use propose_edit on the existing file instead.'
		].join(' '),
		parameters: z.object({
			path: z.string().describe('The vault-relative path for the new note (must end in .md).'),
			content: z.string().describe('The full content of the new note, including any frontmatter.'),
			summary: z.string().optional().describe('One-line description of the note for the pending panel.')
		}),
		execute: async ({ path, content, summary }) => {
			try {
				if (vault.exists(path)) {
					return JSON.stringify({
						error: `A file already exists at ${path}. Use propose_edit to modify it instead.`
					});
				}
				const diff = diffEngine.stageCreate(path, content, summary);
				return JSON.stringify({
					ok: true,
					diffId: diff.id,
					path: diff.notePath,
					summary: diff.summary,
					note: 'Creation staged. The user will review and accept or reject it.'
				});
			} catch (err) {
				return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
			}
		}
	});

	return [proposeEdit, createNote];
}
