(function () {
  "use strict";

  requireAuth();
  var auth = getAuth();
  if (!auth || !auth.user) return;
  if (auth.user.role !== "teacher") {
    window.location.href = "home.html";
    return;
  }

  document.getElementById("userName").textContent = "你好，" + auth.user.displayName;

  var state = {
    recognition: null,
    recording: false,
    finalTranscript: ""
  };
  var recordButton = document.getElementById("recordButton");
  var recordButtonText = document.getElementById("recordButtonText");
  var recordStatus = document.getElementById("recordStatus");
  var transcriptInput = document.getElementById("transcriptInput");
  var dailyForm = document.getElementById("dailyForm");
  var analyzeButton = document.getElementById("analyzeButton");
  var formMessage = document.getElementById("formMessage");
  var charCount = document.getElementById("charCount");
  var timelineList = document.getElementById("timelineList");
  var timelineCount = document.getElementById("timelineCount");

  function parseDate(value) {
    var raw = String(value || "").trim();
    if (!raw) return null;
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) {
      raw = raw.replace(" ", "T") + "+08:00";
    }
    var date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(value) {
    var date = parseDate(value);
    if (!date) return "刚刚";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(date);
  }

  function updateCharCount() {
    charCount.textContent = transcriptInput.value.length + " / 2000";
  }

  function setMessage(text, isError) {
    formMessage.textContent = text || "";
    formMessage.classList.toggle("is-error", !!isError);
  }

  function setRecordingUi(recording) {
    state.recording = recording;
    recordButton.classList.toggle("is-recording", recording);
    recordButton.setAttribute("aria-pressed", recording ? "true" : "false");
    recordButtonText.textContent = recording ? "结束录音" : "点击开始说";
    if (!recording && recordStatus.textContent === "正在聆听…") {
      recordStatus.textContent = "语音已停止，可以继续补充或直接整理。";
    }
  }

  function setupRecognition() {
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      recordStatus.textContent = "当前浏览器不支持语音识别，请直接输入文字。";
      return;
    }
    state.recognition = new SpeechRecognition();
    state.recognition.lang = "zh-CN";
    state.recognition.continuous = true;
    state.recognition.interimResults = true;
    state.recognition.onstart = function () {
      setRecordingUi(true);
      recordStatus.textContent = "正在聆听…说完后再次点击结束。";
    };
    state.recognition.onresult = function (event) {
      var interim = "";
      var finalText = state.finalTranscript;
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var text = event.results[i][0].transcript || "";
        if (event.results[i].isFinal) finalText += text;
        else interim += text;
      }
      state.finalTranscript = finalText;
      transcriptInput.value = (finalText + interim).trim();
      updateCharCount();
    };
    state.recognition.onerror = function (event) {
      setRecordingUi(false);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        recordStatus.textContent = "麦克风权限未开启，请允许访问麦克风后重试。";
      } else {
        recordStatus.textContent = "语音识别暂时中断，可以直接输入文字继续。";
      }
    };
    state.recognition.onend = function () {
      if (state.recording) setRecordingUi(false);
    };
  }

  function toggleRecording() {
    if (!state.recognition) {
      transcriptInput.focus();
      recordStatus.textContent = "请直接输入今天的校园观察。";
      return;
    }
    if (state.recording) {
      state.recognition.stop();
      setRecordingUi(false);
      return;
    }
    state.finalTranscript = transcriptInput.value.trim();
    try {
      state.recognition.start();
    } catch (error) {
      recordStatus.textContent = "语音识别正在准备，请稍后再试。";
    }
  }

  function renderTimeline(updates) {
    updates = updates || [];
    timelineCount.textContent = updates.length + " 条";
    if (!updates.length) {
      timelineList.innerHTML = '<div class="timeline-empty">还没有记录。点击上方麦克风，留下今天的第一个校园观察。</div>';
      return;
    }
    timelineList.innerHTML = updates.map(function (item) {
      var tags = String(item.tags || "").split(",").map(function (tag) {
        return tag.trim();
      }).filter(Boolean);
      var status = item.ai_status === "ai" ? "AI 已整理" : "本地已整理";
      var recipient = Number(item.recipient_count || 0);
      return '<article class="daily-entry">' +
        '<div class="entry-head"><h3 class="entry-title">' + esc(item.student_name || "学生") +
        '</h3><time class="entry-meta">' + esc(formatDate(item.created_at)) + '</time></div>' +
        '<p class="entry-summary">' + esc(item.summary || "") + '</p>' +
        (item.analysis ? '<div class="entry-analysis"><strong>教育观察</strong><br>' + esc(item.analysis) + '</div>' : "") +
        '<div class="entry-foot"><span class="entry-status">' + esc(status) + '</span>' +
        '<span>' + (recipient ? "已通知 " + recipient + " 位家长" : "暂未匹配家长") + '</span>' +
        tags.map(function (tag) { return '<span class="entry-tag">' + esc(tag) + '</span>'; }).join("") +
        '</div></article>';
    }).join("");
  }

  function loadTimeline() {
    return api("/api/teacher/daily-updates?limit=30").then(function (data) {
      renderTimeline(data.updates || []);
    }).catch(function () {
      timelineList.innerHTML = '<div class="timeline-empty">记录暂时无法加载，请刷新页面重试。</div>';
    });
  }

  recordButton.addEventListener("click", toggleRecording);
  transcriptInput.addEventListener("input", updateCharCount);
  dailyForm.addEventListener("submit", function (event) {
    event.preventDefault();
    var transcript = transcriptInput.value.trim();
    if (!transcript || analyzeButton.disabled) {
      setMessage("请先说一段校园记录，或直接输入文字。", true);
      transcriptInput.focus();
      return;
    }
    if (state.recording && state.recognition) {
      state.recognition.stop();
      setRecordingUi(false);
    }
    analyzeButton.disabled = true;
    setMessage("AI 正在整理，并同步通知家长…");
    api("/api/teacher/daily-updates", {
      method: "POST",
      body: { transcript: transcript },
      timeoutMs: 45000
    }).then(function (result) {
      var count = Number(result.recipientCount || 0);
      transcriptInput.value = "";
      state.finalTranscript = "";
      updateCharCount();
      setMessage(count ? "已整理并通知 " + count + " 位家长。" : "已保存到时间线，暂未找到可通知的家长账号。");
      return loadTimeline();
    }).catch(function (error) {
      setMessage(error && error.message ? error.message : "整理失败，请稍后重试。", true);
    }).finally(function () {
      analyzeButton.disabled = false;
    });
  });

  document.getElementById("logoutBtn").addEventListener("click", function () {
    api("/api/auth/logout", { method: "POST" }).catch(function () {});
    localStorage.removeItem("auth");
    localStorage.removeItem("selectedChildId");
    window.location.href = "index.html";
  });

  setupRecognition();
  updateCharCount();
  renderTimeline([]);
  loadTimeline();
})();
