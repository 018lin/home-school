/**
 * 家校共育系统 · 后端服务
 * 技术栈：Node.js 内置 http + 本地 SQLite / 线上 Neon PostgreSQL
 * 启动：node --experimental-sqlite server.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseAdapter, initializeDatabase } = require("./database");

const PORT = Number(process.env.PORT) || 3123;
const ROOT = __dirname;

function loadLocalEnv(root) {
  [".env.local", ".env"].forEach(function (name) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) return;
    String(fs.readFileSync(file, "utf8")).split(/\r?\n/).forEach(function (line) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]]) return;
      let value = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[m[1]] = value;
    });
  });
}
loadLocalEnv(ROOT);

const db = new DatabaseAdapter({ root: ROOT });
/* ============ 工具函数 ============ */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 32).toString("hex");
  return salt + ":" + hash;
}
function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 32).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}
function mondayOf(d) {
  const dt = new Date(d);
  const wd = dt.getDay() === 0 ? 7 : dt.getDay();
  dt.setDate(dt.getDate() - (wd - 1));
  const y = dt.getFullYear(), m = String(dt.getMonth() + 1).padStart(2, "0"), day = String(dt.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}
function lastMondayOf(d) {
  const mon = new Date(mondayOf(d));
  mon.setDate(mon.getDate() - 7);
  return mondayOf(mon);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 6e6) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}
async function getAuthUser(req) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  const row = await db.prepare(
    "SELECT u.id, u.account, u.display_name, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?"
  ).get(token);
  return row || null;
}
async function createSession(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  await db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, userId);
  return token;
}
async function isBoundChild(userId, childId) {
  return !!await db.prepare("SELECT id FROM bindings WHERE user_id = ? AND child_id = ?").get(userId, childId);
}
async function canAccessChild(user, childId) {
  if (!childId) return false;
  if (user.role === "teacher") {
    return !!await db.prepare("SELECT id FROM children WHERE id = ?").get(childId);
  }
  return user.role === "parent" && await isBoundChild(user.id, childId);
}
async function getVisibleTask(taskId, childId) {
  const task = await db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task) return null;
  if (task.child_id != null && Number(task.child_id) !== Number(childId)) return null;
  return task;
}
function cleanTags(tags) {
  return String(tags || "")
    .split(/[，,]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join(",");
}
async function logEvent(user, eventType, childId, taskId, meta) {
  const type = String(eventType || "").trim().slice(0, 60);
  if (!type) return;
  await db.prepare(
    "INSERT INTO events (user_id, child_id, task_id, event_type, meta) VALUES (?,?,?,?,?)"
  ).run(
    user ? user.id : null,
    childId || null,
    taskId || null,
    type,
    JSON.stringify(meta || {})
  );
}

const DEMO_PARENT_ACCOUNTS = ["demo"];
function demoAccountPlaceholders() {
  return DEMO_PARENT_ACCOUNTS.map(function () { return "?"; }).join(",");
}
function realStudentWhere(alias) {
  alias = alias || "c";
  const demoAccounts = demoAccountPlaceholders();
  return "(" +
    "EXISTS (SELECT 1 FROM bindings rb JOIN users ru ON ru.id = rb.user_id " +
      "WHERE rb.child_id = " + alias + ".id AND ru.role = 'parent' AND ru.account NOT IN (" + demoAccounts + ")) " +
    "OR EXISTS (SELECT 1 FROM questionnaires rq JOIN users qu ON qu.id = rq.user_id " +
      "WHERE rq.child_id = " + alias + ".id AND qu.role = 'parent' AND qu.account NOT IN (" + demoAccounts + "))" +
  ")";
}
function demoParams(multiplier) {
  let params = [];
  for (let i = 0; i < (multiplier || 1); i++) params = params.concat(DEMO_PARENT_ACCOUNTS);
  return params;
}
function latestQuestionnaireJoin() {
  return "LEFT JOIN questionnaires q ON q.id = (" +
    "SELECT q2.id FROM questionnaires q2 WHERE q2.child_id = c.id ORDER BY q2.id DESC LIMIT 1" +
  ") ";
}
async function getTeacherVisibleChildren() {
  return await db.prepare(
    "SELECT c.*, q.answers AS q_answers FROM children c " +
    latestQuestionnaireJoin() +
    "WHERE " + realStudentWhere("c") + " ORDER BY c.id"
  ).all(...demoParams(2));
}

async function getParentEngagement(userId, childId) {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceText = since.getFullYear() + "-" +
    String(since.getMonth() + 1).padStart(2, "0") + "-" +
    String(since.getDate()).padStart(2, "0") + " 00:00:00";

  const rows = await db.prepare(
    "SELECT event_type, created_at FROM events " +
    "WHERE user_id = ? AND child_id = ? AND created_at >= ? " +
    "ORDER BY created_at DESC"
  ).all(userId, childId, sinceText);

  const count = {};
  const activeDays = new Set();
  rows.forEach(function (row) {
    count[row.event_type] = (count[row.event_type] || 0) + 1;
    if (["task_detail_viewed", "timeline_viewed", "feedback_card_viewed",
      "submission_drafted", "submission_submitted", "teacher_contact_started"].includes(row.event_type)) {
      activeDays.add(String(row.created_at).slice(0, 10));
    }
  });

  const touchpoints = (count.task_card_viewed || 0) +
    (count.feedback_card_viewed || 0) +
    (count.task_detail_viewed || 0);
  const exploration = (count.task_detail_viewed || 0) +
    (count.timeline_viewed || 0) +
    (count.feedback_card_viewed || 0);
  const followThrough = (count.submission_drafted || 0) +
    (count.submission_submitted || 0) +
    (count.teacher_contact_started || 0);
  const strongSignals = (count.timeline_viewed || 0) +
    (count.submission_drafted || 0) +
    (count.submission_submitted || 0) +
    (count.teacher_contact_started || 0);

  let score = 0;
  score += Math.min(24, (count.task_detail_viewed || 0) * 8);
  score += Math.min(18, (count.timeline_viewed || 0) * 6);
  score += Math.min(28, (count.submission_submitted || 0) * 14);
  score += Math.min(12, (count.submission_drafted || 0) * 6);
  score += Math.min(18, (count.teacher_contact_started || 0) * 18);
  if (activeDays.size >= 2) score += 10;
  score = Math.min(100, score);

  const evidenceCount = rows.length;
  const confidence = evidenceCount >= 5 || activeDays.size >= 2 ? "高"
    : evidenceCount >= 2 ? "中" : "低";
  const level = evidenceCount === 0 ? "证据不足"
    : score >= 60 ? "主动关注证据较高"
    : score >= 30 ? "有一定主动关注"
    : "近期主动关注证据较少";
  const status = evidenceCount === 0 ? "insufficient"
    : score >= 60 ? "high" : score >= 30 ? "medium" : "low";

  const evidence = [];
  if (count.task_detail_viewed) evidence.push("查看任务详情 " + count.task_detail_viewed + " 次");
  if (count.timeline_viewed) evidence.push("回看成长档案 " + count.timeline_viewed + " 次");
  if (count.submission_submitted) evidence.push("完成提交 " + count.submission_submitted + " 次");
  if (count.teacher_contact_started) evidence.push("发起沟通 " + count.teacher_contact_started + " 次");
  if (!evidence.length && touchpoints) evidence.push("接触过 " + touchpoints + " 次家校信息");

  let recommendation = "继续提供简短、可直接行动的信息";
  if (status === "insufficient") recommendation = "暂不下结论，先提供一次清晰摘要";
  else if (status === "low") recommendation = "减少信息负担，给出一个明确的下一步";
  else if (status === "medium") recommendation = "在重要事项后补充一次轻量跟进";
  else if (followThrough > 0) recommendation = "提供更深入的趋势和家庭支持建议";

  return {
    windowDays: 30,
    score: score,
    level: level,
    status: status,
    confidence: confidence,
    evidence: evidence,
    recommendation: recommendation,
    counts: {
      touchpoints: touchpoints,
      exploration: exploration,
      followThrough: followThrough,
      activeDays: activeDays.size,
      events: evidenceCount
    }
  };
}

async function getEngagementPreference(userId, childId) {
  const row = await db.prepare(
    "SELECT enabled FROM engagement_preferences WHERE user_id = ? AND child_id = ?"
  ).get(userId, childId);
  return !row || Number(row.enabled) !== 0;
}

function pickJsonObject(text) {
  const raw = String(text || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(raw); } catch (e) {}
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch (e) {}
  }
  return null;
}

async function generateDeepSeekReport(report) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  const endpoint = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  function anonymizeRows(rows) {
    return (rows || []).slice(0, 12).map(function (row, idx) {
      return {
        studentAlias: "学生" + (idx + 1),
        grade: row.grade || "",
        caregiver: row.caregiver || "",
        interests: row.interests || "",
        timeAvailable: row.timeAvailable || "",
        completeness: row.completeness
      };
    });
  }
  function anonymizeSamples(samples) {
    return (samples || []).slice(0, 6).map(function (sample, idx) {
      return {
        studentAlias: "学生" + (idx + 1),
        taskTitle: sample.taskTitle || "",
        snippet: String(sample.snippet || "").slice(0, 80)
      };
    });
  }
  function anonymizeBehaviorRows(rows) {
    return (rows || []).slice(0, 12).map(function (row, idx) {
      return {
        studentAlias: "学生" + (idx + 1),
        touchpoints: row.touchpoints || 0,
        exploration: row.exploration || 0,
        followThrough: row.followThrough || 0,
        activeDays: row.activeDays || 0,
        events: row.events || 0
      };
    });
  }
  const payload = {
    generatedAt: report.generatedAt,
    dataScope: report.dataScope,
    stats: report.stats,
    dimensions: report.dimensions.map(function (d) {
      return {
        key: d.key,
        title: d.title,
        summary: d.summary,
        findings: d.findings,
        actions: d.actions,
        distribution: d.distribution,
        weekdayDistribution: d.weekdayDistribution,
        indicators: d.indicators,
        samples: anonymizeSamples(d.samples),
        rows: d.key === "behaviorSignals" ? anonymizeBehaviorRows(d.rows) : anonymizeRows(d.rows)
      };
    })
  };
  const messages = [
    {
      role: "system",
      content: "你是家校共育系统里的教师数据分析助手。请基于数据输出审慎、温和、可行动的中文报告，不做排名，不贴负面标签，不夸大站内行为证据。所有建议必须尊重自愿参与、隐私保护、过程性评价和不公开比较。只返回 JSON，不要输出 Markdown。"
    },
    {
      role: "user",
      content: "请从学生档案、家长完成任务时间、家长上传文字素材、家长行为参与信号（埋点）四个维度生成增强分析。其中 behaviorSignals 维度来自家长在系统内的行为埋点（查看、浏览、起草、提交、发起沟通等），只能用于识别参与节奏、活跃时段和沟通时机，绝不能据此断言家长是否关心孩子。返回 JSON，格式必须为 {\"headline\":\"一句总判断\",\"summary\":\"120字以内总览\",\"dimensions\":[{\"key\":\"profiles|completionTime|textMaterials|behaviorSignals\",\"title\":\"维度标题\",\"summary\":\"一句维度判断\",\"findings\":[\"发现1\"],\"actions\":[\"建议1\"]}],\"priorities\":[{\"title\":\"优先事项\",\"reason\":\"为什么优先\",\"action\":\"教师下一步动作\",\"urgency\":\"高|中|低\"}],\"nextWeekPlan\":{\"taskTheme\":\"下周任务主题\",\"targetGroup\":\"适用对象\",\"designNotes\":[\"设计要点\"],\"fallback\":\"低负担替代方案\"},\"followUpGroups\":[{\"group\":\"分层人群\",\"signal\":\"可观察信号\",\"teacherAction\":\"建议动作\",\"tone\":\"沟通语气\"}],\"risks\":[\"需要谨慎解读的点\"]}。要求：1. 不评价家长是否关心孩子；2. 不输出学生姓名；3. 不把低样本当结论；4. 建议必须能在一周内执行；5. 若数据不足，请明确说明证据不足。\n\n数据：" + JSON.stringify(payload)
    }
  ];
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    body: JSON.stringify({
      model: model,
      messages: messages,
      stream: false,
      temperature: 0.2,
      max_tokens: 2200
    })
  });
  if (!response.ok) {
    const text = await response.text().catch(function () { return ""; });
    throw new Error("DeepSeek API " + response.status + (text ? ": " + text.slice(0, 160) : ""));
  }
  const data = await response.json();
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : "";
  return pickJsonObject(content);
}

function getZhipuApiKey() {
  return process.env.ZHIPU_API_KEY || process.env.BIGMODEL_API_KEY || "";
}

function getZhipuEmbeddingModel() {
  return process.env.ZHIPU_EMBEDDING_MODEL || "embedding-3";
}

function getZhipuChatModel() {
  return process.env.ZHIPU_CHAT_MODEL || "glm-4-flash";
}

function getZhipuEndpoint(kind) {
  const defaultBase = "https://open.bigmodel.cn/api/paas/v4";
  const base = String(process.env.ZHIPU_API_BASE || defaultBase).replace(/\/+$/, "");
  if (kind === "embedding") return process.env.ZHIPU_EMBEDDING_URL || base + "/embeddings";
  return process.env.ZHIPU_CHAT_URL || base + "/chat/completions";
}

async function requestZhipuEmbeddings(texts) {
  const apiKey = getZhipuApiKey();
  if (!apiKey || !texts.length) return [];
  const response = await fetch(getZhipuEndpoint("embedding"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    body: JSON.stringify({
      model: getZhipuEmbeddingModel(),
      input: texts
    })
  });
  if (!response.ok) {
    const text = await response.text().catch(function () { return ""; });
    throw new Error("智谱 Embedding API " + response.status + (text ? ": " + text.slice(0, 160) : ""));
  }
  const data = await response.json();
  return (data.data || []).sort(function (a, b) {
    return Number(a.index || 0) - Number(b.index || 0);
  }).map(function (item) {
    return Array.isArray(item.embedding) ? item.embedding : [];
  });
}

async function requestZhipuChat(messages, options) {
  const apiKey = getZhipuApiKey();
  if (!apiKey) return "";
  options = options || {};
  const response = await fetch(getZhipuEndpoint("chat"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + apiKey
    },
    body: JSON.stringify({
      model: options.model || getZhipuChatModel(),
      messages: messages,
      stream: false,
      temperature: options.temperature == null ? 0.2 : options.temperature,
      max_tokens: options.maxTokens || 1200
    })
  });
  if (!response.ok) {
    const text = await response.text().catch(function () { return ""; });
    throw new Error("智谱 Chat API " + response.status + (text ? ": " + text.slice(0, 160) : ""));
  }
  const data = await response.json();
  return data && data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || "") : "";
}

function parseJsonField(value) {
  try { return JSON.parse(value || "{}") || {}; } catch (e) { return {}; }
}

async function teacherParentInfo(childId) {
  const rows = await db.prepare(
    "SELECT u.display_name, b.relation FROM bindings b JOIN users u ON u.id = b.user_id " +
    "WHERE b.child_id = ? AND u.role = 'parent' ORDER BY b.id"
  ).all(childId);
  return rows.map(function (row) {
    return (row.display_name || "家长") + (row.relation ? "（" + row.relation + "）" : "");
  });
}

function buildTeacherSubmissionDocument(row) {
  const content = String(row.content || "").trim();
  if (!content || row.status !== "submitted") return null;
  return {
    docKey: "submission:" + row.id,
    docType: "submission",
    refId: String(row.id),
    title: "提交：" + row.child_name + " · " + row.task_title,
    content: [
      "学生" + row.child_name + "提交了任务《" + row.task_title + "》。",
      "提交时间：" + row.created_at + "；任务周：" + row.week_start + "；任务类型：" + (row.task_type || "未填写") + "。",
      "提交文本：" + content.slice(0, 4000),
      Number(row.feedback_count || 0) > 0 ? "状态：已点评。最近点评：" + (row.feedback_comment || "已完成点评") : "状态：尚未点评。",
      "陪伴人：" + (row.caregiver || "未填写") + "；兴趣：" + (row.interests || "未填写") + "。"
    ].join("\n"),
    metadata: {
      submissionId: row.id,
      childId: row.child_id,
      taskId: row.task_id,
      weekStart: row.week_start,
      hasText: true,
      subType: row.sub_type || "text"
    }
  };
}

async function getTeacherSubmissionRow(submissionId) {
  return await db.prepare(
    "SELECT s.*, c.name AS child_name, c.grade, c.caregiver, c.interests, " +
    "t.title AS task_title, t.task_type, t.week_start, t.child_id AS task_child_id, " +
    "(SELECT COUNT(*) FROM feedback f WHERE f.submission_id = s.id) AS feedback_count, " +
    "(SELECT f.comment FROM feedback f WHERE f.submission_id = s.id ORDER BY f.id DESC LIMIT 1) AS feedback_comment " +
    "FROM submissions s JOIN children c ON c.id = s.child_id JOIN tasks t ON t.id = s.task_id " +
    "WHERE s.id = ? AND " + realStudentWhere("c")
  ).get(submissionId, ...demoParams(2));
}

async function upsertTeacherSubmissionVector(submissionId) {
  const row = await getTeacherSubmissionRow(submissionId);
  const doc = row ? buildTeacherSubmissionDocument(row) : null;
  if (!doc) return { indexed: false, embedded: false };

  const contentHash = crypto.createHash("sha256").update(doc.content).digest("hex");
  const old = await db.prepare(
    "SELECT embedding, embedding_model, embedding_provider, content_hash " +
    "FROM ai_vector_documents WHERE namespace = 'teacher' AND doc_key = ?"
  ).get(doc.docKey);
  const unchanged = old && old.content_hash === contentHash;
  const existingEmbedding = old && old.embedding ? old.embedding : "[]";
  await db.prepare(
    "INSERT INTO ai_vector_documents " +
    "(namespace, doc_key, doc_type, ref_id, title, content, metadata, embedding, embedding_model, embedding_provider, content_hash, updated_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime')) " +
    "ON CONFLICT(doc_key) DO UPDATE SET doc_type=excluded.doc_type, ref_id=excluded.ref_id, title=excluded.title, " +
    "content=excluded.content, metadata=excluded.metadata, embedding=excluded.embedding, embedding_model=excluded.embedding_model, " +
    "embedding_provider=excluded.embedding_provider, content_hash=excluded.content_hash, updated_at=excluded.updated_at"
  ).run(
    "teacher", doc.docKey, doc.docType, doc.refId, doc.title, doc.content, JSON.stringify(doc.metadata),
    unchanged ? existingEmbedding : "[]",
    unchanged ? (old.embedding_model || "") : "",
    unchanged ? (old.embedding_provider || "") : "",
    contentHash
  );

  if (unchanged && existingEmbedding !== "[]") {
    return { indexed: true, embedded: true };
  }
  if (!getZhipuApiKey()) {
    return { indexed: true, embedded: false };
  }
  try {
    const vector = (await requestZhipuEmbeddings([doc.content]))[0] || [];
    if (!vector.length) return { indexed: true, embedded: false };
    await db.prepare(
      "UPDATE ai_vector_documents SET embedding=?, embedding_model=?, embedding_provider='zhipu', " +
      "updated_at=datetime('now','localtime') WHERE namespace='teacher' AND doc_key=?"
    ).run(JSON.stringify(vector), getZhipuEmbeddingModel(), doc.docKey);
    return { indexed: true, embedded: true };
  } catch (e) {
    console.warn("单条提交文本向量化失败，将由下次索引重试：", e.message);
    return { indexed: true, embedded: false, error: e.message };
  }
}

const BEHAVIOR_TYPE_NAMES = {
  task_card_viewed: "查看任务卡片",
  task_detail_viewed: "查看任务详情",
  feedback_card_viewed: "查看反馈卡片",
  timeline_viewed: "回看成长档案",
  submission_drafted: "起草提交",
  submission_submitted: "完成提交",
  teacher_contact_started: "发起沟通",
  page_dwell: "页面停留",
  questionnaire_viewed: "查看问卷"
};

async function buildTeacherKnowledgeDocuments() {
  const weekStart = mondayOf(new Date());
  const children = await getTeacherVisibleChildren();
  const tasks = await db.prepare(
    "SELECT t.*, c.name AS child_name FROM tasks t LEFT JOIN children c ON c.id = t.child_id ORDER BY t.id DESC"
  ).all();
  const submissions = await db.prepare(
    "SELECT s.*, c.name AS child_name, c.grade, c.caregiver, c.interests, " +
    "t.title AS task_title, t.task_type, t.week_start, t.child_id AS task_child_id, " +
    "(SELECT COUNT(*) FROM feedback f WHERE f.submission_id = s.id) AS feedback_count, " +
    "(SELECT f.comment FROM feedback f WHERE f.submission_id = s.id ORDER BY f.id DESC LIMIT 1) AS feedback_comment " +
    "FROM submissions s JOIN children c ON c.id = s.child_id JOIN tasks t ON t.id = s.task_id " +
    "WHERE s.status = 'submitted' AND " + realStudentWhere("c") + " ORDER BY s.id DESC"
  ).all(...demoParams(2));

  const currentSubmissions = submissions.filter(function (row) {
    return row.week_start === weekStart;
  });
  const currentChildIds = new Set(currentSubmissions.map(function (row) { return row.child_id; }));
  const pendingFeedback = currentSubmissions.filter(function (row) {
    return Number(row.feedback_count || 0) === 0;
  }).length;
  const hourBuckets = { "上午": 0, "下午": 0, "晚间": 0, "深夜/清晨": 0 };
  const weekdayBuckets = { "工作日": 0, "周末": 0 };
  currentSubmissions.forEach(function (row) {
    const date = new Date(String(row.created_at || "").replace(" ", "T"));
    if (Number.isNaN(date.getTime())) return;
    const hour = date.getHours();
    const bucket = hour >= 5 && hour < 12 ? "上午"
      : hour >= 12 && hour < 18 ? "下午"
      : hour >= 18 && hour < 22 ? "晚间" : "深夜/清晨";
    hourBuckets[bucket]++;
    weekdayBuckets[date.getDay() === 0 || date.getDay() === 6 ? "周末" : "工作日"]++;
  });
  const topBucket = Object.entries(hourBuckets).sort(function (a, b) { return b[1] - a[1]; })[0];
  const topWeekday = Object.entries(weekdayBuckets).sort(function (a, b) { return b[1] - a[1]; })[0];
  const customTaskCount = tasks.filter(function (task) { return task.child_id != null; }).length;
  const currentTaskCount = tasks.filter(function (task) { return task.week_start === weekStart; }).length;

  const docs = [{
    docKey: "summary:teacher",
    docType: "summary",
    refId: "teacher",
    title: "班级总体情况",
    content: [
      "班级总体情况。",
      "已发布任务总数：" + tasks.length + " 项，其中定制任务 " + customTaskCount + " 项。",
      "本周发布任务：" + currentTaskCount + " 项。",
      "本周已有 " + currentChildIds.size + " 位学生与家长完成任务，共提交 " + currentSubmissions.length + " 份。",
      "本周待点评提交 " + pendingFeedback + " 份。",
      "本周提交时段最多为" + (topBucket ? topBucket[0] : "暂无") + "，工作日/周末较多的是" + (topWeekday ? topWeekday[0] : "暂无") + "。",
      "各时段提交数量：" + Object.entries(hourBuckets).map(function (e) { return e[0] + e[1] + "份"; }).join("、") + "。",
      "工作日与周末提交数量：" + Object.entries(weekdayBuckets).map(function (e) { return e[0] + e[1] + "份"; }).join("、") + "。",
      "这些数据只代表系统内的提交、查看和反馈记录，不等同于家长真实关注程度。"
    ].join("\n"),
    metadata: { weekStart: weekStart }
  }];

  // 班级家长行为埋点总览（近30天 events 表），供 AI 对话回答参与节奏、活跃情况类问题
  const behaviorSince = new Date();
  behaviorSince.setDate(behaviorSince.getDate() - 30);
  const behaviorSinceText = behaviorSince.getFullYear() + "-" +
    String(behaviorSince.getMonth() + 1).padStart(2, "0") + "-" +
    String(behaviorSince.getDate()).padStart(2, "0") + " 00:00:00";
  const behaviorRows = await db.prepare(
    "SELECT e.event_type, e.child_id, e.created_at, c.name AS child_name " +
    "FROM events e JOIN children c ON c.id = e.child_id " +
    "WHERE e.created_at >= ? AND " + realStudentWhere("c") + " ORDER BY e.id DESC"
  ).all(behaviorSinceText, ...demoParams(2));
  const behaviorCount = {};
  const behaviorByChild = {};
  behaviorRows.forEach(function (row) {
    behaviorCount[row.event_type] = (behaviorCount[row.event_type] || 0) + 1;
    if (!behaviorByChild[row.child_id]) {
      behaviorByChild[row.child_id] = { childName: row.child_name, counts: {}, days: new Set(), events: 0 };
    }
    const b = behaviorByChild[row.child_id];
    b.events++;
    b.counts[row.event_type] = (b.counts[row.event_type] || 0) + 1;
    const day = String(row.created_at || "").slice(0, 10);
    if (day) b.days.add(day);
  });
  const behaviorTypeText = Object.keys(behaviorCount).map(function (key) {
    return (BEHAVIOR_TYPE_NAMES[key] || key) + " " + behaviorCount[key] + "次";
  }).join("、") || "暂无";
  let behaviorTouchTotal = 0, behaviorExploreTotal = 0, behaviorFollowTotal = 0;
  const behaviorViewerOnly = [];
  const behaviorChildText = Object.keys(behaviorByChild).map(function (id) {
    const b = behaviorByChild[id];
    const touch = (b.counts.task_card_viewed || 0) + (b.counts.feedback_card_viewed || 0) + (b.counts.task_detail_viewed || 0);
    const explore = (b.counts.task_detail_viewed || 0) + (b.counts.timeline_viewed || 0) + (b.counts.feedback_card_viewed || 0);
    const follow = (b.counts.submission_drafted || 0) + (b.counts.submission_submitted || 0) + (b.counts.teacher_contact_started || 0);
    behaviorTouchTotal += touch;
    behaviorExploreTotal += explore;
    behaviorFollowTotal += follow;
    if (touch > 0 && follow === 0) behaviorViewerOnly.push(b.childName);
    return "学生" + b.childName + "：触达" + touch + "次、探索" + explore + "次、执行" + follow + "次、活跃" + b.days.size + "天";
  }).join("；") || "暂无";
  const behaviorConvertRate = behaviorTouchTotal > 0
    ? Math.round(behaviorFollowTotal / behaviorTouchTotal * 100) : 0;
  docs.push({
    docKey: "behavior:class",
    docType: "behavior",
    refId: "class",
    title: "班级家长行为参与总览（近30天埋点）",
    content: [
      "班级家长行为参与总览（数据来自家长在系统内的行为埋点，近30天）。",
      "共记录站内行为事件 " + behaviorRows.length + " 次，有行为记录的学生 " + Object.keys(behaviorByChild).length + " 名。",
      "行为类型分布：" + behaviorTypeText + "。",
      "参与转化：触达类行为共 " + behaviorTouchTotal + " 次，执行类行为共 " + behaviorFollowTotal + " 次，触达后转化为执行的比例约 " + behaviorConvertRate + "%（仅作参与节奏参考）。",
      "有行为记录的学生明细：" + behaviorChildText + "。",
      (behaviorViewerOnly.length
        ? "有浏览但未进入执行环节的学生：" + behaviorViewerOnly.join("、") + "，可优先安排轻量跟进。"
        : "所有有行为记录的学生均已进入执行环节或暂无浏览记录。"),
      "这些埋点仅反映系统内可见活动（查看、浏览、起草、提交、发起沟通等），用于识别参与节奏和沟通时机，不等同于家长真实关注程度。"
    ].join("\n"),
    metadata: { weekStart: weekStart }
  });

  for (const child of children) {
    const answers = parseJsonField(child.q_answers);
    const parentNames = await teacherParentInfo(child.id);
    const binding = await db.prepare(
      "SELECT b.user_id FROM bindings b JOIN users u ON u.id = b.user_id " +
      "WHERE b.child_id = ? AND u.role = 'parent' AND u.account NOT IN (" + demoAccountPlaceholders() + ") " +
      "ORDER BY b.id LIMIT 1"
    ).get(child.id, ...demoParams(1));
    const engagement = binding ? await getParentEngagement(binding.user_id, child.id) : null;
    const childSubs = submissions.filter(function (row) { return row.child_id === child.id; });
    docs.push({
      docKey: "student:" + child.id,
      docType: "student",
      refId: String(child.id),
      title: "学生档案：" + child.name,
      content: [
        "学生档案：学生" + child.name + "，年级" + (child.grade || "未填写") + "。",
        "性别：" + (child.gender || "未填写") + "；年龄：" + (child.age || "未填写") + "。",
        "主要陪伴人：" + (child.caregiver || "未填写") + "；兴趣：" + (child.interests || "未填写") + "。",
        "家长账号称呼：" + (parentNames.length ? parentNames.join("、") : "未绑定家长") + "。",
        "家庭可用时间：" + (answers.timeAvailable || "未填写") + "；家庭备注：" + (child.family_note || answers.familyNote || "无") + "。",
        "历史正式提交 " + childSubs.length + " 份。",
        engagement ? "近30天站内行为证据：" + engagement.level + "，" + (engagement.evidence.join("、") || "暂无具体证据") + "。建议：" + engagement.recommendation + "。" : "暂无可用的家长站内行为证据。",
        engagement ? "近30天行为计数：触达" + (engagement.counts.touchpoints || 0) + "次、探索" + (engagement.counts.exploration || 0) + "次、执行" + (engagement.counts.followThrough || 0) + "次、活跃" + (engagement.counts.activeDays || 0) + "天、事件共" + (engagement.counts.events || 0) + "次。" : "",
        "关注分析仅用于安排沟通和任务支持，不用于给家庭贴标签。"
      ].join("\n"),
      metadata: { childId: child.id, childName: child.name, weekStart: weekStart }
    });
  }

  tasks.forEach(function (task) {
    docs.push({
      docKey: "task:" + task.id,
      docType: "task",
      refId: String(task.id),
      title: "任务：" + task.title,
      content: [
        "任务：" + task.title + "。",
        "任务类型：" + (task.task_type || "未填写") + "；发布周：" + (task.week_start || "未填写") + "。",
        "适用对象：" + (task.child_name ? "学生" + task.child_name : "全班") + "。",
        "目标：" + (task.goal || "未填写") + "；难度：" + (task.difficulty || "普通") + "；时长：" + (task.duration || 20) + "分钟。",
        "步骤：" + (task.steps || "未填写") + "。",
        "材料：" + (task.materials || "未填写") + "；低负担替代方案：" + (task.fallback_plan || "未填写") + "。"
      ].join("\n"),
      metadata: { taskId: task.id, childId: task.child_id || null, weekStart: task.week_start || "" }
    });
  });

  submissions.slice(0, 500).forEach(function (row) {
    const doc = buildTeacherSubmissionDocument(row);
    if (doc) docs.push(doc);
  });
  return docs;
}

function lexicalSimilarity(a, b) {
  const tokenize = function (text) {
    const value = String(text || "").toLowerCase();
    const tokens = [];
    const words = value.match(/[a-z0-9\u4e00-\u9fff]+/g) || [];
    words.forEach(function (word) {
      tokens.push(word);
      if (/[\u4e00-\u9fff]/.test(word)) {
        for (let i = 0; i < word.length - 1; i++) tokens.push(word.slice(i, i + 2));
      }
    });
    return new Set(tokens);
  };
  const left = tokenize(a), right = tokenize(b);
  if (!left.size || !right.size) return 0;
  let common = 0;
  left.forEach(function (token) { if (right.has(token)) common++; });
  return common / Math.sqrt(left.size * right.size);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0, left = 0, right = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0, y = Number(b[i]) || 0;
    dot += x * y;
    left += x * x;
    right += y * y;
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

async function syncTeacherVectorIndex() {
  const docs = await buildTeacherKnowledgeDocuments();
  const currentKeys = new Set(docs.map(function (doc) { return doc.docKey; }));
  const existingRows = await db.prepare(
    "SELECT * FROM ai_vector_documents WHERE namespace = 'teacher'"
  ).all();
  const existing = new Map(existingRows.map(function (row) { return [row.doc_key, row]; }));
  const apiKey = getZhipuApiKey();
  const model = getZhipuEmbeddingModel();
  const toEmbed = [];

  for (const doc of docs) {
    const contentHash = crypto.createHash("sha256").update(doc.content).digest("hex");
    const old = existing.get(doc.docKey);
    const oldEmbedding = old && old.embedding ? old.embedding : "[]";
    const unchanged = old && old.content_hash === contentHash;
    await db.prepare(
      "INSERT INTO ai_vector_documents " +
      "(namespace, doc_key, doc_type, ref_id, title, content, metadata, embedding, embedding_model, embedding_provider, content_hash, updated_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime')) " +
      "ON CONFLICT(doc_key) DO UPDATE SET doc_type=excluded.doc_type, ref_id=excluded.ref_id, title=excluded.title, " +
      "content=excluded.content, metadata=excluded.metadata, embedding=excluded.embedding, embedding_model=excluded.embedding_model, " +
      "embedding_provider=excluded.embedding_provider, content_hash=excluded.content_hash, updated_at=excluded.updated_at"
    ).run(
      "teacher", doc.docKey, doc.docType, doc.refId, doc.title, doc.content, JSON.stringify(doc.metadata || {}),
      unchanged ? oldEmbedding : "[]", unchanged ? (old.embedding_model || "") : "", unchanged ? (old.embedding_provider || "") : "",
      contentHash
    );
    if (apiKey && (!unchanged || !oldEmbedding || oldEmbedding === "[]")) toEmbed.push(doc);
  }

  for (const [key] of existing) {
    if (!currentKeys.has(key)) {
      await db.prepare("DELETE FROM ai_vector_documents WHERE namespace = 'teacher' AND doc_key = ?").run(key);
    }
  }

  let embeddedCount = 0;
  if (apiKey) {
    for (let i = 0; i < toEmbed.length; i += 24) {
      const batch = toEmbed.slice(i, i + 24);
      try {
        const vectors = await requestZhipuEmbeddings(batch.map(function (doc) { return doc.content; }));
        for (let index = 0; index < batch.length; index++) {
          const doc = batch[index];
          const vector = vectors[index] || [];
          if (!vector.length) continue;
          await db.prepare(
            "UPDATE ai_vector_documents SET embedding=?, embedding_model=?, embedding_provider='zhipu', updated_at=datetime('now','localtime') WHERE doc_key=?"
          ).run(JSON.stringify(vector), model, doc.docKey);
          embeddedCount++;
        }
      } catch (e) {
        console.warn("向量索引更新失败，将使用关键词检索：", e.message);
        break;
      }
    }
  }
  return { documentCount: docs.length, embeddedCount: embeddedCount };
}

async function searchTeacherKnowledge(question, limit) {
  const rows = await db.prepare(
    "SELECT * FROM ai_vector_documents WHERE namespace = 'teacher'"
  ).all();
  if (!rows.length) return [];
  let queryEmbedding = [];
  if (getZhipuApiKey()) {
    try { queryEmbedding = (await requestZhipuEmbeddings([question]))[0] || []; } catch (e) {}
  }
  return rows.map(function (row) {
    const embedding = parseJsonField(row.embedding);
    const vectorScore = queryEmbedding.length ? cosineSimilarity(queryEmbedding, embedding) : 0;
    const keywordScore = lexicalSimilarity(question, row.title + "\n" + row.content);
    return {
      id: row.id,
      title: row.title,
      content: row.content,
      metadata: parseJsonField(row.metadata),
      score: queryEmbedding.length ? vectorScore * 0.8 + keywordScore * 0.2 : keywordScore
    };
  }).sort(function (a, b) { return b.score - a.score; }).slice(0, limit || 7);
}

async function generateZhipuReport(report) {
  if (!getZhipuApiKey()) return null;
  const payload = {
    generatedAt: report.generatedAt,
    dataScope: report.dataScope,
    stats: report.stats,
    dimensions: report.dimensions.map(function (d) {
      const base = {
        key: d.key,
        title: d.title,
        summary: d.summary,
        findings: d.findings,
        actions: d.actions,
        distribution: d.distribution,
        weekdayDistribution: d.weekdayDistribution,
        indicators: d.indicators
      };
      if (d.key === "behaviorSignals") {
        base.rows = (d.rows || []).slice(0, 12).map(function (row, idx) {
          return {
            studentAlias: "学生" + (idx + 1),
            touchpoints: row.touchpoints || 0,
            exploration: row.exploration || 0,
            followThrough: row.followThrough || 0,
            activeDays: row.activeDays || 0,
            events: row.events || 0
          };
        });
      }
      return base;
    })
  };
  const content = await requestZhipuChat([
    {
      role: "system",
      content: "你是家校共育系统里的教师数据分析助手。请基于数据输出审慎、温和、可行动的中文报告，不做排名，不贴负面标签，不夸大站内行为证据。所有建议必须尊重自愿参与、隐私保护、过程性评价和不公开比较。只返回 JSON，不要输出 Markdown。"
    },
    {
      role: "user",
      content: "请生成全局分析。返回 JSON，格式必须为 {\"headline\":\"一句总判断\",\"summary\":\"120字以内总览\",\"dimensions\":[{\"key\":\"profiles|completionTime|textMaterials|behaviorSignals\",\"title\":\"维度标题\",\"summary\":\"一句维度判断\",\"findings\":[\"发现1\"],\"actions\":[\"建议1\"]}],\"priorities\":[{\"title\":\"优先事项\",\"reason\":\"为什么优先\",\"action\":\"教师下一步动作\",\"urgency\":\"高|中|低\"}],\"nextWeekPlan\":{\"taskTheme\":\"下周任务主题\",\"targetGroup\":\"适用对象\",\"designNotes\":[\"设计要点\"],\"fallback\":\"低负担替代方案\"},\"followUpGroups\":[{\"group\":\"分层人群\",\"signal\":\"可观察信号\",\"teacherAction\":\"建议动作\",\"tone\":\"沟通语气\"}],\"risks\":[\"需要谨慎解读的点\"]}。不评价家长是否关心孩子，不输出学生姓名，不把低样本当结论，数据不足时明确说证据不足。behaviorSignals 维度来自家长在系统内的行为埋点（查看、浏览、起草、提交、发起沟通等），只能用于识别参与节奏、活跃时段和沟通时机，绝不能据此断言家长是否关心孩子。\n\n数据：" + JSON.stringify(payload)
    }
  ], { maxTokens: 2200 });
  return pickJsonObject(content);
}

async function generateTeacherChatAnswer(question, history, docs) {
  if (!getZhipuApiKey()) return "";
  const context = docs.map(function (doc, index) {
    return "[资料" + (index + 1) + "] " + doc.title + "\n" + doc.content;
  }).join("\n\n");
  const safeHistory = (Array.isArray(history) ? history : []).slice(-6).map(function (item) {
    return {
      role: item && item.role === "assistant" ? "assistant" : "user",
      content: String(item && item.content || "").slice(0, 800)
    };
  });
  return requestZhipuChat([
    {
      role: "system",
      content: "你是家校共育系统的教师端 AI 助手。请只根据提供的班级资料回答，可以做明确标注为推测的合理推理。回答用中文，先给结论，再给依据和建议。不能把站内行为直接说成家长是否关心，也不要公开比较学生。若资料不足，直接说明证据不足并告诉老师还需要什么数据。涉及学生时可以使用资料中的学生姓名，但不要输出家长账号、密码或无关隐私。资料中会包含家长近30天站内行为埋点统计（查看、浏览、起草、提交、发起沟通等），可用于回答参与节奏、活跃情况和沟通时机类问题，但绝不能据此断言家长是否关心孩子。"
    },
    { role: "system", content: "检索到的班级资料：\n" + context },
    ...safeHistory,
    { role: "user", content: question }
  ], { maxTokens: 1000, temperature: 0.3 });
}

async function answerTeacherMetricQuestion(question) {
  const text = String(question || "");
  if (!/(未点评|待点评|优先.*点评|点评.*优先|还有.*点评)/.test(text)) return null;
  const weekStart = mondayOf(new Date());
  const rows = await db.prepare(
    "SELECT s.id, s.created_at, s.content, c.name AS child_name, t.title AS task_title, " +
    "(SELECT COUNT(*) FROM feedback f WHERE f.submission_id = s.id) AS feedback_count " +
    "FROM submissions s JOIN children c ON c.id = s.child_id JOIN tasks t ON t.id = s.task_id " +
    "WHERE s.status = 'submitted' AND t.week_start = ? AND " + realStudentWhere("c") + " ORDER BY s.created_at ASC"
  ).all(weekStart, ...demoParams(2));
  const pending = rows.filter(function (row) { return Number(row.feedback_count || 0) === 0; });
  if (!pending.length) {
    return {
      answer: "结论：本周暂无未点评提交。\n\n依据：系统内本周正式提交共 " + rows.length +
        " 份，均已有教师点评记录。接下来可以优先查看提交中出现困难、时间压力或需要后续支持的内容，而不是补点评。",
      sources: [{ title: "本周提交与点评记录" }]
    };
  }
  const list = pending.slice(0, 5).map(function (row, index) {
    return (index + 1) + ". " + row.child_name + "：《" + row.task_title + "》，提交于 " +
      row.created_at + "，内容摘要：" + String(row.content || "").slice(0, 48);
  }).join("\n");
  return {
    answer: "结论：本周还有 " + pending.length + " 份提交未点评，建议按提交时间先后和内容中是否有困难线索优先处理。\n\n" + list,
    sources: pending.slice(0, 5).map(function (row) {
      return { title: "提交：" + row.child_name + " · " + row.task_title };
    })
  };
}

/* ============ 种子数据（演示用，幂等） ============ */
async function seed() {
  const hasDemo = await db.prepare("SELECT id FROM users WHERE account = 'demo'").get();
  var demoUserId, teacherId, childId;

  if (!hasDemo) {
    demoUserId = await db.prepare(
      "INSERT INTO users (account, password_hash, display_name, role) VALUES (?, ?, ?, 'parent')"
    ).run("demo", hashPassword("123456"), "李女士").lastInsertRowid;

    teacherId = await db.prepare(
      "INSERT INTO users (account, password_hash, display_name, role) VALUES (?, ?, ?, 'teacher')"
    ).run("018", hashPassword("018018"), "王老师").lastInsertRowid;

    childId = await db.prepare("INSERT INTO children (name, grade) VALUES (?, ?)").run("小明", "三年级").lastInsertRowid;
    await db.prepare("INSERT INTO bindings (user_id, child_id, relation) VALUES (?, ?, '妈妈')").run(demoUserId, childId);

    // 上周任务 + 已完成的提交 + 老师反馈（用于演示成长时间线）
    const lastTaskId = await db.prepare(
      "INSERT INTO tasks (title, goal, steps, dialogue_tips, submit_hint, duration, task_type, week_start, published_by) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(
      "家庭观察：一起种一颗豆子",
      "培养观察能力与责任感",
      "1. 一起泡豆子\n2. 每天观察记录\n3. 周末一起画出变化",
      "「你觉得它明天会有什么变化？为什么？」",
      "拍照或文字记录观察发现",
      15, "观察探究", lastMondayOf(new Date()), teacherId
    ).lastInsertRowid;

    const subId = await db.prepare(
      "INSERT INTO submissions (task_id, child_id, content, sub_type) VALUES (?,?,?,?)"
    ).run(lastTaskId, childId, "豆子发芽了！小明每天早上都先去看它，还画了三张观察图。", "text").lastInsertRowid;

    await db.prepare(
      "INSERT INTO feedback (submission_id, teacher_id, comment, tags, read_at) VALUES (?,?,?,?,datetime('now','localtime'))"
    ).run(subId, teacherId, "坚持观察一整周，非常棒！小明的三张图记录得很细致。", "观察力,坚持");
  } else {
    demoUserId = hasDemo.id;
    var tRow = await db.prepare("SELECT id FROM users WHERE account = '018'").get();
    teacherId = tRow ? tRow.id : null;
  }

  // ===== 以下为扩展演示数据，幂等执行，已有数据库也会补全 =====

  var extraStudents = [
    { name: "小红", grade: "三年级", gender: "女", age: 8, caregiver: "妈妈", interests: "阅读,画画", familyNote: "", timeAvailable: "充足" },
    { name: "小刚", grade: "三年级", gender: "男", age: 9, caregiver: "奶奶", interests: "运动,足球", familyNote: "父母在外地工作，奶奶负责日常照顾", timeAvailable: "有限" },
    { name: "小丽", grade: "三年级", gender: "女", age: 8, caregiver: "爸爸", interests: "音乐,唱歌", familyNote: "", timeAvailable: "适中" },
    { name: "小强", grade: "三年级", gender: "男", age: 9, caregiver: "妈妈、爸爸", interests: "科学,自然", familyNote: "", timeAvailable: "充足" }
  ];

  // 补充小明的档案信息（原种子数据只创建了 name+grade）
  var ming = await db.prepare("SELECT id FROM children WHERE name = '小明'").get();
  if (ming) {
    var mingHas = await db.prepare("SELECT caregiver FROM children WHERE id = ?").get(ming.id);
    if (mingHas && !mingHas.caregiver) {
      await db.prepare("UPDATE children SET gender='男', age=8, caregiver='妈妈', interests='阅读,观察' WHERE id=?").run(ming.id);
      var qExist = await db.prepare("SELECT id FROM questionnaires WHERE child_id = ?").get(ming.id);
      if (!qExist) {
        await db.prepare("INSERT INTO questionnaires (user_id, child_id, answers) VALUES (?,?,?)")
          .run(demoUserId, ming.id, JSON.stringify({ timeAvailable: "充足", familyNote: "", interests: "阅读,观察" }));
      }
    }
  }

  var extraChildIds = {};
  for (const es of extraStudents) {
    var exist = await db.prepare("SELECT id FROM children WHERE name = ?").get(es.name);
    if (exist) { extraChildIds[es.name] = exist.id; return; }
    var cid = await db.prepare(
      "INSERT INTO children (name, grade, gender, age, caregiver, interests, family_note) VALUES (?,?,?,?,?,?,?)"
    ).run(es.name, es.grade, es.gender, es.age, es.caregiver, es.interests, es.familyNote).lastInsertRowid;
    // 创建对应的问卷记录
    await db.prepare("INSERT INTO questionnaires (user_id, child_id, answers) VALUES (?,?,?)")
      .run(demoUserId, cid, JSON.stringify({ timeAvailable: es.timeAvailable, familyNote: es.familyNote, interests: es.interests }));
    extraChildIds[es.name] = cid;
  }

  // ===== 本周班级任务 =====
  var thisWeek = mondayOf(new Date());
  var weekTaskExist = await db.prepare("SELECT id FROM tasks WHERE week_start = ? AND child_id IS NULL").get(thisWeek);
  var weekTaskId;
  if (weekTaskExist) {
    weekTaskId = weekTaskExist.id;
  } else {
    weekTaskId = await db.prepare(
      "INSERT INTO tasks (title, goal, steps, dialogue_tips, submit_hint, duration, task_type, week_start, published_by) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(
      "亲子共读：共读一本好书", "营造家庭阅读氛围，培养孩子表达与思考能力",
      "1. 和孩子一起选一本想读的书\n2. 安静共读 20 分钟\n3. 分享各自最喜欢的段落\n4. 讨论故事中的道理",
      "「你觉得这个故事里，如果你是主角会怎么做？」", "拍照或写一段读后感",
      20, "阅读", thisWeek, teacherId
    ).lastInsertRowid;
  }

  // 小红已提交（待点评）
  var subExist1 = await db.prepare("SELECT id FROM submissions WHERE task_id = ? AND child_id = ?").get(weekTaskId, extraChildIds["小红"]);
  if (!subExist1) {
    var subId2 = await db.prepare(
      "INSERT INTO submissions (task_id, child_id, content, sub_type) VALUES (?,?,?,?)"
    ).run(weekTaskId, extraChildIds["小红"], "和小红一起读了《猜猜我有多爱你》，她特别喜欢里面比较谁更爱谁的情节，还画了一幅画。", "text").lastInsertRowid;
  }

  // 给小刚发布一个个性化任务（祖辈带养适配）
  var personalTaskExist = await db.prepare("SELECT id FROM tasks WHERE week_start = ? AND child_id = ?").get(thisWeek, extraChildIds["小刚"]);
  if (!personalTaskExist) {
    await db.prepare(
      "INSERT INTO tasks (title, goal, steps, dialogue_tips, submit_hint, duration, task_type, week_start, published_by, child_id) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).run(
      "和奶奶一起散步计数", "适合祖辈带养，通过简单散步增进祖孙互动",
      "1. 和奶奶一起去小区散步\n2. 一起数路上看到的小动物\n3. 回家后一起回忆\n4. 把看到的画下来",
      "「你觉得今天散步最有意思的是什么？」", "拍照或写一句话",
      15, "运动", thisWeek, teacherId, extraChildIds["小刚"]
    ).lastInsertRowid;
  }
}
const databaseReady = initializeDatabase(db).then(seed);

/* ============ API 路由 ============ */
async function handleApi(req, res, pathname, query) {
  /* ---- 注册 ---- */
  if (req.method === "POST" && pathname === "/api/auth/register") {
    const body = await readBody(req);
    const account = String(body.account || "").trim();
    const password = String(body.password || "");
    const displayName = String(body.displayName || "").trim();
    if (account.length < 3) return sendJson(res, 400, { message: "账号至少 3 个字符" });
    if (password.length < 6) return sendJson(res, 400, { message: "密码至少 6 位" });
    if (!displayName) return sendJson(res, 400, { message: "请填写称呼" });
    if (await db.prepare("SELECT id FROM users WHERE account = ?").get(account)) {
      return sendJson(res, 409, { message: "该账号已被注册" });
    }
    const userId = await db.prepare(
      "INSERT INTO users (account, password_hash, display_name, role) VALUES (?,?,?, 'parent')"
    ).run(account, hashPassword(password), displayName).lastInsertRowid;
    const token = await createSession(userId);
    return sendJson(res, 200, { token, user: { account, displayName, role: "parent" } });
  }

  /* ---- 登录 ---- */
  if (req.method === "POST" && pathname === "/api/auth/login") {
    const body = await readBody(req);
    const account = String(body.account || "").trim();
    const password = String(body.password || "");
    const user = await db.prepare("SELECT * FROM users WHERE account = ?").get(account);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return sendJson(res, 401, { message: "账号或密码错误" });
    }
    const token = await createSession(user.id);
    return sendJson(res, 200, {
      token,
      user: { account: user.account, displayName: user.display_name, role: user.role }
    });
  }

  /* ---- 以下接口均需登录 ---- */
  const user = await getAuthUser(req);
  if (!user) return sendJson(res, 401, { message: "请先登录" });

  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const token = req.headers["authorization"].slice(7);
    await db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return sendJson(res, 200, { ok: true });
  }

  /* ---- 基础行为埋点 ---- */
  if (req.method === "POST" && pathname === "/api/events") {
    const body = await readBody(req);
    const eventType = String(body.eventType || body.event_type || "").trim();
    const childId = body.childId ? Number(body.childId) : null;
    const taskId = body.taskId ? Number(body.taskId) : null;
    if (!eventType) return sendJson(res, 400, { message: "缺少事件类型" });
    if (childId && !(await canAccessChild(user, childId))) return sendJson(res, 403, { message: "无权记录该孩子事件" });
    await logEvent(user, eventType, childId, taskId, body.meta || {});
    return sendJson(res, 200, { ok: true });
  }

  /* ---- 绑定孩子 ---- */
  if (req.method === "POST" && pathname === "/api/children") {
    if (user.role !== "parent") return sendJson(res, 403, { message: "仅家长账号可绑定孩子" });
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    const grade = String(body.grade || "").trim();
    if (!name) return sendJson(res, 400, { message: "请填写孩子姓名/昵称" });
    const childId = await db.prepare("INSERT INTO children (name, grade) VALUES (?,?)").run(name, grade).lastInsertRowid;
    await db.prepare("INSERT OR IGNORE INTO bindings (user_id, child_id) VALUES (?,?)").run(user.id, childId);
    const child = await db.prepare("SELECT * FROM children WHERE id = ?").get(childId);
    return sendJson(res, 200, { child });
  }

  /* ---- 首页聚合数据 ---- */
  if (req.method === "GET" && pathname === "/api/home") {
    if (user.role !== "parent") return sendJson(res, 403, { message: "仅家长账号可访问家庭首页" });
    const children = await db.prepare(
      "SELECT c.* FROM children c JOIN bindings b ON b.child_id = c.id WHERE b.user_id = ? ORDER BY c.id"
    ).all(user.id);
    const childId = query.get("childId") ? Number(query.get("childId")) : (children[0] && children[0].id);
    const child = children.find((c) => c.id === childId) || null;
    if (query.get("childId") && !child) return sendJson(res, 403, { message: "无权访问该孩子信息" });

    const result = { children, child, task: null, taskStatus: "none", submission: null,
                     feedback: null, unreadCount: 0, timeline: { taskCount: 0, workCount: 0 },
                     needQuestionnaire: false, engagement: null, engagementEnabled: true };
    if (!child) {
      // 首次登录的家长（无孩子且未填问卷）→ 前端跳转问卷页
      const qFilled = await db.prepare("SELECT id FROM questionnaires WHERE user_id = ?").get(user.id);
      result.needQuestionnaire = user.role === "parent" && !qFilled;
      return sendJson(res, 200, result);
    }
    result.engagementEnabled = await getEngagementPreference(user.id, child.id);
    result.engagement = result.engagementEnabled ? await getParentEngagement(user.id, child.id) : null;

    // 本周任务：优先个人任务，其次班级任务
    let task = await db.prepare("SELECT * FROM tasks WHERE week_start = ? AND child_id = ? ORDER BY id DESC LIMIT 1")
      .get(mondayOf(new Date()), child.id);
    if (!task) {
      task = await db.prepare("SELECT * FROM tasks WHERE week_start = ? AND child_id IS NULL ORDER BY id DESC LIMIT 1")
        .get(mondayOf(new Date()));
    }
    if (task) {
      const sub = await db.prepare(
        "SELECT * FROM submissions WHERE task_id = ? AND child_id = ? ORDER BY id DESC LIMIT 1"
      ).get(task.id, child.id);
      let status = "ongoing";
      if (sub) {
        status = sub.status === "draft" ? "draft" : "submitted";
        if (sub.status !== "draft") {
          const fb = await db.prepare("SELECT * FROM feedback WHERE submission_id = ? ORDER BY id DESC LIMIT 1").get(sub.id);
          if (fb) status = "done";
        }
      }
      result.task = task;
      result.taskStatus = status;
      result.submission = sub || null;
    }

    // 最新反馈 + 未读数
    result.feedback = await db.prepare(
      "SELECT f.*, u.display_name AS teacher_name, t.title AS task_title FROM feedback f " +
      "JOIN submissions s ON s.id = f.submission_id " +
      "LEFT JOIN users u ON u.id = f.teacher_id " +
      "JOIN tasks t ON t.id = s.task_id " +
      "WHERE s.child_id = ? ORDER BY f.id DESC LIMIT 1"
    ).get(child.id) || null;
    result.unreadCount = await db.prepare(
      "SELECT COUNT(*) AS n FROM feedback f JOIN submissions s ON s.id = f.submission_id " +
      "WHERE s.child_id = ? AND f.read_at IS NULL"
    ).get(child.id).n;

    // 时间线统计
    result.timeline.taskCount = await db.prepare(
      "SELECT COUNT(DISTINCT task_id) AS n FROM submissions WHERE child_id = ? AND status = 'submitted'"
    ).get(child.id).n;
    result.timeline.workCount = await db.prepare(
      "SELECT COUNT(*) AS n FROM submissions WHERE child_id = ? AND status = 'submitted'"
    ).get(child.id).n;

    return sendJson(res, 200, result);
  }

  /* ---- 首次登录问卷（孩子信息 + 陪伴情况，用于个性化任务） ---- */
  if (req.method === "POST" && pathname === "/api/questionnaire") {
    if (user.role !== "parent") return sendJson(res, 403, { message: "仅家长账号需要填写问卷" });
    const body = await readBody(req);
    const name = String(body.childName || "").trim();
    const gender = String(body.gender || "");
    const age = Number(body.age);
    // 主要陪伴人：支持多选 + 自定义填写
    let caregivers = Array.isArray(body.caregiver)
      ? body.caregiver.filter(Boolean).map(String)
      : (body.caregiver ? [String(body.caregiver)] : []);
    const caregiverOther = String(body.caregiverOther || "").trim();
    if (caregiverOther) caregivers.push(caregiverOther);
    caregivers = [...new Set(caregivers)];
    const caregiver = caregivers.join("、");
    const timeAvailable = String(body.timeAvailable || "");
    const interests = Array.isArray(body.interests) ? body.interests.filter(Boolean).join(",") : "";
    const familyNote = String(body.familyNote || "").trim();
    const grade = String(body.grade || "").trim();

    if (!name) return sendJson(res, 400, { message: "请填写孩子昵称" });
    if (!["男", "女"].includes(gender)) return sendJson(res, 400, { message: "请选择孩子性别" });
    if (!age || age < 3 || age > 18) return sendJson(res, 400, { message: "请填写 3-18 之间的年龄" });
    if (!caregiver) return sendJson(res, 400, { message: "请选择主要陪伴人" });

    // 问卷完成即创建孩子档案并绑定
    const childId = await db.prepare(
      "INSERT INTO children (name, grade, gender, age, caregiver, interests, family_note) VALUES (?,?,?,?,?,?,?)"
    ).run(name, grade, gender, age, caregiver, interests, familyNote).lastInsertRowid;
    await db.prepare("INSERT OR IGNORE INTO bindings (user_id, child_id) VALUES (?,?)").run(user.id, childId);
    await db.prepare(
      "INSERT INTO questionnaires (user_id, child_id, answers) VALUES (?,?,?)"
    ).run(user.id, childId, JSON.stringify({ timeAvailable, familyNote, interests }));
    return sendJson(res, 200, { child: await db.prepare("SELECT * FROM children WHERE id = ?").get(childId) });
  }

  /* ---- 提交作品 ---- */
  if (req.method === "POST" && pathname === "/api/submissions") {
    if (user.role !== "parent") return sendJson(res, 403, { message: "仅家长账号可提交作品" });
    const body = await readBody(req);
    const taskId = Number(body.taskId), childId = Number(body.childId);
    const content = String(body.content || "").trim();
    const subType = ["text", "check", "image", "audio", "video"].includes(body.subType) ? body.subType : "text";
    const status = body.status === "draft" ? "draft" : "submitted";
    const attachments = Array.isArray(body.attachments)
      ? JSON.stringify(body.attachments.slice(0, 6).map((a) => ({
          name: String(a.name || "").slice(0, 80),
          type: String(a.type || "").slice(0, 40),
          size: Number(a.size) || 0,
          url: String(a.url || "").slice(0, 1500000)
        })))
      : "[]";
    if (!taskId || !childId) return sendJson(res, 400, { message: "缺少任务或孩子信息" });
    if (status === "submitted" && !content) return sendJson(res, 400, { message: "请填写提交内容" });
    if (!(await canAccessChild(user, childId))) return sendJson(res, 403, { message: "尚未绑定该孩子" });
    const task = await getVisibleTask(taskId, childId);
    if (!task) return sendJson(res, 403, { message: "该任务不属于当前孩子" });

    // ---- 提交行为增强元数据（素材类型 / 内容长度 / 编辑轮次） ----
    const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
    const attachmentTypes = [];
    rawAttachments.forEach(function (a) {
      const t = String((a && a.type) || "").split("/")[0];
      if (t && attachmentTypes.indexOf(t) < 0) attachmentTypes.push(t);
    });
    const priorDraftCount = await db.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE event_type = 'submission_drafted' AND child_id = ? AND task_id = ?"
    ).get(childId, taskId).n;
    const eventMeta = {
      subType: subType,
      contentLength: content.length,
      attachmentTypes: attachmentTypes,
      fileCount: rawAttachments.length
    };
    if (status === "draft") eventMeta.round = priorDraftCount + 1;
    else eventMeta.draftsBeforeSubmit = priorDraftCount;
    const eventType = status === "draft" ? "submission_drafted" : "submission_submitted";

    const existingSubmitted = await db.prepare(
      "SELECT id FROM submissions WHERE task_id = ? AND child_id = ? AND status = 'submitted' ORDER BY id DESC LIMIT 1"
    ).get(taskId, childId);
    if (existingSubmitted && status === "submitted") {
      return sendJson(res, 409, { message: "该任务已提交，请勿重复提交" });
    }

    const draft = await db.prepare(
      "SELECT id FROM submissions WHERE task_id = ? AND child_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1"
    ).get(taskId, childId);
    if (draft) {
      await db.prepare(
        "UPDATE submissions SET content = ?, sub_type = ?, status = ?, attachments = ?, created_at = datetime('now','localtime') WHERE id = ?"
      ).run(content, subType, status, attachments, draft.id);
      await logEvent(user, eventType, childId, taskId, eventMeta);
      const vector = status === "submitted" && content ? await upsertTeacherSubmissionVector(draft.id) : null;
      return sendJson(res, 200, { id: draft.id, ok: true, status, vectorIndexed: !!(vector && vector.indexed) });
    }

    const id = await db.prepare(
      "INSERT INTO submissions (task_id, child_id, content, sub_type, status, attachments) VALUES (?,?,?,?,?,?)"
    ).run(taskId, childId, content, subType, status, attachments).lastInsertRowid;
    await logEvent(user, eventType, childId, taskId, eventMeta);
    const vector = status === "submitted" && content ? await upsertTeacherSubmissionVector(id) : null;
    return sendJson(res, 200, { id, ok: true, status, vectorIndexed: !!(vector && vector.indexed) });
  }

  /* ---- 成长时间线 ---- */
  if (req.method === "GET" && pathname === "/api/timeline") {
    const childId = query.get("childId") ? Number(query.get("childId")) : null;
    if (!childId) return sendJson(res, 400, { message: "缺少 childId" });
    if (!(await canAccessChild(user, childId))) return sendJson(res, 403, { message: "无权访问该孩子时间线" });
    const items = await db.prepare(
      "SELECT s.id, s.content, s.sub_type, s.attachments, s.created_at, t.title, t.task_type, t.week_start, " +
      "f.id AS feedback_id, f.comment AS feedback_comment, f.tags AS feedback_tags, f.created_at AS feedback_at, " +
      "u.display_name AS teacher_name " +
      "FROM submissions s " +
      "JOIN tasks t ON t.id = s.task_id " +
      "LEFT JOIN feedback f ON f.submission_id = s.id " +
      "LEFT JOIN users u ON u.id = f.teacher_id " +
      "WHERE s.child_id = ? AND s.status = 'submitted' ORDER BY s.id DESC"
    ).all(childId);
    // 标记该孩子的反馈为已读
    await db.prepare(
      "UPDATE feedback SET read_at = datetime('now','localtime') WHERE read_at IS NULL AND submission_id IN " +
      "(SELECT id FROM submissions WHERE child_id = ?)"
    ).run(childId);
    await logEvent(user, "timeline_viewed", childId, null, {});
    return sendJson(res, 200, { items });
  }

  /* ---- 家长关注记录与透明说明 ---- */
  if (req.method === "GET" && pathname === "/api/parent/engagement") {
    if (user.role !== "parent") return sendJson(res, 403, { message: "仅家长账号可查看自己的关注记录" });
    const childId = query.get("childId") ? Number(query.get("childId")) : null;
    if (!childId || !(await canAccessChild(user, childId))) {
      return sendJson(res, 403, { message: "无权访问该孩子的关注记录" });
    }
    const child = await db.prepare("SELECT id, name, grade FROM children WHERE id = ?").get(childId);
    const engagement = await getParentEngagement(user.id, childId);
    const enabled = await getEngagementPreference(user.id, childId);
    await logEvent(user, "engagement_page_viewed", childId, null, {});
    return sendJson(res, 200, {
      child: child,
      engagement: engagement,
      enabled: enabled,
      collected: [
        "系统内通知和任务的查看记录",
        "成长档案的回看记录",
        "提交、草稿和沟通等跟进行为"
      ],
      notCollected: [
        "手机里的其他应用行为",
        "定位、通讯录、麦克风和摄像头",
        "与孩子事项无关的聊天内容"
      ]
    });
  }

  if (req.method === "POST" && pathname === "/api/parent/engagement-preference") {
    if (user.role !== "parent") return sendJson(res, 403, { message: "仅家长账号可修改关注分析设置" });
    const body = await readBody(req);
    const childId = Number(body.childId);
    if (!childId || !(await canAccessChild(user, childId))) {
      return sendJson(res, 403, { message: "无权修改该孩子的关注分析设置" });
    }
    const enabled = body.enabled === false ? 0 : 1;
    await db.prepare(
      "INSERT INTO engagement_preferences (user_id, child_id, enabled, updated_at) VALUES (?,?,?,datetime('now','localtime')) " +
      "ON CONFLICT(user_id, child_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at"
    ).run(user.id, childId, enabled);
    await logEvent(user, enabled ? "engagement_analysis_enabled" : "engagement_analysis_disabled", childId, null, {});
    return sendJson(res, 200, { ok: true, enabled: !!enabled });
  }

  if (req.method === "POST" && pathname === "/api/parent/engagement-feedback") {
    if (user.role !== "parent") return sendJson(res, 403, { message: "仅家长账号可反馈关注分析结果" });
    const body = await readBody(req);
    const childId = Number(body.childId);
    if (!childId || !(await canAccessChild(user, childId))) {
      return sendJson(res, 403, { message: "无权反馈该孩子的关注分析结果" });
    }
    const choice = String(body.choice || "").slice(0, 80);
    if (!choice) return sendJson(res, 400, { message: "缺少反馈内容" });
    await logEvent(user, "engagement_judgment_corrected", childId, null, { choice: choice });
    return sendJson(res, 200, { ok: true });
  }

  /* ---- 教师端 ---- */
  if (user.role !== "teacher") {
    return sendJson(res, 403, { message: "仅教师账号可访问" });
  }

  if (req.method === "POST" && pathname === "/api/teacher/ai-chat") {
    const body = await readBody(req);
    const question = String(body.question || "").trim().slice(0, 1200);
    if (!question) return sendJson(res, 400, { message: "请输入想了解的问题" });
    let indexInfo = { documentCount: 0, embeddedCount: 0 };
    try {
      indexInfo = await syncTeacherVectorIndex();
    } catch (e) {
      console.warn("教师 AI 索引同步失败：", e.message);
    }
    const metricAnswer = await answerTeacherMetricQuestion(question);
    if (metricAnswer) {
      return sendJson(res, 200, {
        answer: metricAnswer.answer,
        sources: metricAnswer.sources,
        provider: "本地规则 + 向量索引",
        indexedDocuments: indexInfo.documentCount,
        embeddedDocuments: indexInfo.embeddedCount
      });
    }
    const matches = await searchTeacherKnowledge(question, 7);
    let answer = "";
    let aiError = "";
    if (getZhipuApiKey() && matches.length) {
      try {
        answer = await generateTeacherChatAnswer(question, body.history, matches);
      } catch (e) {
        aiError = e.message || "智谱 AI 调用失败";
      }
    }
    if (!answer) {
      if (!matches.length) {
        answer = "目前还没有检索到足够的班级资料。请先让家长完成绑定、填写档案或提交任务，再来询问。";
      } else {
        answer = "我已找到相关班级资料，但 AI 暂时无法完成自然语言回答。最相关的记录是：" +
          matches.slice(0, 3).map(function (doc) {
            return "「" + doc.title + "」" + String(doc.content).split("\n")[0];
          }).join("；") + "。";
      }
    }
    return sendJson(res, 200, {
      answer: answer,
      sources: matches.slice(0, 5).map(function (doc) {
        return { title: doc.title, type: doc.metadata && doc.metadata.childId ? "student" : "class" };
      }),
      provider: getZhipuApiKey() && !aiError ? "智谱 AI + 本地向量检索" : "本地检索",
      indexedDocuments: indexInfo.documentCount,
      embeddedDocuments: indexInfo.embeddedCount,
      aiError: aiError || undefined
    });
  }

  if (req.method === "GET" && pathname === "/api/teacher/overview") {
    const weekStart = mondayOf(new Date());
    let task = await db.prepare("SELECT * FROM tasks WHERE week_start = ? AND child_id IS NULL ORDER BY id DESC LIMIT 1").get(weekStart);
    const submissions = await db.prepare(
      "SELECT s.id, s.content, s.sub_type, s.attachments, s.created_at, c.name AS child_name, c.grade, t.title, " +
      "(SELECT COUNT(*) FROM feedback f WHERE f.submission_id = s.id) AS feedback_count " +
      "FROM submissions s JOIN children c ON c.id = s.child_id JOIN tasks t ON t.id = s.task_id " +
      "WHERE s.status = 'submitted' AND " + realStudentWhere("c") + " ORDER BY s.id DESC LIMIT 50"
    ).all(...demoParams(2));
    return sendJson(res, 200, { task, weekStart, submissions });
  }

  if (req.method === "GET" && pathname === "/api/teacher/students") {
    // 学生档案（含问卷信息），同步给教师端做任务定制参考
    const students = (await getTeacherVisibleChildren()).map(function (row) {
      let answers = {};
      try { answers = JSON.parse(row.q_answers || "{}"); } catch (e) {}
      return {
        id: row.id, name: row.name, grade: row.grade, gender: row.gender, age: row.age,
        caregiver: row.caregiver, interests: row.interests, familyNote: row.family_note,
        timeAvailable: answers.timeAvailable || ""
      };
    });
    return sendJson(res, 200, { students });
  }

  if (req.method === "GET" && pathname === "/api/teacher/global-report") {
    const localOnly = query.get("local") === "1";
    const allChildCount = await db.prepare("SELECT COUNT(*) AS n FROM children").get().n;
    const weekStart = mondayOf(new Date());
    const allTasks = await db.prepare("SELECT id, child_id, week_start FROM tasks").all();
    const children = await getTeacherVisibleChildren();
    const submissions = await db.prepare(
      "SELECT s.id, s.child_id, s.task_id, s.content, s.sub_type, s.attachments, s.created_at, " +
      "c.name AS child_name, c.grade, c.caregiver, c.interests, t.title AS task_title, " +
      "t.task_type, t.week_start, t.created_at AS task_created_at, " +
      "(SELECT COUNT(*) FROM feedback f WHERE f.submission_id = s.id) AS feedback_count " +
      "FROM submissions s JOIN children c ON c.id = s.child_id JOIN tasks t ON t.id = s.task_id " +
      "WHERE s.status = 'submitted' AND " + realStudentWhere("c") + " ORDER BY s.created_at DESC"
    ).all(...demoParams(2));
    const weekSubmissions = submissions.filter(function (row) { return row.week_start === weekStart; });
    const weekSubmittedStudents = new Set(weekSubmissions.map(function (row) { return row.child_id; }));
    const weekPendingFeedback = weekSubmissions.filter(function (row) {
      return Number(row.feedback_count || 0) === 0;
    }).length;

    function parseAnswers(row) {
      try { return JSON.parse(row.q_answers || "{}") || {}; } catch (e) { return {}; }
    }
    function pct(part, total) {
      return total > 0 ? Math.round(part / total * 100) : 0;
    }
    function hourOf(value) {
      const text = String(value || "");
      const m = text.match(/\s(\d{1,2}):/);
      return m ? Number(m[1]) : null;
    }
    function dateOf(value) {
      const d = new Date(String(value || "").replace(" ", "T"));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    function bucketOf(hour) {
      if (hour == null) return "未知";
      if (hour >= 5 && hour < 12) return "上午";
      if (hour >= 12 && hour < 18) return "下午";
      if (hour >= 18 && hour < 22) return "晚间";
      return "深夜/清晨";
    }
    function topEntries(map, limit) {
      return Object.entries(map).sort(function (a, b) { return b[1] - a[1]; }).slice(0, limit || 5)
        .map(function (e) { return { label: e[0], count: e[1] }; });
    }
    function addCount(map, key) {
      key = String(key || "").trim() || "未填写";
      map[key] = (map[key] || 0) + 1;
    }
    function textHit(content, words) {
      return words.some(function (w) { return content.indexOf(w) >= 0; });
    }

    const caregiverDist = {};
    const interestDist = {};
    let completeProfiles = 0;
    const profileRows = children.map(function (child) {
      const answers = parseAnswers(child);
      const fields = [child.gender, child.age, child.grade, child.caregiver, child.interests, answers.timeAvailable, child.family_note || answers.familyNote];
      const filled = fields.filter(function (v) { return v != null && String(v).trim(); }).length;
      if (filled >= 5) completeProfiles++;
      if (child.caregiver) {
        String(child.caregiver).split(/[、,，]/).forEach(function (p) { if (p.trim()) addCount(caregiverDist, p.trim()); });
      } else {
        addCount(caregiverDist, "未填写");
      }
      if (child.interests) {
        String(child.interests).split(/[、,，]/).forEach(function (p) { if (p.trim()) addCount(interestDist, p.trim()); });
      }
      return {
        id: child.id,
        name: child.name,
        grade: child.grade,
        caregiver: child.caregiver || "",
        interests: child.interests || "",
        timeAvailable: answers.timeAvailable || "",
        completeness: pct(filled, fields.length)
      };
    });

    const timeBuckets = { "上午": 0, "下午": 0, "晚间": 0, "深夜/清晨": 0, "未知": 0 };
    const weekdayBuckets = { "工作日": 0, "周末": 0, "未知": 0 };
    const childSubmitCount = {};
    let totalLagHours = 0;
    let lagCount = 0;
    submissions.forEach(function (s) {
      const hour = hourOf(s.created_at);
      const bucket = bucketOf(hour);
      timeBuckets[bucket] = (timeBuckets[bucket] || 0) + 1;
      const created = dateOf(s.created_at);
      if (created) {
        const day = created.getDay();
        weekdayBuckets[day === 0 || day === 6 ? "周末" : "工作日"]++;
      } else {
        weekdayBuckets["未知"]++;
      }
      const taskCreated = dateOf(s.task_created_at);
      if (created && taskCreated) {
        totalLagHours += Math.max(0, (created.getTime() - taskCreated.getTime()) / 36e5);
        lagCount++;
      }
      addCount(childSubmitCount, s.child_name);
    });
    const peakTime = topEntries(timeBuckets, 1)[0] || { label: "暂无", count: 0 };
    const avgLagHours = lagCount > 0 ? Math.round(totalLagHours / lagCount) : 0;

    // 两段式响应延迟：任务发布 → 首次查看详情 → 提交
    const firstViewRows = await db.prepare(
      "SELECT child_id, task_id, MIN(created_at) AS t FROM events " +
      "WHERE event_type = 'task_detail_viewed' GROUP BY child_id, task_id"
    ).all();
    const firstViewMap = {};
    firstViewRows.forEach(function (r) {
      const d = dateOf(r.t);
      if (d) firstViewMap[r.child_id + ":" + r.task_id] = d;
    });
    let totalViewLagHours = 0, viewLagCount = 0;
    let totalActionLagHours = 0, actionLagCount = 0;
    submissions.forEach(function (s) {
      const taskCreated = dateOf(s.task_created_at);
      const submitted = dateOf(s.created_at);
      const firstView = firstViewMap[s.child_id + ":" + s.task_id];
      if (taskCreated && firstView) {
        totalViewLagHours += Math.max(0, (firstView.getTime() - taskCreated.getTime()) / 36e5);
        viewLagCount++;
      }
      if (firstView && submitted && submitted.getTime() > firstView.getTime()) {
        totalActionLagHours += Math.max(0, (submitted.getTime() - firstView.getTime()) / 36e5);
        actionLagCount++;
      }
    });
    const avgViewLagHours = viewLagCount > 0 ? Math.round(totalViewLagHours / viewLagCount) : 0;
    const avgActionLagHours = actionLagCount > 0 ? Math.round(totalActionLagHours / actionLagCount) : 0;
    const latencyNote =
      (viewLagCount > 0 ? "发布后平均约 " + avgViewLagHours + " 小时首次查看；" : "暂无首次查看记录；") +
      (actionLagCount > 0 ? "首次查看后平均约 " + avgActionLagHours + " 小时完成提交。" : "暂无查看后提交记录。");

    const textStats = {
      total: submissions.length,
      totalChars: 0,
      positive: 0,
      difficulty: 0,
      collaboration: 0,
      observation: 0,
      samples: []
    };
    const positiveWords = ["喜欢", "开心", "棒", "坚持", "主动", "进步", "认真", "投入", "特别"];
    const difficultyWords = ["难", "不会", "没时间", "忙", "抗拒", "拖拉", "累", "不愿", "忘"];
    const collaborationWords = ["一起", "妈妈", "爸爸", "奶奶", "爷爷", "外婆", "外公", "家长", "陪"];
    const observationWords = ["发现", "观察", "讨论", "为什么", "记录", "画", "读", "计算", "分享"];
    submissions.forEach(function (s) {
      const content = String(s.content || "").trim();
      textStats.totalChars += content.length;
      if (textHit(content, positiveWords)) textStats.positive++;
      if (textHit(content, difficultyWords)) textStats.difficulty++;
      if (textHit(content, collaborationWords)) textStats.collaboration++;
      if (textHit(content, observationWords)) textStats.observation++;
      if (content && textStats.samples.length < 3) {
        textStats.samples.push({
          childName: s.child_name,
          taskTitle: s.task_title,
          snippet: content.length > 56 ? content.slice(0, 56) + "..." : content
        });
      }
    });
    const avgTextLength = textStats.total > 0 ? Math.round(textStats.totalChars / textStats.total) : 0;

    /* ---- 行为埋点维度：家长站内行为信号（近30天 events 表） ---- */
    const behaviorSince = new Date();
    behaviorSince.setDate(behaviorSince.getDate() - 30);
    const behaviorSinceText = behaviorSince.getFullYear() + "-" +
      String(behaviorSince.getMonth() + 1).padStart(2, "0") + "-" +
      String(behaviorSince.getDate()).padStart(2, "0") + " 00:00:00";
    const behaviorRows = await db.prepare(
      "SELECT e.event_type, e.child_id, e.created_at, c.name AS child_name " +
      "FROM events e JOIN children c ON c.id = e.child_id " +
      "WHERE e.created_at >= ? AND " + realStudentWhere("c") + " ORDER BY e.id DESC"
    ).all(behaviorSinceText, ...demoParams(2));

    const behaviorEventCount = {};
    const behaviorByChild = {};
    behaviorRows.forEach(function (row) {
      addCount(behaviorEventCount, row.event_type);
      if (!behaviorByChild[row.child_id]) {
        behaviorByChild[row.child_id] = {
          childId: row.child_id, childName: row.child_name,
          counts: {}, days: new Set(), events: 0
        };
      }
      const child = behaviorByChild[row.child_id];
      child.events++;
      child.counts[row.event_type] = (child.counts[row.event_type] || 0) + 1;
      const day = String(row.created_at || "").slice(0, 10);
      if (day) child.days.add(day);
    });
    function behaviorCat(child, kind) {
      const c = child.counts || {};
      if (kind === "touchpoints") {
        return (c.task_card_viewed || 0) + (c.feedback_card_viewed || 0) + (c.task_detail_viewed || 0);
      }
      if (kind === "exploration") {
        return (c.task_detail_viewed || 0) + (c.timeline_viewed || 0) + (c.feedback_card_viewed || 0);
      }
      return (c.submission_drafted || 0) + (c.submission_submitted || 0) + (c.teacher_contact_started || 0);
    }
    const behaviorChildRows = Object.keys(behaviorByChild).map(function (id) {
      const child = behaviorByChild[id];
      return {
        childId: child.childId,
        childName: child.childName,
        touchpoints: behaviorCat(child, "touchpoints"),
        exploration: behaviorCat(child, "exploration"),
        followThrough: behaviorCat(child, "followThrough"),
        activeDays: child.days.size,
        events: child.events
      };
    }).sort(function (a, b) { return b.events - a.events; });

    const behaviorActiveStudents = behaviorChildRows.length;
    const totalBehaviorEvents = behaviorRows.length;
    const behaviorTypeRows = Object.keys(behaviorEventCount).map(function (key) {
      return {
        label: BEHAVIOR_TYPE_NAMES[key] || key,
        count: behaviorEventCount[key],
        percent: pct(behaviorEventCount[key], totalBehaviorEvents)
      };
    }).sort(function (a, b) { return b.count - a.count; });
    const behaviorTopTypes = behaviorTypeRows.slice(0, 4);
    function behaviorSum(field) {
      return behaviorChildRows.reduce(function (sum, row) { return sum + (row[field] || 0); }, 0);
    }
    const behaviorTouchTotal = behaviorSum("touchpoints");
    const behaviorExploreTotal = behaviorSum("exploration");
    const behaviorFollowTotal = behaviorSum("followThrough");
    const behaviorActiveDaysTotal = behaviorSum("activeDays");
    const behaviorAvgActiveDays = behaviorActiveStudents > 0
      ? Math.round(behaviorActiveDaysTotal / behaviorActiveStudents) : 0;

    const profileCompleteness = pct(completeProfiles, children.length);
    const topCaregivers = topEntries(caregiverDist, 4);
    const topInterests = topEntries(interestDist, 5);
    const activeStudents = Object.keys(childSubmitCount).length;

    const report = {
      generatedAt: new Date().toISOString(),
      source: "本地规则分析",
      aiEnabled: !!(getZhipuApiKey() || process.env.DEEPSEEK_API_KEY),
      dataScope: {
        studentSource: "非 demo 家长绑定或问卷产生的真实学生",
        realStudents: children.length,
        filteredDemoStudents: Math.max(0, allChildCount - children.length),
        storageConfigured: db.isPostgres || !!process.env.DATA_DIR,
        storageMode: db.isPostgres ? "neon" : (process.env.DATA_DIR ? "persistent-disk" : "sqlite")
      },
      stats: {
        totalStudents: children.length,
        profileCompleteness: profileCompleteness,
        totalSubmissions: submissions.length,
        activeStudents: activeStudents,
        peakCompletionTime: peakTime.label,
        avgTextLength: avgTextLength,
        totalTaskCount: allTasks.length,
        customTaskCount: allTasks.filter(function (task) { return task.child_id != null; }).length,
        weekTaskCount: allTasks.filter(function (task) { return task.week_start === weekStart; }).length,
        weekSubmittedStudents: weekSubmittedStudents.size,
        weekPendingFeedback: weekPendingFeedback,
        weekStart: weekStart
      },
      dimensions: [
        {
          key: "profiles",
          title: "学生档案",
          summary: "已建档 " + children.length + " 名学生，完整档案约 " + profileCompleteness + "%。",
          findings: [
            profileCompleteness < 70 ? "档案完整度偏低，影响个性化任务匹配的准确性。" : "档案字段较完整，可支撑分层任务推荐。",
            topCaregivers.length ? "主要陪伴人：" + topCaregivers.map(function (e) { return e.label + " " + e.count + "人"; }).join("、") + "。" : "陪伴人信息不足。",
            topInterests.length ? "兴趣高频项：" + topInterests.map(function (e) { return e.label; }).join("、") + "。" : "兴趣信息不足。"
          ],
          actions: [
            "优先补齐陪伴人、可用时间、兴趣标签三个字段。",
            "用高频兴趣设计班级任务，用陪伴人差异拆分替代方案。"
          ],
          rows: profileRows.slice(0, 6)
        },
        {
          key: "completionTime",
          title: "家长完成任务时间",
          summary: "当前提交高峰集中在" + peakTime.label + "，平均从任务发布到提交约 " + avgLagHours + " 小时。" + latencyNote,
          findings: [
            "晚间/周末提交占比可用于判断提醒推送时段。",
            activeStudents + " 名学生已有正式提交，仍需结合未提交名单做二次触达。",
            avgLagHours > 72 ? "平均提交滞后超过 3 天，建议将提醒前置。" : "提交节奏仍在可跟进范围内。",
            viewLagCount > 0 ? "从发布到首次查看平均约 " + avgViewLagHours + " 小时（反映触达速度），从查看详情到提交平均约 " + avgActionLagHours + " 小时（反映执行效率）。" : "暂无首次查看记录，可先引导家长打开任务详情页。"
          ],
          actions: [
            "将提醒时间设置在提交高峰前 2-4 小时。",
            "对长期不在高峰时段提交的家庭，提供更短任务或周末替代方案。"
          ],
          latency: {
            avgViewLagHours: avgViewLagHours,
            avgActionLagHours: avgActionLagHours,
            avgSubmitLagHours: avgLagHours,
            viewLagCount: viewLagCount,
            actionLagCount: actionLagCount
          },
          distribution: Object.keys(timeBuckets).map(function (key) {
            return { label: key, count: timeBuckets[key], percent: pct(timeBuckets[key], submissions.length) };
          }),
          weekdayDistribution: Object.keys(weekdayBuckets).map(function (key) {
            return { label: key, count: weekdayBuckets[key], percent: pct(weekdayBuckets[key], submissions.length) };
          })
        },
        {
          key: "textMaterials",
          title: "家长上传的文字素材分析",
          summary: "共分析 " + submissions.length + " 份文字提交，平均每份约 " + avgTextLength + " 字。",
          findings: [
            "积极表达出现 " + textStats.positive + " 次，亲子协作线索出现 " + textStats.collaboration + " 次。",
            "困难/阻力线索出现 " + textStats.difficulty + " 次，可作为后续关怀名单参考。",
            "观察、记录、讨论类学习过程线索出现 " + textStats.observation + " 次。"
          ],
          actions: [
            textStats.difficulty > 0 ? "优先查看包含困难线索的提交，给出更具体的减负建议。" : "继续鼓励家长记录过程性细节，而不只提交结果。",
            "点评时提取家长原文中的动作和情绪词，反馈会更有针对性。"
          ],
          indicators: {
            positive: textStats.positive,
            difficulty: textStats.difficulty,
            collaboration: textStats.collaboration,
            observation: textStats.observation
          },
          samples: textStats.samples
        },
        {
          key: "behaviorSignals",
          title: "家长行为参与信号（埋点）",
          summary: "近30天共记录 " + totalBehaviorEvents + " 次站内行为事件，" + behaviorActiveStudents +
            " 名学生有行为记录" + (behaviorActiveStudents > 0 ? "，平均活跃 " + behaviorAvgActiveDays + " 天" : "") + "。",
          findings: [
            behaviorActiveStudents > 0
              ? "有行为记录的学生 " + behaviorActiveStudents + " 名，触达类行为（查看卡片/详情/反馈）" + behaviorTouchTotal +
                " 次，执行类行为（起草/提交/发起沟通）" + behaviorFollowTotal + " 次。"
              : "近30天暂无家长站内行为记录，埋点已启用但尚无活动，先保持轻量提醒即可。",
            behaviorTopTypes.length
              ? "高频行为：" + behaviorTopTypes.map(function (e) { return e.label + " " + e.count + "次"; }).join("、") + "。"
              : "暂无行为事件可统计。",
            behaviorFollowTotal > 0
              ? "已有家庭进入执行环节（起草、提交、发起沟通），可在此基础上安排个性化跟进。"
              : "执行类行为较少，重点先降低参与门槛。",
            "站内行为仅反映系统内可见活动，不等同于家长真实关注程度。"
          ],
          actions: [
            behaviorTouchTotal === 0
              ? "对近30天无任何行为的家庭，保持轻量提醒即可，避免打扰。"
              : "结合提交时段维度，在活跃时段前 2-4 小时推送提醒。",
            behaviorFollowTotal > 0
              ? "对进入执行环节的家庭，点评时多给具体肯定，形成正向循环。"
              : "为尚未进入执行环节的家庭提供更短任务或周末替代方案。"
          ],
          indicators: {
            events: totalBehaviorEvents,
            activeStudents: behaviorActiveStudents,
            avgActiveDays: behaviorAvgActiveDays,
            touchpoints: behaviorTouchTotal,
            exploration: behaviorExploreTotal,
            followThrough: behaviorFollowTotal
          },
          distribution: behaviorTypeRows,
          rows: behaviorChildRows
        }
      ]
    };

    if (localOnly) return sendJson(res, 200, report);

    try {
      await syncTeacherVectorIndex();
    } catch (e) {
      report.aiError = "向量索引更新失败，已使用本地规则分析";
    }

    if (getZhipuApiKey() || process.env.DEEPSEEK_API_KEY) {
      try {
        const ai = getZhipuApiKey()
          ? await generateZhipuReport(report)
          : await generateDeepSeekReport(report);
        if (ai) {
          report.source = getZhipuApiKey() ? "智谱 AI" : "DeepSeek AI";
          report.ai = ai;
          if (Array.isArray(ai.dimensions)) {
            report.dimensions = report.dimensions.map(function (dim) {
              const enhanced = ai.dimensions.find(function (d) { return d && d.key === dim.key; });
              if (!enhanced) return dim;
              return Object.assign({}, dim, {
                aiSummary: enhanced.summary || dim.summary,
                findings: Array.isArray(enhanced.findings) && enhanced.findings.length ? enhanced.findings : dim.findings,
                actions: Array.isArray(enhanced.actions) && enhanced.actions.length ? enhanced.actions : dim.actions
              });
            });
          }
        }
      } catch (e) {
        report.aiError = e.message || "AI 分析调用失败，已使用本地规则分析";
      }
    }

    return sendJson(res, 200, report);
  }

  /* ---- 班级规则概览 ---- */
  if (req.method === "GET" && pathname === "/api/teacher/ai-overview") {
    const weekStart = mondayOf(new Date());
    const allChildren = await getTeacherVisibleChildren();
    const totalStudents = allChildren.length;

    const classTask = await db.prepare(
      "SELECT * FROM tasks WHERE week_start = ? AND child_id IS NULL ORDER BY id DESC LIMIT 1"
    ).get(weekStart);
    const personalTasks = await db.prepare(
      "SELECT t.* FROM tasks t JOIN children c ON c.id = t.child_id " +
      "WHERE t.week_start = ? AND t.child_id IS NOT NULL AND " + realStudentWhere("c") + " ORDER BY t.id DESC"
    ).all(weekStart, ...demoParams(2));

    const allSubs = await db.prepare(
      "SELECT s.id, s.child_id, c.name AS child_name, c.grade, c.caregiver, t.title AS task_title " +
      "FROM submissions s JOIN children c ON c.id = s.child_id JOIN tasks t ON t.id = s.task_id " +
      "WHERE t.week_start = ? AND s.status = 'submitted' AND " + realStudentWhere("c") + " ORDER BY s.id DESC"
    ).all(weekStart, ...demoParams(2));

    const submittedIds = new Set(allSubs.map(s => s.child_id));
    const submittedCount = submittedIds.size;
    const completionRate = totalStudents > 0 ? Math.round(submittedCount / totalStudents * 100) : 0;

    // 反馈统计
    let feedbackedCount = 0;
    for (const s of allSubs) {
      const n = (await db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE submission_id = ?").get(s.id)).n;
      if (n > 0) feedbackedCount++;
    }
    const pendingFeedback = allSubs.length - feedbackedCount;
    const feedbackRate = allSubs.length > 0 ? Math.round(feedbackedCount / allSubs.length * 100) : 0;

    const unsubmittedStudents = allChildren.filter(c => !submittedIds.has(c.id));

    // 陪伴人分布
    const caregiverDist = {};
    allChildren.forEach(function (c) {
      if (c.caregiver) {
        c.caregiver.split("、").forEach(function (p) {
          p = p.trim();
          if (p) caregiverDist[p] = (caregiverDist[p] || 0) + 1;
        });
      }
    });

    // 兴趣分布
    const interestDist = {};
    allChildren.forEach(function (c) {
      if (c.interests) {
        c.interests.split(",").forEach(function (i) {
          i = i.trim();
          if (i) interestDist[i] = (interestDist[i] || 0) + 1;
        });
      }
    });

    // 规则洞察生成
    const insights = [];
    if (!classTask && personalTasks.length === 0) {
      insights.push("本周尚未发布任务，点击学生档案可为其定制个性化成长任务");
    } else {
      if (completionRate < 50) {
        insights.push("本周任务完成率 " + completionRate + "%，偏低，建议周三发送提醒");
      } else if (completionRate >= 80) {
        insights.push("本周任务完成率 " + completionRate + "%，班级参与度高，继续保持");
      } else {
        insights.push("本周任务完成率 " + completionRate + "%，表现平稳");
      }
      if (pendingFeedback > 0) {
        insights.push("还有 " + pendingFeedback + " 份提交待点评，建议及时反馈以保持家长积极性");
      } else if (allSubs.length > 0) {
        insights.push("所有提交均已点评，反馈及时");
      }
      const grandparentCare = allChildren.filter(function (c) {
        if (!c.caregiver) return false;
        return ["奶奶", "爷爷", "外婆", "外公", "祖辈"].some(function (g) {
          return c.caregiver.includes(g);
        });
      });
      if (grandparentCare.length > 0) {
        const gpDone = grandparentCare.filter(function (c) { return submittedIds.has(c.id); }).length;
        insights.push("祖辈带养家庭 " + grandparentCare.length + " 户，其中 " + gpDone + " 户已提交，建议关注其参与难度并提供简化方案");
      }
      if (personalTasks.length > 0) {
        const pSet = new Set(personalTasks.map(t => t.child_id));
        insights.push("已为 " + pSet.size + " 名学生发布了个性化任务，精准化推进中");
      }
    }
    const topInterests = Object.entries(interestDist)
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 3).map(function (e) { return e[0]; });
    if (topInterests.length > 0) {
      insights.push("班级兴趣热点：" + topInterests.join("、") + "，可据此设计下周任务方向");
    }

    const engagementRows = [];
    for (const child of allChildren) {
      const binding = await db.prepare(
        "SELECT b.user_id FROM bindings b JOIN users u ON u.id = b.user_id " +
        "WHERE b.child_id = ? AND u.role = 'parent' AND u.account NOT IN (" + demoAccountPlaceholders() + ") " +
        "ORDER BY b.id LIMIT 1"
      ).get(child.id, ...demoParams(1));
      const enabled = binding ? await getEngagementPreference(binding.user_id, child.id) : false;
      const engagement = binding && enabled ? await getParentEngagement(binding.user_id, child.id) : {
        windowDays: 30, score: 0, level: "证据不足", status: "insufficient",
        confidence: "低", evidence: [], recommendation: "暂不下结论，先提供一次清晰摘要",
        counts: { touchpoints: 0, exploration: 0, followThrough: 0, activeDays: 0, events: 0 }
      };
      engagementRows.push({
        childId: child.id,
        childName: child.name,
        caregiver: child.caregiver || "",
        enabled: enabled,
        engagement: engagement
      });
    }
    const engagementSummary = {
      high: engagementRows.filter(function (r) { return r.engagement.status === "high"; }).length,
      medium: engagementRows.filter(function (r) { return r.engagement.status === "medium"; }).length,
      low: engagementRows.filter(function (r) { return r.engagement.status === "low"; }).length,
      insufficient: engagementRows.filter(function (r) { return r.engagement.status === "insufficient"; }).length
    };

    return sendJson(res, 200, {
      stats: {
        totalStudents: totalStudents, submittedCount: submittedCount, completionRate: completionRate,
        totalSubmissions: allSubs.length, feedbackedCount: feedbackedCount,
        pendingFeedback: pendingFeedback, feedbackRate: feedbackRate,
        personalTaskCount: personalTasks.length
      },
      task: classTask,
      personalTasks: personalTasks.map(function (t) {
        const ch = allChildren.find(function (c) { return c.id === t.child_id; });
        return { id: t.id, title: t.title, child_id: t.child_id, child_name: ch ? ch.name : "" };
      }),
      insights: insights,
      unsubmittedStudents: unsubmittedStudents.map(function (c) {
        return { id: c.id, name: c.name, grade: c.grade, caregiver: c.caregiver };
      }),
      caregiverDistribution: caregiverDist,
      interestDistribution: interestDist,
      engagementSummary: engagementSummary,
      engagementRows: engagementRows
    });
  }

  /* ---- 规则个性化任务建议（基于学生档案） ---- */
  if (req.method === "GET" && pathname === "/api/teacher/student-suggestions") {
    const childId = query.get("childId") ? Number(query.get("childId")) : null;
    if (!childId) return sendJson(res, 400, { message: "缺少 childId" });

    const student = await db.prepare(
      "SELECT c.*, q.answers AS q_answers FROM children c " +
      latestQuestionnaireJoin() +
      "WHERE c.id = ? AND " + realStudentWhere("c")
    ).get(childId, ...demoParams(2));
    if (!student) return sendJson(res, 404, { message: "学生不存在" });

    let answers = {};
    try { answers = JSON.parse(student.q_answers || "{}"); } catch (e) {}
    const timeAvailable = answers.timeAvailable || "";

    // 历史提交
    const history = await db.prepare(
      "SELECT t.task_type FROM submissions s JOIN tasks t ON t.id = s.task_id WHERE s.child_id = ? ORDER BY s.id DESC"
    ).all(childId);
    const completedTypes = [...new Set(history.map(h => h.task_type))];
    const totalCompleted = history.length;

    // 兴趣 → 任务类型
    const interestMap = {
      "阅读": "阅读", "绘本": "阅读", "书": "阅读", "故事": "阅读",
      "运动": "运动健身", "足球": "运动健身", "跳绳": "运动健身", "跑步": "运动健身", "游泳": "运动健身", "篮球": "运动健身", "羽毛球": "运动健身",
      "画画": "观察探究", "绘画": "观察探究", "手工": "学科应用", "折纸": "学科应用", "艺术": "观察探究",
      "做饭": "家务实践", "家务": "家务实践", "整理": "家务实践", "烹饪": "家务实践",
      "朋友": "情绪社交", "社交": "情绪社交", "聊天": "情绪社交",
      "科学": "观察探究", "实验": "观察探究", "自然": "观察探究", "植物": "观察探究", "动物": "观察探究",
      "数学": "学科应用", "英语": "学科应用", "语文": "学科应用", "写字": "学科应用",
      "音乐": "情绪社交", "唱歌": "情绪社交", "乐器": "情绪社交"
    };

    // 任务模板库
    const taskTemplates = {
      "阅读": [
        { title: "亲子共读：绘本角色扮演", goal: "通过角色扮演深化阅读理解，培养表达能力", steps: "1. 选择一本孩子喜欢的绘本\n2. 分配角色，家长和孩子各演一个\n3. 一起读故事，到对话部分就表演出来\n4. 结束后聊聊最喜欢哪个角色", dialogueTips: "「你觉得这个故事里，如果你是主角会怎么做？」", submitHint: "拍照或录一段表演视频" },
        { title: "家庭阅读角：共读20分钟", goal: "营造家庭阅读氛围，培养日常阅读习惯", steps: "1. 和孩子一起选一个家里的角落布置阅读角\n2. 各自选一本想读的书\n3. 一起安静阅读20分钟\n4. 分享各自读到的有趣内容", dialogueTips: "「你读到的这段，最让你惊讶的是什么？」", submitHint: "拍一张阅读角照片，写一句感受" }
      ],
      "运动健身": [
        { title: "亲子运动挑战：一起跳绳", goal: "通过运动增进亲子默契，锻炼身体协调性", steps: "1. 准备一根跳绳\n2. 家长先示范，孩子计数\n3. 换孩子跳，家长计数鼓励\n4. 尝试一起跳10个", dialogueTips: "「你觉得一起跳绳和一个人跳有什么不同？」", submitHint: "拍一段跳绳视频或写感受" },
        { title: "家庭趣味运动会", goal: "在运动中体验合作与竞争的平衡", steps: "1. 设计3个小项目（如夹球跑、投准、接力）\n2. 家长和孩子轮流比赛\n3. 互相计时和加油\n4. 一起复盘哪个最有趣", dialogueTips: "「你觉得赢的感觉和输的感觉有什么不同？」", submitHint: "拍照片或写一段运动感受" }
      ],
      "观察探究": [
        { title: "家庭观察实验：种一颗豆子", goal: "培养观察记录能力与生命责任感", steps: "1. 一起泡豆子\n2. 每天观察并记录变化\n3. 周末一起画出成长图\n4. 讨论植物生长的条件", dialogueTips: "「你觉得它明天会有什么变化？为什么？」", submitHint: "拍照或文字记录观察发现" },
        { title: "自然探索：小区里的秘密", goal: "培养观察力与科学探究兴趣", steps: "1. 带孩子去小区或附近散步\n2. 寻找3种不同的植物或昆虫\n3. 拍照并讨论它们的特点\n4. 回家一起查资料了解", dialogueTips: "「你觉得这个小虫子为什么生活在这里？」", submitHint: "拍照记录并写一句发现" }
      ],
      "情绪社交": [
        { title: "情绪卡片：画出今天的心情", goal: "帮助孩子认识和表达情绪", steps: "1. 准备纸和彩笔\n2. 各自画出今天的心情\n3. 互相分享画的内容\n4. 讨论为什么会有这种感受", dialogueTips: "「今天最开心的事是什么？最难过的呢？」", submitHint: "拍照心情卡片或写感受" },
        { title: "角色互换：今天我来当大人", goal: "培养换位思考能力和同理心", steps: "1. 设定一个生活场景（如做决定）\n2. 孩子扮演大人角色\n3. 家长扮演孩子\n4. 结束后讨论感受", dialogueTips: "「当大人的感觉怎么样？和想象中一样吗？」", submitHint: "录一段对话或写感受" }
      ],
      "家务实践": [
        { title: "今天我当家：一起做一顿饭", goal: "培养生活技能和家庭责任感", steps: "1. 一起决定做什么菜\n2. 分工准备食材\n3. 一起完成烹饪\n4. 一起收拾厨房", dialogueTips: "「你觉得做饭最难的是哪一步？」", submitHint: "拍照或写感受" },
        { title: "整理小能手：给房间大变身", goal: "培养整理收纳习惯和审美", steps: "1. 选一个区域（书桌/衣柜）\n2. 一起分类物品\n3. 决定保留和丢弃\n4. 重新布置", dialogueTips: "「你觉得整理后和整理前有什么不同？」", submitHint: "拍整理前后的对比照" }
      ],
      "学科应用": [
        { title: "生活中的数学：超市小账本", goal: "将数学知识应用到真实生活场景", steps: "1. 去超市前一起列购物清单\n2. 给孩子一个预算\n3. 孩子负责计算价格\n4. 结账时核对", dialogueTips: "「你觉得为什么同样的东西不同牌子价格不同？」", submitHint: "拍购物小票或写计算过程" },
        { title: "创意写作：给物品写自传", goal: "培养观察力、想象力和写作能力", steps: "1. 选一件家里的物品\n2. 以物品的视角写一段自传\n3. 家长也写一篇\n4. 互相朗读", dialogueTips: "「如果你是这件物品，你最想说什么？」", submitHint: "写一段文字或拍照" }
      ],
      "习惯养成": [
        { title: "21天习惯养成打卡", goal: "通过持续打卡培养好习惯", steps: "1. 和孩子一起选一个想养成的小习惯\n2. 制作打卡表格\n3. 每天完成后打卡\n4. 周末一起回顾", dialogueTips: "「坚持了这几天，你感觉自己有什么变化？」", submitHint: "拍打卡表或写感受" },
        { title: "早睡早起挑战周", goal: "培养健康作息习惯", steps: "1. 和孩子约定每天睡觉和起床时间\n2. 制作作息表\n3. 每天记录是否达标\n4. 周末统计达成率", dialogueTips: "「你觉得早睡后第二天感觉怎么样？」", submitHint: "拍作息表或写感受" }
      ]
    };

    const interests = (student.interests || "").split(",").filter(Boolean).map(s => s.trim());
    const suggestedTypes = [];
    const usedTypes = new Set();

    // 基于兴趣匹配
    interests.forEach(function (interest) {
      Object.keys(interestMap).forEach(function (key) {
        if (interest.includes(key) || key.includes(interest)) {
          var type = interestMap[key];
          if (!usedTypes.has(type)) { suggestedTypes.push(type); usedTypes.add(type); }
        }
      });
    });
    // 补充未做过的类型
    var allTypes = ["阅读", "运动健身", "观察探究", "情绪社交", "家务实践", "学科应用", "习惯养成"];
    allTypes.forEach(function (type) {
      if (!usedTypes.has(type) && !completedTypes.includes(type)) {
        suggestedTypes.push(type); usedTypes.add(type);
      }
    });
    // 至少3个
    allTypes.forEach(function (type) {
      if (suggestedTypes.length < 3 && !usedTypes.has(type)) {
        suggestedTypes.push(type); usedTypes.add(type);
      }
    });

    // 陪伴人 & 时长调整
    var isGrandparent = student.caregiver && ["奶奶", "爷爷", "外婆", "外公", "祖辈"].some(function (g) {
      return student.caregiver.includes(g);
    });
    var baseDuration = 20;
    if (timeAvailable.includes("充足") || timeAvailable.includes("很多") || timeAvailable.includes("多")) baseDuration = 30;
    else if (timeAvailable.includes("有限") || timeAvailable.includes("少") || timeAvailable.includes("很少")) baseDuration = 15;
    if (isGrandparent) baseDuration = Math.min(baseDuration, 15);

    var suggestions = suggestedTypes.slice(0, 3).map(function (type) {
      var templates = taskTemplates[type] || taskTemplates["阅读"];
      var tpl = templates[Math.floor(Math.random() * templates.length)];
      var reasons = [];
      var matchedInterests = interests.filter(function (i) {
        return Object.keys(interestMap).some(function (key) {
          return (i.includes(key) || key.includes(i)) && interestMap[key] === type;
        });
      });
      if (matchedInterests.length > 0) reasons.push("基于孩子对「" + matchedInterests.join("、") + "」的兴趣");
      if (student.caregiver) {
        if (isGrandparent) reasons.push("考虑到祖辈带养，选用步骤简单、材料易得的方案");
        else reasons.push("配合「" + student.caregiver + "」的陪伴方式");
      }
      if (timeAvailable) reasons.push("适配家庭可用时间（" + timeAvailable + "）");
      if (completedTypes.includes(type)) reasons.push("孩子已参与过此类任务，建议尝试进阶版本");
      else reasons.push("丰富孩子尚未体验的任务类型");

      return {
        title: tpl.title, type: type,
        duration: isGrandparent ? Math.min(baseDuration, 15) : baseDuration,
        goal: tpl.goal, steps: tpl.steps, dialogueTips: tpl.dialogueTips,
        submitHint: tpl.submitHint, rationale: reasons.join("；")
      };
    });

    return sendJson(res, 200, {
      student: {
        id: student.id, name: student.name, grade: student.grade,
        gender: student.gender, age: student.age, caregiver: student.caregiver,
        interests: student.interests, familyNote: student.family_note || "",
        timeAvailable: timeAvailable
      },
      suggestions: suggestions,
      history: { totalCompleted: totalCompleted, completedTypes: completedTypes }
    });
  }

  if (req.method === "POST" && pathname === "/api/teacher/tasks") {
    const body = await readBody(req);
    const title = String(body.title || "").trim();
    if (!title) return sendJson(res, 400, { message: "请填写任务标题" });
    const weekStart = mondayOf(new Date());
    const childId = body.childId ? Number(body.childId) : null;
    const difficulty = ["简单", "普通", "进阶"].includes(body.difficulty) ? body.difficulty : "普通";
    const materials = String(body.materials || "").trim();
    const fallbackPlan = String(body.fallbackPlan || body.fallback_plan || "").trim();

    if (childId) {
      if (!(await canAccessChild(user, childId))) return sendJson(res, 404, { message: "学生不存在" });
      // 个人任务：直接新建
      await db.prepare(
        "INSERT INTO tasks (title, goal, steps, dialogue_tips, submit_hint, duration, task_type, week_start, published_by, child_id, difficulty, materials, fallback_plan) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).run(
        title, String(body.goal || ""), String(body.steps || ""),
        String(body.dialogueTips || ""), String(body.submitHint || ""),
        Number(body.duration) || 20, String(body.type || "阅读"), weekStart, user.id, childId,
        difficulty, materials, fallbackPlan
      );
    } else {
      // 班级任务：本周已有则更新
      const existing = await db.prepare("SELECT id FROM tasks WHERE week_start = ? AND child_id IS NULL ORDER BY id DESC LIMIT 1").get(weekStart);
      const params = [
        title, String(body.goal || ""), String(body.steps || ""),
        String(body.dialogueTips || ""), String(body.submitHint || ""),
        Number(body.duration) || 20, String(body.type || "阅读"), weekStart, user.id,
        difficulty, materials, fallbackPlan
      ];
      if (existing) {
        await db.prepare(
          "UPDATE tasks SET title=?, goal=?, steps=?, dialogue_tips=?, submit_hint=?, duration=?, task_type=?, published_by=?, difficulty=?, materials=?, fallback_plan=? WHERE id=?"
        ).run(params[0], params[1], params[2], params[3], params[4], params[5], params[6], params[8], params[9], params[10], params[11], existing.id);
      } else {
        await db.prepare(
          "INSERT INTO tasks (title, goal, steps, dialogue_tips, submit_hint, duration, task_type, week_start, published_by, difficulty, materials, fallback_plan) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
        ).run(...params);
      }
    }
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/teacher/feedback") {
    const body = await readBody(req);
    const submissionId = Number(body.submissionId);
    const comment = String(body.comment || "").trim();
    if (!submissionId || !comment) return sendJson(res, 400, { message: "请填写点评内容" });
    const submission = await db.prepare("SELECT id FROM submissions WHERE id = ? AND status = 'submitted'").get(submissionId);
    if (!submission) return sendJson(res, 404, { message: "提交不存在或尚未正式提交" });
    await db.prepare(
      "INSERT INTO feedback (submission_id, teacher_id, comment, tags) VALUES (?,?,?,?)"
    ).run(submissionId, user.id, comment, cleanTags(body.tags));
    await upsertTeacherSubmissionVector(submissionId);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { message: "接口不存在" });
}

/* ============ 静态文件 ============ */
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon"
};
function serveStatic(req, res, pathname) {
  if (pathname.split("/").some(function (part) { return part === ".env" || part.startsWith(".env."); })) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("404 Not Found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

/* ============ 启动 ============ */
const server = http.createServer(async (req, res) => {
  /* CORS：Vercel 前端跨域调用后端接口需要（前端/后端分离部署） */
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  try {
    await databaseReady;
    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname, url.searchParams);
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (e) {
    sendJson(res, 500, { message: e.message || "服务器错误" });
  }
});

server.listen(PORT, () => {
  console.log("家校共育系统已启动: http://localhost:" + PORT);
  console.log(db.isPostgres ? "数据库：Neon PostgreSQL" : "数据库：本地 SQLite");
});
