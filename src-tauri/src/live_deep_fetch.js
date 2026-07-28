/** 在已登录复盘页内，按 roomID 拉取 overview_v3（最多 20 场，并发 4） */
(async function () {
  var ids = window.__flyboxDeepIds || [];
  if (!Array.isArray(ids) || !ids.length) {
    return { sessions: [], fetched: 0, error: "no ids" };
  }
  function n(v) {
    if (v == null || v === "") return null;
    var x = Number(v);
    return isFinite(x) ? x : null;
  }
  function mapRow(id, row) {
    var watch = n(row.watch_ucnt);
    var show = n(row.show_ucnt) || n(row.expose_ucnt) || n(row.exposure_ucnt);
    var enterRate = null;
    if (show && watch != null && show > 0) {
      enterRate = Math.round((watch / show) * 1000) / 10;
    } else if (n(row.watch_rate) != null) {
      enterRate = n(row.watch_rate);
    }
    var avgMins = n(row.avg_watch_duration_mins_rate);
    if (avgMins == null) {
      var secs = n(row.avg_watch_duration);
      if (secs != null) avgMins = Math.round((secs / 60) * 10) / 10;
    }
    return {
      id: String(id),
      totalGifts: n(row.earn_score),
      giftSenders: n(row.consume_ucnt),
      newFollowers: n(row.follow_ucnt),
      totalLikes: n(row.like_cnt),
      totalComments: n(row.comment_ucnt),
      peakViewers: n(row.pcu) || watch,
      avgViewers: n(row.acu) || watch,
      watchUcnt: watch,
      enterUcnt: watch,
      enterRate: enterRate,
      showUcnt: show,
      avgWatchMins: avgMins,
      consumeUcnt: n(row.consume_ucnt),
      consumeRate: n(row.consume_rate),
      earnScoreDiff: n(row.earn_score_diff),
      duration: n(row.live_duration),
      newFansClub: n(row.join_fansclub_ucnt),
    };
  }
  async function one(id) {
    var url =
      location.origin +
      "/anchor_pc_tinker_proxy/lego/native/webcast_api/room/replay/overview_v3?roomID=" +
      encodeURIComponent(String(id));
    var res = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    var text = await res.text();
    var json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return { id: String(id), error: "bad json " + res.status };
    }
    var row =
      json &&
      json.data &&
      Array.isArray(json.data.series) &&
      json.data.series[0]
        ? json.data.series[0]
        : null;
    if (!row) {
      return {
        id: String(id),
        error: "empty " + res.status + " " + text.slice(0, 80),
      };
    }
    return mapRow(id, row);
  }
  var list = ids.slice(0, 20).map(String);
  var out = [];
  var errors = [];
  var i = 0;
  async function worker() {
    while (i < list.length) {
      var idx = i++;
      try {
        var row = await one(list[idx]);
        if (row && row.totalGifts != null) out.push(row);
        else if (row && row.error) errors.push(row.error);
      } catch (e) {
        errors.push(String(e && e.message ? e.message : e));
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return {
    sessions: out,
    fetched: out.length,
    error: out.length ? null : errors.slice(0, 3).join(" | ") || "no data",
  };
})()
