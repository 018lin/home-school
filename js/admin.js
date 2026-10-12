(function () {
  "use strict";

  requireAuth();
  var auth = getAuth();
  if (!auth || !auth.user) return;
  if (auth.user.role !== "admin") {
    window.location.href = auth.user.role === "teacher" ? "teacher.html" : "home.html";
    return;
  }

  setupWorkspaceNavigation("admin", "overview");
  document.getElementById("userName").textContent = "你好，" + auth.user.displayName;
  document.getElementById("logoutBtn").addEventListener("click", function () {
    api("/api/auth/logout", { method: "POST" }).catch(function () {});
    localStorage.removeItem("auth");
    window.location.href = "index.html";
  });

  function formatDate(value) {
    if (!value) return "—";
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(0, 16);
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(date);
  }

  function renderTeachers(teachers) {
    teachers = teachers || [];
    if (!teachers.length) return '<tr><td colspan="3" class="table-state">还没有注册教师</td></tr>';
    return teachers.map(function (teacher) {
      return '<tr><td>' + esc(teacher.account) + '</td><td>' + esc(teacher.display_name) +
        '</td><td>' + esc(formatDate(teacher.created_at)) + '</td></tr>';
    }).join("");
  }

  function renderStudents(students) {
    students = students || [];
    if (!students.length) return '<tr><td colspan="3" class="table-state">还没有学生档案</td></tr>';
    return students.map(function (student) {
      return '<tr><td>' + esc(student.name) + '</td><td>' + esc(student.grade || "未填写") +
        '</td><td>' + esc(String(student.parent_count || 0) + " 位") + '</td></tr>';
    }).join("");
  }

  api("/api/admin/overview").then(function (data) {
    var stats = data.stats || {};
    document.getElementById("teacherCount").textContent = stats.teacherCount || 0;
    document.getElementById("studentCount").textContent = stats.studentCount || 0;
    document.getElementById("parentCount").textContent = stats.parentCount || 0;
    document.getElementById("teacherPanelCount").textContent = (stats.teacherCount || 0) + " 名";
    document.getElementById("studentPanelCount").textContent = (stats.studentCount || 0) + " 名";
    document.getElementById("teacherList").innerHTML = renderTeachers(data.teachers);
    document.getElementById("studentList").innerHTML = renderStudents(data.students);
    document.getElementById("updatedAt").textContent = "更新于 " + formatDate(data.generatedAt);
  }).catch(function () {
    document.getElementById("updatedAt").textContent = "同步失败";
    document.getElementById("teacherList").innerHTML = '<tr><td colspan="3" class="table-state">数据加载失败，请刷新重试</td></tr>';
    document.getElementById("studentList").innerHTML = '<tr><td colspan="3" class="table-state">数据加载失败，请刷新重试</td></tr>';
  });
}());
