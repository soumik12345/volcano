/**
 * Citation helpers — pure functions that transform note content to add web sources
 * to the YAML frontmatter and matching footnote definitions at the end of the body.
 *
 * Used by web tools and (in Phase 4) the propose_edit write tool. None of these
 * functions touch the vault directly.
 *
 * Limitations:
 * - Frontmatter parsing only understands the `sources:` key (other keys are
 *   preserved verbatim).
 * - `sources:` is always re-serialized in inline JSON-array form for round-trip
 *   stability.
 */

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface ParsedFrontmatter {
	/** The frontmatter body between the `---` fences, or null if no frontmatter present. */
	fm: string | null;
	/** The note body (everything after the closing `---`). */
	body: string;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
	const match = content.match(FRONTMATTER_RE);
	if (!match) return { fm: null, body: content };
	return { fm: match[1] ?? '', body: content.slice(match[0].length) };
}

export function serialize(fm: string | null, body: string): string {
	if (fm === null || fm.trim() === '') return body;
	return `---\n${fm}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}

/**
 * Extract URLs from a `sources:` entry. Handles both inline (`sources: [a, b]`)
 * and block (`sources:\n  - a\n  - b`) forms.
 */
export function extractSources(fm: string): string[] {
	const inline = fm.match(/^sources:\s*\[([^\]]*)\]\s*$/m);
	if (inline) {
		return splitInline(inline[1] ?? '');
	}

	const block = fm.match(/^sources:\s*\r?\n((?:[ \t]+-[^\n]*\r?\n?)+)/m);
	if (block) {
		return (block[1] ?? '')
			.split(/\r?\n/)
			.map((l) => l.replace(/^[ \t]+-\s*/, '').trim())
			.map(stripQuotes)
			.filter(Boolean);
	}

	return [];
}

function splitInline(inner: string): string[] {
	return inner
		.split(',')
		.map((s) => stripQuotes(s.trim()))
		.filter(Boolean);
}

function stripQuotes(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1);
	}
	return s;
}

/**
 * Replace or insert a `sources:` line in the frontmatter block, always as
 * inline JSON-array form. If the block currently has no `sources:` key, it is
 * appended.
 */
export function setSources(fm: string, sources: string[]): string {
	const serialized = `sources: ${JSON.stringify(sources)}`;
	const inline = /^sources:\s*\[[^\]]*\]\s*$/m;
	const block = /^sources:\s*\r?\n(?:[ \t]+-[^\n]*\r?\n?)+/m;

	if (inline.test(fm)) return fm.replace(inline, serialized);
	if (block.test(fm)) return fm.replace(block, serialized + '\n').trimEnd();

	return fm.trim() === '' ? serialized : `${fm.trimEnd()}\n${serialized}`;
}

/**
 * Add a list of source URLs to the note's frontmatter, deduping against any
 * existing entries. Creates frontmatter if the note has none.
 */
export function mergeSources(content: string, newSources: string[]): string {
	const cleaned = newSources.map((s) => s.trim()).filter(Boolean);
	if (cleaned.length === 0) return content;

	const { fm, body } = parseFrontmatter(content);
	const existing = fm ? extractSources(fm) : [];
	const merged = dedupePreservingOrder([...existing, ...cleaned]);

	const newFm = setSources(fm ?? '', merged);
	return serialize(newFm, body);
}

function dedupePreservingOrder<T>(xs: T[]): T[] {
	const seen = new Set<T>();
	const out: T[] = [];
	for (const x of xs) {
		if (!seen.has(x)) {
			seen.add(x);
			out.push(x);
		}
	}
	return out;
}

/**
 * Find the next free footnote id (numeric) in the note body. Scans existing
 * `[^N]` references and returns the smallest unused positive integer as a string.
 */
export function nextFootnoteId(content: string): string {
	const used = new Set<number>();
	for (const m of content.matchAll(/\[\^(\d+)\]/g)) {
		const n = Number(m[1]);
		if (Number.isFinite(n)) used.add(n);
	}
	let i = 1;
	while (used.has(i)) i++;
	return String(i);
}

/**
 * Append a footnote definition to the end of the note body. Adds a blank line
 * before the definition if the body doesn't already end in two newlines.
 */
export function appendFootnoteDef(content: string, id: string, text: string): string {
	const trailing = /\n\n$/.test(content) ? '' : content.endsWith('\n') ? '\n' : '\n\n';
	return `${content}${trailing}[^${id}]: ${text}\n`;
}

export interface CitationSource {
	url: string;
	title?: string;
}

export interface CitationResult {
	/** The updated full note content (frontmatter + body + footnote def). */
	content: string;
	/** The footnote id (without brackets) the caller should insert inline. */
	id: string;
	/** A ready-to-insert reference marker like `[^3]`. */
	marker: string;
}

/**
 * High-level helper: register a web source on a note. Adds the URL to the
 * frontmatter `sources:` array (deduped), appends a footnote definition with
 * the title and URL, and returns an inline marker the caller can paste into
 * the body where the citation belongs.
 */
export function addCitation(content: string, source: CitationSource): CitationResult {
	const withSource = mergeSources(content, [source.url]);
	const id = nextFootnoteId(withSource);
	const label = source.title ? `${source.title} — ${source.url}` : source.url;
	const updated = appendFootnoteDef(withSource, id, label);
	return { content: updated, id, marker: `[^${id}]` };
}
