//! Deterministic Windows Native Harness Quality Gate.
//!
//! Validates the critical Windows backend flow with real native components
//! without requiring UI Automation or a WebView2 GUI window:
//! 1. Multiple ConPTY sessions (real shell execution, input, dynamic evaluated output, resize, stop_all).
//! 2. Real MAESTRI_TOKEN capture from ConPTY process environment, strict 64-hex regex validation,
//!    valid credential assertion, and cross-session token spoofing rejection.
//! 3. Access graph topology, node registration, and action authorization.
//! 4. Maestro command payload validation contract and AccessGraph authorization contract.

#[cfg(test)]
mod tests {
    use crate::access_graph::{AccessAction, AccessGraph, GraphNode, NodeId, NodeType};
    use crate::maestro::{
        new_request_id, MaestroCommand, MaestroConnectPayload, MaestroDismissPayload,
        MaestroRecruitPayload, MaestroRolePayload,
    };
    use crate::terminal::TerminalRegistry;

    fn is_valid_ipc_token(token: &str) -> bool {
        token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit())
    }

    fn extract_ipc_token(output: &str, prefix: &str) -> Option<String> {
        output.lines().find_map(|line| {
            if let Some((_, val)) = line.split_once(prefix) {
                let trimmed = val.trim();
                if is_valid_ipc_token(trimmed) {
                    return Some(trimmed.to_string());
                }
            }
            None
        })
    }

    #[test]
    fn test_native_harness_token_parser_helper_pure() {
        let mock_output = "PS C:\\> Write-Output (\"TOKEN_A:\" + $env:MAESTRI_TOKEN)\r\nTOKEN_A:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\r\nPS C:\\>";
        let token = extract_ipc_token(mock_output, "TOKEN_A:");
        assert_eq!(
            token.as_deref(),
            Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
        );

        let invalid_output = "PS C:\\> Write-Output (\"TOKEN_A:\" + $env:MAESTRI_TOKEN)\r\nTOKEN_A:invalid_token_format\r\n";
        assert_eq!(extract_ipc_token(invalid_output, "TOKEN_A:"), None);
    }

    #[test]
    fn test_native_harness_multiple_conpty_input_output_resize_stop_all() {
        let registry = TerminalRegistry::new();

        #[cfg(windows)]
        {
            let app = tauri::test::mock_app();
            // Spawn Session 1 (Manager terminal) with real ConPTY
            let mgr_info = crate::terminal::terminal_create_for_test(
                app.handle().clone(),
                &registry,
                "manager-term-1".to_string(),
                80,
                24,
                None,
                Some("powershell.exe".to_string()),
                None,
                None,
                None,
            )
            .expect("Failed to create Manager ConPTY session");

            assert_eq!(mgr_info.id, "manager-term-1");
            assert_eq!(mgr_info.cols, 80);
            assert_eq!(mgr_info.rows, 24);
            assert_eq!(mgr_info.state, "running");

            // Spawn Session 2 (Worker terminal) with real ConPTY
            let wrk_info = crate::terminal::terminal_create_for_test(
                app.handle().clone(),
                &registry,
                "worker-term-1".to_string(),
                80,
                24,
                None,
                Some("powershell.exe".to_string()),
                None,
                None,
                None,
            )
            .expect("Failed to create Worker ConPTY session");

            assert_eq!(wrk_info.id, "worker-term-1");

            // Verify registry lists both active sessions
            let active = registry.list().expect("Failed to list active sessions");
            assert_eq!(active.len(), 2, "Registry must contain exactly 2 active ConPTY sessions");
            assert!(active.iter().any(|s| s.id == "manager-term-1"));
            assert!(active.iter().any(|s| s.id == "worker-term-1"));

            // Input & Output Test on Manager ConPTY using dynamic shell evaluation (prevents false green from input echo)
            // Input string sent: Write-Output ("MGR_EVAL_" + (40 + 2))
            // Evaluated output string produced by shell: MGR_EVAL_42
            registry
                .write_to("manager-term-1", "Write-Output (\"MGR_EVAL_\" + (40 + 2))\r\n")
                .expect("Failed to write input to Manager ConPTY");

            let mut mgr_matched = false;
            let start = std::time::Instant::now();
            while start.elapsed() < std::time::Duration::from_secs(5) {
                if let Ok(output) = registry.recent_output("manager-term-1") {
                    if output.contains("MGR_EVAL_42") {
                        mgr_matched = true;
                        break;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            assert!(mgr_matched, "Manager ConPTY output must contain dynamically evaluated stdout 'MGR_EVAL_42' (not input echo)");

            // Input & Output Test on Worker ConPTY using dynamic shell evaluation
            // Input string sent: Write-Output ("WRK_EVAL_" + (90 + 9))
            // Evaluated output string produced by shell: WRK_EVAL_99
            registry
                .write_to("worker-term-1", "Write-Output (\"WRK_EVAL_\" + (90 + 9))\r\n")
                .expect("Failed to write input to Worker ConPTY");

            let mut wrk_matched = false;
            let start = std::time::Instant::now();
            while start.elapsed() < std::time::Duration::from_secs(5) {
                if let Ok(output) = registry.recent_output("worker-term-1") {
                    if output.contains("WRK_EVAL_99") {
                        wrk_matched = true;
                        break;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            assert!(wrk_matched, "Worker ConPTY output must contain dynamically evaluated stdout 'WRK_EVAL_99' (not input echo)");

            // Resize Test
            let resized_mgr = crate::terminal::terminal_resize_for_test(
                &registry,
                "manager-term-1".to_string(),
                120,
                40,
            )
            .expect("Failed to resize Manager ConPTY");
            assert_eq!(resized_mgr.cols, 120);
            assert_eq!(resized_mgr.rows, 40);

            let resized_wrk = crate::terminal::terminal_resize_for_test(
                &registry,
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
            let app = tauri::test::mock_app();
            // Spawn Session A
            let _mgr_info = crate::terminal::terminal_create_for_test(
                app.handle().clone(),
                &registry,
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

            // Spawn Session B
            let _wrk_info = crate::terminal::terminal_create_for_test(
                app.handle().clone(),
                &registry,
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

            // Echo MAESTRI_TOKEN from inside Session A ConPTY
            registry
                .write_to("session-a", "Write-Output (\"TOKEN_A:\" + $env:MAESTRI_TOKEN)\r\n")
                .expect("Failed to write token echo to session-a");

            let mut token_a = String::new();
            let start = std::time::Instant::now();
            while start.elapsed() < std::time::Duration::from_secs(5) {
                if let Ok(output) = registry.recent_output("session-a") {
                    if let Some(t) = extract_ipc_token(&output, "TOKEN_A:") {
                        token_a = t;
                        break;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }

            // Echo MAESTRI_TOKEN from inside Session B ConPTY
            registry
                .write_to("session-b", "Write-Output (\"TOKEN_B:\" + $env:MAESTRI_TOKEN)\r\n")
                .expect("Failed to write token echo to session-b");

            let mut token_b = String::new();
            let start = std::time::Instant::now();
            while start.elapsed() < std::time::Duration::from_secs(5) {
                if let Ok(output) = registry.recent_output("session-b") {
                    if let Some(t) = extract_ipc_token(&output, "TOKEN_B:") {
                        token_b = t;
                        break;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }

            // Strict 64-hex regex validation on captured tokens
            assert!(
                is_valid_ipc_token(&token_a),
                "Captured token_a from ConPTY session-a must be a valid 64-hex string"
            );
            assert!(
                is_valid_ipc_token(&token_b),
                "Captured token_b from ConPTY session-b must be a valid 64-hex string"
            );
            assert_ne!(token_a, token_b, "ConPTY session tokens must be unique per session");

            // Assert valid credentials for session-a
            let auth_a = registry.validate_ipc_credentials("session-a", &token_a);
            assert!(auth_a.is_ok(), "Valid token_a captured from ConPTY must authenticate session-a");

            // Assert valid credentials for session-b
            let auth_b = registry.validate_ipc_credentials("session-b", &token_b);
            assert!(auth_b.is_ok(), "Valid token_b captured from ConPTY must authenticate session-b");

            // Assert invalid credentials rejected
            assert!(
                registry.validate_ipc_credentials("session-a", "invalid_token_xyz").is_err(),
                "Invalid credential must be rejected"
            );

            // Cross-session token spoofing: passing token_b to session-a MUST be rejected
            let cross_spoof = registry.validate_ipc_credentials("session-a", &token_b);
            assert!(
                cross_spoof.is_err(),
                "Cross-session token spoofing (token_b on session-a) must be rejected"
            );

            registry.stop_all();
        }

        #[cfg(not(windows))]
        {
            assert!(registry.validate_ipc_credentials("session-a", "token").is_err());
        }
    }

    #[test]
    fn test_native_harness_maestro_command_payload_and_access_graph_contract() {
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

        // 3. Maestro Recruit Command Payload Validation Contract
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

        // 4. Maestro Connect Command Payload Validation Contract & Graph Edge Creation
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

        // 5. Maestro Role Command Payload Validation Contract
        let role_cmd = MaestroCommand::Role(MaestroRolePayload {
            request_id: new_request_id(),
            source_terminal_id: manager_id.to_string(),
            target_terminal_id: worker_id.to_string(),
            role: "lead-builder".to_string(),
            instructions: Some("Execute native harness contract verification".to_string()),
            color: None,
        });
        role_cmd.validate().expect("Role command payload validation failed");

        // 6. Maestro Dismiss Command Payload Validation Contract & Graph Removal
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
