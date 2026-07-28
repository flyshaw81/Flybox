/** 从当前复盘页拦截包 + DOM：画像 / 流量渠道 / 漏斗 / 分钟曲线（单场） */
(function () {
  function n(v) {
    if (v == null || v === "") return null;
    var x = Number(v);
    return isFinite(x) ? x : null;
  }
  function pct01(v) {
    var x = n(v);
    if (x == null) return null;
    return x <= 1 ? Math.round(x * 1000) / 10 : Math.round(x * 10) / 10;
  }
  /** 抖音 ratio 常给 0，用人数重算百分比 */
  function rateFrom(num, den) {
    var a = n(num);
    var b = n(den);
    if (a == null || b == null || b <= 0) return null;
    return Math.round((a / b) * 1000) / 10;
  }
  function rateOrCount(ratio, num, den) {
    var fromRatio = pct01(ratio);
    if (fromRatio != null && fromRatio > 0) return fromRatio;
    return rateFrom(num, den);
  }
  function roomFromUrl(u) {
    var m = String(u || "").match(/[?&]roomID=(\d+)/i);
    return m ? m[1] : null;
  }
  function parseGender(s) {
    var m = String(s || "").match(/([\d.]+)\s*%\s*男性[，,]\s*([\d.]+)\s*%\s*女性/);
    if (!m) return { malePct: null, femalePct: null };
    return { malePct: n(m[1]), femalePct: n(m[2]) };
  }
  function parseFans(s) {
    var m = String(s || "").match(/([\d.]+)\s*%\s*非粉丝[，,]\s*([\d.]+)\s*%\s*粉丝/);
    if (!m) return { nonFanPct: null, fanPct: null };
    return { nonFanPct: n(m[1]), fanPct: n(m[2]) };
  }
  function seriesBuckets(series) {
    if (!Array.isArray(series)) return [];
    return series
      .map(function (row) {
        return { name: String(row.name || ""), pct: n(row.value) };
      })
      .filter(function (b) {
        return b.name && b.pct != null;
      });
  }
  function rootWin() {
    try {
      return window.top || window;
    } catch (e) {
      return window;
    }
  }
  function parseItem(item, wantRoom) {
    if (!item || !item.body) return null;
    var u = item.url || "";
    var body = item.body || "";
    var rid = roomFromUrl(u);
    if (!rid && wantRoom && body.indexOf(wantRoom) >= 0) rid = wantRoom;
    if (wantRoom && rid && rid !== wantRoom) return null;
    try {
      return JSON.parse(body);
    } catch (e) {
      return null;
    }
  }
  function findBody(reUrl, wantRoom) {
    var R = rootWin();
    var pinned = R.__flyboxPinned || {};
    var pinNames = Object.keys(pinned);
    for (var p = 0; p < pinNames.length; p++) {
      var pit = pinned[pinNames[p]];
      if (!pit) continue;
      if (!reUrl.test(pit.url || "") && !reUrl.test((pit.body || "").slice(0, 200)))
        continue;
      // 钉住的关键包优先：先精确 room，再放宽（页面常忽略 URL roomID）
      var fromPin = parseItem(pit, wantRoom) || parseItem(pit, null);
      if (fromPin) return fromPin;
    }
    var raw = R.__flyboxHistoryRaw || [];
    var fallback = null;
    for (var i = raw.length - 1; i >= 0; i--) {
      var item = raw[i];
      var u = item.url || "";
      var body = item.body || "";
      if (!reUrl.test(u) && !reUrl.test(body.slice(0, 200))) continue;
      var parsed = parseItem(item, wantRoom);
      if (parsed) return parsed;
      if (!fallback) fallback = parseItem(item, null);
    }
    return fallback;
  }
  function pinnedJson(key) {
    var R = rootWin();
    var it = (R.__flyboxPinned || {})[key];
    return parseItem(it, null);
  }
  function buildPortrait(analysis, ageJson, honorJson, domBase) {
    var aRow =
      analysis &&
      analysis.data &&
      Array.isArray(analysis.data.series) &&
      analysis.data.series[0]
        ? analysis.data.series[0]
        : null;
    var g = parseGender(aRow && aRow.gender ? aRow.gender : domBase && domBase.genderText);
    var f = parseFans(aRow && aRow.fans ? aRow.fans : domBase && domBase.fansText);
    var ages = seriesBuckets(ageJson && ageJson.data && ageJson.data.series);
    if (!ages.length && domBase && domBase.ages) ages = domBase.ages;
    var honors = seriesBuckets(
      honorJson && honorJson.data && honorJson.data.series
    );
    var portrait = {
      genderText: (aRow && aRow.gender) || (domBase && domBase.genderText) || null,
      genderMost: (aRow && aRow.genderMost) || null,
      malePct: g.malePct,
      femalePct: g.femalePct,
      ageText: (aRow && aRow.age) || (domBase && domBase.ageText) || null,
      ages: ages,
      regionText: (aRow && aRow.region) || (domBase && domBase.regionText) || null,
      hobbyText: (aRow && aRow.hobby) || (domBase && domBase.hobbyText) || null,
      honorText: (aRow && aRow.honor) || (domBase && domBase.honorText) || null,
      honors: honors,
      commentText:
        (aRow && aRow.audienceWords) || (domBase && domBase.commentText) || null,
      fansText: (aRow && aRow.fans) || (domBase && domBase.fansText) || null,
      nonFanPct: f.nonFanPct,
      fanPct: f.fanPct,
      fetchedAt: Math.floor(Date.now() / 1000),
    };
    var ok =
      portrait.malePct != null ||
      (portrait.ages && portrait.ages.length) ||
      portrait.regionText ||
      portrait.hobbyText;
    return ok ? portrait : null;
  }
  function slicePortrait(suffix, roomId, domBase) {
    var analysis =
      pinnedJson("analysis_v3_" + suffix) ||
      (suffix === "all" ? findBody(/analysis_v3/i, roomId) : null);
    var ageJson =
      pinnedJson("age_profile_" + suffix) ||
      (suffix === "all" ? findBody(/age_profile/i, roomId) : null);
    var honorJson =
      pinnedJson("honor_level_profile_" + suffix) ||
      (suffix === "all" ? findBody(/honor_level_profile/i, roomId) : null);
    return buildPortrait(analysis, ageJson, honorJson, suffix === "all" ? domBase : null);
  }
  function ranksFromPinned(pinKey) {
    var j = pinnedJson(pinKey);
    if (!j || !j.data || !Array.isArray(j.data.ranks)) return null;
    var ranks = j.data.ranks;
    if (!ranks.length) return null;
    var samples = [];
    var total = 0;
    for (var i = 0; i < ranks.length; i++) {
      var r = ranks[i];
      var v = n(r.value);
      if (v != null) total += v;
      var nick = r.user && r.user.nickname ? String(r.user.nickname) : "";
      if (
        nick &&
        nick.indexOf("*") < 0 &&
        nick.indexOf("�") < 0 &&
        nick.length <= 16
      ) {
        samples.push(nick);
      }
    }
    return { count: ranks.length, total: total, samples: samples.slice(0, 5) };
  }
  function maintRanks(rankType) {
    return ranksFromPinned("audience_maintenance_" + rankType);
  }
  function publicRanks(rankType) {
    return ranksFromPinned("public_rank_" + rankType);
  }
  function maintFromDom() {
    var t = document.body ? document.body.innerText || "" : "";
    var m = t.match(/流失挽回[\s\S]{0,40}?减少\s*([\d,]+)/);
    if (!m) m = t.match(/减少\s*([\d,]+)/);
    if (!m) return null;
    return n(String(m[1]).replace(/,/g, ""));
  }
  function trafficFromDom() {
    var t = document.body ? document.body.innerText || "" : "";
    var idx = t.indexOf("观众来源分布");
    if (idx < 0) idx = t.indexOf("流量渠道来源");
    if (idx < 0) return null;
    var end = t.indexOf("视频推荐", idx);
    if (end < 0) end = t.indexOf("全部流量转化", idx);
    if (end < 0) end = idx + 900;
    var chunk = t.slice(idx, end);
    var lines = chunk
      .split(/\n+/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var name = lines[i];
      if (!name || /渠道|占比|观众|流量|全部|粉丝|非粉丝|分钟/.test(name))
        continue;
      if (name.length > 16) continue;
      var pctLine = lines[i + 1] || "";
      var m = pctLine.match(/^([\d.]+)\s*%$/);
      if (!m) continue;
      out.push({
        name: name,
        watchPct: n(m[1]),
        consumePct: null,
        avgWatchSec: null,
      });
      i += 1;
    }
    return out.length ? out : null;
  }
  function funnelFromDom() {
    var t = document.body ? document.body.innerText || "" : "";
    function grab(label) {
      var re = new RegExp(label + "\\s*\\n\\s*(\\d+)");
      var m = t.match(re);
      return m ? n(m[1]) : null;
    }
    var showUcnt = grab("曝光展现");
    var enterUcnt = grab("进直播间");
    var payUcnt = grab("打赏送礼");
    var interactUcnt = grab("直播间互动");
    var followUcnt = grab("新增粉丝");
    if (showUcnt == null && enterUcnt == null) return null;
    return {
      showUcnt: showUcnt,
      enterUcnt: enterUcnt,
      interactUcnt: interactUcnt,
      payUcnt: payUcnt,
      followUcnt: followUcnt,
      enterRate: null,
      interactRate: null,
      payRate: null,
      followRate: null,
      enterRateDiff: null,
      payRateDiff: null,
      followRateDiff: null,
    };
  }
  function clickText(exact) {
    var nodes = Array.prototype.slice.call(
      document.querySelectorAll("a,button,[role='tab'],div,span")
    );
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].innerText || "").replace(/\s+/g, " ").trim();
      if (t === exact) {
        try {
          nodes[i].click();
          return true;
        } catch (e) {}
      }
    }
    return false;
  }
  function portraitChunk() {
    var t = document.body ? document.body.innerText || "" : "";
    var idx = t.indexOf("观众画像");
    if (idx < 0) return "";
    var end = t.indexOf("流量分析", idx);
    if (end < 0) end = idx + 2200;
    return t.slice(idx, Math.min(end, idx + 2200));
  }
  function fromDom(chunk) {
    var ages = [];
    var re = /(\d{2}-\d{2}岁|50岁以上)\s*\n?\s*([\d.]+)\s*%/g;
    var m;
    while ((m = re.exec(chunk))) {
      ages.push({ name: m[1], pct: n(m[2]) });
    }
    var g = parseGender(chunk);
    var f = parseFans(chunk);
    var lines = chunk.split(/\n+/).map(function (s) {
      return s.trim();
    });
    function findLine(re2) {
      for (var i = 0; i < lines.length; i++) {
        if (re2.test(lines[i])) return lines[i];
      }
      return null;
    }
    return {
      ages: ages,
      malePct: g.malePct,
      femalePct: g.femalePct,
      genderText: findLine(/%男性/),
      ageText: findLine(/\d{2}-\d{2}岁.*居多/),
      regionText: null,
      honorText: findLine(/级用户居多/),
      hobbyText: null,
      commentText: null,
      fansText: findLine(/%非粉丝/),
      nonFanPct: f.nonFanPct,
      fanPct: f.fanPct,
    };
  }
  function refineDom(chunk, base) {
    var afterGender = chunk.split(/%女性/)[1] || "";
    var bits = afterGender
      .split(/\n+/)
      .map(function (s) {
        return s.trim();
      })
      .filter(Boolean);
    var texts = bits.filter(function (s) {
      return /居多/.test(s) && !/%/.test(s);
    });
    if (texts[0]) base.ageText = base.ageText || texts[0];
    if (texts[1]) base.regionText = texts[1];
    if (texts[2]) base.hobbyText = texts[2];
    if (texts[3]) base.commentText = texts[3];
    return base;
  }

  try {
    clickText("流量分析");
    clickText("观众分析");
    clickText("观众画像");
    clickText("全部观众");
  } catch (e) {}

  var href = String(location.href || "");
  var roomId =
    roomFromUrl(href) ||
    (window.__flyboxPortraitRoom ? String(window.__flyboxPortraitRoom) : null);
  if (!roomId) {
    return {
      id: null,
      error: "no room",
      portrait: null,
      trafficChannels: null,
      trafficFunnel: null,
      minuteTrend: null,
    };
  }

  var entrance = findBody(/entrance_v2/i, roomId);
  var funnelJson = findBody(/common_traffic_conversion/i, roomId);
  var minuteJson = findBody(/minute_trend/i, roomId);
  var overview = findBody(/overview_v3/i, roomId);
  // 无 room 过滤再扫一遍（部分响应 URL 不含 roomID）
  if (!entrance) entrance = findBody(/entrance_v2/i, null);
  if (!funnelJson) funnelJson = findBody(/common_traffic_conversion/i, null);
  if (!minuteJson) minuteJson = findBody(/minute_trend/i, null);
  if (!overview) overview = findBody(/overview_v3/i, null);

  var chunk = portraitChunk();
  var dom = refineDom(chunk, fromDom(chunk));
  var portraitAll = slicePortrait("all", roomId, dom);
  var portraitPaid = slicePortrait("paid", roomId, null);
  var portraitFans = slicePortrait("fans", roomId, null);
  var portrait = portraitAll;
  var portraitOk = !!portrait;
  var portraitSlices = {
    all: portraitAll,
    paid: portraitPaid,
    fans: portraitFans,
  };

  var lost =
    maintRanks("lost_audience") ||
    maintRanks("recall_user");
  var high =
    publicRanks("first_consume") ||
    publicRanks("watch_duration") ||
    maintRanks("promote_vitality") ||
    maintRanks("attract_new");
  var lostDom = maintFromDom();
  var audienceMaintenance = null;
  if (lost || high || lostDom != null) {
    var noteParts = [];
    if (lost && lost.total) noteParts.push("流失相关贡献值变动合计 " + lost.total);
    else if (lostDom != null) noteParts.push("流失挽回减少 " + lostDom);
    if (high && high.count) {
      noteParts.push(
        "高活跃/贡献榜 " + high.count + " 人" +
          (high.samples.length ? "（如 " + high.samples.slice(0, 3).join("、") + "）" : "")
      );
    }
    audienceMaintenance = {
      lostCount: lost ? lost.count : lostDom != null ? 1 : null,
      highValueCount: high ? high.count : null,
      lostSamples: lost && lost.samples.length ? lost.samples : null,
      highValueSamples: high && high.samples.length ? high.samples : null,
      note: noteParts.length ? noteParts.join("；") : null,
      fetchedAt: Math.floor(Date.now() / 1000),
    };
  }

  var trafficChannels = null;
  if (
    entrance &&
    entrance.data &&
    Array.isArray(entrance.data.series) &&
    entrance.data.series.length
  ) {
    trafficChannels = entrance.data.series
      .map(function (row) {
        return {
          name: String(row.name || ""),
          watchPct: pct01(row.watch_uv_ratio),
          consumePct: pct01(row.consume_uv_ratio),
          avgWatchSec: n(row.watch_duration_pavg),
        };
      })
      .filter(function (r) {
        return r.name && r.watchPct != null;
      });
    if (!trafficChannels.length) trafficChannels = null;
  }
  if (!trafficChannels) trafficChannels = trafficFromDom();

  var trafficFunnel = null;
  var fRow =
    funnelJson &&
    funnelJson.data &&
    Array.isArray(funnelJson.data.series) &&
    funnelJson.data.series[0]
      ? funnelJson.data.series[0]
      : null;
  if (fRow) {
    var showU = n(fRow.show_uv);
    var enterU = n(fRow.enter_uv);
    var interactU = n(fRow.interact_uv);
    var payU = n(fRow.pay_uv);
    var followU = n(fRow.follow_uv);
    trafficFunnel = {
      showUcnt: showU,
      enterUcnt: enterU,
      interactUcnt: interactU,
      payUcnt: payU,
      followUcnt: followU,
      // 进房率=进房/曝光；付费/互动/涨粉转化=各自/进房（对齐抖音「全部流量转化」）
      enterRate: rateOrCount(fRow.enter_ratio, enterU, showU),
      interactRate: rateOrCount(fRow.interact_ratio, interactU, enterU),
      payRate: rateOrCount(fRow.pay_ratio, payU, enterU),
      followRate: rateOrCount(fRow.follow_ratio, followU, enterU),
      enterRateDiff: pct01(fRow.enter_ratio_diff),
      interactRateDiff: pct01(fRow.interact_ratio_diff),
      payRateDiff: pct01(fRow.pay_ratio_diff),
      followRateDiff: pct01(fRow.follow_ratio_diff),
    };
  }
  if (!trafficFunnel) {
    trafficFunnel = funnelFromDom();
    if (trafficFunnel) {
      trafficFunnel.enterRate = rateFrom(
        trafficFunnel.enterUcnt,
        trafficFunnel.showUcnt,
      );
      trafficFunnel.interactRate = rateFrom(
        trafficFunnel.interactUcnt,
        trafficFunnel.enterUcnt,
      );
      trafficFunnel.payRate = rateFrom(
        trafficFunnel.payUcnt,
        trafficFunnel.enterUcnt,
      );
      trafficFunnel.followRate = rateFrom(
        trafficFunnel.followUcnt,
        trafficFunnel.enterUcnt,
      );
    }
  }

  var minuteTrend = null;
  if (
    minuteJson &&
    minuteJson.data &&
    Array.isArray(minuteJson.data.series) &&
    minuteJson.data.series.length
  ) {
    var series = minuteJson.data.series;
    var step = series.length > 180 ? Math.ceil(series.length / 180) : 1;
    minuteTrend = [];
    for (var mi = 0; mi < series.length; mi += step) {
      var row = series[mi];
      minuteTrend.push({
        t: String(row.timeMinute || ""),
        viewers: n(row.pcuTotal) || 0,
        watch: n(row.watchUcnt) || 0,
        gifts: n(row.earnScore) || 0,
        followers: n(row.followUcnt) || 0,
        leave: n(row.leaveUcnt) || 0,
        likes: n(row.likeCnt) || 0,
        comments: n(row.commentCnt) || 0,
      });
    }
    if (!minuteTrend.length) minuteTrend = null;
  }

  var deep = null;
  var oRow =
    overview &&
    overview.data &&
    Array.isArray(overview.data.series) &&
    overview.data.series[0]
      ? overview.data.series[0]
      : null;
  if (oRow) {
    deep = {
      totalGifts: n(oRow.earn_score),
      giftSenders: n(oRow.consume_ucnt),
      newFollowers: n(oRow.follow_ucnt),
      totalLikes: n(oRow.like_cnt),
      totalComments: n(oRow.comment_ucnt),
      peakViewers: n(oRow.pcu),
      avgViewers: n(oRow.acu),
      watchUcnt: n(oRow.watch_ucnt),
      enterUcnt: n(oRow.watch_ucnt),
      showUcnt: n(oRow.show_ucnt),
      avgWatchMins: n(oRow.avg_watch_duration_mins_rate),
      consumeUcnt: n(oRow.consume_ucnt),
      consumeRate: n(oRow.consume_rate),
      earnScoreDiff: n(oRow.earn_score_diff),
      duration: n(oRow.live_duration),
      newFansClub: n(oRow.join_fansclub_ucnt),
    };
    if (deep.showUcnt && deep.watchUcnt != null && deep.showUcnt > 0) {
      deep.enterRate =
        Math.round((deep.watchUcnt / deep.showUcnt) * 1000) / 10;
    }
  }

  var sourceRoomId = null;
  var pinnedMap = rootWin().__flyboxPinned || {};
  ["minute_trend", "entrance_v2", "overview_v3", "common_traffic_conversion"].forEach(
    function (k) {
      if (sourceRoomId) return;
      var it = pinnedMap[k];
      if (it && it.url) sourceRoomId = roomFromUrl(it.url);
    }
  );

  var ok =
    portraitOk ||
    portraitPaid ||
    portraitFans ||
    audienceMaintenance ||
    trafficChannels ||
    trafficFunnel ||
    (minuteTrend && minuteTrend.length);
  return {
    id: roomId,
    sourceRoomId: sourceRoomId,
    portrait: portraitOk ? portrait : null,
    portraitSlices: portraitSlices,
    audienceMaintenance: audienceMaintenance,
    trafficChannels: trafficChannels,
    trafficFunnel: trafficFunnel,
    minuteTrend: minuteTrend,
    deep: deep,
    error: ok ? null : "empty review metrics",
    href: href.slice(0, 200),
  };
})()
