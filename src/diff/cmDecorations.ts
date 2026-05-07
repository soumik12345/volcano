import { StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { Hunk, StagedDiff } from './DiffEngine';

/** Dispatch this effect on an EditorView to install or clear the diff overlay. */
export const setVolcanoDiff = StateEffect.define<StagedDiff | null>();

class AddedBlockWidget extends WidgetType {
	constructor(private text: string) {
		super();
	}

	toDOM(): HTMLElement {
		const el = document.createElement('div');
		el.className = 'volcano-diff-added';
		const lines = this.text.replace(/\n$/, '').split('\n');
		for (const line of lines) {
			const lineEl = document.createElement('div');
			lineEl.className = 'volcano-diff-added-line';
			lineEl.textContent = line.length === 0 ? ' ' : line;
			el.appendChild(lineEl);
		}
		return el;
	}

	eq(other: WidgetType): boolean {
		return other instanceof AddedBlockWidget && other.text === this.text;
	}
}

const removedLineDecoration = Decoration.line({ class: 'volcano-diff-removed' });

function anchorForHunk(state: EditorState, hunk: Hunk): number {
	const doc = state.doc;
	if (hunk.oldLines > 0) {
		const lastRemoved = Math.min(hunk.oldStart + hunk.oldLines - 1, doc.lines);
		return doc.line(lastRemoved).to;
	}
	if (hunk.oldStart > doc.lines) return doc.length;
	const line = doc.line(Math.max(1, hunk.oldStart));
	return line.from === 0 ? 0 : line.from - 1;
}

function buildDecorations(state: EditorState, diff: StagedDiff | null): DecorationSet {
	if (!diff || diff.status !== 'pending') return Decoration.none;

	const doc = state.doc;
	const ranges: Array<{ from: number; to: number; deco: Decoration }> = [];

	for (const hunk of diff.hunks) {
		for (let i = 0; i < hunk.oldLines; i++) {
			const lineNo = hunk.oldStart + i;
			if (lineNo < 1 || lineNo > doc.lines) continue;
			const line = doc.line(lineNo);
			ranges.push({ from: line.from, to: line.from, deco: removedLineDecoration });
		}

		if (hunk.newText.length > 0) {
			const widget = Decoration.widget({
				widget: new AddedBlockWidget(hunk.newText),
				block: true,
				side: 1
			});
			const anchor = anchorForHunk(state, hunk);
			ranges.push({ from: anchor, to: anchor, deco: widget });
		}
	}

	ranges.sort((a, b) => a.from - b.from || a.to - b.to);
	return Decoration.set(ranges.map((r) => r.deco.range(r.from, r.to)));
}

interface VolcanoDiffState {
	diff: StagedDiff | null;
	decorations: DecorationSet;
}

const volcanoDiffField = StateField.define<VolcanoDiffState>({
	create: () => ({ diff: null, decorations: Decoration.none }),
	update(value, tr) {
		let diff = value.diff;
		let changed = false;
		for (const e of tr.effects) {
			if (e.is(setVolcanoDiff)) {
				diff = e.value;
				changed = true;
			}
		}
		if (changed || tr.docChanged) {
			return { diff, decorations: buildDecorations(tr.state, diff) };
		}
		return value;
	},
	provide: (f) => EditorView.decorations.from(f, (v) => v.decorations)
});

export const volcanoDiffExtension = [volcanoDiffField];

/** Convenience helper: install or clear the diff overlay on a CM editor. */
export function applyDiffToEditor(view: EditorView, diff: StagedDiff | null): void {
	view.dispatch({ effects: setVolcanoDiff.of(diff) });
}
