//! OBS WebSocket 5.x via `obws` — keeps one live client for scene/seek calls.

use obws::requests::inputs::InputId;
use obws::Client;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use time::Duration as TimeDuration;
use tokio::runtime::Runtime;

pub struct ObsState {
    rt: Runtime,
    inner: Mutex<ObsInner>,
}

struct ObsInner {
    host: String,
    port: u16,
    password: String,
    seek_compensate_ms: i64,
    media_input: Option<String>,
    client: Option<Client>,
    scenes: Vec<String>,
    current_scene: Option<String>,
}

impl Default for ObsState {
    fn default() -> Self {
        Self {
            rt: Runtime::new().expect("tokio runtime"),
            inner: Mutex::new(ObsInner {
                host: "127.0.0.1".into(),
                port: 4455,
                password: String::new(),
                seek_compensate_ms: 0,
                media_input: None,
                client: None,
                scenes: vec![],
                current_scene: None,
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsStatus {
    pub connected: bool,
    pub host: String,
    pub port: u16,
    pub scenes: Vec<String>,
    pub current_scene: Option<String>,
    pub seek_compensate_ms: i64,
    pub media_input: Option<String>,
}

async fn connect_client(host: &str, port: u16, password: &str) -> Result<Client, String> {
    let pass = if password.is_empty() {
        None
    } else {
        Some(password)
    };
    Client::connect(host, port, pass)
        .await
        .map_err(|e| format!("OBS 连接失败: {e}"))
}

fn status_from(g: &ObsInner) -> ObsStatus {
    ObsStatus {
        connected: g.client.is_some(),
        host: g.host.clone(),
        port: g.port,
        scenes: g.scenes.clone(),
        current_scene: g.current_scene.clone(),
        seek_compensate_ms: g.seek_compensate_ms,
        media_input: g.media_input.clone(),
    }
}

/// Take client out of the mutex so we can `.await` without holding the lock.
fn take_client(state: &ObsState) -> Result<(Client, String, u16, String), String> {
    let mut g = state.inner.lock().map_err(|e| e.to_string())?;
    let host = g.host.clone();
    let port = g.port;
    let password = g.password.clone();
    if let Some(c) = g.client.take() {
        return Ok((c, host, port, password));
    }
    drop(g);
    let client = state
        .rt
        .block_on(async { connect_client(&host, port, &password).await })?;
    Ok((client, host, port, password))
}

fn put_client(state: &ObsState, client: Option<Client>) {
    if let Ok(mut g) = state.inner.lock() {
        g.client = client;
    }
}

#[tauri::command]
pub fn obs_configure(
    state: tauri::State<'_, ObsState>,
    host: String,
    port: u16,
    password: String,
    seek_compensate_ms: Option<i64>,
    media_input: Option<String>,
) -> Result<(), String> {
    let mut g = state.inner.lock().map_err(|e| e.to_string())?;
    let creds_changed = g.host != host || g.port != port || g.password != password;
    g.host = host;
    g.port = port;
    g.password = password;
    if let Some(ms) = seek_compensate_ms {
        g.seek_compensate_ms = ms;
    }
    g.media_input = media_input;
    if creds_changed {
        g.client = None;
        g.scenes.clear();
        g.current_scene = None;
    }
    Ok(())
}

#[tauri::command]
pub fn obs_connect(state: tauri::State<'_, ObsState>) -> Result<ObsStatus, String> {
    // Drop any stale client first.
    put_client(&state, None);
    let (host, port, password) = {
        let g = state.inner.lock().map_err(|e| e.to_string())?;
        (g.host.clone(), g.port, g.password.clone())
    };
    let (client, scenes, current_scene) = state.rt.block_on(async {
        let client = connect_client(&host, port, &password).await?;
        let list = client
            .scenes()
            .list()
            .await
            .map_err(|e| format!("获取场景失败: {e}"))?;
        let scenes: Vec<String> = list.scenes.iter().map(|s| s.id.name.clone()).collect();
        let current_scene = list.current_program_scene.map(|c| c.name);
        Ok::<_, String>((client, scenes, current_scene))
    })?;
    {
        let mut g = state.inner.lock().map_err(|e| e.to_string())?;
        g.client = Some(client);
        g.scenes = scenes;
        g.current_scene = current_scene;
        Ok(status_from(&g))
    }
}

#[tauri::command]
pub fn obs_status(state: tauri::State<'_, ObsState>) -> Result<ObsStatus, String> {
    let has = state
        .inner
        .lock()
        .map(|g| g.client.is_some())
        .unwrap_or(false);
    if !has {
        let g = state.inner.lock().map_err(|e| e.to_string())?;
        return Ok(status_from(&g));
    }
    // Refresh scene list on the existing connection.
    let (client, host, port, password) = take_client(&state)?;
    let refreshed = state.rt.block_on(async {
        match client.scenes().list().await {
            Ok(list) => {
                let scenes: Vec<String> = list.scenes.iter().map(|s| s.id.name.clone()).collect();
                let current_scene = list.current_program_scene.map(|c| c.name);
                Ok((client, scenes, current_scene))
            }
            Err(_) => {
                // Stale socket — reconnect once.
                let client = connect_client(&host, port, &password).await?;
                let list = client
                    .scenes()
                    .list()
                    .await
                    .map_err(|e| format!("获取场景失败: {e}"))?;
                let scenes: Vec<String> = list.scenes.iter().map(|s| s.id.name.clone()).collect();
                let current_scene = list.current_program_scene.map(|c| c.name);
                Ok((client, scenes, current_scene))
            }
        }
    });
    match refreshed {
        Ok((client, scenes, current_scene)) => {
            let mut g = state.inner.lock().map_err(|e| e.to_string())?;
            g.client = Some(client);
            g.scenes = scenes;
            g.current_scene = current_scene;
            Ok(status_from(&g))
        }
        Err(e) => {
            put_client(&state, None);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn obs_set_scene(state: tauri::State<'_, ObsState>, scene: String) -> Result<(), String> {
    let (mut client, host, port, password) = take_client(&state)?;
    let result = state.rt.block_on(async {
        let first = client
            .scenes()
            .set_current_program_scene(scene.as_str())
            .await;
        if first.is_ok() {
            return Ok(client);
        }
        client = connect_client(&host, port, &password).await?;
        client
            .scenes()
            .set_current_program_scene(scene.as_str())
            .await
            .map_err(|e| format!("切场景失败: {e}"))?;
        Ok(client)
    });
    match result {
        Ok(client) => {
            if let Ok(mut g) = state.inner.lock() {
                g.client = Some(client);
                g.current_scene = Some(scene);
            }
            Ok(())
        }
        Err(e) => {
            put_client(&state, None);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn obs_sync_media_seek(
    state: tauri::State<'_, ObsState>,
    position_ms: u64,
) -> Result<(), String> {
    let (compensate, media) = {
        let g = state.inner.lock().map_err(|e| e.to_string())?;
        (g.seek_compensate_ms, g.media_input.clone())
    };
    let Some(input) = media else {
        return Ok(());
    };
    let cursor = (position_ms as i64 + compensate).max(0);
    let (mut client, host, port, password) = take_client(&state)?;
    let result = state.rt.block_on(async {
        let first = client
            .media_inputs()
            .set_cursor(
                InputId::Name(input.as_str()),
                TimeDuration::milliseconds(cursor),
            )
            .await;
        if first.is_ok() {
            return Ok(client);
        }
        client = connect_client(&host, port, &password).await?;
        client
            .media_inputs()
            .set_cursor(
                InputId::Name(input.as_str()),
                TimeDuration::milliseconds(cursor),
            )
            .await
            .map_err(|e| format!("同步媒体进度失败: {e}"))?;
        Ok(client)
    });
    match result {
        Ok(client) => {
            put_client(&state, Some(client));
            Ok(())
        }
        Err(e) => {
            put_client(&state, None);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn obs_disconnect(state: tauri::State<'_, ObsState>) -> Result<(), String> {
    let mut g = state.inner.lock().map_err(|e| e.to_string())?;
    g.client = None;
    g.scenes.clear();
    g.current_scene = None;
    Ok(())
}
