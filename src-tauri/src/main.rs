// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Must run BEFORE any WebView2 environment is created.
/// Clash/system proxy (127.0.0.1:7897) breaks http://tauri.localhost → ERR_CONNECTION_REFUSED.
#[cfg(target_os = "windows")]
fn force_webview2_direct() {
    // Fresh user-data folder so AdditionalBrowserArguments actually apply
    // (WebView2 ignores arg changes on an already-created environment).
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let dir = format!(r"{local}\com.flyashaw.flyphoto\wv2_direct_v1");
        let _ = std::fs::create_dir_all(&dir);
        // SAFETY: single-threaded before any other threads; WebView2 reads this at env create.
        unsafe {
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &dir);
        }
    }

    let args = "--no-proxy-server --proxy-server=direct:// --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
    unsafe {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args);
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "http_proxy",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
        ] {
            std::env::remove_var(key);
        }
        std::env::set_var("NO_PROXY", "*");
        std::env::set_var("no_proxy", "*");
    }
}

fn main() {
    #[cfg(target_os = "windows")]
    force_webview2_direct();

    flyphoto_lib::run();
}
