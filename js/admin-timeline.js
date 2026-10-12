(function () {
  "use strict";

  requireAuth();
  var auth = getAuth();
  if (!auth || !auth.user) return;
  if (auth.user.role !== "admin") {
    window.location.href = auth.user.role === "teacher" ? "teacher.html" : "home.html";
    return;
  }

  setupWorkspaceNavigation("admin", "timeline");
  document.getElementById("userName").textContent = "你好，" + auth.user.displayName;
  document.getElementById("logoutBtn").addEventListener("click", function () {
    api("/api/auth/logout", { method: "POST" }).catch(function () {});
    localStorage.removeItem("auth");
    window.location.href = "index.html";
  });

  var state = { items: [], children: [], kind: "all", days: 90, loading: false };
  var feed = document.getElementById("timelineFeed");
  var studentFilter = document.getElementById("studentFilter");
  var rangeFilter = document.getElementById("rangeFilter");

  function parseDate(value) {
    var raw = String(value || "").trim();
    if (!raw) return null;
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
      raw = raw.replace(" ", "T") + "+08:00";
    }
    var date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(value, includeYear) {
    var date = parseDate(value);
    if (!date) return { day: "日期待定", time: "", full: "时间待定" };
    var options = { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
    if (includeYear) options.year = "numeric";
    var parts = new Intl.DateTimeFormat("zh-CN", options).formatToParts(date).reduce(function (out, part) {
      out[part.type] = part.value;
      return out;
    }, {});
    return {
      day: parts.month + "月" + parts.day + "日",
      time: parts.hour + ":" + parts.minute,
      full: (parts.year ? parts.year + "年" : "") + parts.month + "月" + parts.day + "日 " + parts.hour + ":" + parts.minute
    };
  }

  function filteredItems() {
    var selected = studentFilter.value;
    var cutoff = state.days ? Date.now() - state.days * 86400000 : 0;
    return state.items.filter(function (item) {
      var date = parseDate(item.createdAt);
      if (selected && String(item.childId || "") !== selected) return false;
      if (state.kind !== "all" && item.kind !== state.kind) return false;
      if (cutoff && date && date.getTime() < cutoff) return false;
      return true;
    });
  }

  function renderMetrics(items) {
    var students = {};
    items.forEach(function (item) { if (item.childId) students[item.childId] = true; });
    document.getElementById("metricTotal").textContent = items.length;
    document.getElementById("metricStudents").textContent = Object.keys(students).length;
    document.getElementById("metricSubmissions").textContent = items.filter(function (item) { return item.kind === "submission"; }).length;
    document.getElementById("metricObservations").textContent = items.filter(function (item) { return item.kind === "observation"; }).length;
    document.getElementById("feedCount").textContent = items.length + " 条记录";
  }

  function renderEntry(item) {
    var date = formatDate(item.createdAt);
    var content = String(item.content || "").trim();
    var tags = String(item.tags || "").split(",").map(function (tag) { return tag.trim(); }).filter(Boolean);
    var showingAllStudents = !studentFilter.value;
    var meta = [];
    if (!showingAllStudents) meta.push(item.studentName || "未匹配学生");
    if (item.grade) meta.push(item.grade);
    meta.push(item.teacherName ? (item.kind === "observation" ? item.teacherName + " 记录" : "发布于 " + item.teacherName) : date.full);
    var html = '<article class="timeline-entry ' + (item.kind === "observation" ? "observation" : "submission") + '">' +
      '<div class="entry-time"><strong>' + esc(date.day) + '</strong><span>' + esc(date.time) + '</span></div>' +
      '<div class="entry-marker" aria-hidden="true"></div>' +
      '<div class="entry-card"><div class="entry-head"><h3 class="entry-title">' + esc(item.title || "成长记录") + '</h3>' +
      '<span class="entry-badge ' + (item.kind === "observation" ? "observation" : "") + '">' + esc(item.kindLabel) + '</span></div>' +
      (showingAllStudents ? '<div class="entry-student-line"><span class="entry-student-dot" aria-hidden="true"></span><span>学生</span><strong>' + esc(item.studentName || "未匹配学生") + '</strong></div>' : "") +
      '<p class="entry-meta">' + esc(meta.join(" · ")) + '</p>' +
      '<div class="entry-content' + (content ? "" : " is-empty") + '">' + esc(content || "这条记录没有文字内容。") + '</div>';
    if (item.analysis) html += '<div class="entry-analysis"><strong>教育观察</strong><br>' + esc(item.analysis) + '</div>';
    if (tags.length || item.recipientCount) {
      html += '<div class="entry-foot"><span class="student-chip">' + esc(item.studentName || "未匹配学生") + '</span>';
      if (item.recipientCount) html += '<span>已通知 ' + Number(item.recipientCount) + ' 位家长</span>';
      html += tags.map(function (tag) { return '<span class="entry-tag">' + esc(tag) + '</span>'; }).join("") + '</div>';
    }
    if (item.feedback) {
      html += '<div class="entry-feedback"><strong>' + esc(item.feedback.teacherName || "教师") + ' 的反馈</strong><br>' + esc(item.feedback.comment || "已完成点评") + '</div>';
    }
    return html + '</div></article>';
  }

  function renderFeed(items) {
    feed.innerHTML = items.length ? items.map(renderEntry).join("") : '<div class="timeline-state">当前筛选范围内还没有成长记录。</div>';
  }

  function renderTrend(items) {
    var today = new Date();
    var daily = [];
    for (var offset = 6; offset >= 0; offset--) {
      var date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
      var key = date.getFullYear() + "-" + (date.getMonth() + 1) + "-" + date.getDate();
      var count = items.filter(function (item) {
        var itemDate = parseDate(item.createdAt);
        return itemDate && itemDate.getFullYear() === date.getFullYear() && itemDate.getMonth() === date.getMonth() && itemDate.getDate() === date.getDate();
      }).length;
      daily.push({ key: key, count: count, label: (date.getMonth() + 1) + "/" + date.getDate(), today: offset === 0 });
    }
    var max = Math.max.apply(null, daily.map(function (day) { return day.count; }).concat([1]));
    document.getElementById("trendTotal").textContent = daily.reduce(function (sum, day) { return sum + day.count; }, 0) + " 条";
    document.getElementById("trendChart").innerHTML = daily.map(function (day) {
      var height = Math.max(4, Math.round(day.count / max * 100));
      return '<div class="trend-day"><span class="trend-value">' + (day.count || "") + '</span><span class="trend-bar' + (day.today ? " is-today" : "") + '" style="height:' + height + '%"></span><span class="trend-label">' + day.label + '</span></div>';
    }).join("");
  }

  function renderStudentBars(items) {
    var counts = {};
    items.forEach(function (item) {
      if (!item.childId) return;
      var key = String(item.childId);
      if (!counts[key]) counts[key] = { name: item.studentName || "学生", count: 0 };
      counts[key].count++;
    });
    var rows = Object.keys(counts).map(function (key) { return counts[key]; }).sort(function (a, b) { return b.count - a.count; }).slice(0, 6);
    var max = rows.length ? rows[0].count : 1;
    document.getElementById("studentBars").innerHTML = rows.length ? rows.map(function (row) {
      return '<div class="student-bar-row"><div class="student-bar-meta"><strong>' + esc(row.name) + '</strong><span>' + row.count + ' 条</span></div><div class="student-bar-track"><div class="student-bar-fill" style="width:' + Math.round(row.count / max * 100) + '%"></div></div></div>';
    }).join("") : '<div class="timeline-state compact">暂无学生记录</div>';
  }

  function render() {
    var items = filteredItems();
    renderMetrics(items);
    renderFeed(items);
    renderTrend(items);
    renderStudentBars(items);
  }

  function populateChildren(children) {
    studentFilter.innerHTML = '<option value="">全部学生</option>' + (children || []).map(function (child) {
      return '<option value="' + esc(child.id) + '">' + esc(child.name) + (child.grade ? " · " + esc(child.grade) : "") + '</option>';
    }).join("");
  }

  function loadData() {
    if (state.loading) return;
    state.loading = true;
    document.getElementById("updatedAt").textContent = "正在同步…";
    api("/api/admin/growth-timeline?limit=500").then(function (data) {
      state.items = data.items || [];
      state.children = data.children || [];
      populateChildren(state.children);
      document.getElementById("updatedAt").textContent = "更新于 " + formatDate(data.generatedAt, true).full;
      render();
    }).catch(function () {
      document.getElementById("updatedAt").textContent = "同步失败";
      feed.innerHTML = '<div class="timeline-state">数据加载失败，请刷新重试。</div>';
    }).finally(function () { state.loading = false; });
  }

  studentFilter.addEventListener("change", render);
  rangeFilter.addEventListener("change", function () { state.days = Number(rangeFilter.value) || 0; render(); });
  document.querySelectorAll(".type-filter-btn").forEach(function (button) {
    button.addEventListener("click", function () {
      state.kind = button.getAttribute("data-kind") || "all";
      document.querySelectorAll(".type-filter-btn").forEach(function (other) { other.classList.toggle("is-active", other === button); });
      render();
    });
  });
  document.getElementById("refreshBtn").addEventListener("click", loadData);
  loadData();
}());
