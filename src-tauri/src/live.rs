//! 直播数据：隐藏 WebView 登录/采集；二维码抽到主界面显示

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use url::Url;

pub const LIVE_LABEL: &str = "live-anchor";
const LIVE_HOME: &str = "https://anchor.douyin.com/anchor/dashboard/home";

/// 全帧注入：把登录二维码抽成 dataURL 存到顶层（窗口始终隐藏）
const QR_BRIDGE_SCRIPT: &str = include_str!("live_qr_bridge.js");
const HISTORY_BRIDGE_SCRIPT: &str = include_str!("live_history_bridge.js");
const HISTORY_EXTRACT_SCRIPT: &str = include_str!("live_history_extract.js");
const DEEP_FETCH_SCRIPT: &str = include_str!("live_deep_fetch.js");
const PORTRAIT_EXTRACT_SCRIPT: &str = include_str!("live_portrait_extract.js");
const PROFILE_EXTRACT_SCRIPT: &str = include_str!("live_profile_extract.js");
/// 历史场次在「直播复盘」；点「切换场次」会请求 history_list
const HISTORY_URLS: &[&str] = &["https://anchor.douyin.com/anchor/review"];

const CLICK_REVIEW_FLOW: &str = r#"(function(){
  function clickText(re, maxLen) {
    var nodes = Array.prototype.slice.call(document.querySelectorAll('a,button,[role="tab"],div,span,li'));
    for (var i = 0; i < nodes.length; i++) {
      var t = (nodes[i].innerText || nodes[i].textContent || '').replace(/\s+/g,' ').trim();
      if (!t || t.length > (maxLen || 16)) continue;
      if (re.test(t)) { try { nodes[i].click(); return t; } catch (e) {} }
    }
    return null;
  }
  // 关掉订阅弹窗等
  document.querySelectorAll('.semi-modal-close,button').forEach(function(el){
    var t = (el.innerText || el.getAttribute('aria-label') || '').trim();
    if (/关闭|暂不|取消|知道了/.test(t) || (el.className && String(el.className).indexOf('close') >= 0)) {
      try { el.click(); } catch (e) {}
    }
  });
  var nav = clickText(/^(直播复盘)$/, 8);
  var sw = null;
  var btns = Array.prototype.slice.call(document.querySelectorAll('button'));
  for (var j = 0; j < btns.length; j++) {
    var bt = (btns[j].innerText || '').replace(/\s+/g,'').trim();
    if (bt.indexOf('切换场次') >= 0) { try { btns[j].click(); sw = bt; break; } catch (e) {} }
  }
  if (!sw) sw = clickText(/切换场次/, 12);
  return { nav: nav, switch: sw, href: String(location.href || '') };
})()"#;

const FETCH_QR_SCRIPT: &str = r#"(function(){
  if (typeof window.__flyboxLoginQr === 'string' && window.__flyboxLoginQr.length > 100) {
    return window.__flyboxLoginQr;
  }
  function findQr() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll(
      'canvas, img[src*="qr"], img[src*="QR"], [class*="qrcode"], [class*="qr-code"], [class*="QRCode"], [id*="qrcode"]'
    ));
    var best = null, bestArea = 0;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var r = el.getBoundingClientRect();
      var area = r.width * r.height;
      if (r.width >= 72 && r.height >= 72 && area > bestArea) { best = el; bestArea = area; }
    }
    return best;
  }
  function toDataUrl(el) {
    if (!el) return null;
    try {
      if (el.tagName === 'CANVAS') return el.toDataURL('image/png');
      if (el.tagName === 'IMG') {
        if (el.src && el.src.indexOf('data:') === 0) return el.src;
        var c = document.createElement('canvas');
        c.width = el.naturalWidth || el.width;
        c.height = el.naturalHeight || el.height;
        if (c.width < 72 || c.height < 72) return null;
        c.getContext('2d').drawImage(el, 0, 0);
        return c.toDataURL('image/png');
      }
      var canvas = el.querySelector && el.querySelector('canvas');
      if (canvas) return toDataUrl(canvas);
      var img = el.querySelector && el.querySelector('img');
      if (img) return toDataUrl(img);
    } catch (e) { return null; }
    return null;
  }
  return toDataUrl(findQr());
})()"#;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveNavPayload {
    url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveBootstrapResult {
    pub logged_in: bool,
    pub url: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAuthStatus {
    pub logged_in: bool,
    pub need_login: bool,
    pub url: Option<String>,
}

fn emit_nav(app: &AppHandle, url: &Url) {
    let _ = app.emit(
        "live-nav",
        LiveNavPayload {
            url: url.as_str().to_string(),
        },
    );
}

fn classify_url(url: &str) -> (bool, bool) {
    let lower = url.to_lowercase();
    let need_login = lower.contains("passport")
        || lower.contains("/login")
        || lower.contains("sso")
        || lower.contains("qrcode")
        || lower.contains("scan-code")
        || lower.contains("scan_code");
    let on_dashboard = lower.contains("/anchor/dashboard");
    let logged_in = !need_login && on_dashboard;
    (need_login, logged_in)
}

fn decisive(url: &str) -> bool {
    let (need, logged) = classify_url(url);
    need || logged || url.to_lowercase().contains("douyin.com")
}

fn close_live_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LIVE_LABEL) {
        let _ = w.close();
    }
}

fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(LIVE_LABEL) {
        return Ok(w);
    }

    let home: Url = LIVE_HOME.parse().map_err(|e| format!("bad live url: {e}"))?;
    let handle = app.clone();

    let mut builder = WebviewWindowBuilder::new(app, LIVE_LABEL, WebviewUrl::External(home))
        .title("FLYBOX 数据采集")
        .inner_size(900.0, 700.0)
        .visible(false)
        .focused(false)
        .decorations(true)
        .skip_taskbar(true)
        .initialization_script_for_all_frames(QR_BRIDGE_SCRIPT)
        // minute_trend 等常在子 frame 请求，必须全帧注入
        .initialization_script_for_all_frames(HISTORY_BRIDGE_SCRIPT)
        .initialization_script(HISTORY_BRIDGE_SCRIPT)
        .on_navigation(move |url| {
            emit_nav(&handle, url);
            true
        })
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = window.eval(QR_BRIDGE_SCRIPT);
                let _ = window.eval(HISTORY_BRIDGE_SCRIPT);
            }
        });

    #[cfg(windows)]
    {
        builder = builder.additional_browser_args(
            "--no-proxy-server --proxy-server=direct:// --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
        );
    }

    builder.build().map_err(|e| format!("打开采集后台失败: {e}"))
}

async fn wait_url_settle(w: &WebviewWindow, max_iters: u8) -> String {
    let mut last = String::new();
    let mut stable = 0u8;
    for _ in 0..max_iters {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let Ok(u) = w.url() else { continue };
        let s = u.to_string();
        if s == last && decisive(&s) {
            stable += 1;
            if stable >= 2 {
                return s;
            }
        } else {
            stable = 0;
            last = s;
        }
    }
    last
}

async fn page_says_need_login(w: &WebviewWindow) -> Option<bool> {
    let script = r#"(function(){
      var t = ((document.body && (document.body.innerText || document.body.textContent)) || "").slice(0, 4000);
      var h = String(location.href || "").toLowerCase();
      if (/passport|\/login|sso|qrcode/.test(h)) return true;
      if (/扫码登录|打开抖音扫一扫|请使用抖音扫码|手机抖音扫码/.test(t)) return true;
      if (/直播服务平台/.test(t) && /登录|扫码/.test(t) && !/数据中心|实时数据|本场数据/.test(t)) return true;
      return false;
    })()"#;

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));
    if w
        .eval_with_callback(script, move |result| {
            if let Ok(mut guard) = tx.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(result);
                }
            }
        })
        .is_err()
    {
        return None;
    }
    let raw = tokio::time::timeout(Duration::from_secs(3), rx)
        .await
        .ok()?
        .ok()?;
    match raw.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => serde_json::from_str::<bool>(&raw).ok(),
    }
}

async fn eval_string(w: &WebviewWindow, script: &str) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));
    w.eval_with_callback(script.to_string(), move |result| {
        if let Ok(mut guard) = tx.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(result);
            }
        }
    })
    .map_err(|e| e.to_string())?;

    let raw = tokio::time::timeout(Duration::from_secs(4), rx)
        .await
        .map_err(|_| "读取超时".to_string())?
        .map_err(|_| "读取取消".to_string())?;

    let trimmed = raw.trim();
    if trimmed == "null" || trimmed.is_empty() || trimmed == "undefined" {
        return Ok(None);
    }
    // eval_with_callback JSON-encodes string results → "\"data:image/...\""
    if let Ok(s) = serde_json::from_str::<String>(trimmed) {
        if s.starts_with("data:image") {
            return Ok(Some(s));
        }
        return Ok(None);
    }
    if trimmed.starts_with("data:image") {
        return Ok(Some(trimmed.to_string()));
    }
    Ok(None)
}

fn keep_hidden(w: &WebviewWindow) {
    let _ = w.hide();
    let _ = w.set_skip_taskbar(true);
}

/// 进「数据」：复用已有隐藏 WebView（避免每次拆掉重建导致卡很久）
#[tauri::command]
pub async fn live_bootstrap(app: AppHandle) -> Result<LiveBootstrapResult, String> {
    let home: Url = LIVE_HOME.parse().map_err(|e| format!("bad live url: {e}"))?;

    // 快路径：窗口还在，先读登录态，已登录就直接返回
    if let Some(w) = app.get_webview_window(LIVE_LABEL) {
        keep_hidden(&w);
        let url = w.url().map(|u| u.to_string()).unwrap_or_default();
        let (need_login_url, logged_in_url) = classify_url(&url);
        let page_need = page_says_need_login(&w).await;
        let need_login = need_login_url || page_need.unwrap_or(false);
        let logged_in = logged_in_url && !need_login && page_need != Some(true);
        if logged_in {
            let _ = w.eval(QR_BRIDGE_SCRIPT);
            return Ok(LiveBootstrapResult {
                logged_in: true,
                url: if url.is_empty() { None } else { Some(url) },
            });
        }
        // 未登录：不关窗，导航回首页再判一次
        let _ = w.navigate(home.clone());
        let url2 = wait_url_settle(&w, 8).await;
        let (need2, logged2) = classify_url(&url2);
        let page_need2 = page_says_need_login(&w).await;
        let need_login2 = need2 || page_need2.unwrap_or(false);
        let logged_in2 = logged2 && !need_login2 && page_need2 != Some(true);
        keep_hidden(&w);
        let _ = w.eval(QR_BRIDGE_SCRIPT);
        return Ok(LiveBootstrapResult {
            logged_in: logged_in2,
            url: Some(url2),
        });
    }

    let w = ensure_window(&app)?;
    keep_hidden(&w);
    let _ = w.navigate(home.clone());
    let url = wait_url_settle(&w, 10).await;
    if let Ok(parsed) = Url::parse(&url) {
        emit_nav(&app, &parsed);
    } else {
        emit_nav(&app, &home);
    }

    let (need_login_url, logged_in_url) = classify_url(&url);
    let page_need = page_says_need_login(&w).await;
    let need_login = need_login_url || page_need.unwrap_or(false);
    let logged_in = logged_in_url && !need_login && page_need != Some(true);

    keep_hidden(&w);
    let _ = w.eval(QR_BRIDGE_SCRIPT);

    Ok(LiveBootstrapResult {
        logged_in,
        url: Some(url),
    })
}

/// 从隐藏 WebView 取当前登录二维码（dataURL）；没有则 null
#[tauri::command]
pub async fn live_fetch_login_qr(app: AppHandle) -> Result<Option<String>, String> {
    let w = app
        .get_webview_window(LIVE_LABEL)
        .ok_or_else(|| "采集后台未就绪".to_string())?;
    keep_hidden(&w);
    let _ = w.eval(QR_BRIDGE_SCRIPT);
    eval_string(&w, FETCH_QR_SCRIPT).await
}

/// 轮询：扫码后 SPA 不一定触发导航事件，靠读 URL + 页面文案判断
#[tauri::command]
pub async fn live_auth_status(app: AppHandle) -> Result<LiveAuthStatus, String> {
    let Some(w) = app.get_webview_window(LIVE_LABEL) else {
        return Ok(LiveAuthStatus {
            logged_in: false,
            need_login: true,
            url: None,
        });
    };
    keep_hidden(&w);
    let url = w.url().map(|u| u.to_string()).unwrap_or_default();
    let (need_url, logged_url) = classify_url(&url);
    let page_need = page_says_need_login(&w).await;

    // 正向确认：已在 dashboard 且页面不再是扫码文案
    let script = r#"(function(){
      var h = String(location.href || "").toLowerCase();
      var t = ((document.body && (document.body.innerText || document.body.textContent)) || "").slice(0, 5000);
      var onDash = h.indexOf('/anchor/dashboard') >= 0;
      var scanning = /扫码登录|打开抖音扫一扫|请使用抖音扫码|手机抖音扫码/.test(t);
      var appShell = /数据中心|直播数据|实时|开播|场次|音浪|观众/.test(t);
      return onDash && !scanning && (appShell || !/直播服务平台·主播版/.test(t.replace(/\s/g,'')));
    })()"#;
    let page_logged = match eval_string_bool(&w, script).await {
        Ok(Some(v)) => v,
        _ => false,
    };

    let need_login = (need_url || page_need.unwrap_or(false)) && !page_logged;
    let logged_in = page_logged || (logged_url && !need_login && page_need != Some(true));

    // 扫码成功后若还停在中间页，拉回 dashboard
    if logged_in && !url.to_lowercase().contains("/anchor/dashboard") {
        if let Ok(home) = LIVE_HOME.parse::<Url>() {
            let _ = w.navigate(home);
        }
    }

    Ok(LiveAuthStatus {
        logged_in,
        need_login,
        url: if url.is_empty() { None } else { Some(url) },
    })
}

async fn eval_string_bool(w: &WebviewWindow, script: &str) -> Result<Option<bool>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));
    w.eval_with_callback(script.to_string(), move |result| {
        if let Ok(mut guard) = tx.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(result);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    let raw = tokio::time::timeout(Duration::from_secs(3), rx)
        .await
        .map_err(|_| "timeout".to_string())?
        .map_err(|_| "cancel".to_string())?;
    let trimmed = raw.trim();
    Ok(match trimmed {
        "true" => Some(true),
        "false" => Some(false),
        _ => serde_json::from_str::<bool>(trimmed).ok(),
    })
}

/// 登录后同步历史场次：进「直播复盘」→ 点「切换场次」→ 拦截 history_list
#[tauri::command]
pub async fn live_sync_history(app: AppHandle) -> Result<serde_json::Value, String> {
    let w = ensure_window(&app)?;
    keep_hidden(&w);
    let _ = w.eval(HISTORY_BRIDGE_SCRIPT);

    for url in HISTORY_URLS {
        if let Ok(parsed) = url.parse::<Url>() {
            let _ = w.navigate(parsed);
            tokio::time::sleep(Duration::from_millis(2800)).await;
            let _ = w.eval(HISTORY_BRIDGE_SCRIPT);
            let _ = w.eval(CLICK_REVIEW_FLOW);
            // history_list 在点「切换场次」后才会出来
            tokio::time::sleep(Duration::from_millis(3500)).await;
            let _ = w.eval(CLICK_REVIEW_FLOW);
            tokio::time::sleep(Duration::from_millis(2500)).await;
        }
    }

    let script = HISTORY_EXTRACT_SCRIPT;
    let wrapped = format!(
        "(function(){{ try {{ return ({script}); }} catch(e) {{ return {{ sessions: [], error: String(e&&e.message||e) }}; }} }})()"
    );
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));
    w.eval_with_callback(wrapped, move |result| {
        if let Ok(mut guard) = tx.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(result);
            }
        }
    })
    .map_err(|e| format!("抽取历史失败: {e}"))?;

    let raw = tokio::time::timeout(Duration::from_secs(15), rx)
        .await
        .map_err(|_| "同步历史超时".to_string())?
        .map_err(|_| "同步历史取消".to_string())?;

    serde_json::from_str(&raw).map_err(|e| {
        format!(
            "历史结果解析失败: {e}; raw={}",
            raw.chars().take(200).collect::<String>()
        )
    })
}

/// 对最近场次深采 overview_v3（进房率/停留/送礼率等），最多 20 个 roomId
#[tauri::command]
pub async fn live_sync_deep(app: AppHandle, room_ids: Vec<String>) -> Result<serde_json::Value, String> {
    if room_ids.is_empty() {
        return Ok(serde_json::json!({ "sessions": [], "fetched": 0 }));
    }
    let w = ensure_window(&app)?;
    keep_hidden(&w);
    let review: Url = "https://anchor.douyin.com/anchor/review"
        .parse()
        .map_err(|e| format!("bad url: {e}"))?;
    let _ = w.navigate(review);
    tokio::time::sleep(Duration::from_millis(2200)).await;

    let ids_json = serde_json::to_string(&room_ids).map_err(|e| e.to_string())?;
    let prep = format!(
        "window.__flyboxDeepIds={ids_json};window.__flyboxDeepDone=false;window.__flyboxDeepResult=null;"
    );
    let _ = w.eval(prep);
    // 用字符串拼接，避免 format! 吃掉 JS 花括号；async IIFE 结果写入 window
    let kick = String::from(
        "(async function(){ try { window.__flyboxDeepResult = await (",
    ) + DEEP_FETCH_SCRIPT
        + "); } catch(e) { window.__flyboxDeepResult = { sessions: [], error: String(e&&e.message||e), fetched: 0 }; } finally { window.__flyboxDeepDone = true; } })();";
    w.eval(kick).map_err(|e| format!("深采脚本注入失败: {e}"))?;

    let poll = r#"(function(){ if (!window.__flyboxDeepDone) return null; return window.__flyboxDeepResult || { sessions: [], fetched: 0 }; })()"#;
    for _ in 0..90 {
        tokio::time::sleep(Duration::from_millis(1000)).await;
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        let tx = Mutex::new(Some(tx));
        if w
            .eval_with_callback(poll, move |result| {
                if let Ok(mut guard) = tx.lock() {
                    if let Some(sender) = guard.take() {
                        let _ = sender.send(result);
                    }
                }
            })
            .is_err()
        {
            continue;
        }
        let Ok(Ok(raw)) = tokio::time::timeout(Duration::from_secs(3), rx).await else {
            continue;
        };
        let trimmed = raw.trim();
        if trimmed == "null" || trimmed.is_empty() {
            continue;
        }
        return serde_json::from_str(trimmed).map_err(|e| {
            format!(
                "深采结果解析失败: {e}; raw={}",
                trimmed.chars().take(200).collect::<String>()
            )
        });
    }
    Err("深采超时".to_string())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortraitRoomIn {
    id: String,
    /// 「2026-07-27 17:16:23」，对齐复盘列表「开播时间」
    start_hint: Option<String>,
}

/// 打开复盘页，按开播时间切换场次，采集画像/渠道/漏斗/分钟（最多 8 场）
#[tauri::command]
pub async fn live_sync_portrait(
    app: AppHandle,
    rooms: Vec<PortraitRoomIn>,
) -> Result<serde_json::Value, String> {
    if rooms.is_empty() {
        return Ok(serde_json::json!({ "sessions": [], "fetched": 0 }));
    }
    // 复用采集窗；全 frame 拦截靠页面加载回调 + 显式 eval 补齐
    let w = ensure_window(&app)?;
    keep_hidden(&w);

    let rooms: Vec<PortraitRoomIn> = rooms
        .into_iter()
        .filter(|r| r.id.chars().all(|c| c.is_ascii_digit()) && r.id.len() >= 10)
        .take(8)
        .collect();
    if rooms.is_empty() {
        return Ok(serde_json::json!({ "sessions": [], "fetched": 0 }));
    }

    let mut sessions = Vec::new();
    let extract = format!(
        "(function(){{ try {{ return ({PORTRAIT_EXTRACT_SCRIPT}); }} catch(e) {{ return {{ id: null, error: String(e&&e.message||e), portrait: null }}; }} }})()"
    );

    let click_tabs = r#"(function(){
  function clickText(exact){
    var nodes=Array.prototype.slice.call(document.querySelectorAll('a,button,[role="tab"],div,span'));
    for(var i=0;i<nodes.length;i++){
      var t=(nodes[i].innerText||'').replace(/\s+/g,' ').trim();
      if(t===exact){try{nodes[i].click();return true;}catch(e){}}
    }
    return false;
  }
  clickText('整体数据');
  clickText('内容分析');
  clickText('流量分析');
  clickText('观众分析');
  clickText('观众画像');
  clickText('全部观众');
  return true;
})()"#;

    let click_exact = |label: &str| -> String {
        format!(
            r#"(function(){{
  var want={label:?};
  var nodes=Array.prototype.slice.call(document.querySelectorAll('a,button,[role="tab"],div,span'));
  for(var i=0;i<nodes.length;i++){{
    var t=(nodes[i].innerText||'').replace(/\s+/g,' ').trim();
    if(t===want){{ try{{nodes[i].click();return true;}}catch(e){{}} }}
  }}
  return false;
}})()"#
        )
    };

    let open_switch = r#"(function(){
  var btns=Array.prototype.slice.call(document.querySelectorAll('button'));
  for (var i=0;i<btns.length;i++){
    if ((btns[i].innerText||'').indexOf('切换场次')>=0){ try{btns[i].click();return true;}catch(e){} }
  }
  return false;
})()"#;

    let review: Url = "https://anchor.douyin.com/anchor/review"
        .parse()
        .map_err(|e| format!("bad url: {e}"))?;
    let _ = w.eval(HISTORY_BRIDGE_SCRIPT);
    let _ = w.navigate(review);
    tokio::time::sleep(Duration::from_millis(3200)).await;
    let _ = w.eval(HISTORY_BRIDGE_SCRIPT);

    for room in &rooms {
        let id = room.id.clone();
        let start_hint = room
            .start_hint
            .as_deref()
            .unwrap_or("")
            .trim()
            .to_string();

        let _ = w.eval(
            r#"(function(){ try { var R=window.top||window; R.__flyboxHistoryRaw=[]; R.__flyboxPinned={}; } catch(e) { window.__flyboxHistoryRaw=[]; window.__flyboxPinned={}; } })()"#,
        );
        let prep = format!(
            "window.__flyboxPortraitRoom={id:?};window.__flyboxPortraitStart={start_hint:?};"
        );
        let _ = w.eval(&prep);

        // 切换场次 → 点对应开播时间的「查看复盘」（URL roomID 不可靠）
        let _ = w.eval(open_switch);
        tokio::time::sleep(Duration::from_millis(1400)).await;
        if !start_hint.is_empty() {
            // 卡片文案含「开播时间」；秒可能对不齐，优先匹配到分钟
            let pick = format!(
                r#"(function(){{
  var start = {start_hint:?};
  var key = start.length >= 16 ? start.slice(0, 16) : start;
  function hit(text){{
    var t=(text||'').replace(/\s+/g,' ');
    return t.indexOf(start)>=0 || (key && t.indexOf(key)>=0);
  }}
  var cards = Array.prototype.slice.call(document.querySelectorAll('.record-card, [class*="record-card"]'));
  var card = null;
  for (var i=0;i<cards.length;i++){{
    if (hit(cards[i].innerText)){{ card=cards[i]; break; }}
  }}
  if (!card) {{
    var nodes = Array.prototype.slice.call(document.querySelectorAll('div'));
    for (var j=0;j<nodes.length;j++){{
      var t=(nodes[j].innerText||'').replace(/\s+/g,' ').trim();
      if (hit(t) && t.indexOf('查看复盘')>=0 && t.length<220){{ card=nodes[j]; break; }}
    }}
  }}
  if (!card) return {{ ok:false, key:key }};
  var link = null;
  var kids = Array.prototype.slice.call(card.querySelectorAll('a,button,span,div'));
  for (var k=0;k<kids.length;k++){{
    if ((kids[k].innerText||'').trim()==='查看复盘'){{ link=kids[k]; break; }}
  }}
  try {{ (link||card).click(); return {{ ok:true, start:start, key:key }}; }} catch(e) {{ return {{ ok:false, error:String(e) }}; }}
}})()"#
            );
            let _ = w.eval(&pick);
            tokio::time::sleep(Duration::from_millis(3800)).await;
        }
        let _ = w.eval(HISTORY_BRIDGE_SCRIPT);

        // 先点齐画像三切片 + 观众维护子页，让拦截缓存落到带 isFans/isConsume / rankType 的包
        let _ = w.eval(click_tabs);
        tokio::time::sleep(Duration::from_millis(2400)).await;
        for tab in ["付费观众", "仅看粉丝", "全部观众"] {
            let _ = w.eval(&click_exact(tab));
            tokio::time::sleep(Duration::from_millis(1300)).await;
        }
        let _ = w.eval(&click_exact("观众维护"));
        tokio::time::sleep(Duration::from_millis(1100)).await;
        for tab in ["流失挽回", "潜在观众", "粉丝维护", "活跃下降"] {
            let _ = w.eval(&click_exact(tab));
            tokio::time::sleep(Duration::from_millis(1100)).await;
        }
        // 观众贡献榜 → 高价值/高活跃摘要（public/rank）
        let _ = w.eval(&click_exact("观众贡献"));
        tokio::time::sleep(Duration::from_millis(1000)).await;
        for tab in ["首次送礼", "点赞打赏", "观看时长"] {
            let _ = w.eval(&click_exact(tab));
            tokio::time::sleep(Duration::from_millis(1000)).await;
        }
        let _ = w.eval(&click_exact("观众画像"));
        let _ = w.eval(&click_exact("全部观众"));
        tokio::time::sleep(Duration::from_millis(900)).await;

        let mut best: Option<serde_json::Value> = None;
        for attempt in 0..3 {
            let _ = w.eval(click_tabs);
            tokio::time::sleep(Duration::from_millis(if attempt == 0 { 2200 } else { 1600 }))
                .await;

            let (tx, rx) = tokio::sync::oneshot::channel::<String>();
            let tx = Mutex::new(Some(tx));
            if w
                .eval_with_callback(extract.clone(), move |result| {
                    if let Ok(mut guard) = tx.lock() {
                        if let Some(sender) = guard.take() {
                            let _ = sender.send(result);
                        }
                    }
                })
                .is_err()
            {
                continue;
            }
            let Ok(Ok(raw)) = tokio::time::timeout(Duration::from_secs(8), rx).await else {
                continue;
            };
            let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            // 强制 id 为请求场次；来源 room 不一致则丢弃（避免串场）
            if let Some(obj) = val.as_object_mut() {
                obj.insert("id".into(), serde_json::json!(id));
            }
            let source = val
                .get("sourceRoomId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !source.is_empty() && source != id {
                continue;
            }
            let has_traffic = val
                .get("trafficChannels")
                .and_then(|p| p.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            let has_minute = val
                .get("minuteTrend")
                .and_then(|p| p.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            let useful = [
                "portrait",
                "portraitSlices",
                "audienceMaintenance",
                "trafficChannels",
                "trafficFunnel",
                "minuteTrend",
                "deep",
            ]
            .iter()
            .any(|k| val.get(*k).map(|p| !p.is_null()).unwrap_or(false));
            if useful {
                best = Some(val.clone());
            }
            if has_traffic && has_minute {
                break;
            }
        }
        if let Some(val) = best {
            sessions.push(val);
        }
    }

    Ok(serde_json::json!({
        "sessions": sessions,
        "fetched": sessions.len(),
    }))
}

async fn eval_json(w: &WebviewWindow, script: &str) -> Result<serde_json::Value, String> {
    let wrapped = format!(
        "(function(){{ try {{ return ({script}); }} catch(e) {{ return {{ error: String(e&&e.message||e) }}; }} }})()"
    );
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));
    w.eval_with_callback(wrapped, move |result| {
        if let Ok(mut guard) = tx.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(result);
            }
        }
    })
    .map_err(|e| format!("eval failed: {e}"))?;
    let raw = tokio::time::timeout(Duration::from_secs(12), rx)
        .await
        .map_err(|_| "eval timeout".to_string())?
        .map_err(|_| "eval canceled".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("json: {e}"))
}

/// 同步主播资料：头像 / 昵称 / 获赞 / 关注 / 粉丝
/// 数据就在中控台顶栏（「获赞0关注361粉丝481」），不必去 www.douyin.com
#[tauri::command]
pub async fn live_sync_profile(app: AppHandle) -> Result<serde_json::Value, String> {
    let w = ensure_window(&app)?;
    keep_hidden(&w);

    let mut best = serde_json::json!({
        "nickname": "",
        "avatarUrl": null,
        "diggCount": null,
        "followingCount": null,
        "followerCount": null,
    });

    let home: Url = LIVE_HOME.parse().map_err(|e| format!("bad live url: {e}"))?;
    let _ = w.navigate(home);
    tokio::time::sleep(Duration::from_millis(3200)).await;
    let _ = wait_url_settle(&w, 10).await;
    let _ = w.eval(HISTORY_BRIDGE_SCRIPT);

    let mut last_piece = serde_json::Value::Null;
    for _ in 0..8 {
        match eval_json(&w, PROFILE_EXTRACT_SCRIPT).await {
            Ok(v) => {
                last_piece = v.clone();
                merge_profile_json(&mut best, &v);
            }
            Err(e) => {
                last_piece = serde_json::json!({ "evalError": e });
            }
        }
        if profile_complete(&best) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(800)).await;
    }

    // 抖音 CDN 在 Tauri 里直接 <img> 常裂图：拉下来转成 data URL
    if let Some(url) = best.get("avatarUrl").and_then(|x| x.as_str()) {
        if url.starts_with("http") {
            if let Some(data) = avatar_url_to_data_url(url).await {
                best["avatarUrl"] = serde_json::json!(data);
            }
        }
    }

    let _ = last_piece; // 保留轮询结果用于上面 merge
    Ok(best)
}

/// 签名链常失效；收成 p3 无签名地址再拉
fn normalize_avatar_url(url: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(name) = url
        .split("aweme-avatar/")
        .nth(1)
        .map(|s| s.split(&['?', '#'][..]).next().unwrap_or(s))
        .filter(|s| !s.is_empty())
    {
        out.push(format!(
            "https://p3.douyinpic.com/aweme/100x100/aweme-avatar/{name}"
        ));
        out.push(format!(
            "https://p11.douyinpic.com/aweme/100x100/aweme-avatar/{name}"
        ));
    }
    out.push(url.to_string());
    out
}

/// 带抖音 Referer 拉头像，避免应用内直链被 CDN 拒掉
async fn avatar_url_to_data_url(url: &str) -> Option<String> {
    let candidates = normalize_avatar_url(url);
    tokio::task::spawn_blocking(move || {
        for u in candidates {
            let out = std::process::Command::new("curl")
                .args([
                    "-sL",
                    "--max-time",
                    "12",
                    "-H",
                    "Referer: https://anchor.douyin.com/",
                    "-H",
                    "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    &u,
                ])
                .output()
                .ok();
            let Some(out) = out else { continue };
            if !out.status.success() || out.stdout.len() < 64 {
                continue;
            }
            // 拒掉 HTML/JSON 错误页
            if out.stdout.starts_with(b"<") || out.stdout.starts_with(b"{") {
                continue;
            }
            let mime = if out.stdout.starts_with(&[0x89, b'P', b'N', b'G']) {
                "image/png"
            } else if out.stdout.len() > 12 && &out.stdout[0..4] == b"RIFF" {
                "image/webp"
            } else if out.stdout.starts_with(&[0xFF, 0xD8, 0xFF]) {
                "image/jpeg"
            } else {
                continue;
            };
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&out.stdout);
            return Some(format!("data:{mime};base64,{b64}"));
        }
        None
    })
    .await
    .ok()
    .flatten()
}

fn profile_complete(v: &serde_json::Value) -> bool {
    let nick = v.get("nickname").and_then(|x| x.as_str()).unwrap_or("");
    let avatar = v.get("avatarUrl").and_then(|x| x.as_str()).unwrap_or("");
    let digg = v.get("diggCount").and_then(|x| x.as_i64());
    let following = v.get("followingCount").and_then(|x| x.as_i64());
    let follower = v.get("followerCount").and_then(|x| x.as_i64());
    !nick.is_empty()
        && !avatar.is_empty()
        && digg.is_some()
        && following.is_some()
        && follower.is_some()
}

fn merge_profile_json(into: &mut serde_json::Value, piece: &serde_json::Value) {
    if into.get("nickname").and_then(|x| x.as_str()).unwrap_or("").is_empty() {
        if let Some(n) = piece.get("nickname").and_then(|x| x.as_str()) {
            if !n.is_empty() {
                into["nickname"] = serde_json::json!(n);
            }
        }
    }
    if into.get("avatarUrl").and_then(|x| x.as_str()).unwrap_or("").is_empty() {
        if let Some(a) = piece.get("avatarUrl").and_then(|x| x.as_str()) {
            if !a.is_empty() {
                into["avatarUrl"] = serde_json::json!(a);
            }
        }
    }
    for key in ["diggCount", "followingCount", "followerCount"] {
        if into.get(key).and_then(|x| x.as_i64()).is_none() {
            if let Some(n) = piece.get(key).and_then(|x| x.as_i64()) {
                into[key] = serde_json::json!(n);
            }
        }
    }
}

/// 重新拉起登录页（仍隐藏），前端继续轮询二维码
#[tauri::command]
pub async fn live_open_login(app: AppHandle) -> Result<(), String> {
    close_live_window(&app);
    tokio::time::sleep(Duration::from_millis(180)).await;
    let w = ensure_window(&app)?;
    let home: Url = LIVE_HOME.parse().map_err(|e| format!("bad live url: {e}"))?;
    keep_hidden(&w);
    let _ = w.navigate(home);
    let _ = w.eval("window.__flyboxLoginQr=null;");
    let _ = w.eval(QR_BRIDGE_SCRIPT);
    if let Ok(url) = w.url() {
        emit_nav(&app, &url);
    }
    Ok(())
}

#[tauri::command]
pub async fn live_close_window(app: AppHandle) -> Result<(), String> {
    close_live_window(&app);
    Ok(())
}

#[tauri::command]
pub async fn live_hide_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LIVE_LABEL) {
        keep_hidden(&w);
    }
    Ok(())
}

#[tauri::command]
pub async fn live_show_window(app: AppHandle) -> Result<(), String> {
    let w = ensure_window(&app)?;
    let home: Url = LIVE_HOME.parse().map_err(|e| format!("bad live url: {e}"))?;
    let _ = w.navigate(home);
    let _ = w.set_title("FLYBOX 数据采集");
    let _ = w.set_size(LogicalSize::new(1100.0, 760.0));
    let _ = w.set_skip_taskbar(false);
    w.show().map_err(|e| e.to_string())?;
    let _ = w.set_focus();
    Ok(())
}

#[tauri::command]
pub async fn live_current_url(app: AppHandle) -> Result<Option<String>, String> {
    match app.get_webview_window(LIVE_LABEL) {
        Some(w) => Ok(Some(w.url().map(|u| u.to_string()).map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn live_scrape(app: AppHandle, script: String) -> Result<serde_json::Value, String> {
    let w = app
        .get_webview_window(LIVE_LABEL)
        .ok_or_else(|| "采集后台未打开，请先登录".to_string())?;

    let wrapped = format!(
        "(function(){{ try {{ return ({script}); }} catch (e) {{ return {{ error: String(e && e.message || e), needLogin: false }}; }} }})()"
    );

    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Mutex::new(Some(tx));
    w.eval_with_callback(wrapped, move |result| {
        if let Ok(mut guard) = tx.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(result);
            }
        }
    })
    .map_err(|e| format!("注入采集脚本失败: {e}"))?;

    let raw = tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .map_err(|_| "采集超时".to_string())?
        .map_err(|_| "采集被取消".to_string())?;

    serde_json::from_str(&raw).map_err(|e| format!("采集结果解析失败: {e}; raw={raw}"))
}
