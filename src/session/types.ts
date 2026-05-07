import type { AgentInputItem } from '@openai/agents';

export interface StoredSession {
  id: string;
  title: string | null;
  created_at: number;     // unix ms
  updated_at: number;     // unix ms
  history_json: string;   // JSON.stringify(AgentInputItem[])
  message_count: number;  // populated by listSessions() COUNT query; always 0 from loadSession()
}

// Flat interface rather than discriminated union: sql.js getAsObject() returns
// Record<string, SqlValue> which cannot be safely narrowed after the cast.
// Invariant: tool_name is always null for role='user' and type='text'|'reasoning' rows.
export interface StoredMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  type: 'text' | 'reasoning' | 'tool_call' | 'tool_result';
  content: string;        // display text (markdown for text/reasoning, JSON args for tool_call)
  tool_name: string | null;
  created_at: number;     // unix ms — used to ORDER BY on restore
}

// Re-export AgentInputItem so callers don't need to import @openai/agents directly
export type { AgentInputItem };
