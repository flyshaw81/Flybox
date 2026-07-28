/** 全帧注入：后台抽取登录二维码 dataURL，交给顶层 window.__flyboxLoginQr（不改页面外观） */
(function () {
  function findQrRoot(doc) {
    var nodes = Array.prototype.slice.call(
      doc.querySelectorAll(
        'canvas, img[src*="qr"], img[src*="QR"], [class*="qrcode"], [class*="qr-code"], [class*="QRCode"], [id*="qrcode"]'
      )
    );
    var best = null;
    var bestArea = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var r = el.getBoundingClientRect();
      var area = r.width * r.height;
      if (r.width >= 72 && r.height >= 72 && area > bestArea) {
        best = el;
        bestArea = area;
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

  function tick() {
    var root = findQrRoot(document);
    var data = toDataUrl(root);
    if (data) publish(data);
  }

  if (window === window.top && !window.__flyboxQrBridgeTop) {
    window.__flyboxQrBridgeTop = true;
    window.addEventListener("message", function (ev) {
      try {
        if (ev.data && typeof ev.data.__flyboxLoginQr === "string") {
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
