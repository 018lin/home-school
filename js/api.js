/**
 * 前端 API 工具：统一携带登录态，401 自动跳回登录页
 */

/* API 服务地址（单点配置，只改这里即可）
 * - 本地开发：用 node server.js 启动时页面和接口同源，保持 "" 不用动
 * - 线上（Vercel 前端 + Render 后端）：改成你的后端地址，例如：
 *     window.API_BASE = "https://home-school-backend.onrender.com";
 *   注意：结尾不要带斜杠 "/"
 */
window.API_BASE = "https://home-school-04zi.onrender.com";

function api(path, options) {
  options = options || {};
  var headers = options.headers || {};
  if (options.body) headers["Content-Type"] = "application/json";
  var auth = getAuth();
  if (auth && auth.token) headers["Authorization"] = "Bearer " + auth.token;
  return fetch(API_BASE + path, {
    method: options.method || "GET",
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  }).then(function (res) {
    if (res.status === 401) {
      localStorage.removeItem("auth");
      window.location.href = "index.html";
      throw new Error("请先登录");
    }
    return res.json();
  });
}

function getAuth() {
  try { return JSON.parse(localStorage.getItem("auth")) || null; }
  catch (e) { return null; }
}

function requireAuth() {
  if (!getAuth()) window.location.href = "index.html";
}

function getSelectedChildId() {
  return localStorage.getItem("selectedChildId");
}
function setSelectedChildId(id) {
  localStorage.setItem("selectedChildId", id);
}

function trackEvent(eventType, payload) {
  payload = payload || {};
  payload.eventType = eventType;
  return api("/api/events", { method: "POST", body: payload }).catch(function () {});
}

function esc(str) {
  var div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

/* ---- 页面停留时长 + 离开时间埋点（P1-4） ---- */
(function () {
  if (!getAuth()) return; // 仅登录用户生效，避免登录页误触发 401 跳转
  var startAt = Date.now();
  var page = (location.pathname.split("/").pop() || "index").replace(/\.html$/, "");
  var fired = false;
  function sendDwell() {
    if (fired) return;
    fired = true;
    var durationMs = Date.now() - startAt;
    if (durationMs < 3000) return; // 过滤极短停留，减少噪声
    trackEvent("page_dwell", {
      meta: {
        page: page,
        durationMs: durationMs,
        leftAt: new Date().toISOString()
      }
    });
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") sendDwell();
  });
  window.addEventListener("pagehide", sendDwell);
})();
