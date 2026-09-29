/**
 * 前端 API 工具：统一携带登录态，401 自动跳回登录页
 */

/* API 服务地址（单点配置，只改这里即可）
 * - 本地开发：用 node server.js 启动时页面和接口同源，自动使用 ""
 * - 线上（Vercel 前端 + Render 后端）：改成你的后端地址，例如：
 *     window.API_BASE = "https://home-school-backend.onrender.com";
 *   注意：结尾不要带斜杠 "/"
 */
var isLocalHost = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
window.API_BASE = window.API_BASE || (isLocalHost ? "" : "https://home-school-04zi.onrender.com");

function ApiClientError(message, status, data) {
  this.name = "ApiClientError";
  this.message = message || "请求失败";
  this.status = status || 0;
  this.data = data || {};
  if (Error.captureStackTrace) Error.captureStackTrace(this, ApiClientError);
}
ApiClientError.prototype = Object.create(Error.prototype);
ApiClientError.prototype.constructor = ApiClientError;

function api(path, options) {
  options = options || {};
  var headers = Object.assign({}, options.headers || {});
  if (options.body) headers["Content-Type"] = "application/json";
  var auth = getAuth();
  if (auth && auth.token) headers["Authorization"] = "Bearer " + auth.token;
  var timeoutMs = Number(options.timeoutMs) || 20000;
  var controller = window.AbortController && !options.signal ? new AbortController() : null;
  var timer = controller ? window.setTimeout(function () { controller.abort(); }, timeoutMs) : null;
  return fetch(API_BASE + path, {
    method: options.method || "GET",
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal || (controller && controller.signal)
  }).then(function (res) {
    if (res.status === 401) {
      localStorage.removeItem("auth");
      window.location.href = "index.html";
      throw new ApiClientError("请先登录", 401, { message: "请先登录" });
    }
    return res.text().then(function (text) {
      var data = {};
      try { data = text ? JSON.parse(text) : {}; } catch (e) {
        data = { message: text || "服务器返回格式不正确" };
      }
      if (!res.ok) {
        throw new ApiClientError(data.message || "请求失败", res.status, data);
      }
      return data;
    });
  }).catch(function (error) {
    if (error && error.name === "AbortError") {
      throw new ApiClientError("请求超时，请稍后重试", 408, { message: "请求超时，请稍后重试" });
    }
    throw error;
  }).finally(function () {
    if (timer) window.clearTimeout(timer);
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
