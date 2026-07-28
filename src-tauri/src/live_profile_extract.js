/** 抽取主播资料：优先中控台顶栏（获赞0关注361粉丝481） */
(function () {
  function rootWin() {
    try {
      return window.top || window;
    } catch (e) {
      return window;
    }
  }
  var R = rootWin();

  function parseNum(raw) {
    if (raw == null) return null;
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
    var s = String(raw).replace(/,/g, "").replace(/\s/g, "").trim();
    if (!s || s === "-" || s === "—") return null;
    var m = s.match(/^([\d.]+)\s*([万wW亿])?$/);
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    if (m[2] === "万" || m[2] === "w" || m[2] === "W") n *= 10000;
    if (m[2] === "亿") n *= 100000000;
    return Math.round(n);
  }

  function pickAvatar(v) {
    if (!v) return null;
    if (typeof v === "string") {
      if (/^https?:\/\//i.test(v)) return v;
      if (/^\/\//.test(v)) return "https:" + v;
      return null;
    }
    if (Array.isArray(v) && v[0]) return pickAvatar(v[0]);
    if (typeof v === "object") {
      if (v.url_list) return pickAvatar(v.url_list);
      if (v.url) return pickAvatar(v.url);
    }
    return null;
  }

  function merge(into, piece) {
    if (!piece) return into;
    if (!into.nickname && piece.nickname) into.nickname = String(piece.nickname);
    if (!into.avatarUrl && piece.avatarUrl) into.avatarUrl = piece.avatarUrl;
    if (into.diggCount == null && piece.diggCount != null)
      into.diggCount = piece.diggCount;
    if (into.followingCount == null && piece.followingCount != null)
      into.followingCount = piece.followingCount;
    if (into.followerCount == null && piece.followerCount != null)
      into.followerCount = piece.followerCount;
    return into;
  }

  function fromUserObj(u) {
    if (!u || typeof u !== "object") return null;
    var nick =
      u.nickname || u.nick_name || u.nickName || u.nick || u.name || null;
    if (
      nick &&
      /获赞|关注|粉丝|直播|数据|首页|消息|作品|喜欢|推荐|播前|复盘/.test(
        String(nick)
      )
    ) {
      nick = null;
    }
    var avatar =
      pickAvatar(u.avatar_thumb) ||
      pickAvatar(u.avatar_medium) ||
      pickAvatar(u.avatar_larger) ||
      pickAvatar(u.avatarUrl) ||
      pickAvatar(u.avatar_url) ||
      pickAvatar(u.avatar) ||
      null;
    var digg = parseNum(
      u.total_favorited != null
        ? u.total_favorited
        : u.totalFavorited != null
          ? u.totalFavorited
          : null
    );
    var following = parseNum(
      u.following_count != null
        ? u.following_count
        : u.followingCount != null
          ? u.followingCount
          : null
    );
    var follower = parseNum(
      u.follower_count != null
        ? u.follower_count
        : u.followerCount != null
          ? u.followerCount
          : u.mplatform_followers_count != null
            ? u.mplatform_followers_count
            : null
    );
    if (!nick && !avatar && digg == null && following == null && follower == null)
      return null;
    return {
      nickname: nick ? String(nick) : null,
      avatarUrl: avatar,
      diggCount: digg,
      followingCount: following,
      followerCount: follower,
    };
  }

  function walk(node, depth, out) {
    if (!node || depth > 12) return;
    if (Array.isArray(node)) {
      for (var i = 0; i < Math.min(node.length, 80); i++)
        walk(node[i], depth + 1, out);
      return;
    }
    if (typeof node !== "object") return;
    var hit = fromUserObj(node);
    if (hit) merge(out, hit);
    var keys = Object.keys(node);
    for (var k = 0; k < keys.length && k < 40; k++) {
      var key = keys[k];
      if (/user|author|account|anchor|profile|data/i.test(key)) {
        try {
          walk(node[key], depth + 1, out);
        } catch (e) {}
      }
    }
  }

  function tryParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function fromBodies() {
    var out = {
      nickname: null,
      avatarUrl: null,
      diggCount: null,
      followingCount: null,
      followerCount: null,
    };
    if (R.__flyboxProfileResult) merge(out, R.__flyboxProfileResult);
    var pinned = R.__flyboxPinned || {};
    if (pinned.user_profile && pinned.user_profile.body) {
      var obj = tryParseJson(pinned.user_profile.body);
      if (obj) walk(obj, 0, out);
    }
    return out;
  }

  /** 中控台顶栏常见：获赞0 / 关注361 / 粉丝481（字在前、数在后） */
  function byLabel(label) {
    var nodes = Array.prototype.slice.call(
      document.querySelectorAll("div,span,p,li,a,strong")
    );
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t) continue;

      // 「获赞0」「关注361」「粉丝481」
      var mAfter = t.match(
        new RegExp("^" + label + "\\s*([\\d.]+\\s*[万wW亿]?)$")
      );
      if (mAfter) {
        var n0 = parseNum(mAfter[1]);
        if (n0 != null) return n0;
      }

      // 「0获赞」「361关注」
      var mBefore = t.match(
        new RegExp("^([\\d.]+\\s*[万wW亿]?)\\s*" + label + "$")
      );
      if (mBefore) {
        var n1 = parseNum(mBefore[1]);
        if (n1 != null) return n1;
      }

      if (t === label) {
        var parent = el.parentElement;
        if (!parent) continue;
        var kids = Array.prototype.slice.call(parent.children);
        for (var k = 0; k < kids.length; k++) {
          var n2 = parseNum((kids[k].textContent || "").trim());
          if (n2 != null) return n2;
        }
        var prev = el.previousElementSibling;
        if (prev) {
          var n3 = parseNum((prev.textContent || "").trim());
          if (n3 != null) return n3;
        }
        var next = el.nextElementSibling;
        if (next) {
          var n4 = parseNum((next.textContent || "").trim());
          if (n4 != null) return n4;
        }
      }
    }

    var body = ((document.body && document.body.innerText) || "").replace(
      /\s+/g,
      " "
    );
    // 字在前
    var m5 = body.match(
      new RegExp(label + "\\s*([\\d.]+)\\s*([万wW亿])?")
    );
    if (m5) {
      var n5 = parseNum(m5[1] + (m5[2] || ""));
      if (n5 != null) return n5;
    }
    // 数在前
    var m6 = body.match(
      new RegExp("([\\d.]+)\\s*([万wW亿])?\\s*" + label)
    );
    if (m6) {
      var n6 = parseNum(m6[1] + (m6[2] || ""));
      if (n6 != null) return n6;
    }
    return null;
  }

  function fromDom() {
    var out = {
      nickname: null,
      avatarUrl: null,
      diggCount: null,
      followingCount: null,
      followerCount: null,
    };

    var imgs = Array.prototype.slice.call(document.querySelectorAll("img"));
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var src = img.currentSrc || img.src || "";
      if (!src || !/aweme-avatar|avatar/i.test(src)) continue;
      if (/qr|login|logo|emoji|sticker|ai-broker|ai_broker/i.test(src)) continue;
      var r = img.getBoundingClientRect();
      var area = r.width * r.height;
      var cls = String(img.className || "");
      var score = area;
      if (/avatar/i.test(cls)) score += 5000;
      if (/aweme-avatar/i.test(src)) score += 2000;
      // 隐藏 webview 可能量到 0，仍按 src 质量分
      if (area < 1) score = (/avatar/i.test(cls) ? 4000 : 1000) + i;
      if (score > bestScore) {
        best = img;
        bestScore = score;
      }
    }
    if (best) {
      var rawAv = best.currentSrc || best.src || null;
      // 优先无签名 CDN，签名链在应用内常裂图
      if (rawAv && /aweme-avatar/i.test(rawAv)) {
        var mAv = rawAv.match(
          /https?:\/\/[^/]+\/(?:aweme\/\d+x\d+\/)?aweme-avatar\/[^?#"'\s]+/i
        );
        if (mAv) {
          rawAv =
            "https://p3.douyinpic.com/" +
            mAv[0].replace(/^https?:\/\/[^/]+\//i, "");
          if (!/\/aweme\/\d+x\d+\//i.test(rawAv)) {
            rawAv = rawAv.replace(
              "https://p3.douyinpic.com/aweme-avatar/",
              "https://p3.douyinpic.com/aweme/100x100/aweme-avatar/"
            );
          }
        }
      }
      out.avatarUrl = rawAv;
      var p = best.parentElement;
      for (var d = 0; d < 8 && p && !out.nickname; d++) {
        var texts = Array.prototype.slice
          .call(p.querySelectorAll("div,span,p,a,h1,h2,h3"))
          .map(function (x) {
            return (x.textContent || "").replace(/\s+/g, " ").trim();
          })
          .filter(function (x) {
            return (
              x &&
              x.length >= 1 &&
              x.length <= 24 &&
              !/^[\d.]+[万wW亿]?$/.test(x) &&
              !/获赞|关注|粉丝|直播|数据|首页|消息|私信|设置|抖音|登录|作品|喜欢|推荐|中控台|数据中心|实时数据|播前|复盘|观测|课堂|核心|AI助手/.test(
                x
              )
            );
          });
        if (texts.length) out.nickname = texts[0];
        p = p.parentElement;
      }
    }

    // 整段「获赞0关注361粉丝481」一次抠出
    var blob = ((document.body && document.body.innerText) || "").replace(
      /\s+/g,
      ""
    );
    var trio = blob.match(
      /获赞([\d.]+[万wW亿]?)关注([\d.]+[万wW亿]?)粉丝([\d.]+[万wW亿]?)/
    );
    if (trio) {
      out.diggCount = parseNum(trio[1]);
      out.followingCount = parseNum(trio[2]);
      out.followerCount = parseNum(trio[3]);
    } else {
      out.diggCount = byLabel("获赞");
      out.followingCount = byLabel("关注");
      out.followerCount = byLabel("粉丝");
    }

    return out;
  }

  var out = {
    nickname: null,
    avatarUrl: null,
    diggCount: null,
    followingCount: null,
    followerCount: null,
  };
  merge(out, fromBodies());
  merge(out, fromDom());

  var body = ((document.body && document.body.innerText) || "")
    .replace(/\s+/g, " ")
    .slice(0, 240);
  return {
    nickname: out.nickname || "",
    avatarUrl: out.avatarUrl || null,
    diggCount: out.diggCount,
    followingCount: out.followingCount,
    followerCount: out.followerCount,
    href: String(location.href || ""),
    bodyHint: body,
    imgCount: document.querySelectorAll("img").length,
  };
})()
