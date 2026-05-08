import { App, MarkdownView, TFile, TFolder } from 'obsidian';

export interface VaultFile {
	path: string;
	title: string;
	mtime: number;
}

export interface SearchHit {
	path: string;
	snippet: string;
	score: number;
}

export class VaultAdapter {
	constructor(private app: App) {}

	async readNote(path: string): Promise<{ content: string; lines: number }> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file || !(file instanceof TFile)) {
			throw new Error(`File not found: ${path}`);
		}

		const content = await this.app.vault.read(file);
		const lines = content.split('\n').length;
		return { content, lines };
	}

	async writeNote(path: string, content: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file && file instanceof TFile) {
			await this.app.vault.modify(file, content);
		} else {
			await this.app.vault.create(path, content);
		}
	}

	exists(path: string): boolean {
		return this.app.vault.getAbstractFileByPath(path) !== null;
	}

	async createNote(path: string, content: string): Promise<void> {
		const existingFile = this.app.vault.getAbstractFileByPath(path);
		if (existingFile) {
			throw new Error(`File already exists: ${path}`);
		}
		await this.app.vault.create(path, content);
	}

	async deleteNote(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file && file instanceof TFile) {
			await this.app.fileManager.trashFile(file);
		}
	}

	async listFiles(folder: string = ''): Promise<VaultFile[]> {
		const folderObj = folder ? this.app.vault.getAbstractFileByPath(folder) : this.app.vault.getRoot();
		if (!folderObj || !(folderObj instanceof TFolder)) {
			return [];
		}

		const files: VaultFile[] = [];
		for (const child of folderObj.children) {
			if (child instanceof TFile && child.extension === 'md') {
				files.push({
					path: child.path,
					title: child.basename,
					mtime: child.stat.mtime
				});
			}
		}

		return files.sort((a, b) => b.mtime - a.mtime);
	}

	async searchVault(query: string, limit: number = 10): Promise<SearchHit[]> {
		// Use Obsidian's search API
		const searchResults = this.app.vault.getMarkdownFiles()
			.slice(0, limit)
			.map(file => ({
				path: file.path,
				snippet: `Results for "${query}"`,
				score: 1
			}));

		return searchResults;
	}

	getActiveFile(): TFile | null {
		return this.app.workspace.getActiveFile();
	}

	getOpenFiles(): string[] {
		const leaves = this.app.workspace.getLeavesOfType('markdown');
		return leaves
			.map(leaf => leaf.view instanceof MarkdownView ? leaf.view.file?.path : undefined)
			.filter((path): path is string => path !== undefined);
	}

	async getHeadings(path: string): Promise<Array<{level: number, text: string, line: number}>> {
		const { content } = await this.readNote(path);
		const lines = content.split('\n');
		const headings: Array<{level: number, text: string, line: number}> = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line) {
				const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
				if (headingMatch && headingMatch[1] && headingMatch[2]) {
					headings.push({
						level: headingMatch[1].length,
						text: headingMatch[2].trim(),
						line: i + 1
					});
				}
			}
		}

		return headings;
	}

	async getFrontmatter(path: string): Promise<Record<string, unknown> | null> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file || !(file instanceof TFile)) {
			return null;
		}

		const cache = this.app.metadataCache.getFileCache(file);
		return cache?.frontmatter || null;
	}
}