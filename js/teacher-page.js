(function () {
  "use strict";

  requireAuth();
  var auth = getAuth();
  if (auth && auth.user) {
    if (auth.user.role !== "teacher") {
      window.location.href = "home.html";
      return;
    }
    document.getElementById("userName").textContent = "你好，" + auth.user.displayName;
  }

  document.getElementById("logoutBtn").addEventListener("click", function () {
    api("/api/auth/logout", { method: "POST" }).catch(function () {});
    localStorage.removeItem("auth");
    window.location.href = "index.html";
  });

  var state = {
    messages: [],
    sending: false
  };

  function cacheKey(suffix) {
    var auth = getAuth();
    var account = (auth && auth.user && auth.user.account) || "anonymous";
    return "teacherAi" + suffix + "_v3_" + account;
  }

  function loadCached(key) {
    try { return JSON.parse(localStorage.getItem(key)) || null; } catch (e) { return null; }
  }

  function saveCached(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  function stat(label, value) {
    return '<div class="stat-card"><div class="stat-value">' + esc(value) +
      '</div><div class="stat-label">' + esc(label) + '</div></div>';
  }

  function list(items, cls) {
    items = items || [];
    if (!items.length) return '<p class="summary">暂无足够数据。</p>';
    return '<ul class="line-list ' + (cls || "") + '">' + items.map(function (item) {
      return '<li>' + esc(item) + '</li>';
    }).join("") + '</ul>';
  }

  function bars(items) {
    items = items || [];
    if (!items.length) return "";
    return '<div class="bar-list">' + items.map(function (item) {
      return '<div class="bar-row"><span>' + esc(item.label) +
        '</span><div class="bar-track"><div class="bar-fill" style="width:' +
        (item.percent || 0) + '%"></div></div><span>' + (item.percent || 0) + '%</span></div>';
    }).join("") + '</div>';
  }

  function renderProfileRows(rows) {
    rows = rows || [];
    if (!rows.length) return "";
    return '<div class="mini-table">' + rows.map(function (row) {
      return '<div class="mini-row"><b>' + esc(row.name) + '</b><span>' +
        esc((row.caregiver || "陪伴人未填") + " · " + (row.interests || "兴趣未填") +
          " · 档案" + row.completeness + "%") + '</span></div>';
    }).join("") + '</div>';
  }

  function renderBehaviorRows(rows) {
    rows = rows || [];
    if (!rows.length) return '<p class="summary">近30天暂无行为记录。</p>';
    return '<div class="mini-table">' + rows.slice(0, 6).map(function (row) {
      return '<div class="mini-row"><b>' + esc(row.childName) + '</b><span>触达 ' +
        (row.touchpoints || 0) + ' · 执行 ' + (row.followThrough || 0) + ' · 活跃 ' +
        (row.activeDays || 0) + ' 天 · 共 ' + (row.events || 0) + ' 次</span></div>';
    }).join("") + '</div>';
  }

  function renderSamples(samples) {
    return (samples || []).map(function (sample) {
      return '<div class="sample"><b>' + esc(sample.childName) + '</b> · ' +
        esc(sample.taskTitle) + '<br>' + esc(sample.snippet) + '</div>';
    }).join("");
  }

  function renderAiPriorities(items) {
    items = items || [];
    if (!items.length) return "";
    return '<section class="ai-panel"><div class="ai-panel-title">AI 优先处理建议</div><div class="priority-grid">' +
      items.slice(0, 3).map(function (item) {
        return '<div class="priority-card"><div class="priority-head"><div class="priority-title">' +
          esc(item.title || "优先事项") + '</div><span class="urgency">' +
          esc(item.urgency || "中") + '</span></div><p>' + esc(item.reason || "") +
          '</p><p><b>下一步：</b>' + esc(item.action || "") + '</p></div>';
      }).join("") + '</div></section>';
  }

  function renderAiPlan(ai) {
    var plan = ai.nextWeekPlan;
    var groups = ai.followUpGroups || [];
    var planHtml = "";
    if (plan && plan.taskTheme) {
      planHtml = '<div class="plan-box"><div class="plan-title">' + esc(plan.taskTheme) +
        '</div><p>适用对象：' + esc(plan.targetGroup || "全班") +
        '</p><div class="chip-line">' + (plan.designNotes || []).slice(0, 4).map(function (note) {
          return '<span>' + esc(note) + '</span>';
        }).join("") + '</div><p><b>替代方案：</b>' +
        esc(plan.fallback || "按家庭时间简化步骤") + '</p></div>';
    }
    var groupsHtml = groups.slice(0, 3).map(function (group) {
      return '<div class="follow-card"><div class="follow-title">' +
        esc(group.group || "跟进对象") + '</div><p>信号：' + esc(group.signal || "") +
        '</p><p>建议：' + esc(group.teacherAction || "") + '</p><p>语气：' +
        esc(group.tone || "温和、具体") + '</p></div>';
    }).join("");
    if (!planHtml && !groupsHtml) return "";
    return '<section class="ai-layout"><section class="ai-panel"><div class="ai-panel-title">AI 下周任务方案</div>' +
      (planHtml || '<p class="summary">暂无任务方案。</p>') +
      '</section><section class="ai-panel"><div class="ai-panel-title">AI 分层跟进</div>' +
      (groupsHtml || '<p class="summary">暂无分层建议。</p>') + '</section></section>';
  }

  function renderDimension(dim) {
    var extra = "";
    if (dim.key === "profiles") extra = renderProfileRows(dim.rows);
    if (dim.key === "completionTime") {
      extra = '<div class="section-title">提交时段</div>' + bars(dim.distribution) +
        '<div class="section-title">工作日/周末</div>' + bars(dim.weekdayDistribution);
    }
    if (dim.key === "textMaterials") {
      var indicators = dim.indicators || {};
      extra = '<div class="mini-table">' +
        '<div class="mini-row"><b>积极表达</b><span>' + (indicators.positive || 0) + ' 次</span></div>' +
        '<div class="mini-row"><b>困难线索</b><span>' + (indicators.difficulty || 0) + ' 次</span></div>' +
        '<div class="mini-row"><b>亲子协作</b><span>' + (indicators.collaboration || 0) + ' 次</span></div>' +
        '<div class="mini-row"><b>过程记录</b><span>' + (indicators.observation || 0) + ' 次</span></div>' +
        '</div><div class="section-title">素材样本</div>' + renderSamples(dim.samples);
    }
    if (dim.key === "behaviorSignals") {
      var beh = dim.indicators || {};
      extra = '<div class="section-title">行为事件分布（近30天）</div>' + bars(dim.distribution) +
        '<div class="mini-table">' +
        '<div class="mini-row"><b>触达类行为</b><span>' + (beh.touchpoints || 0) + ' 次</span></div>' +
        '<div class="mini-row"><b>执行类行为</b><span>' + (beh.followThrough || 0) + ' 次</span></div>' +
        '<div class="mini-row"><b>有记录学生</b><span>' + (beh.activeStudents || 0) + ' 名</span></div>' +
        '<div class="mini-row"><b>平均活跃</b><span>' + (beh.avgActiveDays || 0) + ' 天</span></div>' +
        '</div><div class="section-title">学生行为摘要</div>' + renderBehaviorRows(dim.rows);
    }
    return '<section class="report-card"><div class="card-head"><div class="card-title">' +
      esc(dim.title) + '</div><span class="card-tag">' + (dim.aiSummary ? "AI 增强" : "规则分析") +
      '</span></div><p class="summary">' + esc(dim.aiSummary || dim.summary) +
      '</p><div class="section-title">关键发现</div>' + list(dim.findings) +
      '<div class="section-title">建议动作</div>' + list(dim.actions, "action-list") + extra + '</section>';
  }

  function assistantGreeting(report) {
    var stats = report.stats || {};
    var submitted = stats.weekSubmittedStudents || 0;
    var pending = stats.weekPendingFeedback || 0;
    var taskText = "目前已发布" + (stats.totalTaskCount || 0) + "项任务，其中" +
      (stats.customTaskCount || 0) + "项是定制任务";
    var feedbackText = pending > 0
      ? "还有" + pending + "份本周提交未点评"
      : "本周提交目前已全部点评";
    var timeText = stats.peakCompletionTime && stats.peakCompletionTime !== "暂无"
      ? "历史提交高峰在" + stats.peakCompletionTime
      : "当前还没有足够的提交时间数据";
    var text = "老师您好，我刚刚查看了班级资料。" + taskText + "。本星期已有" +
      submitted + "位学生与家长完成任务，" + feedbackText + "。" + timeText + "。";
    var difficulty = 0;
    (report.dimensions || []).forEach(function (dim) {
      if (dim.key === "textMaterials" && dim.indicators) difficulty = dim.indicators.difficulty || 0;
    });
    if (difficulty > 0) {
      text += "提交文字中有" + difficulty + "份出现困难、时间压力或阻力线索，建议先查看这些记录，再决定是否降低任务负担。";
    } else {
      text += "目前没有足够证据直接判断任务负担是否过重，我会在你追问时结合具体提交和任务内容分析。";
    }
    var behaviorSignals = null;
    (report.dimensions || []).forEach(function (dim) {
      if (dim.key === "behaviorSignals") behaviorSignals = dim;
    });
    if (behaviorSignals && behaviorSignals.indicators) {
      text += "\n\n行为层面：" + buildBehaviorAnalysis(behaviorSignals);
    }
    if (report.ai && report.ai.summary) text += "\n\nAI 总览：" + report.ai.summary;
    return text;
  }

  function createAssistantShell(report, aiLoading) {
    var source = report.source || "本地规则分析";
    return '<section class="assistant-shell' + (aiLoading ? " is-ai-loading" : "") + '"' +
      (aiLoading ? ' aria-busy="true"' : "") + '><div class="assistant-head"><div class="assistant-brand">' +
      '<span class="assistant-mark">✦</span><div><div class="assistant-title">AI 班级助手</div>' +
      '<div class="assistant-status">' + (aiLoading ? "正在分析班级数据…" : "已读取学生档案、任务、提交与点评记录") +
      '</div></div></div>' +
      '<span class="assistant-source">' + esc(source) + '</span></div>' +
      '<div id="assistantMessages" class="assistant-messages"></div>' +
      '<div class="assistant-quick"><button type="button" data-question="哪些提交最需要我优先点评？">优先点评</button>' +
      '<button type="button" data-question="本周任务负担是否可能偏重？">任务负担</button>' +
      '<button type="button" data-question="家长通常在什么时间提交任务？">提交时段</button>' +
      '<button type="button" data-question="请给我一份下周任务调整建议。">下周建议</button></div>' +
      '<form id="assistantForm" class="assistant-compose"><textarea id="assistantInput" class="assistant-input" rows="1" ' +
      'placeholder="继续追问班级数据，例如：哪些家庭适合收到更短的任务？"></textarea>' +
      '<button id="assistantSend" class="assistant-send" type="submit">发送</button></form>' +
      '<div class="assistant-note">分析依据为系统内已授权的班级数据；家长行为信号仅用于支持沟通，不代表对家长关注程度的绝对判断。</div>' +
      (aiLoading ? '<div class="assistant-loading" role="status" aria-label="AI 正在加载">' +
        '<img src="assets/site-logo.png" alt=""></div>' : '') + '</section>';
  }

  function appendMessage(role, content, sources) {
    var root = document.getElementById("assistantMessages");
    if (!root) return;
    var isUser = role === "user";
    var html = '<div class="assistant-message ' + (isUser ? "user" : "assistant") + '">' +
      '<span class="assistant-avatar">' + (isUser ? "我" : "AI") + '</span>' +
      '<div><div class="assistant-bubble">' + esc(content) + '</div>';
    if (!isUser && sources && sources.length) {
      html += '<div class="assistant-citations">参考：' + sources.map(function (source) {
        return esc(source.title);
      }).join("、") + '</div>';
    }
    html += '</div></div>';
    root.insertAdjacentHTML("beforeend", html);
    root.scrollTop = root.scrollHeight;
    state.messages.push({ role: role, content: content, sources: sources || [] });
    saveCached(cacheKey("Chat"), state.messages);
  }

  function restoreChat(skipGreeting) {
    var messages = loadCached(cacheKey("Chat"));
    if (!messages || !messages.length) return;
    var list = messages;
    // 缓存里的第一条问候语是旧版本生成的，跳过它，由最新逻辑重新生成
    if (skipGreeting && list.length && list[0] && list[0].role === "assistant") {
      list = list.slice(1);
    }
    list.forEach(function (message) {
      appendMessage(message.role, message.content, message.sources);
    });
  }

  function sendQuestion(question) {
    question = String(question || "").trim();
    if (!question || state.sending) return;
    state.sending = true;
    document.getElementById("assistantSend").disabled = true;
    appendMessage("user", question);
    api("/api/teacher/ai-chat", {
      method: "POST",
      body: {
        question: question,
        history: state.messages.slice(-7).map(function (message) {
          return { role: message.role, content: message.content };
        })
      }
    }).then(function (result) {
      var answer = result.answer || "暂时没有得到回答。";
      appendMessage("assistant", answer, result.sources || []);
    }).catch(function () {
      appendMessage("assistant", "这次查询没有完成，请稍后再试。");
    }).finally(function () {
      state.sending = false;
      document.getElementById("assistantSend").disabled = false;
    });
  }

  function buildBehaviorAnalysis(dim) {
    var beh = (dim && dim.indicators) || {};
    var events = beh.events || 0;
    var active = beh.activeStudents || 0;
    var touch = beh.touchpoints || 0;
    var follow = beh.followThrough || 0;
    var avgDays = beh.avgActiveDays || 0;
    if (events === 0) {
      return "近30天暂未记录到家长站内行为，家长端活跃度还比较低。建议先用低门槛任务和轻量提醒建立第一次接触，暂不做深度行为判断。";
    }
    var parts = [];
    parts.push("近30天共记录" + events + "次家长站内行为，" + active + "名学生有参与记录" +
      (avgDays > 0 ? "，平均活跃" + avgDays + "天" : "") + "。");
    if (follow > 0) {
      parts.push("触达类行为" + touch + "次、执行类行为" + follow +
        "次，说明已有家庭进入任务执行环节（起草/提交/沟通），参与正在从浏览转向行动。");
    } else if (touch > 0) {
      parts.push("触达类行为" + touch + "次、执行类行为0次，说明家长停留在浏览阶段、尚未进入任务执行环节，可能存在参与门槛，建议优先降低任务复杂度并提供更短的替代方案。");
    }
    var viewerOnly = ((dim && dim.rows) || []).filter(function (row) {
      return (row.touchpoints || 0) > 0 && (row.followThrough || 0) === 0;
    });
    if (viewerOnly.length) {
      var names = viewerOnly.slice(0, 2).map(function (row) { return row.childName; }).join("、");
      parts.push("其中有浏览但未进入执行环节的家长" + names +
        (viewerOnly.length > 2 ? "等" : "") + "（" + viewerOnly.length + "位），可优先做一次轻量跟进。");
    }
    return parts.join("");
  }

  function renderReport(report, options) {
    options = options || {};
    var ai = report.ai || {};
    var stats = report.stats || {};
    var scope = report.dataScope || {};
    var dims = report.dimensions || [];
    var html = createAssistantShell(report, options.aiLoading === true);
    html += '<section class="stat-grid">' +
      stat("学生总数", stats.totalStudents || 0) +
      stat("档案完整度", (stats.profileCompleteness || 0) + "%") +
      stat("提交总数", stats.totalSubmissions || 0) +
      stat("活跃学生", stats.activeStudents || 0) +
      stat("提交高峰", stats.peakCompletionTime || "暂无") +
      stat("平均字数", stats.avgTextLength || 0) + '</section>';
    if (report.aiError) {
      html += '<div class="warn-note">AI 调用未完成：' + esc(report.aiError) +
        '。当前展示本地规则分析结果。</div>';
    }
    if ((scope.filteredDemoStudents || 0) > 0) {
      html += '<div class="warn-note">已排除 ' + esc(scope.filteredDemoStudents) +
        ' 条演示学生数据，当前报告仅使用真实家长账号产生的数据。</div>';
    }
    if ((scope.realStudents || 0) === 0) {
      html += '<p class="empty">暂无真实学生数据。请先让家长注册、填写问卷或绑定孩子后再查看 AI 分析。</p>';
    } else {
      html += renderAiPriorities(ai.priorities) + renderAiPlan(ai);
      html += '<section class="report-grid">' + dims.map(renderDimension).join("") + '</section>';
      if (ai.risks && ai.risks.length) {
        html += '<div class="warn-note"><b>谨慎解读：</b>' + esc(ai.risks.join("；")) + '</div>';
      }
    }
    document.getElementById("reportBody").innerHTML = html;
    if (options.restoreMessages) {
      // 问候语始终按最新逻辑与最新数据重新生成，历史对话恢复时跳过缓存的旧问候语
      appendMessage("assistant", assistantGreeting(report));
      restoreChat(true);
    } else {
      appendMessage("assistant", assistantGreeting(report));
    }
    bindAssistant();
  }

  function bindAssistant() {
    var form = document.getElementById("assistantForm");
    var input = document.getElementById("assistantInput");
    if (!form || !input) return;
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var value = input.value.trim();
      input.value = "";
      sendQuestion(value);
    });
    document.querySelectorAll(".assistant-quick button").forEach(function (button) {
      button.addEventListener("click", function () {
        sendQuestion(button.getAttribute("data-question"));
      });
    });
  }

  var aiCacheKey = cacheKey("Report");
  var cachedAiReport = loadCached(aiCacheKey);

  if (cachedAiReport && cachedAiReport.stats) {
    // 本次登录已加载过 AI 分析：直接使用缓存结果，AI 交互框不再重新加载
    renderReport(cachedAiReport, { aiLoading: false, restoreMessages: true });
    return;
  }

  api("/api/teacher/global-report?local=1").then(function (report) {
    renderReport(report, { aiLoading: !!report.aiEnabled });
    if (!report.aiEnabled) return null;
    return api("/api/teacher/global-report?ai=1").then(function (aiReport) {
      saveCached(aiCacheKey, aiReport);
      renderReport(aiReport, { aiLoading: false });
    }).catch(function () {
      report.aiError = "AI 分析加载失败，当前展示本地规则分析结果";
      renderReport(report, { aiLoading: false });
    });
  }).catch(function () {
    document.getElementById("reportBody").innerHTML =
      '<p class="empty">全局报告加载失败，请稍后重试</p>';
  });
}());
