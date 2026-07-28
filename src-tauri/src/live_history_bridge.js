/** 拦截接口响应，便于同步历史场次（不改页面外观）
 *  必须挂到 top：复盘里 minute_trend 等常在子 frame 发出
 */
(function () {
  function rootWin() {
    try {
      return window.top || window;
    } catch (e) {
      return window;
    }
  }
  var R = rootWin();
  // 每个 frame 都要打补丁；共享缓存放 top
  if (window.__flyboxHistoryBridgePatched) return;
  window.__flyboxHistoryBridgePatched = true;
  R.__flyboxHistoryRaw = R.__flyboxHistoryRaw || [];
  R.__flyboxPinned = R.__flyboxPinned || {};

  function sliceSuffix(u) {
    if (/[?&]isConsume=1\b/i.test(u)) return "paid";
    if (/[?&]isFans=1\b/i.test(u)) return "fans";
    return "all";
  }
  function pinKey(u) {
    if (/minute_trend/i.test(u)) return "minute_trend";
    if (/entrance_v2/i.test(u)) return "entrance_v2";
    if (/common_traffic_conversion/i.test(u)) return "common_traffic_conversion";
    if (/analysis_v3/i.test(u)) return "analysis_v3_" + sliceSuffix(u);
    if (/age_profile/i.test(u)) return "age_profile_" + sliceSuffix(u);
    if (/honor_level_profile/i.test(u))
      return "honor_level_profile_" + sliceSuffix(u);
    if (/overview_v3/i.test(u)) return "overview_v3";
    if (/history_list/i.test(u)) return "history_list";
    if (/audience_maintenance/i.test(u)) {
      var rt = (u.match(/[?&]rankType=([^&]+)/i) || [])[1] || "all";
      return "audience_maintenance_" + decodeURIComponent(rt);
    }
    if (/\/anchor\/public\/rank/i.test(u)) {
      var rt2 = (u.match(/[?&]rankType=([^&]+)/i) || [])[1] || "all";
      return "public_rank_" + decodeURIComponent(rt2);
    }
    if (/user\/profile|web\/user\/|account\/info|user_info|\/user\/self/i.test(u)) {
      return "user_profile";
    }
    return null;
  }

  function maybeKeep(url, body) {
    try {
      if (!body || body.length < 20 || body.length > 8e6) return;
      var u = String(url || "");
      var hit =
        /history_list|room_base|replay|review|webcast\/data|tinker_proxy|overview_v3|analysis_v3|age_profile|honor_level_profile|entrance_v2|minute_trend|common_traffic_conversion|conversion_ratio|audience_maintain|lost_audience|high_value|user_maintain|audience_operate|core_audience|silent_audience|churn|public\/rank|gift_top|user\/profile|web\/user|account\/info|user_info/i.test(
          u
        ) ||
        /"roomID"|"room_id"|roomLiveEarnScore|liveNewFollowUcnt|serverWatchUcntTdDirect|"genderMost"|"audienceWords"|"watch_uv_ratio"|"timeMinute"|流失挽回|高价值|贡献值|"first_consume"|"watch_duration"|"total_favorited"|"follower_count"/.test(
          body
        );
      if (!hit) return;
      var item = {
        url: u.slice(0, 500),
        body: body.slice(0, 2e6),
        t: Date.now(),
      };
      var pk = pinKey(u);
      if (
        !pk &&
        /"total_favorited"/.test(body) &&
        /"follower_count"/.test(body) &&
        /"nickname"/.test(body)
      ) {
        pk = "user_profile";
      }
      if (pk) {
        R.__flyboxPinned[pk] = item;
      }
      R.__flyboxHistoryRaw.push(item);
      if (R.__flyboxHistoryRaw.length > 100) {
        R.__flyboxHistoryRaw = R.__flyboxHistoryRaw.slice(-100);
      }
    } catch (e) {}
  }

  try {
    var ofetch = window.fetch;
    if (typeof ofetch === "function") {
      window.fetch = function () {
        var args = arguments;
        var url = args[0] && args[0].url ? args[0].url : args[0];
        return ofetch.apply(this, args).then(function (res) {
          try {
            var clone = res.clone();
            clone.text().then(function (text) {
              maybeKeep(url, text);
            });
          } catch (e) {}
          return res;
        });
      };
    }
  } catch (e) {}

  try {
    var XO = window.XMLHttpRequest;
    if (XO && XO.prototype) {
      var open = XO.prototype.open;
      var send = XO.prototype.send;
      XO.prototype.open = function (method, url) {
        this.__flyboxUrl = url;
        return open.apply(this, arguments);
      };
      XO.prototype.send = function () {
        var xhr = this;
        xhr.addEventListener("load", function () {
          try {
            maybeKeep(xhr.__flyboxUrl, xhr.responseText);
          } catch (e) {}
        });
        return send.apply(this, arguments);
      };
    }
  } catch (e) {}
})();
