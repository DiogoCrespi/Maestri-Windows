mod access_graph;
mod filesystem;
mod floors;
mod ipc;
mod maestro;
mod native_harness;
mod notes;
mod portal;
mod portal_automation;
mod portal_capture;
mod routine_commands;
mod routine_runtime;
mod routines;
mod scrollback;
mod shells;
mod terminal;
mod workspace;

use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use access_graph::{AccessAction, AccessGraph, GraphNode, NodeType};
use ipc::{IpcBackend, IpcServer};
use maestro::{classify_connection_type, parse_strict_ack_context, MaestroBridge, MaestroCommand};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager, RunEvent};
use terminal::TerminalRegistry;

const APP_READY_EVENT: &str = "app://ready";

pub struct AppState {
    terminal: TerminalRegistry,
    ipc: Mutex<Option<IpcServer>>,
    maestro_listener: tauri::EventId,
}

impl AppState {
    fn shutdown(&self, app: &AppHandle) {
        app.unlisten(self.maestro_listener);
        self.terminal.stop_all();
        if let Ok(mut server) = self.ipc.lock() {
            if let Some(server) = server.take() {
                server.shutdown();
            }
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyPayload {
    version: &'static str,
    platform: &'static str,
    ipc_endpoint: String,
}

#[derive(Clone)]
struct TerminalIpcBackend {
    app: AppHandle,
    terminals: TerminalRegistry,
    access_graph: AccessGraph,
    portals: portal::PortalRegistry,
    routine_runtime: Arc<routine_runtime::RoutineRuntime>,
    maestro: MaestroBridge,
}

impl TerminalIpcBackend {
    fn validate_origin(&self, terminal_id: &str) -> Result<(), String> {
        self.terminals
            .recent_output(terminal_id)
            .map(|_| ())
            .map_err(|_| "error: unknown source terminal".to_string())?;
        let node = self
            .access_graph
            .resolve(terminal_id)
            .map_err(|_| "error: unknown source terminal".to_string())?;
        if node.node_type != NodeType::Terminal {
            return Err("error: source must be a terminal".to_string());
        }
        Ok(())
    }

    fn authorize_target(
        &self,
        terminal_id: &str,
        action: AccessAction,
        agent: &str,
    ) -> Result<GraphNode, String> {
        self.validate_origin(terminal_id)?;
        self.access_graph
            .authorize(terminal_id, action, agent)
            .map_err(|error| match error {
                access_graph::AccessGraphError::TargetTypeNotAllowed { .. } => {
                    format!("error: {error}")
                }
                _ => format!("error: agent '{agent}' not found in connections"),
            })
    }

    fn authorize_portal(
        &self,
        terminal_id: &str,
        action: AccessAction,
        portal_name: &str,
    ) -> Result<GraphNode, String> {
        let target = self.authorize_target(terminal_id, action, portal_name)?;
        if target.node_type != NodeType::Portal {
            return Err(format!("error: target '{portal_name}' is not a portal"));
        }
        if self.portals.get(target.id.as_str()).is_none() {
            return Err(format!("error: portal '{portal_name}' is not registered"));
        }
        Ok(target)
    }

    fn authorize_maestro_origin(&self, terminal_id: &str) -> Result<GraphNode, String> {
        let active = self
            .terminals
            .list()
            .map_err(|_| "error: cannot inspect active terminals".to_string())?
            .into_iter()
            .any(|terminal| {
                terminal.id.eq_ignore_ascii_case(terminal_id) && terminal.state == "running"
            });
        if !active {
            return Err("error: source terminal is not active".to_string());
        }
        self.access_graph
            .authorize_manager(terminal_id)
            .map_err(|error| format!("error: {error}"))
    }

    fn canonicalize_maestro_command(
        &self,
        manager: &GraphNode,
        command: MaestroCommand,
    ) -> Result<MaestroCommand, String> {
        canonicalize_maestro_command(&self.access_graph, manager, command)
    }
}

impl IpcBackend for TerminalIpcBackend {
    fn authenticate(&self, terminal_id: &str, credential: &str) -> Result<(), String> {
        self.terminals
            .validate_ipc_credentials(terminal_id, credential)
    }

    fn list(&self, terminal_id: &str) -> String {
        if let Err(error) = self.validate_origin(terminal_id) {
            return error;
        }
        let targets = match self.access_graph.list_targets(terminal_id) {
            Ok(targets) => targets,
            Err(error) => return format!("error: {error}"),
        };
        let terminals = match self.terminals.list() {
            Ok(terminals) => terminals,
            Err(_) => Vec::new(),
        };

        targets
            .into_iter()
            .map(|target| match target.node_type {
                access_graph::NodeType::Terminal => {
                    let state = terminals
                        .iter()
                        .find(|t| t.id.eq_ignore_ascii_case(target.id.as_str()))
                        .map(|t| t.state.as_str())
                        .unwrap_or("disconnected");
                    format!("{}\t[terminal]\t{}", target.name, state)
                }
                access_graph::NodeType::Note => {
                    format!("{}\t[note]\tready", target.name)
                }
                access_graph::NodeType::Portal => {
                    format!("{}\t[portal]\tready", target.name)
                }
                access_graph::NodeType::Other => {
                    format!("{}\t[node]\tready", target.name)
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn check(&self, terminal_id: &str, agent: &str, lines: usize) -> String {
        let target = match self.authorize_target(terminal_id, AccessAction::Check, agent) {
            Ok(target) => target,
            Err(error) => return error,
        };
        match self.terminals.recent_output(target.id.as_str()) {
            Ok(output) => output
                .lines()
                .rev()
                .take(lines.clamp(1, 5_000))
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<Vec<_>>()
                .join("\n"),
            Err(_) => format!("error: terminal '{agent}' not found"),
        }
    }

    fn ask(&self, terminal_id: &str, agent: &str, prompt: &str) -> String {
        let target = match self.authorize_target(terminal_id, AccessAction::Ask, agent) {
            Ok(target) => target,
            Err(error) => return error,
        };
        let line = format!("{prompt}\r");
        match self.terminals.write_to(target.id.as_str(), &line) {
            Ok(()) => format!("sent to {agent}"),
            Err(_) => format!("error: terminal '{agent}' not found"),
        }
    }

    fn note_read(&self, terminal_id: &str, note_name: &str) -> String {
        let target_node =
            match self.authorize_target(terminal_id, AccessAction::NoteRead, note_name) {
                Ok(target) => target,
                Err(error) => return error,
            };
        let resource_path = match authorized_note_path(&target_node, note_name) {
            Ok(path) => path,
            Err(error) => return error,
        };
        let workspace_root = match self.routine_runtime.workspace_root() {
            Ok(root) => root,
            Err(_) => return "error: workspace not confirmed or loaded".to_string(),
        };
        let root_str = workspace_root.to_string_lossy();
        match notes::note_read_scoped(&root_str, &resource_path) {
            Ok(content) => content,
            Err(err) => format!("error: failed to read note '{note_name}': {err}"),
        }
    }

    fn note_write(&self, terminal_id: &str, note_name: &str, content: &str) -> String {
        let target_node =
            match self.authorize_target(terminal_id, AccessAction::NoteWrite, note_name) {
                Ok(target) => target,
                Err(error) => return error,
            };
        let resource_path = match authorized_note_path(&target_node, note_name) {
            Ok(path) => path,
            Err(error) => return error,
        };
        let workspace_root = match self.routine_runtime.workspace_root() {
            Ok(root) => root,
            Err(_) => return "error: workspace not confirmed or loaded".to_string(),
        };
        let root_str = workspace_root.to_string_lossy();
        match notes::note_save_scoped(&root_str, &resource_path, content) {
            Ok(()) => format!("note '{note_name}' saved"),
            Err(err) => format!("error: failed to write note '{note_name}': {err}"),
        }
    }

    fn portal_inspect(&self, terminal_id: &str, portal_name: &str) -> String {
        let target_node =
            match self.authorize_portal(terminal_id, AccessAction::PortalInspect, portal_name) {
                Ok(target) => target,
                Err(error) => return error,
            };
        let script = portal_automation::build_inspect_js();
        execute_portal_js(&self.app, &target_node.id.as_str(), &script)
    }

    fn portal_click(&self, terminal_id: &str, portal_name: &str, selector: &str) -> String {
        let target_node =
            match self.authorize_portal(terminal_id, AccessAction::PortalClick, portal_name) {
                Ok(target) => target,
                Err(error) => return error,
            };
        let script = match portal_automation::build_click_js(selector) {
            Ok(s) => s,
            Err(e) => return format!("error: {e}"),
        };
        execute_portal_js(&self.app, &target_node.id.as_str(), &script)
    }

    fn portal_fill(
        &self,
        terminal_id: &str,
        portal_name: &str,
        selector: &str,
        text: &str,
    ) -> String {
        let target_node =
            match self.authorize_portal(terminal_id, AccessAction::PortalFill, portal_name) {
                Ok(target) => target,
                Err(error) => return error,
            };
        let script = match portal_automation::build_fill_js(selector, text) {
            Ok(s) => s,
            Err(e) => return format!("error: {e}"),
        };
        execute_portal_js(&self.app, &target_node.id.as_str(), &script)
    }

    fn portal_eval(&self, terminal_id: &str, portal_name: &str, script: &str) -> String {
        let target_node =
            match self.authorize_portal(terminal_id, AccessAction::PortalEval, portal_name) {
                Ok(target) => target,
                Err(error) => return error,
            };
        let eval_script = match portal_automation::build_eval_js(script) {
            Ok(s) => s,
            Err(e) => return format!("error: {e}"),
        };
        execute_portal_js(&self.app, &target_node.id.as_str(), &eval_script)
    }

    fn portal_navigate(&self, terminal_id: &str, portal_name: &str, url: &str) -> String {
        let target_node =
            match self.authorize_portal(terminal_id, AccessAction::PortalNavigate, portal_name) {
                Ok(target) => target,
                Err(error) => return error,
            };
        if url.as_bytes().len() > portal_automation::MAX_SCRIPT_BYTES {
            return format!(
                "error: URL size exceeds {} bytes",
                portal_automation::MAX_SCRIPT_BYTES
            );
        }
        let portal_id = target_node.id.as_str();
        let label = portal::portal_webview_label(portal_id);
        if let Some(webview) = self.app.get_webview(&label) {
            let sanitized = portal::sanitize_url(url);
            if let Ok(parsed) = sanitized.parse() {
                let _ = webview.navigate(parsed);
                self.portals
                    .update_page_meta(portal_id, Some(sanitized.clone()), None);
                return format!("navigated to {sanitized}");
            }
        }
        format!("error: failed to navigate portal '{portal_name}'")
    }

    fn portal_screenshot(
        &self,
        terminal_id: &str,
        portal_name: &str,
        output: Option<&str>,
    ) -> String {
        let target_node =
            match self.authorize_portal(terminal_id, AccessAction::PortalInspect, portal_name) {
                Ok(target) => target,
                Err(error) => return error,
            };
        let portal_id = target_node.id.to_string();
        let output = output
            .map(|path| portal_capture::CaptureOutput::Png(PathBuf::from(path)))
            .unwrap_or(portal_capture::CaptureOutput::Temporary);
        let request = portal_capture::CaptureRequest::for_portal(portal_id.clone(), output);
        let label = portal::portal_webview_label(&portal_id);
        let webview = match self.app.get_webview(&label) {
            Some(webview) => webview,
            None => {
                return format!("error: webview for portal '{portal_name}' not found or active")
            }
        };

        #[cfg(windows)]
        {
            match portal_capture::capture_webview(
                &webview,
                request,
                Duration::from_millis(portal_capture::DEFAULT_CAPTURE_TIMEOUT_MS),
                portal_capture::CaptureLimits::default(),
            ) {
                Ok(result) => result.path.display().to_string(),
                Err(error) => format!("error: {error}"),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (webview, request);
            "error: portal screenshot is only supported on Windows WebView2".to_string()
        }
    }

    fn maestro(&self, terminal_id: &str, command: MaestroCommand) -> String {
        let manager = match self.authorize_maestro_origin(terminal_id) {
            Ok(manager) => manager,
            Err(error) => return error,
        };
        let command = match self.canonicalize_maestro_command(&manager, command) {
            Ok(command) => command,
            Err(error) => return error,
        };
        match self.maestro.dispatch(command) {
            Ok(result) if result.success => serde_json::to_string(&result)
                .unwrap_or_else(|_| "Maestro action accepted".to_string()),
            Ok(result) => format!(
                "error: {}",
                result
                    .error
                    .unwrap_or_else(|| "Maestro action rejected".to_string())
            ),
            Err(error) => format!("error: {error}"),
        }
    }
}

fn authorized_note_path(node: &GraphNode, note_name: &str) -> Result<String, String> {
    if node.node_type != NodeType::Note {
        return Err(format!("error: target '{note_name}' is not a note"));
    }
    node.resource_path
        .clone()
        .ok_or_else(|| format!("error: note '{note_name}' has no authorized path"))
}

fn node_type_name(node_type: NodeType) -> &'static str {
    match node_type {
        NodeType::Terminal => "terminal",
        NodeType::Note => "note",
        NodeType::Portal => "portal",
        NodeType::Other => "other",
    }
}

fn canonicalize_maestro_command(
    access_graph: &AccessGraph,
    manager: &GraphNode,
    mut command: MaestroCommand,
) -> Result<MaestroCommand, String> {
    let actor = access_graph
        .resolve(command.actor_terminal_id())
        .map_err(|error| format!("error: invalid Maestro actor: {error}"))?;
    if actor.id != manager.id {
        return Err("error: Maestro actor must match MAESTRI_TERMINAL_ID".to_string());
    }
    command.canonicalize_actor(manager.id.to_string());

    match command.clone() {
        MaestroCommand::Dismiss(payload) => {
            let target = access_graph
                .resolve(&payload.target_terminal_id)
                .map_err(|error| format!("error: invalid dismiss target: {error}"))?;
            if target.node_type != NodeType::Terminal {
                return Err("error: dismiss target must be a terminal".to_string());
            }
            if target.id == manager.id {
                return Err("error: a Manager terminal cannot dismiss itself".to_string());
            }
            command.canonicalize_dismiss_target(target.id.to_string());
        }
        MaestroCommand::Role(payload) => {
            let target = access_graph
                .resolve(&payload.target_terminal_id)
                .map_err(|error| format!("error: invalid role target: {error}"))?;
            if target.node_type != NodeType::Terminal {
                return Err("error: role target must be a terminal".to_string());
            }
            command.canonicalize_role_target(target.id.to_string());
        }
        MaestroCommand::Connect(payload) => {
            let source_ref = if payload.source_id.trim().is_empty() {
                payload.actor_terminal_id.as_str()
            } else {
                payload.source_id.as_str()
            };
            let (source, target) = access_graph
                .canonicalize_connection(source_ref, &payload.target_id)
                .map_err(|error| format!("error: invalid connection endpoints: {error}"))?;
            let connection_type = classify_connection_type(
                node_type_name(source.node_type),
                node_type_name(target.node_type),
            )
            .ok_or_else(|| {
                format!(
                    "error: incompatible connection types {:?} and {:?}",
                    source.node_type, target.node_type
                )
            })?;
            command.canonicalize_connect(
                manager.id.to_string(),
                source.id.to_string(),
                target.id.to_string(),
                connection_type,
            );
        }
        MaestroCommand::Recruit(_) => {}
    }
    Ok(command)
}

fn execute_portal_js(app: &AppHandle, portal_id: &str, script: &str) -> String {
    if script.as_bytes().len() > portal_automation::MAX_SCRIPT_BYTES {
        return format!(
            "error: script size exceeds {} bytes",
            portal_automation::MAX_SCRIPT_BYTES
        );
    }
    let label = portal::portal_webview_label(portal_id);
    let webview = match app.get_webview(&label) {
        Some(w) => w,
        None => return format!("error: webview for portal '{portal_id}' not found or active"),
    };

    let (sender, receiver) = mpsc::channel::<String>();
    if let Err(error) = webview.eval_with_callback(script.to_owned(), move |value: String| {
        let _ = sender.send(value);
    }) {
        return format!("error: script execution failed: {error}");
    }
    match receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(value) => portal_automation::limit_response_body(value),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            "error: portal script timed out after 5 seconds".to_string()
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            "error: portal script callback disconnected".to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_path_is_taken_from_resource_metadata_not_node_identity() {
        let node = GraphNode::new_with_type_and_resource(
            access_graph::NodeId::new("00000000-0000-0000-0000-000000000001").unwrap(),
            "Design",
            NodeType::Note,
            Some(r"notes/project.md".to_owned()),
        )
        .unwrap();
        assert_eq!(
            authorized_note_path(&node, "Design").unwrap(),
            r"notes/project.md"
        );
        assert_ne!(authorized_note_path(&node, "Design").unwrap(), "Design");
    }

    #[test]
    fn note_label_design_resolves_to_authorized_resource_path_project_md() {
        let temp_dir = std::env::temp_dir().join("maestri_label_test");
        let notes_dir = temp_dir.join("notes");
        std::fs::create_dir_all(&notes_dir).unwrap();

        let runtime = Arc::new(routine_runtime::RoutineRuntime::new(
            Arc::new(routine_runtime::SystemClock),
            None,
        ));
        runtime.set_workspace(Some(&temp_dir)).unwrap();

        let access_graph = AccessGraph::new();
        let term_id = "00000000-0000-0000-0000-000000000100";
        let note_id = "00000000-0000-0000-0000-000000000101";

        let term_node = GraphNode::new_with_type_and_resource(
            access_graph::NodeId::new(term_id).unwrap(),
            "WorkerTerm",
            NodeType::Terminal,
            None,
        )
        .unwrap();

        let note_node = GraphNode::new_with_type_and_resource(
            access_graph::NodeId::new(note_id).unwrap(),
            "Design", // Display Label is "Design"
            NodeType::Note,
            Some("project.md".to_string()), // Authorized resourcePath below notes/ is "project.md"
        )
        .unwrap();

        access_graph.upsert_node(term_node).unwrap();
        access_graph.upsert_node(note_node).unwrap();
        access_graph.connect(term_id, note_id).unwrap();

        // Directly test authorized_note_path and scoped resolution logic
        let target_node = access_graph
            .authorize(term_id, AccessAction::NoteWrite, "Design")
            .unwrap();
        let resource_path = authorized_note_path(&target_node, "Design").unwrap();
        assert_eq!(resource_path, "project.md");

        let ws_root = runtime.workspace_root().unwrap();
        let root_str = ws_root.to_string_lossy();

        // Write note using authorized resourcePath
        notes::note_save_scoped(&root_str, &resource_path, "Project Content").unwrap();

        // Verify project.md was created and populated, and "Design" file was NOT created
        assert_eq!(
            std::fs::read_to_string(notes_dir.join("project.md")).unwrap(),
            "Project Content"
        );
        assert!(!notes_dir.join("Design").exists());

        // Read note using authorized resourcePath
        let read_content = notes::note_read_scoped(&root_str, &resource_path).unwrap();
        assert_eq!(read_content, "Project Content");

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn note_without_resource_cannot_be_read_or_written() {
        let node = GraphNode::new_with_type(
            access_graph::NodeId::new("00000000-0000-0000-0000-000000000002").unwrap(),
            "Untitled",
            NodeType::Note,
        )
        .unwrap();
        assert!(authorized_note_path(&node, "Untitled").is_err());
    }

    #[test]
    fn maestro_canonicalizes_named_targets_and_arbitrary_connect_endpoints() {
        let graph = AccessGraph::new();
        let manager = GraphNode::new_with_type_and_resource_and_manager(
            access_graph::NodeId::new("00000000-0000-0000-0000-000000000010").unwrap(),
            "Manager",
            NodeType::Terminal,
            None,
            true,
        )
        .unwrap();
        let worker = GraphNode::new_with_type(
            access_graph::NodeId::new("00000000-0000-0000-0000-000000000011").unwrap(),
            "Worker",
            NodeType::Terminal,
        )
        .unwrap();
        let note = GraphNode::new_with_type(
            access_graph::NodeId::new("00000000-0000-0000-0000-000000000012").unwrap(),
            "Design",
            NodeType::Note,
        )
        .unwrap();
        graph.upsert_node(manager.clone()).unwrap();
        graph.upsert_node(worker.clone()).unwrap();
        graph.upsert_node(note.clone()).unwrap();

        let dismissed = canonicalize_maestro_command(
            &graph,
            &manager,
            MaestroCommand::Dismiss(maestro::MaestroDismissPayload {
                request_id: maestro::new_request_id(),
                source_terminal_id: "Manager".to_string(),
                target_terminal_id: "Worker".to_string(),
            }),
        )
        .unwrap();
        if let MaestroCommand::Dismiss(payload) = dismissed {
            assert_eq!(payload.target_terminal_id, worker.id.to_string());
        } else {
            panic!("expected dismiss");
        }

        let connected = canonicalize_maestro_command(
            &graph,
            &manager,
            MaestroCommand::Connect(maestro::MaestroConnectPayload {
                request_id: maestro::new_request_id(),
                actor_terminal_id: "Manager".to_string(),
                source_id: "Worker".to_string(),
                target_id: "Design".to_string(),
                connection_type: None,
            }),
        )
        .unwrap();
        if let MaestroCommand::Connect(payload) = connected {
            assert_eq!(payload.actor_terminal_id, manager.id.to_string());
            assert_eq!(payload.source_id, worker.id.to_string());
            assert_eq!(payload.target_id, note.id.to_string());
            assert_eq!(
                payload.connection_type,
                Some(maestro::MaestroConnectionType::TerminalNote)
            );
        } else {
            panic!("expected connect");
        }
    }

    #[test]
    fn maestro_rejects_self_and_incompatible_connection() {
        let graph = AccessGraph::new();
        let manager = GraphNode::new_with_type_and_resource_and_manager(
            access_graph::NodeId::new("00000000-0000-0000-0000-000000000020").unwrap(),
            "Manager",
            NodeType::Terminal,
            None,
            true,
        )
        .unwrap();
        let note = GraphNode::new_with_type(
            access_graph::NodeId::new("00000000-0000-0000-0000-000000000021").unwrap(),
            "Design",
            NodeType::Note,
        )
        .unwrap();
        let other = GraphNode::new_with_type(
            access_graph::NodeId::new("00000000-0000-0000-0000-000000000022").unwrap(),
            "Other",
            NodeType::Other,
        )
        .unwrap();
        graph.upsert_node(manager.clone()).unwrap();
        graph.upsert_node(note).unwrap();
        graph.upsert_node(other).unwrap();
        let self_edge = MaestroCommand::Connect(maestro::MaestroConnectPayload {
            request_id: maestro::new_request_id(),
            actor_terminal_id: "Manager".to_string(),
            source_id: "Manager".to_string(),
            target_id: "Manager".to_string(),
            connection_type: None,
        });
        assert!(canonicalize_maestro_command(&graph, &manager, self_edge).is_err());
        let incompatible = MaestroCommand::Connect(maestro::MaestroConnectPayload {
            request_id: maestro::new_request_id(),
            actor_terminal_id: "Manager".to_string(),
            source_id: "Design".to_string(),
            target_id: "Other".to_string(),
            connection_type: None,
        });
        assert!(canonicalize_maestro_command(&graph, &manager, incompatible).is_err());
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let terminal = TerminalRegistry::new();
            let portal = portal::PortalRegistry::new();
            let access_graph = AccessGraph::new();
            let maestro = MaestroBridge::new(app.handle().clone());
            let main_window = app.get_webview_window("main").ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "main WebviewWindow is required for strict Maestro ACKs",
                )
            })?;
            let maestro_for_listener = maestro.clone();
            let maestro_listener = main_window.listen("maestro://result", move |event| {
                let Ok(context) = parse_strict_ack_context(event.payload()) else {
                    return;
                };
                let _ =
                    maestro_for_listener.accept_result_json_with_context(event.payload(), context);
            });
            let routine_runtime = Arc::new(routine_runtime::RoutineRuntime::new(
                Arc::new(routine_runtime::SystemClock),
                None,
            ));

            let backend = Arc::new(TerminalIpcBackend {
                app: app.handle().clone(),
                terminals: terminal.clone(),
                access_graph: access_graph.clone(),
                portals: portal.clone(),
                routine_runtime: routine_runtime.clone(),
                maestro,
            });
            let server = IpcServer::bind_loopback(backend)?.start()?;
            let endpoint = server.local_addr().to_string();
            std::env::set_var("MAESTRI_SOCKET", &endpoint);

            let app_handle_for_cb = app.handle().clone();
            let terminal_for_cb = terminal.clone();
            routine_runtime.set_dispatch_callback(move |routine, idempotency_key| {
                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);

                let dispatched_payload = serde_json::json!({
                    "routineId": routine.id,
                    "targetTerminalId": routine.target_terminal_id,
                    "idempotencyKey": idempotency_key,
                    "status": "dispatched",
                    "timestampMs": now_ms,
                    "message": "Routine execution dispatched"
                });
                let _ = app_handle_for_cb.emit("routine://status", dispatched_payload);

                match &routine.action {
                    routines::RoutineAction::Command { .. } => {
                        let active_terminals = terminal_for_cb.list().unwrap_or_default();
                        let target_active = active_terminals
                            .iter()
                            .any(|t| t.id == routine.target_terminal_id && t.state == "running");

                        if !target_active {
                            let fail_payload = serde_json::json!({
                                "routineId": routine.id,
                                "targetTerminalId": routine.target_terminal_id,
                                "idempotencyKey": idempotency_key,
                                "status": "failed",
                                "timestampMs": now_ms,
                                "message": "Target terminal is not active or running"
                            });
                            let _ = app_handle_for_cb.emit("routine://status", fail_payload);
                            return Err("Target terminal is not active or running".to_string());
                        }

                        if let Some(payload_text) = routine.build_command_payload() {
                            if let Err(e) =
                                terminal_for_cb.write_to(&routine.target_terminal_id, &payload_text)
                            {
                                let fail_payload = serde_json::json!({
                                    "routineId": routine.id,
                                    "targetTerminalId": routine.target_terminal_id,
                                    "idempotencyKey": idempotency_key,
                                    "status": "failed",
                                    "timestampMs": now_ms,
                                    "message": e
                                });
                                let _ = app_handle_for_cb.emit("routine://status", fail_payload);
                                return Err(e);
                            }
                        }
                    }
                    routines::RoutineAction::Reminder { reminder } => {
                        if !routine.no_notify {
                            let reminder_payload = serde_json::json!({
                                "routineId": routine.id,
                                "targetTerminalId": routine.target_terminal_id,
                                "idempotencyKey": idempotency_key,
                                "timestampMs": now_ms,
                                "message": reminder
                            });
                            let _ = app_handle_for_cb.emit("routine://reminder", reminder_payload);
                        }
                    }
                }

                if !routine.no_notify {
                    let completed_payload = serde_json::json!({
                        "routineId": routine.id,
                        "targetTerminalId": routine.target_terminal_id,
                        "idempotencyKey": idempotency_key,
                        "status": "completed",
                        "timestampMs": now_ms,
                        "message": "Routine execution completed successfully"
                    });
                    let _ = app_handle_for_cb.emit("routine://status", completed_payload);
                }
                Ok(())
            });

            if let Err(e) = routine_runtime.start(1000) {
                eprintln!("Failed to start routine runtime scheduler: {e}");
            }

            app.manage(terminal.clone());
            app.manage(portal);
            app.manage(access_graph);
            app.manage(routine_runtime.clone());
            app.manage(AppState {
                terminal,
                ipc: Mutex::new(Some(server)),
                maestro_listener,
            });
            app.emit(
                APP_READY_EVENT,
                ReadyPayload {
                    version: env!("CARGO_PKG_VERSION"),
                    platform: "windows",
                    ipc_endpoint: endpoint,
                },
            )?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_stop,
            terminal::terminal_list,
            terminal::terminal_load_scrollback,
            workspace::workspace_load,
            workspace::workspace_path_exists,
            workspace::workspace_save,
            access_graph::access_graph_replace,
            shells::shell_list,
            filesystem::list_directory,
            portal::portal_register,
            portal::portal_unregister,
            portal::portal_navigate,
            portal::portal_reload,
            portal::portal_go_back,
            portal::portal_go_forward,
            portal::portal_inspect,
            portal::portal_list,
            routine_commands::routine_set_workspace,
            routine_commands::routine_list,
            routine_commands::routine_upsert,
            routine_commands::routine_remove,
            routine_commands::routine_set_enabled,
            routine_commands::routine_run_now,
            floors::floor_current_branch,
            floors::floor_create,
            floors::floor_remove,
            floors::floor_run_hooks,
            floors::floor_preview_land,
            floors::floor_land
        ])
        .build(tauri::generate_context!())
        .expect("error while building open-maestri Tauri application")
        .run(|app_handle, event| {
            if matches!(event, RunEvent::Exit) {
                app_handle
                    .state::<Arc<routine_runtime::RoutineRuntime>>()
                    .shutdown();
                app_handle.state::<AppState>().shutdown(app_handle);
            }
        });
}
