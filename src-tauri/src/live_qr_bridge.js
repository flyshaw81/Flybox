/** 全帧注入：后台抽取登录二维码 dataURL，交给顶层 window.__flyboxLoginQr（不改页面外观） */
(function () {
  function pageWantsQr() {
    try {
      var h = String(location.href || "").toLowerCase();
      var t = (
        (document.body && (document.body.innerText || document.body.textContent)) ||
        ""
      ).slice(0, 4000);
      var onAuth = /passport|\/login|sso|qrcode|scan-code|scan_code/.test(h);
      var scanning = /扫码登录|打开抖音扫一扫|请使用抖音扫码|手机抖音扫码/.test(t);
      var appShell =
        /数据中心|直播热度|流量转化|在线人数|收获音浪|直播数据|本场数据|实时数据/.test(
          t
        );
      // 已进后台且不是扫码页：绝不再抓 canvas（避免把趋势图当二维码）
      if (appShell && !scanning) return false;
      if (/\/anchor\/(dashboard|review)/.test(h) && !scanning && !onAuth) return false;
      return onAuth || scanning || !appShell;
    } catch (e) {
      return true;
    }
  }

  function ancestryLooksLikeChart(el) {
    var p = el;
    for (var i = 0; i < 6 && p; i++) {
      var sig = (
        String(p.className || "") +
        " " +
        String(p.id || "") +
        " " +
        String(p.getAttribute && p.getAttribute("aria-label") || "")
      ).toLowerCase();
      if (/chart|echart|trend|graph|highcharts|canvas-container|g2-/.test(sig)) {
        return true;
      }
      p = p.parentElement;
    }
    return false;
  }

  function isLikelyQr(el) {
    if (!el || ancestryLooksLikeChart(el)) return false;
    var r = el.getBoundingClientRect();
    var w = r.width;
    var h = r.height;
    if (w < 96 || h < 96 || w > 420 || h > 420) return false;
    var ratio = w / h;
    if (ratio < 0.8 || ratio > 1.25) return false;
    var sig = (
      String(el.className || "") +
      " " +
      String(el.id || "") +
      " " +
      String(el.src || "") +
      " " +
      String(el.alt || "")
    ).toLowerCase();
    var named = /qr|qrcode|login.?code|扫码/.test(sig);
    // 无名 canvas：只接受接近正方形、尺寸像登录码的
    return named || (w >= 120 && h >= 120 && w <= 360 && h <= 360);
  }

  function scoreQr(el) {
    var r = el.getBoundingClientRect();
    var area = r.width * r.height;
    var sig = (
      String(el.className || "") +
      " " +
      String(el.id || "") +
      " " +
      String(el.src || "")
    ).toLowerCase();
    var bonus = /qr|qrcode/.test(sig) ? 1e7 : 0;
    // 越接近正方形越好
    var ratio = r.width / Math.max(r.height, 1);
    var square = 1 - Math.min(Math.abs(ratio - 1), 1);
    return bonus + area * (0.5 + square);
  }

  function findQrRoot(doc) {
    var nodes = Array.prototype.slice.call(
      doc.querySelectorAll(
        'canvas, img[src*="qr"], img[src*="QR"], img[alt*="码"], [class*="qrcode"], [class*="qr-code"], [class*="QRCode"], [class*="qrCode"], [id*="qrcode"], [id*="qr-code"]'
      )
    );
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isLikelyQr(el)) continue;
      var s = scoreQr(el);
      if (s > bestScore) {
        best = el;
        bestScore = s;
      }
    }
    return best;
  }

  function toDataUrl(el) {
    if (!el) return null;
    try {
      if (el.tagName === "CANVAS") {
        return el.toDataURL("image/png");
      }
      if (el.tagName === "IMG") {
        if (el.src && el.src.indexOf("data:") === 0) return el.src;
        var c = document.createElement("canvas");
        var w = el.naturalWidth || el.width || 0;
        var h = el.naturalHeight || el.height || 0;
        if (w < 72 || h < 72) return null;
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(el, 0, 0);
        return c.toDataURL("image/png");
      }
      var canvas = el.querySelector && el.querySelector("canvas");
      if (canvas) return toDataUrl(canvas);
      var img = el.querySelector && el.querySelector("img");
      if (img) return toDataUrl(img);
    } catch (e) {
      return null;
    }
    return null;
  }

  function publish(dataUrl) {
    if (!dataUrl || dataUrl.length < 100) return;
    try {
      window.top.postMessage({ __flyboxLoginQr: dataUrl }, "*");
    } catch (e) {}
    try {
      if (window.top && window.top !== window) {
        /* cross-origin: only postMessage */
      } else {
        window.__flyboxLoginQr = dataUrl;
      }
    } catch (e) {
      window.__flyboxLoginQr = dataUrl;
    }
    if (window === window.top) {
      window.__flyboxLoginQr = dataUrl;
    }
  }

  function clearPublished() {
    try {
      if (window === window.top) window.__flyboxLoginQr = null;
    } catch (e) {}
    try {
      window.top.postMessage({ __flyboxLoginQr: null }, "*");
    } catch (e) {}
  }

  function tick() {
    if (!pageWantsQr()) {
      clearPublished();
      return;
    }
    var root = findQrRoot(document);
    var data = toDataUrl(root);
    if (data) publish(data);
  }

  if (window === window.top && !window.__flyboxQrBridgeTop) {
    window.__flyboxQrBridgeTop = true;
    window.addEventListener("message", function (ev) {
      try {
        if (ev.data && "__flyboxLoginQr" in ev.data) {
          window.__flyboxLoginQr = ev.data.__flyboxLoginQr;
        }
      } catch (e) {}
    });
  }

  if (!window.__flyboxQrBridgeBooted) {
    window.__flyboxQrBridgeBooted = true;
    tick();
    setInterval(tick, 400);
    try {
      new MutationObserver(tick).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch (e) {}
  } else {
    tick();
  }
})();
