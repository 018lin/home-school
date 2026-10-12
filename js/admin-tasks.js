(function () {
  "use strict";

  requireAuth();
  var auth = getAuth();
  if (!auth || !auth.user) return;
  if (auth.user.role !== "admin") {
    window.location.href = auth.user.role === "teacher" ? "teacher.html" : "home.html";
    return;
  }

  setupWorkspaceNavigation("admin", "tasks");
  document.getElementById("userName").textContent = "你好，" + auth.user.displayName;
  document.getElementById("logoutBtn").addEventListener("click", function () {
    api("/api/auth/logout", { method: "POST" }).catch(function () {});
    localStorage.removeItem("auth");
    window.location.href = "index.html";
  });

  var allTasks = [];
  var filter = document.getElementById("taskFilter");
  var taskList = document.getElementById("taskList");
  var note = document.getElementById("taskResultNote");

  function formatDate(value) {
    if (!value) return "—";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(date);
  }

  function statusLabel(status) {
    if (status === "completed") return "已完成";
    if (status === "draft") return "草稿";
    return "未开始";
  }

  function renderDetail(row) {
    var meta = row.status === "completed"
      ? (formatDate(row.submittedAt) + " · " + (row.subType || "文字提交"))
      : row.status === "draft" ? "已保存草稿，尚未正式提交" : "暂无提交记录";
    return '<div class="completion-row"><div class="completion-row-top"><strong class="completion-name">' +
      esc(row.studentName) + '</strong><span class="completion-status ' + (row.status === "not_started" ? "not-started" : row.status) + '">' +
      statusLabel(row.status) + '</span></div><div class="completion-meta">' + esc(meta) + '</div>' +
      (row.content ? '<div class="completion-content">' + esc(row.content) + '</div>' : '') + '</div>';
  }

  function renderTask(task) {
    var scope = task.scope + " · " + (task.studentName || "全班学生");
    var summary = '<summary class="task-summary"><div class="task-title-line"><strong>' + esc(task.title) +
      '</strong><span>' + esc(scope + " · 发布于 " + formatDate(task.createdAt)) + '</span></div>' +
      '<div class="task-stat"><span><b>' + task.completedCount + '</b> / ' + task.targetCount + ' 完成</span><span>' +
      task.draftCount + ' 份草稿</span></div><div class="task-progress"><div class="task-progress-top"><span>完成率</span><strong>' +
      task.completionRate + '%</strong></div><div class="task-progress-track"><div class="task-progress-fill" style="width:' +
      task.completionRate + '%"></div></div></div></summary>';
    var details = task.details && task.details.length ? task.details.map(renderDetail).join("") :
      '<div class="task-state">暂无目标学生数据</div>';
    return '<details class="task-card">' + summary + '<div class="task-detail"><div class="task-detail-head"><h2>完成详情</h2><span>' +
      esc(task.publisherName + " · " + task.type + " · 预计 " + task.duration + " 分钟") + '</span></div><div class="completion-list">' +
      details + '</div></div></details>';
  }

  function render() {
    var mode = filter.value;
    var visible = allTasks.filter(function (task) {
      if (mode === "incomplete") return task.completedCount < task.targetCount;
      if (mode === "completed") return task.targetCount > 0 && task.completedCount === task.targetCount;
      return true;
    });
    note.textContent = visible.length + " 项任务 · 共 " + allTasks.length + " 项已发布任务";
    taskList.innerHTML = visible.length ? visible.map(renderTask).join("") : '<div class="task-state">没有符合条件的任务</div>';
  }

  filter.addEventListener("change", render);
  api("/api/admin/tasks?limit=100").then(function (data) {
    allTasks = data.tasks || [];
    render();
  }).catch(function () {
    note.textContent = "同步失败";
    taskList.innerHTML = '<div class="task-state">任务加载失败，请刷新重试</div>';
  });
}());
