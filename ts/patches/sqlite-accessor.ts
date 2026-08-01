import Database from "better-sqlite3";
import * as path from "path";

const dbPath = path.resolve(process.env.OPENCLAW_REGISTRY_PATH || "./registry.db");
const db = new Database(dbPath);

// Enable Write-Ahead Logging (WAL) and busy timeout to prevent production SQLite lock deadlocks
try {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
} catch {
  // Ignore pragma errors if unsupported
}

// Initialize DB schema
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sessionKey TEXT PRIMARY KEY,
    sessionId TEXT,
    status TEXT,
    model TEXT,
    spawnedBy TEXT,
    spawnDepth INTEGER DEFAULT 0,
    isSubagent INTEGER DEFAULT 0,
    startedAtMs INTEGER,
    endedAtMs INTEGER,
    runtimeMs INTEGER,
    aborted INTEGER DEFAULT 0,
    raw TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_spawnedBy ON sessions(spawnedBy);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

  -- Automatic migration: rewrite legacy direct anthropic channel overrides to openrouter/
  UPDATE sessions 
  SET model = 'openrouter/' || model 
  WHERE model LIKE 'anthropic/%' AND model NOT LIKE 'openrouter/%';
`);

export interface SqliteRecord {
  sessionKey: string;
  sessionId?: string | null;
  status: string;
  model?: string | null;
  spawnedBy?: string | null;
  spawnDepth?: number;
  isSubagent?: number;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  runtimeMs?: number | null;
  aborted?: number;
  raw?: any;
}

export function sanitizeModelString(model?: string | null): string | null {
  if (!model) return null;
  if (model.startsWith("anthropic/") && !model.startsWith("openrouter/")) {
    return `openrouter/${model}`;
  }
  return model;
}

export function getSession(sessionKey: string): SqliteRecord | null {
  const row = db.prepare("SELECT * FROM sessions WHERE sessionKey = ?").get(sessionKey) as any;
  if (!row) return null;
  return {
    ...row,
    model: sanitizeModelString(row.model),
    raw: row.raw ? JSON.parse(row.raw) : {}
  };
}

export function saveSession(record: SqliteRecord): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sessions 
    (sessionKey, sessionId, status, model, spawnedBy, spawnDepth, isSubagent, startedAtMs, endedAtMs, runtimeMs, aborted, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.sessionKey,
    record.sessionId || null,
    record.status,
    sanitizeModelString(record.model),
    record.spawnedBy || null,
    record.spawnDepth || 0,
    record.isSubagent ? 1 : 0,
    record.startedAtMs || null,
    record.endedAtMs || null,
    record.runtimeMs || null,
    record.aborted ? 1 : 0,
    JSON.stringify(record.raw || {})
  );
}

export function deleteSession(sessionKey: string): boolean {
  const info = db.prepare("DELETE FROM sessions WHERE sessionKey = ?").run(sessionKey);
  return info.changes > 0;
}

export function countActiveSessions(): number {
  const res = db.prepare(`
    SELECT COUNT(*) as count FROM sessions 
    WHERE status IN ('running', 'processing', 'created', 'dispatched')
  `).get() as { count: number };
  return res.count;
}

export function countChildren(parentKey: string): number {
  const res = db.prepare(`
    SELECT COUNT(*) as count FROM sessions 
    WHERE spawnedBy = ? AND isSubagent = 1 AND status IN ('running', 'processing', 'created', 'dispatched')
  `).get(parentKey) as { count: number };
  return res.count;
}

export function getTimedOut(timeoutSeconds: number): string[] {
  const now = Date.now();
  const threshold = now - (timeoutSeconds * 1000);
  const rows = db.prepare(`
    SELECT sessionKey FROM sessions 
    WHERE isSubagent = 1 AND status = 'running' AND startedAtMs IS NOT NULL AND startedAtMs < ?
  `).all(threshold) as Array<{ sessionKey: string }>;
  return rows.map(r => r.sessionKey);
}

export function clearRegistry(): void {
  db.prepare("DELETE FROM sessions").run();
}
