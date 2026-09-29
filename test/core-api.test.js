const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "home-school-test-"));
process.env.DATA_DIR = dataDir;
process.env.DATABASE_URL = "";
process.env.ZHIPU_API_KEY = "";
process.env.DEEPSEEK_API_KEY = "";
process.env.PORT = "0";
process.env.NODE_ENV = "test";

const app = require("../server");
let baseUrl;
let parentToken;
let teacherToken;
let childId;
let taskId;
let submissionId;

async function request(pathname, options) {
  options = options || {};
  const headers = Object.assign({}, options.headers || {});
  if (options.token) headers.Authorization = "Bearer " + options.token;
  if (options.body) headers["Content-Type"] = "application/json";
  const response = await fetch(baseUrl + pathname, {
    method: options.method || "GET",
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data = {};
  const text = await response.text();
  try { data = text ? JSON.parse(text) : {}; } catch (error) { data = { text: text }; }
  return { response, data };
}

before(async function () {
  await app.databaseReady;
  await new Promise(function (resolve) {
    app.server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = "http://127.0.0.1:" + app.server.address().port;
});

after(async function () {
  await new Promise(function (resolve) {
    if (!app.server.listening) return resolve();
    app.server.close(resolve);
  });
  await app.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("database transaction rolls back failed writes", async function () {
  const beforeCount = Number((await app.db.prepare("SELECT COUNT(*) AS n FROM users").get()).n);
  await assert.rejects(
    app.db.transaction(async function (tx) {
      await tx.prepare(
        "INSERT INTO users (account, password_hash, display_name, role) VALUES (?,?,?,'parent')"
      ).run("rollback-user", "hash", "回滚测试");
      throw new Error("force rollback");
    }),
    /force rollback/
  );
  const afterCount = Number((await app.db.prepare("SELECT COUNT(*) AS n FROM users").get()).n);
  assert.equal(afterCount, beforeCount);
});

test("core parent and teacher workflow remains compatible", async function () {
  const account = "parent_" + Date.now();
  let result = await request("/api/auth/register", {
    method: "POST",
    body: { account: account, password: "123456", displayName: "测试家长" }
  });
  assert.equal(result.response.status, 200);
  assert.ok(result.data.token);
  parentToken = result.data.token;

  result = await request("/api/home", { token: parentToken });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.needQuestionnaire, true);

  result = await request("/api/questionnaire", {
    method: "POST",
    token: parentToken,
    body: {
      childName: "测试孩子",
      gender: "女",
      age: 9,
      caregiver: ["妈妈"],
      timeAvailable: "适中",
      taskPreference: "低负担",
      interests: ["阅读", "观察"],
      familyNote: "",
      grade: "三年级"
    }
  });
  assert.equal(result.response.status, 200);
  childId = Number(result.data.child.id);
  assert.ok(childId);

  result = await request("/api/auth/login", {
    method: "POST",
    body: { account: "018", password: "018018" }
  });
  assert.equal(result.response.status, 200);
  teacherToken = result.data.token;

  result = await request("/api/teacher/tasks", {
    method: "POST",
    token: teacherToken,
    body: {
      title: "测试班级任务",
      type: "观察探究",
      duration: 15,
      goal: "完成一次家庭观察",
      steps: "1. 一起观察\n2. 记录发现",
      dialogueTips: "你发现了什么？",
      submitHint: "提交文字记录",
      materials: "纸笔",
      fallbackPlan: "时间有限时只记录一句话",
      difficulty: "简单"
    }
  });
  assert.equal(result.response.status, 200);

  result = await request("/api/home?childId=" + childId, { token: parentToken });
  assert.equal(result.response.status, 200);
  taskId = Number(result.data.task.id);
  assert.ok(taskId);

  result = await request("/api/submissions", {
    method: "POST",
    token: parentToken,
    body: { taskId, childId, status: "draft", content: "", attachments: [] }
  });
  assert.equal(result.response.status, 200);
  submissionId = Number(result.data.id);

  result = await request("/api/submissions", {
    method: "POST",
    token: parentToken,
    body: {
      taskId,
      childId,
      status: "submitted",
      content: "我们观察到阳台上的植物长出了新叶。",
      attachments: []
    }
  });
  assert.equal(result.response.status, 200);
  assert.equal(Number(result.data.id), submissionId);

  result = await request("/api/submissions", {
    method: "POST",
    token: parentToken,
    body: {
      taskId,
      childId,
      status: "submitted",
      content: "重复提交",
      attachments: []
    }
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.data.errorCode, "SUBMISSION_EXISTS");

  result = await request("/api/teacher/feedback", {
    method: "POST",
    token: teacherToken,
    body: { submissionId, comment: "记录得很具体。", tags: ["观察力"] }
  });
  assert.equal(result.response.status, 200);

  result = await request("/api/timeline?childId=" + childId, { token: parentToken });
  assert.equal(result.response.status, 200);
  assert.ok(result.data.items.some(function (item) { return item.feedback_comment === "记录得很具体。"; }));

  result = await request("/api/teacher/overview", { token: parentToken });
  assert.equal(result.response.status, 403);

  result = await request("/api/teacher/overview", { token: teacherToken });
  assert.equal(result.response.status, 200);
  assert.ok(result.data.submissions.some(function (item) { return Number(item.id) === submissionId; }));

  result = await request("/api/teacher/ai-chat", {
    method: "POST",
    token: teacherToken,
    body: { question: "本周谁未提交？" }
  });
  assert.equal(result.response.status, 200);
  assert.ok(result.data.answer);

  result = await request("/api/teacher/tasks", {
    method: "POST",
    token: teacherToken,
    body: {
      childId,
      title: "并发提交测试任务",
      type: "观察探究",
      duration: 10,
      goal: "测试重复请求保护",
      steps: "完成一次简短观察"
    }
  });
  assert.equal(result.response.status, 200);
  result = await request("/api/home?childId=" + childId, { token: parentToken });
  const concurrentTaskId = Number(result.data.task.id);
  const concurrentResults = await Promise.all([
    request("/api/submissions", {
      method: "POST",
      token: parentToken,
      body: { taskId: concurrentTaskId, childId, status: "submitted", content: "并发提交一", attachments: [] }
    }),
    request("/api/submissions", {
      method: "POST",
      token: parentToken,
      body: { taskId: concurrentTaskId, childId, status: "submitted", content: "并发提交二", attachments: [] }
    })
  ]);
  assert.deepEqual(
    concurrentResults.map(function (item) { return item.response.status; }).sort(),
    [200, 409]
  );
});

test("input and static file boundaries are enforced", async function () {
  let result = await request("/api/submissions", {
    method: "POST",
    token: parentToken,
    body: {
      taskId,
      childId,
      status: "draft",
      content: "",
      attachments: [{ type: "application/x-msdownload", name: "bad.exe", size: 10, url: "" }]
    }
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.errorCode, "INVALID_ATTACHMENT");

  let response = await fetch(baseUrl + "/data/app.db");
  assert.equal(response.status, 403);
  response = await fetch(baseUrl + "/.env.local");
  assert.equal(response.status, 403);
  response = await fetch(baseUrl + "/../package.json");
  assert.notEqual(response.status, 200);
});
