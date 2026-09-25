const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { DatabaseAdapter, initializeDatabase } = require("../database");

function loadEnv(root) {
  [".env.local", ".env"].forEach(function (name) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) return;
    String(fs.readFileSync(file, "utf8")).split(/\r?\n/).forEach(function (line) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]]) return;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[match[1]] = value;
    });
  });
}

function quoteIdentifier(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

async function main() {
  const root = path.resolve(__dirname, "..");
  loadEnv(root);
  if (!process.env.DATABASE_URL) throw new Error("缺少 DATABASE_URL。请先设置 Neon 连接字符串。");

  const sourcePath = process.env.SQLITE_PATH || path.join(root, "data", "app.db");
  if (!fs.existsSync(sourcePath)) throw new Error("找不到 SQLite 文件：" + sourcePath);
  const source = new DatabaseSync(sourcePath);
  const target = new DatabaseAdapter({ root });
  if (!target.isPostgres) throw new Error("DATABASE_URL 未被识别为 PostgreSQL 连接。");
  await initializeDatabase(target);

  const replace = process.argv.includes("--replace");
  if (replace) {
    await target.pool.query("TRUNCATE TABLE sessions, feedback, submissions, questionnaires, events, engagement_preferences, bindings, tasks, children, users, ai_vector_documents RESTART IDENTITY CASCADE");
  }

  const tables = ["users", "children", "bindings", "tasks", "submissions", "feedback", "questionnaires", "events", "engagement_preferences", "ai_vector_documents", "sessions"];
  let total = 0;
  for (const table of tables) {
    const columns = source.prepare("PRAGMA table_info(" + quoteIdentifier(table) + ")").all().map(function (row) { return row.name; });
    if (!columns.length) continue;
    const rows = source.prepare("SELECT " + columns.map(quoteIdentifier).join(", ") + " FROM " + quoteIdentifier(table)).all();
    if (!rows.length) continue;
    const names = columns.map(quoteIdentifier).join(", ");
    const placeholders = columns.map(function (_, index) { return "$" + (index + 1); }).join(", ");
    const sql = "INSERT INTO " + quoteIdentifier(table) + " (" + names + ") VALUES (" + placeholders + ") ON CONFLICT DO NOTHING";
    for (const row of rows) {
      await target.pool.query(sql, columns.map(function (column) { return row[column]; }));
      total += 1;
    }
    console.log(table + ": " + rows.length + " 行");
  }

  for (const table of ["users", "children", "bindings", "tasks", "submissions", "feedback", "questionnaires", "events", "ai_vector_documents"]) {
    await target.pool.query("SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM " + quoteIdentifier(table) + "), 1), true)", [table]);
  }
  console.log("迁移完成，共写入 " + total + " 行。" + (replace ? "（已替换 Neon 原有数据）" : ""));
  await target.close();
  source.close();
}

main().catch(function (error) {
  console.error("迁移失败：" + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
