import { diffLines } from 'diff';
import type { VaultAdapter } from '../vault/VaultAdapter';

export type HunkStatus = 'pending' | 'accepted' | 'rejected';
export type DiffStatus = 'pending' | 'applied' | 'rejected' | 'conflicted';

export interface Hunk {
	id: string;
	/** 1-based line in the base content where the removed block starts. */
	oldStart: number;
	oldLines: number;
	/** 1-based line in the proposed content where the added block starts. */
	newStart: number;
	newLines: number;
	/** The removed text, including trailing newlines. Empty for pure insertions. */
	oldText: string;
	/** The added text, including trailing newlines. Empty for pure deletions. */
	newText: string;
	status: HunkStatus;
}

export interface StagedDiff {
	id: string;
	notePath: string;
	/** Snapshot of the note content at the time the diff was staged. */
	baseContent: string;
	/** The full file content the agent is proposing. */
	proposedContent: string;
	hunks: Hunk[];
	status: DiffStatus;
	/** True for create_note proposals (note did not exist when staged). */
	isCreate: boolean;
	/** When the agent staged the diff. */
	createdAt: number;
	/** Optional human-readable summary the tool can attach. */
	summary?: string;
}

export type DiffEngineEvent =
	| { type: 'staged'; diff: StagedDiff }
	| { type: 'updated'; diff: StagedDiff }
	| { type: 'removed'; diffId: string };

type Listener = (event: DiffEngineEvent) => void;

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export class DiffEngine {
	private diffs = new Map<string, StagedDiff>();
	private listeners = new Set<Listener>();

	constructor(private vault: VaultAdapter) {}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: DiffEngineEvent) {
		for (const l of this.listeners) l(event);
	}

	list(): StagedDiff[] {
		return Array.from(this.diffs.values()).sort((a, b) => a.createdAt - b.createdAt);
	}

	get(id: string): StagedDiff | undefined {
		return this.diffs.get(id);
	}

	getForPath(path: string): StagedDiff | undefined {
		return this.list().find((d) => d.notePath === path && d.status === 'pending');
	}

	stageEdit(path: string, baseContent: string, proposedContent: string, summary?: string): StagedDiff {
		const hunks = computeHunks(baseContent, proposedContent);
		const diff: StagedDiff = {
			id: nextId('diff'),
			notePath: path,
			baseContent,
			proposedContent,
			hunks,
			status: 'pending',
			isCreate: false,
			createdAt: Date.now(),
			summary
		};
		this.diffs.set(diff.id, diff);
		this.emit({ type: 'staged', diff });
		return diff;
	}

	stageCreate(path: string, content: string, summary?: string): StagedDiff {
		const hunks = computeHunks('', content);
		const diff: StagedDiff = {
			id: nextId('diff'),
			notePath: path,
			baseContent: '',
			proposedContent: content,
			hunks,
			status: 'pending',
			isCreate: true,
			createdAt: Date.now(),
			summary
		};
		this.diffs.set(diff.id, diff);
		this.emit({ type: 'staged', diff });
		return diff;
	}

	async accept(id: string): Promise<StagedDiff> {
		const diff = this.diffs.get(id);
		if (!diff) throw new Error(`No staged diff with id ${id}`);
		if (diff.status !== 'pending') return diff;

		if (diff.isCreate) {
			if (this.vault.exists(diff.notePath)) {
				diff.status = 'conflicted';
				this.emit({ type: 'updated', diff });
				throw new Error(`Cannot create ${diff.notePath}: a file already exists at that path.`);
			}
			await this.vault.createNote(diff.notePath, diff.proposedContent);
		} else {
			let current: string;
			try {
				current = (await this.vault.readNote(diff.notePath)).content;
			} catch (err) {
				diff.status = 'conflicted';
				this.emit({ type: 'updated', diff });
				throw err;
			}
			if (current !== diff.baseContent) {
				diff.status = 'conflicted';
				this.emit({ type: 'updated', diff });
				throw new Error(
					`Cannot apply diff: ${diff.notePath} has been modified since the proposal was staged.`
				);
			}
			await this.vault.writeNote(diff.notePath, diff.proposedContent);
		}

		for (const h of diff.hunks) h.status = 'accepted';
		diff.status = 'applied';
		this.emit({ type: 'updated', diff });
		return diff;
	}

	reject(id: string): void {
		const diff = this.diffs.get(id);
		if (!diff) return;
		if (diff.status === 'pending') {
			for (const h of diff.hunks) h.status = 'rejected';
			diff.status = 'rejected';
			this.emit({ type: 'updated', diff });
		}
		this.discard(id);
	}

	discard(id: string): void {
		if (this.diffs.delete(id)) {
			this.emit({ type: 'removed', diffId: id });
		}
	}
}

/**
 * Group consecutive added/removed `diffLines` changes into hunks, tracking
 * 1-based line numbers in both the base and proposed content.
 */
export function computeHunks(base: string, proposed: string): Hunk[] {
	const changes = diffLines(base, proposed);

	const hunks: Hunk[] = [];
	let oldLine = 1;
	let newLine = 1;
	let pending: { oldStart: number; newStart: number; oldText: string; newText: string } | null = null;

	const flush = () => {
		if (!pending) return;
		const oldLines = pending.oldText ? countLines(pending.oldText) : 0;
		const newLines = pending.newText ? countLines(pending.newText) : 0;
		hunks.push({
			id: nextId('hunk'),
			oldStart: pending.oldStart,
			oldLines,
			newStart: pending.newStart,
			newLines,
			oldText: pending.oldText,
			newText: pending.newText,
			status: 'pending'
		});
		pending = null;
	};

	for (const change of changes) {
		const lines = countLines(change.value);
		if (change.added) {
			pending ??= { oldStart: oldLine, newStart: newLine, oldText: '', newText: '' };
			pending.newText += change.value;
			newLine += lines;
		} else if (change.removed) {
			pending ??= { oldStart: oldLine, newStart: newLine, oldText: '', newText: '' };
			pending.oldText += change.value;
			oldLine += lines;
		} else {
			flush();
			oldLine += lines;
			newLine += lines;
		}
	}
	flush();

	return hunks;
}

function countLines(text: string): number {
	if (text === '') return 0;
	const matches = text.match(/\n/g);
	let n = matches ? matches.length : 0;
	if (!text.endsWith('\n')) n += 1;
	return n;
}
