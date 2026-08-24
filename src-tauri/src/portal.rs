//! Portal and WebView2 management registry for Windows.
//!
//! Provides a thread-safe registry for active Portals and native Tauri commands
//! to navigate, reload, go back/forward, and inspect state.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortalInfo {
    pub id: String,
    pub name: String,
    pub current_url: String,
    pub title: Option<String>,
    pub is_loading: bool,
}

#[derive(Debug, Clone)]
pub struct PortalSession {
    pub id: String,
    pub name: String,
    pub current_url: String,
    pub title: Option<String>,
    pub history: Vec<String>,
    pub history_index: usize,
    pub is_loading: bool,
}

/// The React Flow canvas node UUID is the native Portal identity. The same
/// value is used by the access graph and by the child WebView2 label.
pub fn portal_webview_label(id: &str) -> String {
    format!("portal:{id}")
}

impl PortalSession {
    pub fn new(id: String, name: String, initial_url: String) -> Self {
        let sanitized = sanitize_url(&initial_url);
        Self {
            id,
            name,
            current_url: sanitized.clone(),
            title: None,
            history: vec![sanitized],
            history_index: 0,
            is_loading: false,
        }
    }

    pub fn to_info(&self) -> PortalInfo {
        PortalInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            current_url: self.current_url.clone(),
            title: self.title.clone(),
            is_loading: self.is_loading,
        }
    }

    pub fn navigate(&mut self, url: &str) -> String {
        let sanitized = sanitize_url(url);
        self.current_url = sanitized.clone();
        if self.history_index + 1 < self.history.len() {
            self.history.truncate(self.history_index + 1);
        }
        self.history.push(sanitized.clone());
        self.history_index = self.history.len() - 1;
        self.is_loading = true;
        sanitized
    }

    pub fn go_back(&mut self) -> Option<String> {
        if self.history_index > 0 {
            self.history_index -= 1;
            let url = self.history[self.history_index].clone();
            self.current_url = url.clone();
            self.is_loading = true;
            Some(url)
        } else {
            None
        }
    }

    pub fn go_forward(&mut self) -> Option<String> {
        if self.history_index + 1 < self.history.len() {
            self.history_index += 1;
            let url = self.history[self.history_index].clone();
            self.current_url = url.clone();
            self.is_loading = true;
            Some(url)
        } else {
            None
        }
    }

    pub fn reload(&mut self) -> String {
        self.is_loading = true;
        self.current_url.clone()
    }
}

pub fn sanitize_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "about:blank".to_string();
    }
    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("about:")
    {
        return trimmed.to_string();
    }
    format!("https://{trimmed}")
}

#[derive(Clone, Default)]
pub struct PortalRegistry {
    sessions: Arc<RwLock<HashMap<String, PortalSession>>>,
}

impl PortalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, id: String, name: String, initial_url: String) -> PortalInfo {
        let session = PortalSession::new(id.clone(), name, initial_url);
        let info = session.to_info();
        if let Ok(mut lock) = self.sessions.write() {
            lock.insert(id, session);
        }
        info
    }

    pub fn unregister(&self, id: &str) -> bool {
        if let Ok(mut lock) = self.sessions.write() {
            lock.remove(id).is_some()
        } else {
            false
        }
    }

    pub fn get(&self, id: &str) -> Option<PortalInfo> {
        self.sessions
            .read()
            .ok()
            .and_then(|lock| lock.get(id).map(|s| s.to_info()))
    }

    pub fn list(&self) -> Vec<PortalInfo> {
        self.sessions
            .read()
            .ok()
            .map(|lock| lock.values().map(|s| s.to_info()).collect())
            .unwrap_or_default()
    }

    pub fn update_page_meta(&self, id: &str, url: Option<String>, title: Option<String>) -> bool {
        if let Ok(mut lock) = self.sessions.write() {
            if let Some(session) = lock.get_mut(id) {
                if let Some(u) = url {
                    session.current_url = u;
                }
                if title.is_some() {
                    session.title = title;
                }
                session.is_loading = false;
                return true;
            }
        }
        false
    }
}

// MARK: - Tauri Commands

#[tauri::command]
pub fn portal_register(
    registry: State<'_, PortalRegistry>,
    id: String,
    name: String,
    initial_url: String,
) -> Result<PortalInfo, String> {
    if id.trim().is_empty() {
        return Err("Portal ID cannot be empty".to_string());
    }
    Ok(registry.register(id, name, initial_url))
}

#[tauri::command]
pub fn portal_unregister(
    app: AppHandle,
    registry: State<'_, PortalRegistry>,
    id: String,
) -> Result<bool, String> {
    let removed = registry.unregister(&id);
    if removed {
        let label = portal_webview_label(&id);
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
    }
    Ok(removed)
}

#[tauri::command]
pub fn portal_navigate(
    app: AppHandle,
    registry: State<'_, PortalRegistry>,
    id: String,
    url: String,
) -> Result<PortalInfo, String> {
    let target_url = {
        let mut lock = registry
            .sessions
            .write()
            .map_err(|_| "Registry lock poisoned".to_string())?;
        let session = lock
            .get_mut(&id)
            .ok_or_else(|| format!("Portal '{id}' not found"))?;
        session.navigate(&url)
    };

    let label = portal_webview_label(&id);
    if let Some(webview) = app.get_webview(&label) {
        if let Ok(parsed) = target_url.parse() {
            let _ = webview.navigate(parsed);
        }
    }

    registry
        .get(&id)
        .ok_or_else(|| format!("Portal '{id}' not found after navigate"))
}

#[tauri::command]
pub fn portal_reload(
    app: AppHandle,
    registry: State<'_, PortalRegistry>,
    id: String,
) -> Result<PortalInfo, String> {
    {
        let mut lock = registry
            .sessions
            .write()
            .map_err(|_| "Registry lock poisoned".to_string())?;
        let session = lock
            .get_mut(&id)
            .ok_or_else(|| format!("Portal '{id}' not found"))?;
        session.reload();
    }

    let label = portal_webview_label(&id);
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.reload();
    }

    registry
        .get(&id)
        .ok_or_else(|| format!("Portal '{id}' not found"))
}

#[tauri::command]
pub fn portal_go_back(
    app: AppHandle,
    registry: State<'_, PortalRegistry>,
    id: String,
) -> Result<PortalInfo, String> {
    let target_url = {
        let mut lock = registry
            .sessions
            .write()
            .map_err(|_| "Registry lock poisoned".to_string())?;
        let session = lock
            .get_mut(&id)
            .ok_or_else(|| format!("Portal '{id}' not found"))?;
        session.go_back()
    };

    if let Some(url) = target_url {
        let label = portal_webview_label(&id);
        if let Some(webview) = app.get_webview(&label) {
            if let Ok(parsed) = url.parse() {
                let _ = webview.navigate(parsed);
            }
        }
    }

    registry
        .get(&id)
        .ok_or_else(|| format!("Portal '{id}' not found"))
}

#[tauri::command]
pub fn portal_go_forward(
    app: AppHandle,
    registry: State<'_, PortalRegistry>,
    id: String,
) -> Result<PortalInfo, String> {
    let target_url = {
        let mut lock = registry
            .sessions
            .write()
            .map_err(|_| "Registry lock poisoned".to_string())?;
        let session = lock
            .get_mut(&id)
            .ok_or_else(|| format!("Portal '{id}' not found"))?;
        session.go_forward()
    };

    if let Some(url) = target_url {
        let label = portal_webview_label(&id);
        if let Some(webview) = app.get_webview(&label) {
            if let Ok(parsed) = url.parse() {
                let _ = webview.navigate(parsed);
            }
        }
    }

    registry
        .get(&id)
        .ok_or_else(|| format!("Portal '{id}' not found"))
}

#[tauri::command]
pub fn portal_inspect(
    registry: State<'_, PortalRegistry>,
    id: String,
) -> Result<PortalInfo, String> {
    registry
        .get(&id)
        .ok_or_else(|| format!("Portal '{id}' not found"))
}

#[tauri::command]
pub fn portal_list(registry: State<'_, PortalRegistry>) -> Result<Vec<PortalInfo>, String> {
    Ok(registry.list())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_url_formats_correctly() {
        assert_eq!(sanitize_url("  example.com "), "https://example.com");
        assert_eq!(sanitize_url("http://local.test"), "http://local.test");
        assert_eq!(sanitize_url("https://secure.test"), "https://secure.test");
        assert_eq!(sanitize_url("about:blank"), "about:blank");
        assert_eq!(sanitize_url(""), "about:blank");
    }

    #[test]
    fn portal_session_history_navigation() {
        let mut session = PortalSession::new(
            "p1".to_string(),
            "Main Portal".to_string(),
            "example.com".to_string(),
        );

        assert_eq!(session.current_url, "https://example.com");
        assert_eq!(session.history_index, 0);

        session.navigate("google.com");
        assert_eq!(session.current_url, "https://google.com");
        assert_eq!(session.history_index, 1);

        session.go_back();
        assert_eq!(session.current_url, "https://example.com");
        assert_eq!(session.history_index, 0);

        session.go_forward();
        assert_eq!(session.current_url, "https://google.com");
        assert_eq!(session.history_index, 1);

        session.navigate("rust-lang.org");
        assert_eq!(session.current_url, "https://rust-lang.org");
        assert_eq!(session.history.len(), 3);
    }

    #[test]
    fn portal_registry_crud() {
        let registry = PortalRegistry::new();
        let info = registry.register(
            "p100".to_string(),
            "Test Portal".to_string(),
            "https://test.com".to_string(),
        );

        assert_eq!(info.id, "p100");
        assert_eq!(info.current_url, "https://test.com");

        assert!(registry.get("p100").is_some());
        assert_eq!(registry.list().len(), 1);

        registry.update_page_meta(
            "p100",
            Some("https://test.com/page2".to_string()),
            Some("Page 2 Title".to_string()),
        );

        let updated = registry.get("p100").unwrap();
        assert_eq!(updated.current_url, "https://test.com/page2");
        assert_eq!(updated.title.as_deref(), Some("Page 2 Title"));

        assert!(registry.unregister("p100"));
        assert!(registry.get("p100").is_none());
    }

    #[test]
    fn webview_label_uses_canvas_portal_id() {
        assert_eq!(portal_webview_label("8f0e"), "portal:8f0e");
    }
}
