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

  function emphasize(text) {
    return esc(text).replace(/(\d+(?:\.\d+)?\s*(?:%|人|名|次|天|小时|份|项)?)/g, "<strong>$1</strong>");
  }

  function list(items, cls) {
    items = items || [];
    if (!items.length) return '<p class="summary">暂无足够数据。</p>';
    return '<ul class="line-list ' + (cls || "") + '">' + items.map(function (item) {
      return '<li>' + emphasize(item) + '</li>';
    }).join("") + '</ul>';
  }

  function actionList(items, cls) {
    items = items || [];
    if (!items.length) return '<p class="summary">暂无建议动作。</p>';
    return '<ul class="action-points ' + (cls || "") + '">' + items.map(function (item) {
      return '<li><span class="point-icon" aria-hidden="true"></span><span>' + emphasize(item) + '</span></li>';
    }).join("") + '</ul>';
  }

  function clampPercent(value) {
    value = Number(value) || 0;
    return Math.max(0, Math.min(100, value));
  }

  function badge(label, value, tone) {
    return '<span class="insight-badge ' + (tone || "") + '"><span>' + esc(label) +
      '</span><b>' + esc(value) + '</b></span>';
  }

  function bars(items) {
    items = items || [];
    if (!items.length) return "";
    return '<div class="bar-list">' + items.map(function (item) {
      var percent = clampPercent(item.percent);
      var muted = percent === 0 ? " is-empty" : "";
      return '<div class="bar-row' + muted + '"><span>' + esc(item.label) +
        '</span><div class="bar-track"><div class="bar-fill" style="width:' +
        percent + '%"></div></div><span>' + percent + '%</span></div>';
    }).join("") + '</div>';
  }

  function countBars(items) {
    items = items || [];
    if (!items.length) return "";
    var max = items.reduce(function (n, item) {
      return Math.max(n, Number(item.count) || 0);
    }, 0) || 1;
    return '<div class="bar-list count-bars">' + items.map(function (item) {
      var count = Number(item.count) || 0;
      var percent = count ? Math.max(8, Math.round(count / max * 100)) : 0;
      return '<div class="bar-row' + (count ? "" : " is-empty") + '"><span>' + esc(item.label) +
        '</span><div class="bar-track"><div class="bar-fill" style="width:' + percent +
        '%"></div></div><span>' + count + '次</span></div>';
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

  function renderReportBadges(report) {
    var stats = report.stats || {};
    var difficulty = 0;
    var behaviorEvents = 0;
    (report.dimensions || []).forEach(function (dim) {
      if (dim.key === "textMaterials" && dim.indicators) difficulty = dim.indicators.difficulty || 0;
      if (dim.key === "behaviorSignals" && dim.indicators) behaviorEvents = dim.indicators.events || 0;
    });
    return '<div class="report-badges">' +
      badge("重点跟进", difficulty ? difficulty + "条困难线索" : "暂无困难线索", difficulty ? "warn" : "calm") +
      badge("活跃期", stats.peakCompletionTime || "暂无", "accent") +
      badge("待点评", (stats.weekPendingFeedback || 0) + "份", stats.weekPendingFeedback ? "warn" : "calm") +
      badge("行为记录", behaviorEvents + "次", behaviorEvents ? "accent" : "muted") +
      '</div>';
  }

  function fallbackActionModel(report) {
    var stats = (report && report.stats) || {};
    var dims = (report && report.dimensions) || [];
    var difficulty = 0;
    var behavior = {};
    dims.forEach(function (dim) {
      if (dim.key === "textMaterials" && dim.indicators) difficulty = dim.indicators.difficulty || 0;
      if (dim.key === "behaviorSignals" && dim.indicators) behavior = dim.indicators;
    });
    var priorities = [
      {
        title: (stats.weekPendingFeedback || 0) > 0 ? "优先完成本周点评" : "保持点评闭环",
        urgency: (stats.weekPendingFeedback || 0) > 0 ? "高" : "中",
        reason: (stats.weekPendingFeedback || 0) > 0
          ? "本周还有" + stats.weekPendingFeedback + "份提交未点评，先处理能直接提升家长反馈体验。"
          : "本周提交目前已全部点评，可以把精力转向任务设计和个别跟进。",
        action: (stats.weekPendingFeedback || 0) > 0
          ? "先打开学生提交页，按困难线索和提交时间排序点评。"
          : "抽取1-2条优秀过程记录，作为下周任务示例。"
      },
      {
        title: difficulty > 0 ? "查看困难线索" : "继续鼓励过程记录",
        urgency: difficulty > 0 ? "高" : "中",
        reason: difficulty > 0
          ? "文字素材中出现" + difficulty + "次困难、时间压力或阻力线索，需要先判断是否要减负。"
          : "当前没有明显困难线索，说明任务负担暂未暴露异常。",
        action: difficulty > 0
          ? "给相关提交补一句具体减负建议，并准备更短替代方案。"
          : "点评时继续追问观察过程、亲子对话和孩子感受。"
      },
      {
        title: "顺着活跃时段提醒",
        urgency: "中",
        reason: "当前提交高峰为" + (stats.peakCompletionTime || "暂无") + "，提醒时机比提醒频次更影响完成率。",
        action: (stats.peakCompletionTime && stats.peakCompletionTime !== "暂无")
          ? "把提醒提前到高峰前2-4小时，避免临近截止集中催促。"
          : "先收集更多提交时间，再固定提醒节奏。"
      }
    ];
    return {
      priorities: priorities,
      nextWeekPlan: {
        taskTheme: "低负担亲子观察任务",
        targetGroup: "全班；时间有限家庭使用简化版",
        designNotes: ["15分钟内完成", "允许文字或照片任选", "给出一句示范反馈", "保留周末替代方案"],
        fallback: "只记录一次亲子对话或一张观察照片即可提交。"
      },
      followUpGroups: [
        {
          group: "已提交家庭",
          signal: "已有正式提交或进入执行环节",
          teacherAction: "点评中具体肯定孩子动作，形成正向循环。",
          tone: "具体肯定"
        },
        {
          group: "仅浏览家庭",
          signal: (behavior.touchpoints || 0) + "次触达类行为，执行类行为" + (behavior.followThrough || 0) + "次",
          teacherAction: "提供更短步骤，减少从查看到行动的门槛。",
          tone: "轻量邀请"
        }
      ]
    };
  }

  function renderAiActionHub(ai, report) {
    ai = ai || {};
    var fallback = fallbackActionModel(report);
    var priorities = (ai.priorities && ai.priorities.length) ? ai.priorities : fallback.priorities;
    var plan = (ai.nextWeekPlan && ai.nextWeekPlan.taskTheme) ? ai.nextWeekPlan : fallback.nextWeekPlan;
    var groups = (ai.followUpGroups && ai.followUpGroups.length) ? ai.followUpGroups : fallback.followUpGroups;
    var priorityHtml = priorities.length ? priorities.slice(0, 3).map(function (item) {
      return '<article class="priority-card"><div class="priority-head"><div class="priority-title">' +
        esc(item.title || "优先事项") + '</div><span class="urgency">' +
        esc(item.urgency || "中") + '</span></div><p class="priority-reason">' +
        emphasize(item.reason || "暂无原因说明") + '</p><div class="next-action"><span>下一步</span><b>' +
        emphasize(item.action || "结合具体提交记录判断") + '</b></div></article>';
    }).join("") : '<p class="summary">暂无 AI 优先级建议。</p>';

    var planHtml = "";
    if (plan && plan.taskTheme) {
      planHtml = '<div class="plan-box"><div class="plan-kicker">下周方案</div><div class="plan-title">' +
        esc(plan.taskTheme) + '</div><p><b>适用对象：</b>' + esc(plan.targetGroup || "全班") +
        '</p><div class="chip-line">' + (plan.designNotes || []).slice(0, 4).map(function (note) {
          return '<span>' + esc(note) + '</span>';
        }).join("") + '</div><p><b>替代方案：</b>' +
        esc(plan.fallback || "按家庭时间简化步骤") + '</p></div>';
    } else {
      planHtml = '<div class="plan-box"><p class="summary">暂无下周方案。</p></div>';
    }

    var groupHtml = groups.length ? '<div class="follow-grid">' + groups.slice(0, 3).map(function (group) {
      return '<div class="follow-card"><div class="follow-title">' +
        esc(group.group || "跟进对象") + '</div><p><b>信号：</b>' + esc(group.signal || "暂无") +
        '</p><p><b>建议：</b>' + esc(group.teacherAction || "保持观察") + '</p><span class="tone-tag">' +
        esc(group.tone || "温和、具体") + '</span></div>';
    }).join("") + '</div>' : '<p class="summary">暂无分层建议。</p>';

    return '<section class="ai-action-hub"><div class="hub-head"><div><div class="eyebrow">AI 核心洞察与行动建议</div>' +
      '<h2>先处理最值得老师花时间的事</h2></div></div><div class="hub-layout"><div class="hub-column">' +
      '<div class="hub-section-title">优先级</div>' + priorityHtml + '</div><div class="hub-column">' +
      planHtml + '<div class="hub-section-title follow-title-label">分组跟进</div>' + groupHtml +
      '</div></div></section>';
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

  function dimensionLabel(key) {
    var labels = {
      profiles: "学生详情",
      completionTime: "完成时间",
      textMaterials: "素材分析",
      behaviorSignals: "行为指导"
    };
    return labels[key] || "数据维度";
  }

  function renderDimensionBadges(dim) {
    if (dim.key === "profiles") {
      var rows = dim.rows || [];
      var avg = rows.length ? Math.round(rows.reduce(function (sum, row) {
        return sum + (Number(row.completeness) || 0);
      }, 0) / rows.length) : 0;
      return badge("样本", rows.length + "名", "accent") + badge("档案完整", avg + "%", avg < 70 ? "warn" : "calm");
    }
    if (dim.key === "completionTime") {
      var peak = "暂无";
      (dim.distribution || []).forEach(function (row) {
        if (row.percent && (peak === "暂无" || row.percent > peak.percent)) peak = row;
      });
      return badge("活跃期", peak.label || "暂无", "accent") +
        badge("提交滞后", ((dim.latency && dim.latency.avgSubmitLagHours) || 0) + "小时", "muted");
    }
    if (dim.key === "textMaterials") {
      var text = dim.indicators || {};
      return badge("积极表达", (text.positive || 0) + "次", "calm") +
        badge("困难线索", (text.difficulty || 0) + "次", text.difficulty ? "warn" : "muted") +
        badge("亲子协作", (text.collaboration || 0) + "次", "accent");
    }
    if (dim.key === "behaviorSignals") {
      var beh = dim.indicators || {};
      return badge("触达", (beh.touchpoints || 0) + "次", "accent") +
        badge("执行", (beh.followThrough || 0) + "次", beh.followThrough ? "calm" : "muted") +
        badge("活跃学生", (beh.activeStudents || 0) + "名", "accent");
    }
    return "";
  }

  function renderDimensionVisual(dim) {
    if (dim.key === "profiles") {
      return '<div class="compact-note">优先补齐陪伴人、可用时间和兴趣标签，再做个性化任务匹配。</div>';
    }
    if (dim.key === "completionTime") {
      return '<div class="viz-grid"><div><div class="section-title">提交时段</div>' + bars(dim.distribution) +
        '</div><div><div class="section-title">工作日/周末</div>' + bars(dim.weekdayDistribution) + '</div></div>';
    }
    if (dim.key === "textMaterials") {
      var indicators = dim.indicators || {};
      return countBars([
        { label: "积极表达", count: indicators.positive || 0 },
        { label: "困难线索", count: indicators.difficulty || 0 },
        { label: "亲子协作", count: indicators.collaboration || 0 },
        { label: "过程记录", count: indicators.observation || 0 }
      ]);
    }
    if (dim.key === "behaviorSignals") {
      return '<div class="section-title">行为事件分布（近30天）</div>' + bars(dim.distribution);
    }
    return "";
  }

  function renderDimensionDetails(dim) {
    var extra = "";
    if (dim.key === "profiles") extra = renderProfileRows(dim.rows);
    if (dim.key === "textMaterials") extra = renderSamples(dim.samples);
    if (dim.key === "behaviorSignals") extra = renderBehaviorRows(dim.rows);
    return '<details class="analysis-details"><summary>查看详细分析</summary>' +
      '<div class="details-grid"><div><div class="section-title">关键发现</div>' + list(dim.findings) +
      '</div><div><div class="section-title">建议动作</div>' + actionList(dim.actions) +
      '</div></div>' + (extra ? '<div class="section-title">明细样本</div>' + extra : "") + '</details>';
  }

  function renderDimensionPanel(dim, active) {
    var finding = (dim.findings && dim.findings[0]) || dim.aiSummary || dim.summary || "暂无足够数据。";
    var action = (dim.actions && dim.actions[0]) || "继续观察数据变化。";
    return '<section class="data-pane' + (active ? " active" : "") + '" data-data-panel="' + esc(dim.key) + '">' +
      '<div class="data-pane-head"><div><div class="eyebrow">' + esc(dimensionLabel(dim.key)) +
      '</div><h3>' + esc(dim.title) + '</h3></div><span class="card-tag">' +
      (dim.aiSummary ? "AI 增强" : "规则分析") + '</span></div><div class="report-badges compact">' +
      renderDimensionBadges(dim) + '</div><div class="core-finding"><span>核心发现</span><p>' +
      emphasize(finding) + '</p></div><div class="core-action"><span>核心建议</span><p>' +
      emphasize(action) + '</p></div>' + renderDimensionVisual(dim) + renderDimensionDetails(dim) + '</section>';
  }

  function renderDataBoard(dims) {
    dims = dims || [];
    if (!dims.length) return "";
    return '<section class="data-board"><div class="board-head"><div><div class="eyebrow">详细学情与数据档案</div>' +
      '<h2>把明细收进同一个看板</h2></div></div><div class="data-tabs" role="tablist">' +
      dims.map(function (dim, index) {
        return '<button type="button" class="data-tab' + (index === 0 ? " active" : "") +
          '" data-data-tab="' + esc(dim.key) + '">' + esc(dimensionLabel(dim.key)) + '</button>';
      }).join("") + '</div><div class="data-panels">' + dims.map(function (dim, index) {
        return renderDimensionPanel(dim, index === 0);
      }).join("") + '</div></section>';
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
      renderReportBadges(report) +
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
    var statHtml = '<section class="stat-grid">' +
      stat("学生总数", stats.totalStudents || 0) +
      stat("档案完整度", (stats.profileCompleteness || 0) + "%") +
      stat("提交总数", stats.totalSubmissions || 0) +
      stat("活跃学生", stats.activeStudents || 0) +
      stat("提交高峰", stats.peakCompletionTime || "暂无") +
      stat("平均字数", stats.avgTextLength || 0) + '</section>';
    var notices = "";
    if (report.aiError) {
      notices += '<div class="warn-note">AI 调用未完成：' + esc(report.aiError) +
        '。当前展示本地规则分析结果。</div>';
    }
    if ((scope.filteredDemoStudents || 0) > 0) {
      notices += '<div class="warn-note">已排除 ' + esc(scope.filteredDemoStudents) +
        ' 条演示学生数据，当前报告仅使用真实家长账号产生的数据。</div>';
    }
    var scopeNotice = "";
    if ((scope.realStudents || 0) === 0 && (scope.filteredDemoStudents || 0) > 0) {
      scopeNotice = '<div class="warn-note data-scope-note"><b>当前没有真实家长数据</b>：线上数据库目前只有演示账号产生的学生记录，' +
        '这些记录已按规则排除。请先让家长使用真实账号注册，并绑定孩子或提交问卷；数据会在真实操作后出现在这里。</div>';
    }
    var corePanel = scopeNotice + createAssistantShell(report, options.aiLoading === true) + statHtml + notices;
    var dataPanel = scopeNotice + statHtml;
    if ((scope.realStudents || 0) === 0) {
      corePanel += '<p class="empty">暂无真实学生数据。请先让家长注册、填写问卷或绑定孩子后再查看 AI 分析。</p>';
      dataPanel += '<p class="empty">暂无真实学生数据。请先让家长注册、填写问卷或绑定孩子后再查看数据档案。</p>';
    } else {
      corePanel += renderAiActionHub(ai, report);
      dataPanel += notices + renderDataBoard(dims);
      if (ai.risks && ai.risks.length) {
        corePanel += '<div class="warn-note"><b>谨慎解读：</b>' + esc(ai.risks.join("；")) + '</div>';
      }
    }
    var html = '<section class="dashboard-tabs"><div class="main-tab-list" role="tablist">' +
      '<button type="button" class="main-tab active" data-main-tab="core">AI 核心洞察与行动建议</button>' +
      '<button type="button" class="main-tab" data-main-tab="data">详细学情与数据档案</button>' +
      '</div><div class="main-tab-panel active" data-main-panel="core">' + corePanel +
      '</div><div class="main-tab-panel" data-main-panel="data">' + dataPanel + '</div></section>';
    document.getElementById("reportBody").innerHTML = html;
    if (options.restoreMessages) {
      // 问候语始终按最新逻辑与最新数据重新生成，历史对话恢复时跳过缓存的旧问候语
      appendMessage("assistant", assistantGreeting(report));
      restoreChat(true);
    } else {
      appendMessage("assistant", assistantGreeting(report));
    }
    bindAssistant();
    bindDashboardTabs();
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

  function bindDashboardTabs() {
    document.querySelectorAll(".main-tab").forEach(function (button) {
      button.addEventListener("click", function () {
        var target = button.getAttribute("data-main-tab");
        document.querySelectorAll(".main-tab").forEach(function (tab) {
          tab.classList.toggle("active", tab === button);
        });
        document.querySelectorAll(".main-tab-panel").forEach(function (panel) {
          panel.classList.toggle("active", panel.getAttribute("data-main-panel") === target);
        });
      });
    });
    document.querySelectorAll(".data-tab").forEach(function (button) {
      button.addEventListener("click", function () {
        var target = button.getAttribute("data-data-tab");
        var board = button.closest(".data-board");
        if (!board) return;
        board.querySelectorAll(".data-tab").forEach(function (tab) {
          tab.classList.toggle("active", tab === button);
        });
        board.querySelectorAll(".data-pane").forEach(function (panel) {
          panel.classList.toggle("active", panel.getAttribute("data-data-panel") === target);
        });
      });
    });
  }

  var aiCacheKey = cacheKey("Report");

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
