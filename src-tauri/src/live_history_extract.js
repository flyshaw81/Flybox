/** 从拦截到的接口 + DOM 抽出历史场次（直播复盘 history_list） */
(function () {
  function num(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number" && isFinite(v)) return v;
    var s = String(v).replace(/,/g, "").trim();
    var m = s.match(/^([\d.]+)\s*([万wW亿])?/);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    if (m[2] === "万" || m[2] === "w" || m[2] === "W") n *= 10000;
    if (m[2] === "亿") n *= 1e8;
    return Math.round(n);
  }

  function parseDurationText(s) {
    if (!s) return null;
    var t = String(s);
    var h = t.match(/(\d+)\s*小时/);
    var m = t.match(/(\d+)\s*分钟/);
    var sec = t.match(/(\d+)\s*秒/);
    if (!h && !m && !sec) return null;
    return (
      (h ? parseInt(h[1], 10) * 3600 : 0) +
      (m ? parseInt(m[1], 10) * 60 : 0) +
      (sec ? parseInt(sec[1], 10) : 0)
    );
  }

  function parseTime(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number" && isFinite(v)) {
      return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
    }
    var s = String(v).trim();
    if (/^\d+$/.test(s)) {
      var n = parseInt(s, 10);
      return n > 1e12 ? Math.floor(n / 1000) : n;
    }
    var ms = Date.parse(s.replace(/-/g, "/"));
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
    return null;
  }

  function toSession(obj) {
    if (!obj || typeof obj !== "object") return null;
    var id =
      obj.roomID ||
      obj.roomId ||
      obj.room_id ||
      obj.item ||
      obj.id ||
      obj.liveId ||
      obj.live_id;
    var title =
      obj.roomTitle ||
      obj.room_title ||
      obj.title ||
      obj.live_title ||
      "直播场次";
    var start =
      parseTime(obj.startTimeUnix) ||
      parseTime(obj.start_time_unix) ||
      parseTime(obj.startTime) ||
      parseTime(obj.start_time) ||
      parseTime(obj.createTimeUnix) ||
      parseTime(obj.createTime);
    var end =
      parseTime(obj.endTimeUnix) ||
      parseTime(obj.end_time_unix) ||
      parseTime(obj.endTime) ||
      parseTime(obj.end_time) ||
      parseTime(obj.finish_ts) ||
      parseTime(obj.finish_time);
    var duration =
      num(obj.live_duration) ||
      num(obj.duration) ||
      parseDurationText(obj.duration) ||
      (start && end && end > start ? end - start : null);
    var gifts = num(
      obj.roomLiveEarnScore ||
        obj.earn_score ||
        obj.earnScore ||
        obj.fan_ticket ||
        obj.fanTicket
    );
    var viewers = num(
      obj.serverWatchUcntTdDirect ||
        obj.watch_ucnt ||
        obj.watchUcnt ||
        obj.pcu ||
        obj.acu
    );
    var peak = num(obj.pcu || obj.peak_watch_ucnt || obj.max_online) || viewers;
    var avg = num(obj.acu || obj.avg_watch_ucnt || obj.avgOnline) || viewers;
    var followers = num(
      obj.liveNewFollowUcnt || obj.follow_ucnt || obj.followUcnt || obj.new_fans
    );
    var likes = num(obj.serverLikeCntTd || obj.like_cnt || obj.likeCnt);
    var comments = num(
      obj.clientCommentUcntTd || obj.comment_ucnt || obj.commentCnt
    );
    var senders = num(
      obj.liveConsumeUcnt || obj.consume_ucnt || obj.consumeUcnt || obj.gift_uv
    );
    var avgStay = num(
      obj.liveServerWatchDurationTdPavg ||
        obj.avg_watch_duration_mins_rate ||
        obj.avgWatchMins
    );
    if (!id && !start && gifts == null && viewers == null) return null;
    if (!id) id = String(start || Date.now()) + "_" + String(title).slice(0, 12);
    return {
      id: String(id),
      title: String(title).slice(0, 80),
      startTime: start,
      endTime: end,
      duration: duration,
      peakViewers: peak,
      avgViewers: avg,
      totalGifts: gifts,
      newFollowers: followers,
      totalLikes: likes,
      totalComments: comments,
      giftSenders: senders,
      avgWatchMins: avgStay,
      consumeUcnt: senders,
      consumeRate:
        senders != null && viewers != null && viewers > 0
          ? Math.round((senders / viewers) * 1000) / 10
          : null,
      dateHint: obj.startTime || obj.start_time || null,
    };
  }

  function unwrapJson(node) {
    if (typeof node === "string") {
      try {
        return unwrapJson(JSON.parse(node));
      } catch (e) {
        return node;
      }
    }
    if (node && typeof node === "object" && typeof node.data === "string") {
      try {
        return unwrapJson(Object.assign({}, node, { data: JSON.parse(node.data) }));
      } catch (e) {
        return node;
      }
    }
    return node;
  }

  function walk(node, out, depth) {
    if (!node || depth > 10) return;
    node = unwrapJson(node);
    if (Array.isArray(node)) {
      if (node.length >= 1 && typeof node[0] === "object") {
        var mapped = [];
        for (var i = 0; i < node.length; i++) {
          var s = toSession(node[i]);
          if (s) mapped.push(s);
        }
        // Prefer arrays that look like history_list (have roomID-ish)
        var withRoom = mapped.filter(function (x) {
          return /^\d{10,}$/.test(String(x.id));
        });
        var candidate = withRoom.length ? withRoom : mapped;
        if (candidate.length > out.length) {
          out.length = 0;
          for (var j = 0; j < candidate.length; j++) out.push(candidate[j]);
        }
      }
      for (var k = 0; k < Math.min(node.length, 80); k++) walk(node[k], out, depth + 1);
      return;
    }
    if (typeof node === "object") {
      if (Array.isArray(node.series)) walk(node.series, out, depth + 1);
      var keys = Object.keys(node);
      for (var x = 0; x < keys.length; x++) walk(node[keys[x]], out, depth + 1);
    }
  }

  var sessions = [];
  var raw = window.__flyboxHistoryRaw || [];
  for (var r = 0; r < raw.length; r++) {
    try {
      walk(JSON.parse(raw[r].body), sessions, 0);
    } catch (e) {}
  }

  // DOM 兜底：切换场次弹层里的卡片
  if (sessions.length === 0) {
    var root =
      document.querySelector(".review-record-modal") ||
      document.querySelector(".semi-modal-wrap") ||
      document.body;
    var text = (root.innerText || "").replace(/\s+/g, " ").trim();
    var blocks = text.split(/查看复盘/);
    for (var b = 0; b < blocks.length; b++) {
      var chunk = blocks[b];
      var startM = chunk.match(/开播时间[:：]\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
      if (!startM) continue;
      var durM = chunk.match(/开播时长[:：]\s*([^收获观众新增]+)/);
      var giftM = chunk.match(/收获音浪\s*([\d,.]+万?)/);
      var watchM = chunk.match(/观众人数\s*([\d,.]+万?)/);
      var fanM = chunk.match(/新增粉丝\s*([\d,.]+万?)/);
      var titleGuess = chunk.match(/([\u4e00-\u9fffA-Za-z0-9]{2,40})\s*开播时间/);
      sessions.push({
        id: "dom_" + startM[1].replace(/\D/g, ""),
        title: (titleGuess && titleGuess[1]) || "直播场次",
        startTime: parseTime(startM[1]),
        endTime: null,
        duration: parseDurationText(durM && durM[1]),
        peakViewers: num(watchM && watchM[1]),
        avgViewers: num(watchM && watchM[1]),
        totalGifts: num(giftM && giftM[1]),
        newFollowers: num(fanM && fanM[1]),
        totalLikes: null,
        totalComments: null,
        dateHint: startM[1],
      });
    }
  }

  var seen = {};
  var uniq = [];
  for (var u = 0; u < sessions.length; u++) {
    var key = sessions[u].id;
    if (seen[key]) continue;
    seen[key] = 1;
    uniq.push(sessions[u]);
  }

  return {
    sessions: uniq.slice(0, 120),
    captured: raw.length,
    href: String(location.href || ""),
  };
})()
