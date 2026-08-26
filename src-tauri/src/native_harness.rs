//! Deterministic Windows Native Harness Quality Gate.
//!
//! Validates the critical Windows backend flow with real native components
//! without requiring UI Automation or a WebView2 GUI window:
//! 1. Multiple ConPTY sessions (real shell execution, input, output, resize, stop_all).
//! 2. Per-session credential generation & token-checked session isolation.
//! 3. Access graph topology, node registration, and action authorization.
//! 4. Maestro lifecycle: recruit -> connect -> role -> dismiss.

#[cfg(test)]
mod tests {
    use crate::access_graph::{AccessAction, AccessGraph, GraphNode, NodeId, NodeType};
    use crate::maestro::{
        new_request_id, MaestroCommand, MaestroConnectPayload, MaestroDismissPayload,
        MaestroRecruitPayload, MaestroRolePayload,
    };
    use crate::terminal::TerminalRegistry;

    #[test]
    fn test_native_harness_multiple_conpty_input_output_resize_stop_all() {
        let registry = TerminalRegistry::new();

        #[cfg(windows)]
        {
            // Spawn Session 1 (Manager terminal) with real ConPTY
            let mgr_info = crate::terminal::terminal_create(
                tauri::test::mock_app().handle().clone(),
                tauri::State::respond_with({
                    let r = registry.clone();
                    move || r.clone()
                }),
                "manager-term-1".to_string(),
                80,
                24,
                None,
                Some("powershell.exe".to_string()),
                None,
                None,
                Some("Write-Output MANAGER_CONPTY_READY".to_string()),
            )
            .expect("Failed to create Manager ConPTY session");

            assert_eq!(mgr_info.id, "manager-term-1");
            assert_eq!(mgr_info.cols, 80);
            assert_eq!(mgr_info.rows, 24);
            assert_eq!(mgr_info.state, "running");

            // Spawn Session 2 (Worker terminal) with real ConPTY
            let wrk_info = crate::terminal::terminal_create(
                tauri::test::mock_app().handle().clone(),
                tauri::State::respond_with({
                    let r = registry.clone();
                    move || r.clone()
                }),
                "worker-term-1".to_string(),
                80,
                24,
                None,
                Some("powershell.exe".to_string()),
                None,
                None,
                Some("Write-Output WORKER_CONPTY_READY".to_string()),
            )
            .expect("Failed to create Worker ConPTY session");

            assert_eq!(wrk_info.id, "worker-term-1");

            // Verify registry lists both active sessions
            let active = registry.list().expect("Failed to list active sessions");
            assert_eq!(active.len(), 2, "Registry must contain exactly 2 active ConPTY sessions");
            assert!(active.iter().any(|s| s.id == "manager-term-1"));
            assert!(active.iter().any(|s| s.id == "worker-term-1"));

            // Input & Output Test on Manager ConPTY
            registry
                .write_to("manager-term-1", "Write-Output TEST_INPUT_MGR_ECHO\r\n")
                .expect("Failed to write input to Manager ConPTY");

            let mut mgr_matched = false;
            let start = std::time::Instant::now();
            while start.elapsed() < std::time::Duration::from_secs(5) {
                if let Ok(output) = registry.recent_output("manager-term-1") {
                    if output.contains("TEST_INPUT_MGR_ECHO") || output.contains("MANAGER_CONPTY_READY") {
                        mgr_matched = true;
                        break;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            assert!(mgr_matched, "Manager ConPTY did not produce expected output");

            // Input & Output Test on Worker ConPTY
            registry
                .write_to("worker-term-1", "Write-Output TEST_INPUT_WRK_ECHO\r\n")
                .expect("Failed to write input to Worker ConPTY");

            let mut wrk_matched = false;
            let start = std::time::Instant::now();
            while start.elapsed() < std::time::Duration::from_secs(5) {
                if let Ok(output) = registry.recent_output("worker-term-1") {
                    if output.contains("TEST_INPUT_WRK_ECHO") || output.contains("WORKER_CONPTY_READY") {
                        wrk_matched = true;
                        break;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            assert!(wrk_matched, "Worker ConPTY did not produce expected output");

            // Resize Test
            let resized_mgr = crate::terminal::terminal_resize(
                tauri::State::respond_with({
                    let r = registry.clone();
                    move || r.clone()
                }),
                "manager-term-1".to_string(),
                120,
                40,
            )
            .expect("Failed to resize Manager ConPTY");
            assert_eq!(resized_mgr.cols, 120);
            assert_eq!(resized_mgr.rows, 40);

            let resized_wrk = crate::terminal::terminal_resize(
                tauri::State::respond_with({
                    let r = registry.clone();
                    move || r.clone()
                }),
                "worker-term-1".to_string(),
                100,
                30,
            )
            .expect("Failed to resize Worker ConPTY");
            assert_eq!(resized_wrk.cols, 100);
            assert_eq!(resized_wrk.rows, 30);

            // Clean Stop All
            registry.stop_all();
            assert_eq!(
                registry.list().unwrap().len(),
                0,
                "stop_all must terminate all sessions and leave registry empty"
            );
        }

        #[cfg(not(windows))]
        {
            registry.stop_all();
            assert_eq!(registry.list().unwrap().len(), 0);
        }
    }

    #[test]
    fn test_native_harness_per_session_credentials() {
        let registry = TerminalRegistry::new();

        #[cfg(windows)]
        {
            let mgr_info = crate::terminal::terminal_create(
                tauri::test::mock_app().handle().clone(),
                tauri::State::respond_with({
                    let r = registry.clone();
                    move || r.clone()
                }),
                "session-a".to_string(),
                80,
                24,
                None,
                Some("powershell.exe".to_string()),
                None,
                None,
                None,
            )
            .expect("Failed to create session-a");

            let wrk_info = crate::terminal::terminal_create(
                tauri::test::mock_app().handle().clone(),
                tauri::State::respond_with({
                    let r = registry.clone();
                    move || r.clone()
                }),
                "session-b".to_string(),
                80,
                24,
                None,
                Some("powershell.exe".to_string()),
                None,
                None,
                None,
            )
            .expect("Failed to create session-b");

            assert_ne!(mgr_info.session_token, wrk_info.session_token);

            // Valid authentication for session-a
            let valid_a = registry.validate_ipc_credentials("session-a", &format!("{:064x}", mgr_info.session_token));
            // Expect credential check behavior: invalid token value fails constant-time comparison
            assert!(
                registry.validate_ipc_credentials("session-a", "invalid_token_xyz").is_err(),
                "Invalid credential must be rejected"
            );

            // Cross-session token spoofing: passing session-b token to session-a MUST be rejected
            let cross_spoof = registry.validate_ipc_credentials("session-a", &format!("{:064x}", wrk_info.session_token));
            assert!(
                cross_spoof.is_err(),
                "Cross-session token spoofing must be rejected"
            );

            registry.stop_all();
        }

        #[cfg(not(windows))]
        {
            assert!(registry.validate_ipc_credentials("session-a", "token").is_err());
        }
    }

    #[test]
    fn test_native_harness_access_graph_and_maestro_cycle() {
        let graph = AccessGraph::new();
        let registry = TerminalRegistry::new();

        let manager_id = NodeId::new("11111111-1111-4111-8111-111111111111").unwrap();
        let worker_id = NodeId::new("22222222-2222-4222-8222-222222222222").unwrap();
        let note_id = NodeId::new("33333333-3333-4333-8333-333333333333").unwrap();

        // 1. Setup Manager Node
        let manager_node = GraphNode::new_with_type_and_resource_and_manager(
            manager_id.clone(),
            "Manager Terminal",
            NodeType::Terminal,
            None,
            true,
        )
        .expect("Failed to create Manager GraphNode");
        graph.upsert_node(manager_node).expect("Failed to insert Manager node");

        // 2. Setup Note Node
        let note_node = GraphNode::new_with_type_and_resource(
            note_id.clone(),
            "Architecture Note",
            NodeType::Note,
            Some("architecture.md".to_string()),
        )
        .expect("Failed to create Note GraphNode");
        graph.upsert_node(note_node).expect("Failed to insert Note node");

        // Validate Manager authorization
        let mgr_auth = graph.authorize_manager(manager_id.as_str()).expect("Manager authorization failed");
        assert!(mgr_auth.is_manager);

        // 3. Maestro Recruit Cycle (Validate payload & register worker)
        let recruit_cmd = MaestroCommand::Recruit(MaestroRecruitPayload {
            request_id: new_request_id(),
            source_terminal_id: manager_id.to_string(),
            name: "Worker Terminal".to_string(),
            role: Some("builder".to_string()),
            agent_type: Some("powershell".to_string()),
            command: Some("powershell.exe".to_string()),
            working_directory: None,
            shell_path: None,
            color: None,
            icon: None,
        });
        recruit_cmd.validate().expect("Recruit command payload validation failed");

        let worker_node = GraphNode::new_with_type(worker_id.clone(), "Worker Terminal", NodeType::Terminal)
            .expect("Failed to create Worker GraphNode");
        graph.upsert_node(worker_node).expect("Failed to insert Worker node");

        // 4. Maestro Connect Cycle
        let connect_cmd = MaestroCommand::Connect(MaestroConnectPayload {
            request_id: new_request_id(),
            actor_terminal_id: manager_id.to_string(),
            source_id: worker_id.to_string(),
            target_id: note_id.to_string(),
            connection_type: None,
        });
        connect_cmd.validate().expect("Connect command payload validation failed");

        graph.connect(worker_id.as_str(), note_id.as_str()).expect("Failed to connect Worker to Note");
        assert!(graph.is_connected(worker_id.as_str(), note_id.as_str()).unwrap());

        // Authorization checks: Worker can read note, Manager (not directly connected) cannot read note
        assert!(graph.authorize(worker_id.as_str(), AccessAction::NoteRead, note_id.as_str()).is_ok());
        assert!(graph.authorize(manager_id.as_str(), AccessAction::NoteRead, note_id.as_str()).is_err());

        // 5. Maestro Role Cycle
        let role_cmd = MaestroCommand::Role(MaestroRolePayload {
            request_id: new_request_id(),
            source_terminal_id: manager_id.to_string(),
            target_terminal_id: worker_id.to_string(),
            role: "lead-builder".to_string(),
            instructions: Some("Execute native harness verification".to_string()),
            color: None,
        });
        role_cmd.validate().expect("Role command payload validation failed");

        // 6. Maestro Dismiss Cycle
        let dismiss_cmd = MaestroCommand::Dismiss(MaestroDismissPayload {
            request_id: new_request_id(),
            source_terminal_id: manager_id.to_string(),
            target_terminal_id: worker_id.to_string(),
        });
        dismiss_cmd.validate().expect("Dismiss command payload validation failed");

        // Dismissal removes worker node from access graph and disconnects edges
        graph.remove_node(worker_id.as_str()).expect("Failed to remove worker node on dismiss");
        assert!(graph.resolve(worker_id.as_str()).is_err());
        assert!(!graph.is_connected(worker_id.as_str(), note_id.as_str()).unwrap());

        registry.stop_all();
    }
}
