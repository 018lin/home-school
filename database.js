const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { Pool } = require("pg");

const SERIAL_TABLES = new Set(["users", "children", "bindings", "tasks", "submissions", "feedback", "questionnaires", "events", "parent_task_requests", "ai_vector_documents"]);

function replaceQuestionMarks(sql) {
  let index = 0;
  return String(sql).replace(/\?/g, function () { index += 1; return "$" + index; });
}

function normalizePostgresSql(sql) {
  const ignored = /INSERT\s+OR\s+IGNORE\s+INTO/i.test(String(sql));
  let text = String(sql)
    .replace(/datetime\('now','localtime'\)/gi, "(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')")
    .replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO");
  if (ignored && !/ON\s+CONFLICT/i.test(text)) text += " ON CONFLICT DO NOTHING";
  return replaceQuestionMarks(text);
}

function projectRowPromise(promise) {
  return new Proxy(promise, {
    get: function (target, property, receiver) {
      if (property === "then" || property === "catch" || property === "finally") {
        return target[property].bind(target);
      }
      if (property in target) return target[property];
      return target.then(function (row) { return row == null ? undefined : row[property]; });
    }
  });
}

function tableFromInsert(sql) {
  const match = String(sql).match(/^\s*INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+([a-z_]+)/i);
  return match ? match[1].toLowerCase() : "";
}

class Statement {
  constructor(database, sql) { this.database = database; this.sql = sql; }
  get(...params) {
    const promise = (async function () {
      if (!this.database.isPostgres) return this.database.raw.prepare(this.sql).get(...params) || undefined;
      const result = await this.database.pool.query(normalizePostgresSql(this.sql), params);
      return result.rows[0];
    }).call(this);
    return projectRowPromise(promise);
  }
  async all(...params) {
    if (!this.database.isPostgres) return this.database.raw.prepare(this.sql).all(...params);
    const result = await this.database.pool.query(normalizePostgresSql(this.sql), params);
    return result.rows;
  }
  run(...params) {
    const promise = (async function () {
      if (!this.database.isPostgres) return this.database.raw.prepare(this.sql).run(...params);
      const table = tableFromInsert(this.sql);
      let sql = normalizePostgresSql(this.sql);
      if (table && SERIAL_TABLES.has(table) && !/\bRETURNING\b/i.test(sql)) sql += " RETURNING id";
      const result = await this.database.pool.query(sql, params);
      return { changes: result.rowCount || 0, lastInsertRowid: result.rows[0] ? result.rows[0].id : undefined };
    }).call(this);
    promise.lastInsertRowid = promise.then(function (result) { return result && result.lastInsertRowid; });
    return promise;
  }
}

class DatabaseAdapter {
  constructor(options) {
    options = options || {};
    this.isPostgres = !!process.env.DATABASE_URL;
    if (this.isPostgres) {
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: Number(process.env.DB_POOL_MAX) || 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        ssl: /sslmode=require|neon\.tech/i.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined
      });
    } else {
      const root = options.root || __dirname;
      const configuredDataDir = process.env.DATA_DIR || path.join(root, "data");
      const dataDir = path.isAbsolute(configuredDataDir) ? configuredDataDir : path.resolve(root, configuredDataDir);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      this.raw = new DatabaseSync(path.join(dataDir, "app.db"));
    }
  }
  prepare(sql) { return new Statement(this, sql); }
  async exec(sql) {
    if (!this.isPostgres) { this.raw.exec(sql); return; }
    await this.pool.query(sql);
  }
  async close() { if (this.isPostgres) await this.pool.end(); else this.raw.close(); }
}

function postgresSchema() {
  return [
    "CREATE TABLE IF NOT EXISTS users (id BIGSERIAL PRIMARY KEY, account TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'parent', created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'))",
    "CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id BIGINT NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'))",
    "CREATE TABLE IF NOT EXISTS children (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, grade TEXT NOT NULL DEFAULT '', created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'), gender TEXT NOT NULL DEFAULT '', age INTEGER, caregiver TEXT NOT NULL DEFAULT '', interests TEXT NOT NULL DEFAULT '', family_note TEXT NOT NULL DEFAULT '')",
    "CREATE TABLE IF NOT EXISTS bindings (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, child_id BIGINT NOT NULL, relation TEXT NOT NULL DEFAULT '家长', UNIQUE(user_id, child_id))",
    "CREATE TABLE IF NOT EXISTS tasks (id BIGSERIAL PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL DEFAULT '', dialogue_tips TEXT NOT NULL DEFAULT '', submit_hint TEXT NOT NULL DEFAULT '', duration INTEGER NOT NULL DEFAULT 20, task_type TEXT NOT NULL DEFAULT '阅读', week_start TEXT NOT NULL, published_by BIGINT, created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'), child_id BIGINT, difficulty TEXT NOT NULL DEFAULT '普通', materials TEXT NOT NULL DEFAULT '', fallback_plan TEXT NOT NULL DEFAULT '')",
    "CREATE TABLE IF NOT EXISTS submissions (id BIGSERIAL PRIMARY KEY, task_id BIGINT NOT NULL, child_id BIGINT NOT NULL, content TEXT NOT NULL, sub_type TEXT NOT NULL DEFAULT 'text', created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'), status TEXT NOT NULL DEFAULT 'submitted', attachments TEXT NOT NULL DEFAULT '[]')",
    "CREATE TABLE IF NOT EXISTS feedback (id BIGSERIAL PRIMARY KEY, submission_id BIGINT NOT NULL, teacher_id BIGINT, comment TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', read_at TIMESTAMP, created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'))",
    "CREATE TABLE IF NOT EXISTS questionnaires (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, child_id BIGINT, answers TEXT NOT NULL DEFAULT '{}', created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'))",
    "CREATE TABLE IF NOT EXISTS events (id BIGSERIAL PRIMARY KEY, user_id BIGINT, child_id BIGINT, task_id BIGINT, event_type TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'))",
    "CREATE TABLE IF NOT EXISTS parent_task_requests (id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, child_id BIGINT NOT NULL, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', duration INTEGER NOT NULL DEFAULT 20, status TEXT NOT NULL DEFAULT 'pending', teacher_id BIGINT, teacher_comment TEXT NOT NULL DEFAULT '', task_id BIGINT, created_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'), reviewed_at TIMESTAMP)",
    "CREATE TABLE IF NOT EXISTS engagement_preferences (user_id BIGINT NOT NULL, child_id BIGINT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, updated_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'), UNIQUE(user_id, child_id))",
    "CREATE TABLE IF NOT EXISTS ai_vector_documents (id BIGSERIAL PRIMARY KEY, namespace TEXT NOT NULL DEFAULT 'teacher', doc_key TEXT UNIQUE NOT NULL, doc_type TEXT NOT NULL, ref_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', embedding TEXT NOT NULL DEFAULT '[]', embedding_model TEXT NOT NULL DEFAULT '', embedding_provider TEXT NOT NULL DEFAULT '', content_hash TEXT NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'))",
    "CREATE INDEX IF NOT EXISTS idx_bindings_user_child ON bindings(user_id, child_id)",
    "CREATE INDEX IF NOT EXISTS idx_submissions_child_task ON submissions(child_id, task_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_week_child ON tasks(week_start, child_id)",
    "CREATE INDEX IF NOT EXISTS idx_events_type_child_task ON events(event_type, child_id, task_id)",
    "CREATE INDEX IF NOT EXISTS idx_parent_task_requests_child_status ON parent_task_requests(child_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_ai_vector_documents_namespace ON ai_vector_documents(namespace, doc_type)"
  ].join(";\n") + ";";
}

async function initializeDatabase(database) {
  if (database.isPostgres) { await database.exec(postgresSchema()); return; }
  await database.exec([ 
    "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'parent', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))",
    "CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))",
    "CREATE TABLE IF NOT EXISTS children (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, grade TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), gender TEXT NOT NULL DEFAULT '', age INTEGER, caregiver TEXT NOT NULL DEFAULT '', interests TEXT NOT NULL DEFAULT '', family_note TEXT NOT NULL DEFAULT '')",
    "CREATE TABLE IF NOT EXISTS bindings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, child_id INTEGER NOT NULL, relation TEXT NOT NULL DEFAULT '家长', UNIQUE(user_id, child_id))",
    "CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', steps TEXT NOT NULL DEFAULT '', dialogue_tips TEXT NOT NULL DEFAULT '', submit_hint TEXT NOT NULL DEFAULT '', duration INTEGER NOT NULL DEFAULT 20, task_type TEXT NOT NULL DEFAULT '阅读', week_start TEXT NOT NULL, published_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), child_id INTEGER, difficulty TEXT NOT NULL DEFAULT '普通', materials TEXT NOT NULL DEFAULT '', fallback_plan TEXT NOT NULL DEFAULT '')",
    "CREATE TABLE IF NOT EXISTS submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, child_id INTEGER NOT NULL, content TEXT NOT NULL, sub_type TEXT NOT NULL DEFAULT 'text', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), status TEXT NOT NULL DEFAULT 'submitted', attachments TEXT NOT NULL DEFAULT '[]')",
    "CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id INTEGER NOT NULL, teacher_id INTEGER, comment TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', read_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))",
    "CREATE TABLE IF NOT EXISTS questionnaires (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, child_id INTEGER, answers TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))",
    "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, child_id INTEGER, task_id INTEGER, event_type TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))",
    "CREATE TABLE IF NOT EXISTS parent_task_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, child_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL, goal TEXT NOT NULL DEFAULT '', duration INTEGER NOT NULL DEFAULT 20, status TEXT NOT NULL DEFAULT 'pending', teacher_id INTEGER, teacher_comment TEXT NOT NULL DEFAULT '', task_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), reviewed_at TEXT)",
    "CREATE TABLE IF NOT EXISTS engagement_preferences (user_id INTEGER NOT NULL, child_id INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), UNIQUE(user_id, child_id))",
    "CREATE TABLE IF NOT EXISTS ai_vector_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL DEFAULT 'teacher', doc_key TEXT UNIQUE NOT NULL, doc_type TEXT NOT NULL, ref_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', embedding TEXT NOT NULL DEFAULT '[]', embedding_model TEXT NOT NULL DEFAULT '', embedding_provider TEXT NOT NULL DEFAULT '', content_hash TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))",
    "CREATE INDEX IF NOT EXISTS idx_bindings_user_child ON bindings(user_id, child_id)",
    "CREATE INDEX IF NOT EXISTS idx_submissions_child_task ON submissions(child_id, task_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_week_child ON tasks(week_start, child_id)",
    "CREATE INDEX IF NOT EXISTS idx_events_type_child_task ON events(event_type, child_id, task_id)",
    "CREATE INDEX IF NOT EXISTS idx_ai_vector_documents_namespace ON ai_vector_documents(namespace, doc_type)"
  ].join(";\n") + ";");
  const additions = ["ALTER TABLE children ADD COLUMN gender TEXT NOT NULL DEFAULT ''", "ALTER TABLE children ADD COLUMN age INTEGER", "ALTER TABLE children ADD COLUMN caregiver TEXT NOT NULL DEFAULT ''", "ALTER TABLE children ADD COLUMN interests TEXT NOT NULL DEFAULT ''", "ALTER TABLE children ADD COLUMN family_note TEXT NOT NULL DEFAULT ''", "ALTER TABLE tasks ADD COLUMN child_id INTEGER", "ALTER TABLE tasks ADD COLUMN difficulty TEXT NOT NULL DEFAULT '普通'", "ALTER TABLE tasks ADD COLUMN materials TEXT NOT NULL DEFAULT ''", "ALTER TABLE tasks ADD COLUMN fallback_plan TEXT NOT NULL DEFAULT ''", "ALTER TABLE submissions ADD COLUMN status TEXT NOT NULL DEFAULT 'submitted'", "ALTER TABLE submissions ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'"];
  for (const sql of additions) { try { await database.exec(sql); } catch (e) {} }
  const indexes = ["CREATE INDEX IF NOT EXISTS idx_bindings_user_child ON bindings(user_id, child_id)", "CREATE INDEX IF NOT EXISTS idx_submissions_child_task ON submissions(child_id, task_id, status)", "CREATE INDEX IF NOT EXISTS idx_tasks_week_child ON tasks(week_start, child_id)", "CREATE INDEX IF NOT EXISTS idx_events_type_child_task ON events(event_type, child_id, task_id)", "CREATE INDEX IF NOT EXISTS idx_parent_task_requests_child_status ON parent_task_requests(child_id, status)", "CREATE INDEX IF NOT EXISTS idx_ai_vector_documents_namespace ON ai_vector_documents(namespace, doc_type)"];
  for (const sql of indexes) { try { await database.exec(sql); } catch (e) {} }
}

module.exports = { DatabaseAdapter, initializeDatabase };
