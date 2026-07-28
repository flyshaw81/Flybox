/** 注入主播后台页面的采集脚本（表达式，返回对象）。DOM 变更时优先改这里。 */
export const SCRAPE_SCRIPT = `(() => {
  const text = (document.body && (document.body.innerText || document.body.textContent)) || "";
  const href = String(location.href || "");
  const lower = href.toLowerCase();

  // 已在主播后台时，勿因文案/URL 子串误判「需登录」（曾把图表 canvas 当成二维码）
  const onAnchorApp =
    lower.includes("anchor.douyin.com") &&
    /\/anchor\/(dashboard|review|data|live|home)/.test(lower) &&
    !/passport|\/login|sso|qrcode|scan-code|scan_code/.test(lower);
  const scanningUi =
    /扫码登录|打开抖音扫一扫|请使用抖音扫码|手机抖音扫码/.test(text);
  const appShell =
    /数据中心|直播热度|流量转化|在线人数|收获音浪|直播数据|本场数据|实时数据/.test(
      text,
    );
  const needLogin = onAnchorApp
    ? scanningUi && !appShell
    : /passport|\/login|sso|qrcode|scan-code|scan_code/.test(lower) ||
      scanningUi;

  const parseNum = (raw) => {
    if (raw == null) return null;
    let s = String(raw).replace(/,/g, "").replace(/\\s/g, "").trim();
    if (!s) return null;
    const m = s.match(/^([\\d.]+)\\s*([万wW亿])?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return null;
    const u = m[2];
    if (u === "万" || u === "w" || u === "W") n *= 10000;
    if (u === "亿") n *= 100000000;
    return Math.round(n);
  };

  const byLabel = (labels) => {
    const nodes = Array.from(document.querySelectorAll("div,span,p,li,td,th,dd,dt,label"));
    for (const label of labels) {
      for (const el of nodes) {
        const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (!t || t.length > 40) continue;
        if (t === label || t.startsWith(label) || t.endsWith(label)) {
          const parent = el.parentElement;
          if (!parent) continue;
          const cand = Array.from(parent.querySelectorAll("div,span,p,strong,b,em"))
            .map((x) => (x.textContent || "").trim())
            .filter((x) => x && x !== t && /[\\d]/.test(x) && x.length < 24);
          for (const c of cand) {
            const n = parseNum(c);
            if (n != null) return n;
          }
          const sib = el.nextElementSibling;
          if (sib) {
            const n = parseNum(sib.textContent);
            if (n != null) return n;
          }
        }
      }
      const re = new RegExp(label + "[^\\\\d]{0,12}([\\\\d,.]+\\\\s*[万wW亿]?)", "i");
      const m = text.match(re);
      if (m) {
        const n = parseNum(m[1]);
        if (n != null) return n;
      }
    }
    return null;
  };

  let liveStatus = "unknown";
  if (needLogin) liveStatus = "idle";
  else if (/直播中|正在直播|直播进行中/.test(text)) liveStatus = "live";
  else if (/直播结束|已下播|本场结束|直播已结束/.test(text)) liveStatus = "ended";
  else if (/准备开播|未开播|暂无直播|开播准备/.test(text)) liveStatus = "idle";

  let title = null;
  const titleEl =
    document.querySelector("h1") ||
    document.querySelector("[class*='title']") ||
    document.querySelector("title");
  if (titleEl) {
    const t = (titleEl.textContent || "").trim();
    if (t && t.length < 80 && !/抖音|登录|主播/.test(t)) title = t;
  }

  const parsePct = (raw) => {
    if (raw == null) return null;
    const s = String(raw).replace(/\\s/g, "").trim();
    const m = s.match(/([\\d.]+)\\s*%/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n : null;
  };

  const byLabelPct = (labels) => {
    const nodes = Array.from(document.querySelectorAll("div,span,p,li,td,th,dd,dt,label"));
    for (const label of labels) {
      for (const el of nodes) {
        const t = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (!t || t.length > 40) continue;
        if (t === label || t.startsWith(label) || t.endsWith(label)) {
          const parent = el.parentElement;
          if (!parent) continue;
          const cand = Array.from(parent.querySelectorAll("div,span,p,strong,b,em"))
            .map((x) => (x.textContent || "").trim())
            .filter((x) => x && x !== t && /%/.test(x) && x.length < 24);
          for (const c of cand) {
            const n = parsePct(c);
            if (n != null) return n;
          }
          const sib = el.nextElementSibling;
          if (sib) {
            const n = parsePct(sib.textContent);
            if (n != null) return n;
          }
        }
      }
    }
    return null;
  };

  return {
    needLogin,
    liveStatus,
    title,
    viewers: byLabel(["在线人数", "实时在线", "在线观众", "当前在线", "人气值"]),
    gifts: byLabel(["收获音浪", "音浪收入", "音浪", "本场音浪", "礼物音浪"]),
    giftSenders: byLabel(["送礼人数", "打赏人数", "送礼观众"]),
    newFollowers: byLabel(["新增粉丝", "涨粉", "新增关注", "本场涨粉"]),
    newFansClub: byLabel(["加粉丝团", "粉丝团", "加入粉丝团", "新增粉丝团"]),
    comments: byLabel(["评论人数", "评论条数", "评论数", "评论"]),
    likes: byLabel(["点赞次数", "点赞数", "点赞"]),
    shares: byLabel(["分享次数", "分享数", "分享"]),
    show: byLabel(["累计曝光", "近一分钟曝光", "曝光"]),
    enter: byLabel(["累计进入", "近一分钟进入", "进入", "进房人数"]),
    stay: byLabel(["累计停留", "近一分钟停留", "停留人数", "停留"]),
    enterRate: byLabelPct(["进房率"]),
    stayRate: byLabelPct(["停留率"]),
    giftRate: byLabelPct(["送礼率"]),
  };
})()`;

export function classifyLiveUrl(url: string | null | undefined): {
  needLogin: boolean;
  loggedInHint: boolean;
} {
  if (!url) return { needLogin: true, loggedInHint: false };
  const lower = url.toLowerCase();
  const needLogin =
    /passport|\/login|sso|qrcode|scan-code|scan_code/.test(lower);
  const onDashboard = lower.includes("/anchor/dashboard");
  return {
    needLogin,
    loggedInHint: !needLogin && onDashboard,
  };
}
