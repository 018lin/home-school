(function () {
  "use strict";

  var auth = getAuth();
  if (!auth || !auth.token) { window.location.href = "index.html"; return; }
  if (!auth.user || auth.user.role !== "student") { window.location.href = "home.html"; return; }

  var taskId = null;
  var childId = null;
  var contentInput = document.getElementById("contentInput");
  var submitMessage = document.getElementById("submitMessage");
  document.getElementById("userName").textContent = auth.user.displayName || "小测";

  function setText(id, value) { document.getElementById(id).textContent = value == null ? "" : String(value); }
  function setStatus(status) {
    var el = document.getElementById("taskStatus");
    var labels = { ongoing: "进行中", draft: "草稿已保存", submitted: "已提交" };
    el.textContent = labels[status] || "进行中";
    el.className = "student-status status-" + (status || "ongoing");
    el.hidden = false;
  }

  function render(data) {
    if (!data.task || !data.child) {
      document.getElementById("emptyState").hidden = false;
      return;
    }
    taskId = data.task.id;
    childId = data.child.id;
    document.getElementById("taskContent").hidden = false;
    setStatus(data.taskStatus);
    setText("taskType", data.task.task_type || "学习任务");
    setText("taskTitle", data.task.title || "本周任务");
    setText("taskMeta", "约 " + (data.task.duration || 20) + " 分钟");
    setText("taskDifficulty", data.task.difficulty || "普通");
    setText("taskMaterials", data.task.materials || "无特殊材料");
    setText("taskGoal", data.task.goal || "-");
    setText("taskSteps", data.task.steps || "-");
    setText("taskTips", data.task.dialogue_tips || "");
    setText("taskSubmitHint", data.task.submit_hint || "提交你的过程记录");
    if (data.submission) {
      if (data.submission.status === "draft") {
        contentInput.value = data.submission.content || "";
        updateCount();
      } else {
        document.getElementById("submitCard").hidden = true;
        document.getElementById("submittedCard").hidden = false;
        setText("submittedContent", data.submission.content || "");
        if (data.feedback && data.feedback.comment) {
          document.getElementById("feedbackBlock").hidden = false;
          setText("feedbackContent", data.feedback.comment);
        }
      }
    }
  }

  function updateCount() { setText("charCount", contentInput.value.length + " / 1200"); }
  function save(status, button) {
    var content = contentInput.value.trim();
    if (status === "submitted" && !content) {
      submitMessage.textContent = "请先写下你的记录";
      submitMessage.className = "message-error";
      contentInput.focus();
      return;
    }
    var old = button.textContent;
    button.disabled = true;
    button.textContent = status === "draft" ? "保存中" : "提交中";
    submitMessage.textContent = "";
    api("/api/submissions", {
      method: "POST",
      body: { taskId: taskId, childId: childId, content: content, subType: "text", status: status, attachments: [] }
    }).then(function () {
      if (status === "submitted") {
        window.location.reload();
        return;
      }
      submitMessage.textContent = "草稿已保存";
      submitMessage.className = "message-ok";
      setStatus("draft");
      button.disabled = false;
      button.textContent = old;
    }).catch(function (error) {
      submitMessage.textContent = error.message || "操作失败，请稍后重试";
      submitMessage.className = "message-error";
      button.disabled = false;
      button.textContent = old;
    });
  }

  contentInput.addEventListener("input", updateCount);
  document.getElementById("draftButton").addEventListener("click", function () { save("draft", this); });
  document.getElementById("submitButton").addEventListener("click", function () { save("submitted", this); });
  document.getElementById("logoutBtn").addEventListener("click", function () {
    api("/api/auth/logout", { method: "POST" }).catch(function () {});
    localStorage.removeItem("auth");
    window.location.href = "index.html";
  });
  api("/api/student/home").then(render).catch(function (error) {
    document.getElementById("emptyState").hidden = false;
    document.getElementById("emptyState").querySelector("p").textContent = error.message || "任务加载失败，请刷新重试";
  });
})();
