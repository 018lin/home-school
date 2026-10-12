(function () {
  "use strict";
  requireAuth();
  var auth = getAuth();
  if (!auth || !auth.user) return;
  if (auth.user.role !== "admin") { window.location.href = auth.user.role === "teacher" ? "teacher.html" : "home.html"; return; }

  setupWorkspaceNavigation("admin", "accounts");
  document.getElementById("userName").textContent = "你好，" + auth.user.displayName;
  document.getElementById("logoutBtn").addEventListener("click", function () {
    api("/api/auth/logout", { method: "POST" }).catch(function () {});
    localStorage.removeItem("auth"); window.location.href = "index.html";
  });

  var allAccounts = [], filter = "all", editingId = null;
  var modal = document.getElementById("accountModal"), form = document.getElementById("accountForm");
  var fields = {
    account: document.getElementById("accountInput"), password: document.getElementById("passwordInput"), displayName: document.getElementById("displayNameInput"),
    phone: document.getElementById("phoneInput"), email: document.getElementById("emailInput"), subject: document.getElementById("subjectInput"), employeeNo: document.getElementById("employeeNoInput"),
    grade: document.getElementById("gradeInput"), gender: document.getElementById("genderInput"), age: document.getElementById("ageInput"), caregiver: document.getElementById("caregiverInput"),
    interests: document.getElementById("interestsInput"), parentAccount: document.getElementById("parentAccountInput"), relation: document.getElementById("relationInput"), familyNote: document.getElementById("familyNoteInput")
  };
  function formatDate(value) { if (!value) return "—"; var d = new Date(value); return Number.isNaN(d.getTime()) ? String(value).slice(0, 16) : new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d); }
  function currentRole() { return document.querySelector("input[name='role']:checked").value; }
  function profileText(item) { return item.role === "teacher" ? [item.subject || "未填写科目", item.employee_no ? "工号 " + item.employee_no : "", item.phone || ""].filter(Boolean).join(" · ") : item.role === "parent" ? [(item.child_count || 0) + " 位关联学生", item.phone || "", item.email || ""].filter(Boolean).join(" · ") : [item.grade || "未填写年级", item.gender || "", item.age ? item.age + " 岁" : "", item.caregiver || ""].filter(Boolean).join(" · "); }
  function render() {
    var query = document.getElementById("accountSearch").value.trim().toLowerCase();
    var rows = allAccounts.filter(function (item) { return (filter === "all" || item.role === filter) && (!query || [item.account, item.display_name, item.name, item.grade].join(" ").toLowerCase().indexOf(query) >= 0); });
    document.getElementById("resultCount").textContent = rows.length + " 个账号";
    document.getElementById("accountList").innerHTML = rows.length ? rows.map(function (item) {
      var roleLabel = item.role === "teacher" ? "教师" : item.role === "student" ? "学生" : "家长";
      var memberType = item.role === "student" ? "学生档案" : item.role === "parent" ? "家长账号" : "工作人员";
      return '<tr><td><div class="member-cell"><strong>' + esc(item.display_name || item.name) + '</strong><small>' + memberType + '</small></div></td><td>' + esc(item.account) + '</td><td><span class="identity ' + item.role + '">' + roleLabel + '</span></td><td><span class="profile-summary">' + esc(profileText(item) || "资料待完善") + '</span></td><td>' + esc(formatDate(item.created_at)) + '</td><td><button class="edit-button" type="button" data-edit="' + item.id + '">编辑</button></td></tr>';
    }).join("") : '<tr><td colspan="6" class="table-state">没有匹配的账号</td></tr>';
  }
  function load() { document.getElementById("resultCount").textContent = "正在同步…"; return api("/api/admin/accounts").then(function (data) { allAccounts = (data.teachers || []).map(function (x) { x.role = "teacher"; return x; }).concat((data.students || []).map(function (x) { x.role = "student"; return x; }), (data.parents || []).map(function (x) { x.role = "parent"; return x; })); render(); }).catch(function (error) { document.getElementById("resultCount").textContent = "同步失败"; document.getElementById("accountList").innerHTML = '<tr><td colspan="6" class="table-state">' + esc(error.message || "数据加载失败，请刷新重试") + '</td></tr>'; }); }
  function setRole(role) { document.body.classList.toggle("student-form", role === "student"); document.body.classList.toggle("parent-form", role === "parent"); document.getElementById("displayNameLabel").firstChild.textContent = role === "student" ? "学生姓名 " : role === "parent" ? "家长姓名 " : "教师姓名 "; document.getElementById("passwordRequired").textContent = editingId ? "" : "*"; document.getElementById("passwordHint").textContent = editingId ? "留空表示不修改密码" : "至少 6 位字符"; }
  function openModal(item) {
    editingId = item ? Number(item.id) : null; form.reset(); document.getElementById("formStatus").textContent = ""; document.getElementById("modalTitle").textContent = item ? "编辑账号" : "新增账号"; document.getElementById("rolePicker").style.display = item ? "none" : "block";
    document.querySelector("input[name='role'][value='" + (item ? item.role : "teacher") + "']").checked = true;
    if (item) { Object.keys(fields).forEach(function (key) { var map = { displayName: "display_name", employeeNo: "employee_no", familyNote: "family_note", parentAccount: "parent_account", relation: "parent_relation" }; if (map[key] && item[map[key]] != null) fields[key].value = item[map[key]]; else if (item[key] != null && key !== "password") fields[key].value = item[key]; }); }
    setRole(currentRole()); modal.hidden = false; fields.account.focus();
  }
  function closeModal() { modal.hidden = true; editingId = null; }
  document.querySelectorAll(".segment[data-filter]").forEach(function (button) { button.addEventListener("click", function () { filter = button.dataset.filter; document.querySelectorAll(".segment[data-filter]").forEach(function (x) { x.classList.toggle("active", x === button); }); render(); }); });
  document.getElementById("accountSearch").addEventListener("input", render); document.getElementById("addAccountBtn").addEventListener("click", function () { openModal(); }); document.getElementById("closeModalBtn").addEventListener("click", closeModal); document.getElementById("cancelBtn").addEventListener("click", closeModal); modal.addEventListener("click", function (event) { if (event.target === modal) closeModal(); });
  document.querySelectorAll("input[name='role']").forEach(function (radio) { radio.addEventListener("change", function () { setRole(radio.value); }); });
  document.getElementById("accountList").addEventListener("click", function (event) { var button = event.target.closest("[data-edit]"); if (!button) return; openModal(allAccounts.find(function (item) { return Number(item.id) === Number(button.dataset.edit); })); });
  form.addEventListener("submit", function (event) { event.preventDefault(); var role = currentRole(), status = document.getElementById("formStatus"); status.className = "form-status"; status.textContent = ""; if (fields.account.value.trim().length < 3) { status.className = "form-status error"; status.textContent = "账号至少 3 个字符"; return; } if (!editingId && fields.password.value.length < 6 || editingId && fields.password.value && fields.password.value.length < 6) { status.className = "form-status error"; status.textContent = "密码至少 6 位"; return; } if (!fields.displayName.value.trim()) { status.className = "form-status error"; status.textContent = "请填写姓名"; return; } if (role === "student" && !fields.grade.value.trim()) { status.className = "form-status error"; status.textContent = "请填写学生年级"; return; }
    var body = { role: role, account: fields.account.value.trim(), password: fields.password.value, displayName: fields.displayName.value.trim(), phone: fields.phone.value.trim(), email: fields.email.value.trim(), subject: fields.subject.value.trim(), employeeNo: fields.employeeNo.value.trim(), grade: fields.grade.value.trim(), gender: fields.gender.value, age: fields.age.value, caregiver: fields.caregiver.value.trim(), interests: fields.interests.value.trim(), parentAccount: fields.parentAccount.value.trim(), relation: fields.relation.value.trim(), familyNote: fields.familyNote.value.trim() }; var save = document.getElementById("saveBtn"); save.disabled = true; save.textContent = "保存中…"; api(editingId ? "/api/admin/accounts/" + editingId : "/api/admin/accounts", { method: editingId ? "PUT" : "POST", body: body }).then(function () { closeModal(); return load(); }).catch(function (error) { status.className = "form-status error"; status.textContent = error.message || "保存失败，请重试"; }).finally(function () { save.disabled = false; save.textContent = "保存账号"; });
  });
  load();
}());
