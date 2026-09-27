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
    sending: false,
    report: null
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

  function stat(label, value, meta, formula, href, tone) {
    var tag = href ? "a" : "div";
    var attrs = href ? ' href="' + esc(href) + '"' : "";
    var title = formula ? ' title="' + esc(formula) + '"' : "";
    return '<' + tag + ' class="stat-card' + (href ? " is-clickable" : "") + (tone ? " " + tone : "") + '"' +
      attrs + title + '><div class="stat-card-top"><div class="stat-value">' + esc(value) +
      '</div>' + (formula ? '<span class="metric-help" aria-label="指标说明">?</span>' : '') +
      '</div><div class="stat-label">' + esc(label) + '</div>' +
      (meta ? '<div class="stat-meta">' + esc(meta) + '</div>' : '') + '</' + tag + '>';
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

  function badgeTip(label, value, tone, formula) {
    return '<span class="insight-badge ' + (tone || "") + '"' + (formula ? ' title="' + esc(formula) + '"' : '') +
      '><span>' + esc(label) + '</span><b>' + esc(value) + '</b>' +
      (formula ? '<i class="metric-help" aria-label="指标说明">?</i>' : '') + '</span>';
  }

  function percent(part, total) {
    part = Number(part) || 0;
    total = Number(total) || 0;
    return total > 0 ? Math.round(part / total * 100) : 0;
  }

  function peakTimeText(label) {
    var ranges = {
      "上午": "上午 08:00 - 12:00",
      "下午": "下午 14:00 - 17:00",
      "晚间": "晚间 18:00 - 21:00",
      "深夜/清晨": "深夜/清晨 21:00 - 08:00",
      "未知": "暂无"
    };
    return ranges[label] || label || "暂无";
  }

  function behaviorDim(report) {
    var found = null;
    (report.dimensions || []).forEach(function (dim) {
      if (dim.key === "behaviorSignals") found = dim;
    });
    return found;
  }

  function scopeText(report) {
    var scope = (report && report.dataScope) || {};
    var total = scope.realStudents != null ? scope.realStudents : (((report || {}).stats || {}).totalStudents || 0);
    var excluded = scope.filteredDemoStudents || 0;
    var text = "基于已激活档案的 " + total + " 名学生";
    if (excluded > 0) text += "，排除 " + excluded + " 名未入库或演示学生";
    return text + "；顶部指标与下方分析使用同一统计分母。";
  }

  function copyTemplate(text) {
    return '<button type="button" class="inline-action" data-dashboard-copy="' + esc(text) + '">' +
      esc("一键通知家长补充") + '</button>';
  }

  function dimensionActionButtons(dim, report) {
    if (dim.key === "profiles") {
      return '<div class="dimension-actions">' +
        copyTemplate("各位家长好，为便于老师更准确地安排家校共育任务，请补充孩子档案中的主要陪伴人、可用时间和兴趣标签。") +
        '<a class="inline-action secondary" href="teacher-students.html#filter=incomplete">批量完善档案</a></div>';
    }
    if (dim.key === "completionTime") {
      return '<div class="dimension-actions"><a class="inline-action secondary" href="teacher-students.html#filter=unsubmitted">查看未提交学生</a></div>';
    }
    if (dim.key === "textMaterials") {
      return '<div class="dimension-actions"><a class="inline-action secondary" href="teacher-submissions.html">查看提交与点评</a></div>';
    }
    if (dim.key === "behaviorSignals") {
      return '<div class="dimension-actions"><button type="button" class="inline-action secondary" data-question="请根据近30天行为信号，列出需要轻量提醒的学生分组和沟通措辞。">生成分层提醒</button></div>';
    }
    return "";
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

  function renderDimensionBadges(dim, report) {
    var stats = (report && report.stats) || {};
    var scope = (report && report.dataScope) || {};
    var totalStudents = scope.realStudents != null ? scope.realStudents : (stats.totalStudents || 0);
    if (dim.key === "profiles") {
      var avg = stats.profileCompleteness || 0;
      return badgeTip("统计分母", totalStudents + "名", "accent", "仅统计已激活、非演示的真实学生档案") +
        badgeTip("档案完整", avg + "%", avg < 70 ? "warn" : "calm", "完整档案数 / 已激活学生数") +
        badge("明细预览", ((dim.rows || []).length) + "名", "muted");
    }
    if (dim.key === "completionTime") {
      var peak = "暂无";
      (dim.distribution || []).forEach(function (row) {
        if (row.percent && (peak === "暂无" || row.percent > peak.percent)) peak = row;
      });
      return badgeTip("活跃期", peakTimeText(peak.label || "暂无"), "accent", "按提交时间小时段聚合，展示占比最高时段") +
        badgeTip("提交滞后", ((dim.latency && dim.latency.avgSubmitLagHours) || 0) + "小时", "muted", "提交时间 - 任务发布时间的平均小时数");
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
      return "";
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
    var detailLabel = dim.key === "profiles"
      ? "展开查看 " + ((dim.rows || []).length) + " 名学生明细得分与缺失字段"
      : "展开查看关键发现、建议动作与明细样本";
    return '<details class="analysis-details"><summary>' + esc(detailLabel) + '</summary>' +
      '<div class="details-grid"><div><div class="section-title">关键发现</div>' + list(dim.findings) +
      '</div><div><div class="section-title">建议动作</div>' + actionList(dim.actions) +
      '</div></div>' + (extra ? '<div class="section-title">明细样本</div>' + extra : "") + '</details>';
  }

  function renderDimensionPanel(dim, active, report) {
    var finding = (dim.findings && dim.findings[0]) || dim.aiSummary || dim.summary || "暂无足够数据。";
    var action = (dim.actions && dim.actions[0]) || "继续观察数据变化。";
    return '<section class="data-pane' + (active ? " active" : "") + '" data-data-panel="' + esc(dim.key) + '">' +
      '<div class="data-pane-head"><div><div class="eyebrow">' + esc(dimensionLabel(dim.key)) +
      '</div><h3>' + esc(dim.title) + '</h3></div><span class="card-tag">' +
      (dim.aiSummary ? "AI 增强" : "评估依据") + '</span></div><div class="report-badges compact">' +
      renderDimensionBadges(dim, report) + '</div><div class="core-grid"><div class="core-finding"><span>核心发现</span><p>' +
      emphasize(finding) + '</p></div><div class="core-action"><span>核心建议</span><p>' +
      emphasize(action) + '</p>' + dimensionActionButtons(dim, report) + '</div></div>' +
      renderDimensionVisual(dim) + renderDimensionDetails(dim) + '</section>';
  }

  function renderDataBoard(dims, report) {
    dims = dims || [];
    if (!dims.length) return "";
    return '<section class="data-board"><div class="board-head"><div><div class="eyebrow">详细学情与数据档案</div>' +
      '<h2>班级学情与档案综合分析</h2></div></div><div class="scope-note">' + esc(scopeText(report)) + '</div><div class="data-tabs" role="tablist">' +
      dims.map(function (dim, index) {
        return '<button type="button" class="data-tab' + (index === 0 ? " active" : "") +
          '" data-data-tab="' + esc(dim.key) + '">' + esc(dimensionLabel(dim.key)) + '</button>';
      }).join("") + '</div><div class="data-panels">' + dims.map(function (dim, index) {
        return renderDimensionPanel(dim, index === 0, report);
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

  function getStudentProgress(report) {
    var stats = report.stats || {};
    var progress = report.studentProgress || {};
    var total = progress.totalStudents || stats.totalStudents || 0;
    var submitted = progress.submittedCount != null ? progress.submittedCount : (stats.weekSubmittedStudents || 0);
    var rate = progress.completionRate != null ? progress.completionRate : (total ? Math.round(submitted / total * 100) : 0);
    var weekTasks = progress.weekTaskCount != null ? progress.weekTaskCount : (stats.weekTaskCount || 0);
    var customTasks = progress.personalizedWeekTaskCount != null ? progress.personalizedWeekTaskCount : (stats.customTaskCount || 0);
    var riskLevel = progress.riskLevel || (rate < 30 || (weekTasks >= 5 && rate < 50) ? "red" : (rate < 70 || customTasks >= 3 ? "yellow" : "green"));
    var riskTitle = progress.riskTitle || (riskLevel === "red" ? "任务进度严重滞后" : (riskLevel === "yellow" ? "任务推进需要干预" : "任务进度正常"));
    return {
      riskLevel: riskLevel,
      riskTitle: riskTitle,
      completionRate: rate,
      totalStudents: total,
      weekTaskCount: weekTasks,
      personalizedWeekTaskCount: customTasks,
      submittedCount: submitted,
      pendingFeedback: progress.pendingFeedback != null ? progress.pendingFeedback : (stats.weekPendingFeedback || 0),
      suggestedReminderWindow: progress.suggestedReminderWindow || "18:30 - 20:00",
      completed: progress.completed || [],
      draftStalled: progress.draftStalled || [],
      viewedNotStarted: progress.viewedNotStarted || [],
      untouched: progress.untouched || [],
      noAnswerCount: progress.noAnswerCount != null ? progress.noAnswerCount : Math.max(0, total - submitted)
    };
  }

  function namesText(items, field, limit) {
    items = items || [];
    field = field || "name";
    limit = limit || 8;
    if (!items.length) return "暂无";
    var names = items.slice(0, limit).map(function (item) { return item[field] || item.childName || item.name; }).filter(Boolean);
    return names.join("、") + (items.length > limit ? "等" + items.length + "人" : "");
  }

  function reminderTemplate(report) {
    var progress = getStudentProgress(report || {});
    return "各位家长好，本周家校共育任务还有部分同学未提交。建议今晚 " +
      progress.suggestedReminderWindow + " 前完成或先保存草稿；如果时间紧，请优先完成最核心的一项，并在提交中简单说明遇到的困难。老师会根据大家的完成情况调整后续任务量。";
  }

  function renderFollowupChips(report) {
    var progress = getStudentProgress(report || state.report || {});
    var copyText = esc(reminderTemplate(report || state.report || {}));
    return '<div class="assistant-followups" aria-label="建议追问">' +
      '<button type="button" data-copy="' + copyText + '">[复制] 未交家庭催交通知</button>' +
      '<button type="button" data-question="查看草稿卡点学生的具体任务与可能卡点。">[查看] 草稿卡点</button>' +
      '<button type="button" data-question="帮我生成本周定制任务延期48小时方案，并说明应优先延期哪些任务。">[建议] 延期48小时方案</button>' +
      '<button type="button" data-question="生成下周任务合并与减负建议清单。">[方案] 下周减负清单</button>' +
      (progress.pendingFeedback ? '<button type="button" data-question="哪些提交最需要我优先点评？">[点评] ' + progress.pendingFeedback + '份待处理</button>' : '') +
      '</div>';
  }

  function renderBriefingBubble(report) {
    var progress = getStudentProgress(report);
    var riskLabel = progress.riskLevel === "red" ? "红色风险" : (progress.riskLevel === "yellow" ? "黄色预警" : "绿色正常");
    var completedDetail = progress.completed.length
      ? progress.completed.slice(0, 6).map(function (item) {
          return esc(item.name) + "（" + (item.pendingFeedback ? "待点评" : "已点评") + "）";
        }).join("、") + (progress.completed.length > 6 ? "等" + progress.completed.length + "人" : "")
      : "暂无";
    var draftDetail = progress.draftStalled.length
      ? progress.draftStalled.slice(0, 5).map(function (item) {
          return esc(item.name) + "（《" + esc(item.taskTitle || "本周任务") + "》草稿）";
        }).join("、") + (progress.draftStalled.length > 5 ? "等" + progress.draftStalled.length + "人" : "")
      : "暂无";
    var noAnswerDetail = namesText(progress.untouched.concat(progress.viewedNotStarted), "name", 8);
    var diagnosis = progress.weekTaskCount >= 5 || progress.personalizedWeekTaskCount >= 3
      ? "本周任务量偏高，尤其是定制任务占比较大，容易让家庭产生观望或拖延。"
      : "本周任务量处于可控范围，当前主要问题在提醒触达与开始动作。";
    var completionLine = "本周已发布 " + progress.weekTaskCount + " 项任务（含 " + progress.personalizedWeekTaskCount +
      " 项定制任务），班级共 " + progress.totalStudents + " 人，目前 " + progress.submittedCount +
      " 人提交，完成率 " + progress.completionRate + "%。";
    return '<div class="briefing-card action-brief"><section class="brief-section status-alert ' + progress.riskLevel + '">' +
      '<div class="briefing-kicker">学情风险提示</div><div class="briefing-title"><span class="risk-dot" aria-hidden="true"></span>' +
      esc(progress.riskTitle) + '</div><p>' + esc(completionLine) + '</p><div class="briefing-metrics">' +
      '<span class="briefing-metric ' + progress.riskLevel + '"><span>状态定级</span><b>' + esc(riskLabel) + '</b></span>' +
      '<span class="briefing-metric"><span>任务量</span><b>' + progress.weekTaskCount + '项 / 定制' + progress.personalizedWeekTaskCount + '项</b></span>' +
      '<span class="briefing-metric"><span>完成率</span><b>' + progress.completionRate + '%</b></span>' +
      '<span class="briefing-metric"><span>建议提醒时段</span><b>' + esc(progress.suggestedReminderWindow) + '</b></span>' +
      '</div></section><section class="brief-section"><div class="brief-section-title">学生进度分流</div>' +
      '<div class="progress-lanes"><div><b>已完成（' + progress.completed.length + '人）</b><p>' + completedDetail + '</p></div>' +
      '<div><b>草稿卡点（' + progress.draftStalled.length + '人）</b><p>' + draftDetail + '</p></div>' +
      '<div><b>完全未做（' + progress.noAnswerCount + '人）</b><p>' + esc(noAnswerDetail) +
      (progress.viewedNotStarted.length ? '；其中 ' + progress.viewedNotStarted.length + ' 位已查看但未开始' : '') + '</p></div></div></section>' +
      '<section class="brief-section"><div class="brief-section-title">教学诊断与负担评估</div><p>' +
      esc(diagnosis + "建议把提醒安排在 " + progress.suggestedReminderWindow + "，并优先处理草稿停滞学生的共同卡点。") + '</p></section>' +
      '<section class="brief-section"><div class="brief-section-title">建议下一步行动</div><ol class="next-steps">' +
      '<li><b>任务减负：</b>将定制任务截止时间顺延 48 小时，或合并重复口头打卡。</li>' +
      '<li><b>重点讲评：</b>先查看草稿卡点学生涉及的任务，明日课堂优先复习同类要求。</li>' +
      '<li><b>定向提醒：</b>在 ' + esc(progress.suggestedReminderWindow) + ' 向未提交家庭发送提醒。</li>' +
      '</ol><div class="copy-template"><span>催交通知模板</span><p>' + esc(reminderTemplate(report)) + '</p></div></section>' +
      renderFollowupChips(report) + '</div>';
  }

  function createAssistantShell(report, aiLoading) {
    var source = report.source || "本地规则分析";
    var loadingText = report.aiLoadingText || (report.aiStale ? "正在更新为最新班级数据" : "正在生成 AI 洞察");
    return '<section class="assistant-shell' + (aiLoading ? " is-ai-loading" : "") + '"' +
      (aiLoading ? ' aria-busy="true"' : "") + '><div class="assistant-head"><div class="assistant-brand">' +
      '<span class="assistant-mark">✦</span><div><div class="assistant-title">AI 班级助手</div>' +
      '<div class="assistant-status">' + (aiLoading ? esc(loadingText) + "…" : "已读取学生档案、任务、提交与点评记录") +
      '</div></div></div>' +
      '<span class="assistant-source">' + esc(source) + '</span></div>' +
      '<div id="assistantMessages" class="assistant-messages"></div>' +
      '<form id="assistantForm" class="assistant-compose"><textarea id="assistantInput" class="assistant-input" rows="1" ' +
      'placeholder="询问班级学情，或输入“帮我写催交通知”…"></textarea>' +
      '<button id="assistantSend" class="assistant-send" type="submit" aria-label="发送" disabled>↑</button></form>' +
      '<div class="assistant-note">分析依据为系统内已授权的班级数据；家长行为信号仅用于支持沟通，不代表对家长关注程度的绝对判断。</div>' +
      (aiLoading ? '<div class="assistant-loading" role="status" aria-label="AI 正在加载">' +
        '<img src="assets/site-logo.png" alt=""><span>' + esc(loadingText) + '</span></div>' : '') + '</section>';
  }

  function insertMessage(role, content, sources, extraClass, htmlContent, withFollowups) {
    var root = document.getElementById("assistantMessages");
    if (!root) return null;
    var isUser = role === "user";
    var html = '<div class="assistant-message ' + (isUser ? "user" : "assistant") +
      (extraClass ? " " + extraClass : "") + '">' +
      '<span class="assistant-avatar">' + (isUser ? "我" : "AI") + '</span>' +
      '<div><div class="assistant-bubble">' + (!isUser && htmlContent ? htmlContent : esc(content)) + '</div>';
    if (!isUser && sources && sources.length) {
      html += '<div class="assistant-citations">参考：' + sources.map(function (source) {
        return esc(source.title);
      }).join("、") + '</div>';
    }
    if (!isUser && withFollowups) html += renderFollowupChips();
    html += '</div></div>';
    root.insertAdjacentHTML("beforeend", html);
    var messageEl = root.lastElementChild;
    root.scrollTop = root.scrollHeight;
    return {
      root: root,
      messageEl: messageEl,
      bubbleEl: messageEl ? messageEl.querySelector(".assistant-bubble") : null
    };
  }

  function saveMessage(role, content, sources) {
    state.messages.push({ role: role, content: content, sources: sources || [] });
    saveCached(cacheKey("Chat"), state.messages);
  }

  function appendMessage(role, content, sources) {
    var inserted = insertMessage(role, content, sources);
    if (!inserted) return;
    saveMessage(role, content, sources);
  }

  function appendBriefingMessage(report) {
    var text = assistantGreeting(report);
    var inserted = insertMessage("assistant", text, [], "briefing", renderBriefingBubble(report), false);
    if (!inserted) return;
    saveMessage("assistant", text, []);
  }

  function setMessageSources(messageEl, sources) {
    if (!messageEl || !sources || !sources.length) return;
    var wrap = messageEl.children[1];
    if (!wrap) return;
    var old = wrap.querySelector(".assistant-citations");
    if (old) old.remove();
    var citations = document.createElement("div");
    citations.className = "assistant-citations";
    citations.textContent = "参考：" + sources.map(function (source) { return source.title; }).join("、");
    wrap.appendChild(citations);
  }

  function setMessageFollowups(messageEl) {
    if (!messageEl) return;
    var wrap = messageEl.children[1];
    if (!wrap || wrap.querySelector(".assistant-followups")) return;
    wrap.insertAdjacentHTML("beforeend", renderFollowupChips(state.report));
  }

  function createStreamingAssistantMessage(onDone) {
    var inserted = insertMessage("assistant", "", [], "streaming");
    var queue = "";
    var displayed = "";
    var finished = false;
    var saved = false;
    var sources = [];
    var timer = null;

    function render() {
      if (!inserted || !inserted.bubbleEl) return;
      inserted.bubbleEl.textContent = displayed || " ";
      inserted.root.scrollTop = inserted.root.scrollHeight;
    }

    function complete() {
      if (!finished || queue || timer) return;
      if (saved) return;
      saved = true;
      if (!displayed) {
        displayed = "暂时没有得到回答。";
        render();
      }
      if (inserted.messageEl) inserted.messageEl.classList.remove("streaming");
      setMessageSources(inserted.messageEl, sources);
      setMessageFollowups(inserted.messageEl);
      saveMessage("assistant", displayed, sources);
      if (onDone) onDone();
    }

    function tick() {
      timer = null;
      if (!queue) { complete(); return; }
      var take = queue.length > 120 ? 4 : (queue.length > 40 ? 2 : 1);
      displayed += queue.slice(0, take);
      queue = queue.slice(take);
      render();
      timer = window.setTimeout(tick, queue.length > 120 ? 4 : 12);
    }

    return {
      push: function (text) {
        queue += String(text || "");
        if (!timer) tick();
      },
      fail: function (message) {
        queue += (displayed || queue ? "\n\n" : "") + (message || "这次查询没有完成，请稍后再试。");
        finished = true;
        if (!timer) tick();
      },
      finish: function (nextSources) {
        sources = nextSources || [];
        finished = true;
        if (!timer) tick();
      }
    };
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
    var sendButton = document.getElementById("assistantSend");
    if (sendButton) sendButton.disabled = true;
    var history = state.messages.slice(-7).map(function (message) {
      return { role: message.role, content: message.content };
    });
    appendMessage("user", question);
    var stream = createStreamingAssistantMessage(function () {
      state.sending = false;
      var input = document.getElementById("assistantInput");
      if (sendButton) sendButton.disabled = !(input && input.value.trim());
    });
    var auth = getAuth();
    fetch(API_BASE + "/api/teacher/ai-chat?stream=1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": auth && auth.token ? "Bearer " + auth.token : ""
      },
      body: JSON.stringify({
        question: question,
        history: history
      })
    }).then(function (res) {
      if (res.status === 401) {
        localStorage.removeItem("auth");
        window.location.href = "index.html";
        throw new Error("请先登录");
      }
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          throw new Error(data.message || "这次查询没有完成，请稍后再试。");
        });
      }
      if (!res.body || !window.TextDecoder) {
        return res.json().then(function (result) {
          stream.push(result.answer || "暂时没有得到回答。");
          stream.finish(result.sources || []);
        });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder("utf-8");
      var buffer = "";
      var gotDone = false;

      function handleBlock(block) {
        var eventName = "message";
        var dataLines = [];
        block.split(/\r?\n/).forEach(function (line) {
          if (line.indexOf("event:") === 0) eventName = line.slice(6).trim();
          if (line.indexOf("data:") === 0) dataLines.push(line.slice(5).trimStart());
        });
        if (!dataLines.length) return;
        var data = {};
        try { data = JSON.parse(dataLines.join("\n")); } catch (e) { return; }
        if (eventName === "delta") stream.push(data.content || "");
        if (eventName === "error") stream.fail(data.message || "AI 连接中断，以上为已生成内容。");
        if (eventName === "done") {
          gotDone = true;
          stream.finish(data.sources || []);
        }
      }

      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            buffer += decoder.decode();
            if (buffer.trim()) handleBlock(buffer);
            if (!gotDone) stream.finish([]);
            return;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          var blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() || "";
          blocks.forEach(handleBlock);
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      stream.fail(err && err.message ? err.message : "这次查询没有完成，请稍后再试。");
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
    state.report = report;
    var isAiPage = document.body.classList.contains("teacher-ai-page");
    var ai = report.ai || {};
    var stats = report.stats || {};
    var scope = report.dataScope || {};
    var dims = report.dimensions || [];
    var progress = getStudentProgress(report);
    var behavior = behaviorDim(report);
    var behaviorActive = behavior && behavior.indicators ? (behavior.indicators.activeStudents || 0) : (stats.activeStudents || 0);
    var submittedRate = percent(progress.submittedCount, progress.totalStudents);
    var completeCount = Math.round((stats.profileCompleteness || 0) * (stats.totalStudents || 0) / 100);
    var avgTextBaseline = 50;
    var avgTextMeta = "历史提交 · " + ((stats.avgTextLength || 0) >= avgTextBaseline ? "达到50字基准" : "低于50字基准");
    var statHtml = '<section class="stat-grid">' +
      stat("学生总数", stats.totalStudents || 0, "已激活档案", "已激活、非演示学生数量", "teacher-students.html", "") +
      stat("档案完整度", (stats.profileCompleteness || 0) + "%", "完整 " + completeCount + " / " + (stats.totalStudents || 0), "完整档案数 / 已激活学生数", "teacher-students.html#filter=incomplete", (stats.profileCompleteness || 0) < 70 ? "warn" : "") +
      stat("本周提交进度", "实交 " + progress.submittedCount + " / 应交 " + progress.totalStudents, submittedRate + "% · 点击看未提交", "本周已提交学生数 / 已激活学生数", "teacher-students.html#filter=unsubmitted", submittedRate < 70 ? "warn" : "") +
      stat("近30天活跃学生", behaviorActive + " / " + (stats.totalStudents || 0), "有触达或执行记录", "近30天有站内行为记录的学生数 / 已激活学生数", "teacher-students.html", "") +
      stat("提交高峰", peakTimeText(stats.peakCompletionTime), "按历史提交时段", "提交时间按小时段聚合，占比最高的时段", "teacher-submissions.html", "") +
      stat("平均字数", (stats.avgTextLength || 0) + "字", avgTextMeta, "文字提交总字数 / 提交份数；50字为过程描述参考基准", "teacher-submissions.html", (stats.avgTextLength || 0) < avgTextBaseline ? "warn" : "") + '</section>';
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
    var assistantPanel = scopeNotice + createAssistantShell(report, options.aiLoading === true);
    var dataPanel = scopeNotice + statHtml;
    var aiPanel = assistantPanel + notices;
    if ((scope.realStudents || 0) === 0) {
      dataPanel += '<p class="empty">暂无真实学生数据。请先让家长注册、填写问卷或绑定孩子后再查看数据档案。</p>';
      aiPanel += '<p class="empty">暂无真实学生数据。请先让家长注册、填写问卷或绑定孩子后再查看 AI 分析。</p>';
    } else {
      dataPanel += notices + renderDataBoard(dims, report);
      if (!isAiPage) aiPanel += renderAiActionHub(ai, report);
      if (!isAiPage && ai.risks && ai.risks.length) {
        aiPanel += '<div class="warn-note"><b>谨慎解读：</b>' + esc(ai.risks.join("；")) + '</div>';
      }
    }
    var html = isAiPage
      ? '<section class="dashboard-page ai-insight-page">' + aiPanel + '</section>'
      : '<section class="dashboard-page data-archive-page">' + dataPanel + '</section>';
    document.getElementById("reportBody").innerHTML = html;
    if (options.restoreMessages) {
      // 问候语始终按最新逻辑与最新数据重新生成，历史对话恢复时跳过缓存的旧问候语
      appendBriefingMessage(report);
      restoreChat(true);
    } else {
      appendBriefingMessage(report);
    }
    bindAssistant();
    bindDashboardTabs();
    bindDashboardActions();
  }

  function bindAssistant() {
    var form = document.getElementById("assistantForm");
    var input = document.getElementById("assistantInput");
    var sendButton = document.getElementById("assistantSend");
    if (!form || !input) return;
    function autoSize() {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 132) + "px";
    }
    function updateSendState() {
      var hasText = !!input.value.trim();
      form.classList.toggle("has-input", hasText);
      if (sendButton) sendButton.disabled = state.sending || !hasText;
    }
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var value = input.value.trim();
      input.value = "";
      autoSize();
      updateSendState();
      sendQuestion(value);
    });
    input.addEventListener("input", function () {
      autoSize();
      updateSendState();
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    document.querySelectorAll(".assistant-shell").forEach(function (shell) {
      shell.addEventListener("click", function (event) {
        var button = event.target.closest("button[data-question], button[data-copy]");
        if (!button || !shell.contains(button)) return;
        var copy = button.getAttribute("data-copy");
        if (copy) {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(copy).then(function () {
              button.textContent = "已复制";
              window.setTimeout(function () { button.textContent = "[复制] 未交家庭催交通知"; }, 1600);
            }).catch(function () {});
          }
          return;
        }
        sendQuestion(button.getAttribute("data-question"));
      });
    });
    autoSize();
    updateSendState();
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

  function bindDashboardActions() {
    document.querySelectorAll("[data-dashboard-copy]").forEach(function (button) {
      button.addEventListener("click", function () {
        var text = button.getAttribute("data-dashboard-copy") || "";
        if (!text || !(navigator.clipboard && navigator.clipboard.writeText)) return;
        navigator.clipboard.writeText(text).then(function () {
          var old = button.textContent;
          button.textContent = "已复制通知文案";
          window.setTimeout(function () { button.textContent = old; }, 1600);
        }).catch(function () {});
      });
    });
    document.querySelectorAll(".data-board button[data-question]").forEach(function (button) {
      button.addEventListener("click", function () {
        sendQuestion(button.getAttribute("data-question"));
      });
    });
  }

  var aiCacheKey = cacheKey("Report");
  var aiLoadingPhases = [
    "正在读取班级数据",
    "正在分析家长参与节奏",
    "正在生成下周任务建议",
    "正在整理教师行动清单"
  ];

  function aiLoadingText(attempt, report) {
    if (report && report.aiLoadingText) return report.aiLoadingText;
    return aiLoadingPhases[Math.min(aiLoadingPhases.length - 1, Math.floor((attempt || 0) / 2))];
  }

  function loadAiReport(baseReport, attempt) {
    attempt = attempt || 0;
    return api("/api/teacher/global-report?ai=1").then(function (aiReport) {
      if (aiReport.aiPending) {
        aiReport.aiLoadingText = aiLoadingText(attempt, aiReport);
        renderReport(aiReport, { aiLoading: true });
        if (attempt < 18) {
          window.setTimeout(function () { loadAiReport(baseReport, attempt + 1); }, attempt < 3 ? 1200 : 2500);
        } else {
          baseReport.aiError = "AI 分析仍在生成中，稍后刷新可查看最新结果";
          renderReport(baseReport, { aiLoading: false });
        }
        return null;
      }
      saveCached(aiCacheKey, aiReport);
      renderReport(aiReport, { aiLoading: false });
      return aiReport;
    }).catch(function () {
      baseReport.aiError = "AI 分析加载失败，当前展示本地规则分析结果";
      renderReport(baseReport, { aiLoading: false });
    });
  }

  api("/api/teacher/global-report?local=1").then(function (report) {
    report.aiLoadingText = aiLoadingPhases[0];
    renderReport(report, { aiLoading: !!report.aiEnabled });
    if (!report.aiEnabled) return null;
    return loadAiReport(report, 0);
  }).catch(function () {
    document.getElementById("reportBody").innerHTML =
      '<p class="empty">全局报告加载失败，请稍后重试</p>';
  });
}());
