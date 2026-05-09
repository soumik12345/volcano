import { normalizePath, type App } from 'obsidian';
import initSqlJs from 'sql.js';
import type { AgentInputItem } from '@openai/agents';
import type { StoredSession, StoredMessage } from './types';

type SqlDatabase = Awaited<ReturnType<typeof initSqlJs>>['Database']['prototype'];

export class SessionStore {
  private db: SqlDatabase;
  private app: App;
  private dbPath: string;

  private constructor(db: SqlDatabase, app: App, dbPath: string) {
    this.db = db;
    this.app = app;
    this.dbPath = dbPath;
  }

  static async load(app: App, sqlWasmBase64: string): Promise<SessionStore> {
    const dbPath = normalizePath(`${app.vault.configDir}/plugins/volcano/sessions.db`);

    // Decode the base64-embedded WASM (bundled by esbuild — works with BRAT installs
    // which only deliver main.js and therefore never have sql-wasm.wasm on disk).
    const binaryStr = atob(sqlWasmBase64);
    const wasmBytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) wasmBytes[i] = binaryStr.charCodeAt(i);
    const SQL = await initSqlJs({ wasmBinary: wasmBytes.buffer });

    let db: SqlDatabase;
    if (await app.vault.adapter.exists(dbPath)) {
      const data = await app.vault.adapter.readBinary(dbPath);
      db = new SQL.Database(new Uint8Array(data));
    } else {
      db = new SQL.Database();
    }

    const store = new SessionStore(db, app, dbPath);
    store.initSchema();
    await store.flush();
    return store;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id           TEXT PRIMARY KEY,
        title        TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        history_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        role        TEXT NOT NULL,
        type        TEXT NOT NULL,
        content     TEXT NOT NULL,
        tool_name   TEXT,
        created_at  INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
    `);
  }

  private async flush(): Promise<void> {
    const data = this.db.export();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- TS narrows ArrayBufferLike to ArrayBuffer | SharedArrayBuffer; writeBinary requires ArrayBuffer
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    await this.app.vault.adapter.writeBinary(this.dbPath, buffer);
  }

  close(): void {
    this.db.close();
  }

  async createSession(): Promise<string> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const stmt = this.db.prepare(
      'INSERT INTO sessions (id, title, created_at, updated_at, history_json) VALUES (?, NULL, ?, ?, ?)'
    );
    stmt.run([id, now, now, '[]']);
    stmt.free();
    await this.flush();
    return id;
  }

  async appendMessage(sessionId: string, msg: StoredMessage): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT INTO messages (id, session_id, role, type, content, tool_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    stmt.run([msg.id, sessionId, msg.role, msg.type, msg.content, msg.tool_name ?? null, msg.created_at]);
    stmt.free();
    const upd = this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
    upd.run([Date.now(), sessionId]);
    upd.free();
    await this.flush();
  }

  async updateHistory(sessionId: string, history: AgentInputItem[]): Promise<void> {
    const stmt = this.db.prepare('UPDATE sessions SET history_json = ?, updated_at = ? WHERE id = ?');
    stmt.run([JSON.stringify(history), Date.now(), sessionId]);
    stmt.free();
    await this.flush();
  }

  async updateTitle(sessionId: string, title: string): Promise<void> {
    const stmt = this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?');
    stmt.run([title, sessionId]);
    stmt.free();
    await this.flush();
  }

  async deleteSession(id: string): Promise<void> {
    const d1 = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
    d1.run([id]);
    d1.free();
    const d2 = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    d2.run([id]);
    d2.free();
    await this.flush();
  }

  private static rowToSession(row: Record<string, unknown>): StoredSession {
    return {
      id: row['id'] as string,
      title: (row['title'] as string | null) ?? null,
      created_at: row['created_at'] as number,
      updated_at: row['updated_at'] as number,
      history_json: (row['history_json'] as string) ?? '[]',
      message_count: (row['message_count'] as number) ?? 0,
    };
  }

  private static rowToMessage(row: Record<string, unknown>): StoredMessage {
    return {
      id: row['id'] as string,
      session_id: row['session_id'] as string,
      role: row['role'] as StoredMessage['role'],
      type: row['type'] as StoredMessage['type'],
      content: row['content'] as string,
      tool_name: (row['tool_name'] as string | null) ?? null,
      created_at: row['created_at'] as number,
    };
  }

  listSessions(limit = 50): StoredSession[] {
    const stmt = this.db.prepare(`
      SELECT s.id, s.title, s.created_at, s.updated_at, s.history_json,
             COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id
      GROUP BY s.id
      ORDER BY s.updated_at DESC
      LIMIT ?
    `);
    stmt.bind([limit]);
    const rows: StoredSession[] = [];
    while (stmt.step()) {
      rows.push(SessionStore.rowToSession(stmt.getAsObject() as Record<string, unknown>));
    }
    stmt.free();
    return rows;
  }

  loadSession(id: string): { session: StoredSession; messages: StoredMessage[] } | null {
    const ss = this.db.prepare(
      'SELECT id, title, created_at, updated_at, history_json, 0 as message_count FROM sessions WHERE id = ?'
    );
    const sessionObj = ss.getAsObject([id]);
    ss.free();
    if (sessionObj['id'] == null) return null;

    const ms = this.db.prepare(
      'SELECT id, session_id, role, type, content, tool_name, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC'
    );
    ms.bind([id]);
    const messages: StoredMessage[] = [];
    while (ms.step()) {
      messages.push(SessionStore.rowToMessage(ms.getAsObject() as Record<string, unknown>));
    }
    ms.free();

    return {
      session: SessionStore.rowToSession(sessionObj as Record<string, unknown>),
      messages
    };
  }
}
