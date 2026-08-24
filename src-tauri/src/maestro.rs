//! Pure Maestro command contract.
//!
//! Maestro wire types, validation and the Tauri event/ACK bridge.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub const MAX_NAME_CHARS: usize = 128;
pub const MAX_ROLE_CHARS: usize = 64;
pub const MAX_INSTRUCTIONS_CHARS: usize = 8_192;
pub const MAX_ID_CHARS: usize = 128;
pub const ACK_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_PENDING_ACKS_GLOBAL: usize = 256;
pub const MAX_PENDING_ACKS_PER_ACTOR: usize = 32;

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MaestroAction {
    Recruit,
    Dismiss,
    Connect,
    Role,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MaestroConnectionType {
    #[serde(rename = "terminal")]
    Terminal,
    #[serde(rename = "terminal-note")]
    TerminalNote,
    #[serde(rename = "terminal-portal")]
    TerminalPortal,
    #[serde(rename = "note-note")]
    NoteNote,
    #[serde(rename = "portal-portal")]
    PortalPortal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaestroRecruitPayload {
    pub request_id: String,
    pub source_terminal_id: String,
    pub name: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub agent_type: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub working_directory: Option<String>,
    #[serde(default)]
    pub shell_path: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaestroDismissPayload {
    pub request_id: String,
    pub source_terminal_id: String,
    pub target_terminal_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaestroConnectPayload {
    pub request_id: String,
    /// The active Manager terminal authorizing the operation.
    #[serde(default, alias = "sourceTerminalId")]
    pub actor_terminal_id: String,
    /// The first graph endpoint. This is not the actor unless the caller
    /// explicitly chooses the Manager as an endpoint.
    #[serde(default)]
    pub source_id: String,
    pub target_id: String,
    #[serde(default)]
    pub connection_type: Option<MaestroConnectionType>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaestroRolePayload {
    pub request_id: String,
    pub source_terminal_id: String,
    pub target_terminal_id: String,
    pub role: String,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
}

/// Future event envelope. Current Tauri listeners still use one payload per
/// event (`maestro://recruit`, etc.); this tagged form is the backend-facing
/// representation for a later unified command entry point.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", content = "payload", rename_all = "camelCase")]
pub enum MaestroCommand {
    Recruit(MaestroRecruitPayload),
    Dismiss(MaestroDismissPayload),
    Connect(MaestroConnectPayload),
    Role(MaestroRolePayload),
}

impl MaestroCommand {
    pub fn action(&self) -> MaestroAction {
        match self {
            Self::Recruit(_) => MaestroAction::Recruit,
            Self::Dismiss(_) => MaestroAction::Dismiss,
            Self::Connect(_) => MaestroAction::Connect,
            Self::Role(_) => MaestroAction::Role,
        }
    }

    pub fn request_id(&self) -> &str {
        match self {
            Self::Recruit(payload) => &payload.request_id,
            Self::Dismiss(payload) => &payload.request_id,
            Self::Connect(payload) => &payload.request_id,
            Self::Role(payload) => &payload.request_id,
        }
    }

    pub fn source_terminal_id(&self) -> &str {
        match self {
            Self::Recruit(payload) => &payload.source_terminal_id,
            Self::Dismiss(payload) => &payload.source_terminal_id,
            Self::Connect(payload) => &payload.actor_terminal_id,
            Self::Role(payload) => &payload.source_terminal_id,
        }
    }

    pub fn actor_terminal_id(&self) -> &str {
        self.source_terminal_id()
    }

    pub fn connect_source_id(&self) -> Option<&str> {
        match self {
            Self::Connect(payload) => Some(if payload.source_id.trim().is_empty() {
                payload.actor_terminal_id.as_str()
            } else {
                payload.source_id.as_str()
            }),
            _ => None,
        }
    }

    pub fn canonicalize_dismiss_target(&mut self, target_id: String) {
        if let Self::Dismiss(payload) = self {
            payload.target_terminal_id = target_id;
        }
    }

    pub fn canonicalize_actor(&mut self, actor_id: String) {
        match self {
            Self::Recruit(payload) => payload.source_terminal_id = actor_id,
            Self::Dismiss(payload) => payload.source_terminal_id = actor_id,
            Self::Role(payload) => payload.source_terminal_id = actor_id,
            Self::Connect(payload) => payload.actor_terminal_id = actor_id,
        }
    }

    pub fn canonicalize_role_target(&mut self, target_id: String) {
        if let Self::Role(payload) = self {
            payload.target_terminal_id = target_id;
        }
    }

    pub fn canonicalize_connect(
        &mut self,
        actor_id: String,
        source_id: String,
        target_id: String,
        connection_type: MaestroConnectionType,
    ) {
        if let Self::Connect(payload) = self {
            payload.actor_terminal_id = actor_id;
            payload.source_id = source_id;
            payload.target_id = target_id;
            payload.connection_type = Some(connection_type);
        }
    }

    fn event_name(&self) -> &'static str {
        match self {
            Self::Recruit(_) => "maestro://recruit",
            Self::Dismiss(_) => "maestro://dismiss",
            Self::Connect(_) => "maestro://connect",
            Self::Role(_) => "maestro://role",
        }
    }

    fn payload_value(&self) -> Result<serde_json::Value, String> {
        match self {
            Self::Recruit(payload) => serde_json::to_value(payload),
            Self::Dismiss(payload) => serde_json::to_value(payload),
            Self::Connect(payload) => serde_json::to_value(payload),
            Self::Role(payload) => serde_json::to_value(payload),
        }
        .map_err(|error| format!("failed to serialize Maestro payload: {error}"))
    }

    pub fn validate(&self) -> Result<(), MaestroValidationError> {
        match self {
            Self::Recruit(payload) => payload.validate(),
            Self::Dismiss(payload) => payload.validate(),
            Self::Connect(payload) => payload.validate(),
            Self::Role(payload) => payload.validate(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaestroActionResult {
    pub request_id: String,
    pub action: MaestroAction,
    pub success: bool,
    #[serde(default)]
    pub target_id: Option<String>,
    #[serde(default)]
    pub edge_id: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MaestroValidationError {
    InvalidRequestId,
    InvalidCharacters(&'static str),
    Required(&'static str),
    TooLong { field: &'static str, max: usize },
}

impl fmt::Display for MaestroValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequestId => formatter.write_str("requestId must be a UUID"),
            Self::InvalidCharacters(field) => {
                write!(formatter, "{field} must not contain control characters")
            }
            Self::Required(field) => write!(formatter, "{field} is required"),
            Self::TooLong { field, max } => write!(formatter, "{field} exceeds {max} characters"),
        }
    }
}

impl std::error::Error for MaestroValidationError {}

impl MaestroRecruitPayload {
    pub fn validate(&self) -> Result<(), MaestroValidationError> {
        validate_common(&self.request_id, &self.source_terminal_id)?;
        validate_required(&self.name, "name", MAX_NAME_CHARS)?;
        validate_optional(&self.role, "role", MAX_ROLE_CHARS)?;
        validate_optional_text(&self.command, "command")?;
        validate_optional_text(&self.agent_type, "agentType")?;
        validate_optional_text(&self.working_directory, "workingDirectory")?;
        validate_optional_text(&self.shell_path, "shellPath")?;
        validate_optional_text(&self.color, "color")?;
        validate_optional_text(&self.icon, "icon")
    }
}

impl MaestroDismissPayload {
    pub fn validate(&self) -> Result<(), MaestroValidationError> {
        validate_common(&self.request_id, &self.source_terminal_id)?;
        validate_id(&self.target_terminal_id, "targetTerminalId")
    }
}

impl MaestroConnectPayload {
    pub fn validate(&self) -> Result<(), MaestroValidationError> {
        validate_common(&self.request_id, &self.actor_terminal_id)?;
        let source_id = if self.source_id.trim().is_empty() {
            &self.actor_terminal_id
        } else {
            &self.source_id
        };
        validate_id(source_id, "sourceId")?;
        validate_id(&self.target_id, "targetId")
    }
}

pub fn classify_connection_type(source: &str, target: &str) -> Option<MaestroConnectionType> {
    match (source, target) {
        ("terminal", "terminal") => Some(MaestroConnectionType::Terminal),
        ("terminal", "note") | ("note", "terminal") => Some(MaestroConnectionType::TerminalNote),
        ("terminal", "portal") | ("portal", "terminal") => {
            Some(MaestroConnectionType::TerminalPortal)
        }
        ("note", "note") => Some(MaestroConnectionType::NoteNote),
        ("portal", "portal") => Some(MaestroConnectionType::PortalPortal),
        _ => None,
    }
}

impl MaestroRolePayload {
    pub fn validate(&self) -> Result<(), MaestroValidationError> {
        validate_common(&self.request_id, &self.source_terminal_id)?;
        validate_id(&self.target_terminal_id, "targetTerminalId")?;
        validate_required(&self.role, "role", MAX_ROLE_CHARS)?;
        validate_optional(&self.instructions, "instructions", MAX_INSTRUCTIONS_CHARS)
    }
}

fn validate_common(
    request_id: &str,
    source_terminal_id: &str,
) -> Result<(), MaestroValidationError> {
    if !is_uuid(request_id) {
        return Err(MaestroValidationError::InvalidRequestId);
    }
    validate_id(source_terminal_id, "sourceTerminalId")
}

fn validate_id(value: &str, field: &'static str) -> Result<(), MaestroValidationError> {
    if value.trim().is_empty() {
        return Err(MaestroValidationError::Required(field));
    }
    if value.chars().any(char::is_control) {
        return Err(MaestroValidationError::InvalidCharacters(field));
    }
    if value.chars().count() > MAX_ID_CHARS {
        return Err(MaestroValidationError::TooLong {
            field,
            max: MAX_ID_CHARS,
        });
    }
    Ok(())
}

fn validate_required(
    value: &str,
    field: &'static str,
    max: usize,
) -> Result<(), MaestroValidationError> {
    if value.trim().is_empty() {
        return Err(MaestroValidationError::Required(field));
    }
    if value.chars().any(char::is_control) {
        return Err(MaestroValidationError::InvalidCharacters(field));
    }
    if value.chars().count() > max {
        return Err(MaestroValidationError::TooLong { field, max });
    }
    Ok(())
}

fn validate_optional_text(
    value: &Option<String>,
    field: &'static str,
) -> Result<(), MaestroValidationError> {
    if let Some(value) = value {
        if value.chars().any(char::is_control) {
            return Err(MaestroValidationError::Required(field));
        }
    }
    Ok(())
}

fn validate_optional(
    value: &Option<String>,
    field: &'static str,
    max: usize,
) -> Result<(), MaestroValidationError> {
    match value {
        None => Ok(()),
        Some(value) => validate_required(value, field, max),
    }
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if *byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

pub fn new_request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0);
    let counter = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "{:08x}-{:04x}-4{:03x}-8{:03x}-{:012x}",
        (nanos ^ counter) as u32,
        ((nanos >> 32) ^ counter) & 0xffff,
        (counter ^ (nanos >> 16)) & 0xfff,
        (counter ^ nanos) & 0x3ff,
        ((nanos << 16) ^ counter as u128 as u64) & 0xffff_ffff_ffff,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaestroAckExpectation {
    pub action: MaestroAction,
    pub actor_terminal_id: String,
    pub source_id: Option<String>,
    pub target_id: Option<String>,
}

impl MaestroAckExpectation {
    pub fn from_command(command: &MaestroCommand) -> Self {
        let target_id = match command {
            MaestroCommand::Dismiss(payload) => Some(payload.target_terminal_id.clone()),
            MaestroCommand::Role(payload) => Some(payload.target_terminal_id.clone()),
            MaestroCommand::Connect(payload) => Some(payload.target_id.clone()),
            MaestroCommand::Recruit(_) => None,
        };
        Self {
            action: command.action(),
            actor_terminal_id: command.actor_terminal_id().to_owned(),
            source_id: command.connect_source_id().map(str::to_owned),
            target_id,
        }
    }
}

/// Context supplied by a trusted listener/transport when it can identify the
/// event origin and the canonical graph endpoints used by the operation.
/// The existing wire ACK does not carry these fields, so callers can use
/// [`MaestroBridge::accept_result_json_with_context`] without changing JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaestroAckContext {
    pub actor_terminal_id: String,
    pub source_id: Option<String>,
    pub target_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StrictAckContextPayload {
    actor_terminal_id: Option<String>,
    #[serde(default)]
    source_id: Option<String>,
    #[serde(default)]
    target_id: Option<String>,
}

/// Parses the context carried by the strict frontend ACK. The listener must
/// compare this with the command context it received from the backend before
/// resolving the pending request; these fields are not accepted as an
/// independent authorization source.
pub fn parse_strict_ack_context(payload: &str) -> Result<MaestroAckContext, String> {
    let wire = serde_json::from_str::<StrictAckContextPayload>(payload)
        .map_err(|error| format!("invalid strict Maestro ACK: {error}"))?;
    let actor_terminal_id = wire
        .actor_terminal_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "strict Maestro ACK actorTerminalId is required".to_string())?;
    let context = MaestroAckContext {
        actor_terminal_id,
        source_id: wire.source_id,
        target_id: wire.target_id,
    };
    validate_ack_context(&context)?;
    Ok(context)
}

struct PendingAck {
    sender: mpsc::Sender<MaestroActionResult>,
    expected: MaestroAckExpectation,
    expires_at: Instant,
}

#[derive(Clone, Default)]
pub struct MaestroAckRouter {
    pending: Arc<Mutex<HashMap<String, PendingAck>>>,
}

impl MaestroAckRouter {
    pub fn register_command(
        &self,
        command: &MaestroCommand,
    ) -> Result<mpsc::Receiver<MaestroActionResult>, String> {
        self.register_expected(
            command.request_id(),
            MaestroAckExpectation::from_command(command),
        )
    }

    pub fn register_expected(
        &self,
        request_id: &str,
        expected: MaestroAckExpectation,
    ) -> Result<mpsc::Receiver<MaestroActionResult>, String> {
        self.register_expected_with_timeout(request_id, expected, ACK_TIMEOUT)
    }

    fn register_expected_with_timeout(
        &self,
        request_id: &str,
        expected: MaestroAckExpectation,
        timeout: Duration,
    ) -> Result<mpsc::Receiver<MaestroActionResult>, String> {
        if !is_uuid(request_id) {
            return Err("Maestro ACK requestId must be a UUID".to_string());
        }
        validate_id(&expected.actor_terminal_id, "ackActorTerminalId")
            .map_err(|error| error.to_string())?;
        if let Some(source_id) = &expected.source_id {
            validate_id(source_id, "ackSourceId").map_err(|error| error.to_string())?;
        }
        if let Some(target_id) = &expected.target_id {
            validate_id(target_id, "ackTargetId").map_err(|error| error.to_string())?;
        }
        let (sender, receiver) = mpsc::channel();
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Maestro ACK router lock poisoned".to_string())?;
        purge_expired(&mut pending, Instant::now());
        if pending.contains_key(request_id) {
            return Err("Maestro ACK request is already pending".to_string());
        }
        if pending.len() >= MAX_PENDING_ACKS_GLOBAL {
            return Err(format!(
                "Maestro ACK pending capacity reached (global limit {MAX_PENDING_ACKS_GLOBAL})"
            ));
        }
        let actor_pending = pending
            .values()
            .filter(|entry| entry.expected.actor_terminal_id == expected.actor_terminal_id)
            .count();
        if actor_pending >= MAX_PENDING_ACKS_PER_ACTOR {
            return Err(format!(
                "Maestro ACK pending capacity reached for actor (limit {MAX_PENDING_ACKS_PER_ACTOR})"
            ));
        }
        pending.insert(
            request_id.to_owned(),
            PendingAck {
                sender,
                expected,
                expires_at: Instant::now() + timeout,
            },
        );
        Ok(receiver)
    }

    /// Removes expired entries without spawning a cleanup thread or holding a
    /// lock while any channel operation runs. Dispatch also calls `cancel`
    /// immediately after its receive timeout.
    pub fn cleanup_expired(&self) -> Result<usize, String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Maestro ACK router lock poisoned".to_string())?;
        Ok(purge_expired(&mut pending, Instant::now()))
    }

    pub fn pending_len(&self) -> Result<usize, String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "Maestro ACK router lock poisoned".to_string())?;
        purge_expired(&mut pending, Instant::now());
        Ok(pending.len())
    }

    /// Compatibility resolver for the existing ACK wire. It validates the
    /// request/action and any target endpoint present in the wire result.
    /// Use `resolve_with_context` when the listener can authenticate origin
    /// and both graph endpoints.
    pub fn resolve(&self, result: MaestroActionResult) -> Result<bool, String> {
        self.resolve_inner(result, None)
    }

    pub fn resolve_with_context(
        &self,
        result: MaestroActionResult,
        context: MaestroAckContext,
    ) -> Result<bool, String> {
        self.resolve_inner(result, Some(context))
    }

    fn resolve_inner(
        &self,
        result: MaestroActionResult,
        context: Option<MaestroAckContext>,
    ) -> Result<bool, String> {
        let (sender, result) = {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| "Maestro ACK router lock poisoned".to_string())?;
            purge_expired(&mut pending, Instant::now());
            let entry = match pending.get(&result.request_id) {
                Some(entry) => entry,
                None => return Ok(false),
            };
            validate_ack(&entry.expected, &result, context.as_ref())?;
            let entry = pending
                .remove(&result.request_id)
                .ok_or_else(|| "Maestro ACK request disappeared".to_string())?;
            (entry.sender, result)
        };
        Ok(sender.send(result).is_ok())
    }

    pub fn cancel(&self, request_id: &str) -> Result<(), String> {
        self.pending
            .lock()
            .map_err(|_| "Maestro ACK router lock poisoned".to_string())?
            .remove(request_id);
        Ok(())
    }
}

fn purge_expired(pending: &mut HashMap<String, PendingAck>, now: Instant) -> usize {
    let before = pending.len();
    pending.retain(|_, entry| entry.expires_at > now);
    before - pending.len()
}

fn validate_ack(
    expected: &MaestroAckExpectation,
    result: &MaestroActionResult,
    context: Option<&MaestroAckContext>,
) -> Result<(), String> {
    if result.action != expected.action {
        return Err(format!(
            "Maestro ACK action mismatch: expected {:?}, received {:?}",
            expected.action, result.action
        ));
    }
    if let Some(target_id) = &result.target_id {
        if expected.target_id.as_deref() != Some(target_id.as_str()) {
            if expected.target_id.is_some() {
                return Err("Maestro ACK target endpoint mismatch".to_string());
            }
        }
    } else if result.success && expected.target_id.is_some() {
        return Err("Maestro successful ACK is missing its target endpoint".to_string());
    }

    if let Some(context) = context {
        validate_ack_context(context)?;
        if context.actor_terminal_id != expected.actor_terminal_id {
            return Err("Maestro ACK actor identity mismatch".to_string());
        }
        if context.source_id != expected.source_id {
            return Err("Maestro ACK source endpoint mismatch".to_string());
        }
        if expected.target_id.is_some() && context.target_id != expected.target_id {
            return Err("Maestro ACK target endpoint mismatch".to_string());
        }
    }
    Ok(())
}

fn validate_ack_context(context: &MaestroAckContext) -> Result<(), String> {
    validate_id(&context.actor_terminal_id, "ackActorTerminalId")
        .map_err(|error| error.to_string())?;
    if let Some(source_id) = &context.source_id {
        validate_id(source_id, "ackSourceId").map_err(|error| error.to_string())?;
    }
    if let Some(target_id) = &context.target_id {
        validate_id(target_id, "ackTargetId").map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[derive(Clone)]
pub struct MaestroBridge {
    app: AppHandle,
    pub acks: MaestroAckRouter,
}

impl MaestroBridge {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            acks: MaestroAckRouter::default(),
        }
    }

    pub fn accept_result_json(&self, payload: &str) -> Result<bool, String> {
        let result = serde_json::from_str::<MaestroActionResult>(payload)
            .map_err(|error| format!("invalid Maestro ACK: {error}"))?;
        self.acks.resolve(result)
    }

    pub fn accept_result_json_with_context(
        &self,
        payload: &str,
        context: MaestroAckContext,
    ) -> Result<bool, String> {
        let payload_context = parse_strict_ack_context(payload)?;
        if payload_context != context {
            return Err("strict Maestro ACK context does not match listener context".to_string());
        }
        let result = serde_json::from_str::<MaestroActionResult>(payload)
            .map_err(|error| format!("invalid Maestro ACK: {error}"))?;
        self.acks.resolve_with_context(result, context)
    }

    pub fn dispatch(&self, command: MaestroCommand) -> Result<MaestroActionResult, String> {
        command.validate().map_err(|error| error.to_string())?;
        let request_id = command.request_id().to_owned();
        let receiver = self.acks.register_command(&command)?;
        let payload = command.payload_value()?;
        if let Err(error) = self.app.emit(command.event_name(), payload) {
            let _ = self.acks.cancel(&request_id);
            return Err(format!("failed to emit {}: {error}", command.event_name()));
        }
        match receiver.recv_timeout(ACK_TIMEOUT) {
            Ok(result) => Ok(result),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = self.acks.cancel(&request_id);
                Err(format!(
                    "Maestro action '{}' timed out after {} seconds",
                    command.action_name(),
                    ACK_TIMEOUT.as_secs()
                ))
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = self.acks.cancel(&request_id);
                Err("Maestro ACK channel disconnected".to_string())
            }
        }
    }
}

impl MaestroCommand {
    fn action_name(&self) -> &'static str {
        match self {
            Self::Recruit(_) => "recruit",
            Self::Dismiss(_) => "dismiss",
            Self::Connect(_) => "connect",
            Self::Role(_) => "role",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUEST_ID: &str = "7c1e7e5f-9ad4-4fa7-9e3f-9d1a6f20d2c4";

    fn recruit() -> MaestroCommand {
        MaestroCommand::Recruit(MaestroRecruitPayload {
            request_id: REQUEST_ID.to_string(),
            source_terminal_id: "manager-1".to_string(),
            name: "Worker".to_string(),
            role: Some("builder".to_string()),
            agent_type: Some("claude_code".to_string()),
            command: Some("claude".to_string()),
            working_directory: None,
            shell_path: None,
            color: None,
            icon: None,
        })
    }

    #[test]
    fn validates_all_command_variants() {
        assert_eq!(recruit().action(), MaestroAction::Recruit);
        assert!(recruit().validate().is_ok());
        assert!(MaestroCommand::Dismiss(MaestroDismissPayload {
            request_id: REQUEST_ID.to_string(),
            source_terminal_id: "manager-1".to_string(),
            target_terminal_id: "worker-1".to_string(),
        })
        .validate()
        .is_ok());
        assert!(MaestroCommand::Connect(MaestroConnectPayload {
            request_id: REQUEST_ID.to_string(),
            actor_terminal_id: "manager-1".to_string(),
            source_id: "worker-1".to_string(),
            target_id: "note-1".to_string(),
            connection_type: None,
        })
        .validate()
        .is_ok());
        assert!(MaestroCommand::Role(MaestroRolePayload {
            request_id: REQUEST_ID.to_string(),
            source_terminal_id: "manager-1".to_string(),
            target_terminal_id: "worker-1".to_string(),
            role: "reviewer".to_string(),
            instructions: Some("Run tests".to_string()),
            color: None,
        })
        .validate()
        .is_ok());
    }

    #[test]
    fn rejects_bad_uuid_and_limits() {
        let mut command = recruit();
        if let MaestroCommand::Recruit(payload) = &mut command {
            payload.request_id = "req-1".to_string();
            assert_eq!(
                payload.validate(),
                Err(MaestroValidationError::InvalidRequestId)
            );
            payload.request_id = REQUEST_ID.to_string();
            payload.name = "x".repeat(MAX_NAME_CHARS + 1);
            assert_eq!(
                payload.validate(),
                Err(MaestroValidationError::TooLong {
                    field: "name",
                    max: MAX_NAME_CHARS
                })
            );
        }
    }

    #[test]
    fn serializes_tagged_command_with_camel_case_fields() {
        let value = serde_json::to_value(recruit()).expect("serialize command");
        assert_eq!(value["action"], "recruit");
        assert_eq!(value["payload"]["requestId"], REQUEST_ID);
    }

    #[test]
    fn ack_router_resolves_ack_and_cleans_up_timeout() {
        let router = MaestroAckRouter::default();
        let receiver = router
            .register_expected(
                REQUEST_ID,
                MaestroAckExpectation {
                    action: MaestroAction::Recruit,
                    actor_terminal_id: "manager-1".to_string(),
                    source_id: None,
                    target_id: None,
                },
            )
            .unwrap();
        let result = MaestroActionResult {
            request_id: REQUEST_ID.to_string(),
            action: MaestroAction::Recruit,
            success: true,
            target_id: Some("worker-1".to_string()),
            edge_id: None,
            error: None,
        };
        assert!(router.resolve(result.clone()).unwrap());
        assert_eq!(
            receiver.recv_timeout(Duration::from_millis(10)).unwrap(),
            result
        );
        assert!(!router.resolve(result).unwrap());

        let timed_out = router
            .register_expected(
                "7c1e7e5f-9ad4-4fa7-9e3f-9d1a6f20d2c5",
                MaestroAckExpectation {
                    action: MaestroAction::Recruit,
                    actor_terminal_id: "manager-1".to_string(),
                    source_id: None,
                    target_id: None,
                },
            )
            .unwrap();
        assert!(matches!(
            timed_out.recv_timeout(Duration::from_millis(1)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        router
            .cancel("7c1e7e5f-9ad4-4fa7-9e3f-9d1a6f20d2c5")
            .unwrap();
    }

    #[test]
    fn rejects_wrong_action_and_replay_without_losing_valid_pending_request() {
        let router = MaestroAckRouter::default();
        let command = MaestroCommand::Dismiss(MaestroDismissPayload {
            request_id: new_request_id(),
            source_terminal_id: "manager-1".to_string(),
            target_terminal_id: "worker-1".to_string(),
        });
        let request_id = command.request_id().to_owned();
        let receiver = router.register_command(&command).unwrap();

        let wrong_action = MaestroActionResult {
            request_id: request_id.clone(),
            action: MaestroAction::Role,
            success: true,
            target_id: Some("worker-1".to_string()),
            edge_id: None,
            error: None,
        };
        assert!(router.resolve(wrong_action).is_err());
        assert_eq!(router.pending_len().unwrap(), 1);

        let valid = MaestroActionResult {
            request_id,
            action: MaestroAction::Dismiss,
            success: true,
            target_id: Some("worker-1".to_string()),
            edge_id: None,
            error: None,
        };
        assert!(router
            .resolve_with_context(
                valid.clone(),
                MaestroAckContext {
                    actor_terminal_id: "manager-1".to_string(),
                    source_id: None,
                    target_id: Some("worker-1".to_string()),
                },
            )
            .unwrap());
        assert_eq!(receiver.recv().unwrap(), valid);
        assert!(!router.resolve(valid).unwrap());
    }

    #[test]
    fn rejects_wrong_actor_and_endpoints() {
        let router = MaestroAckRouter::default();
        let command = MaestroCommand::Connect(MaestroConnectPayload {
            request_id: new_request_id(),
            actor_terminal_id: "manager-1".to_string(),
            source_id: "worker-1".to_string(),
            target_id: "note-1".to_string(),
            connection_type: Some(MaestroConnectionType::TerminalNote),
        });
        let request_id = command.request_id().to_owned();
        let receiver = router.register_command(&command).unwrap();
        let result = MaestroActionResult {
            request_id,
            action: MaestroAction::Connect,
            success: true,
            target_id: Some("note-1".to_string()),
            edge_id: Some("edge-1".to_string()),
            error: None,
        };

        for context in [
            MaestroAckContext {
                actor_terminal_id: "worker-1".to_string(),
                source_id: Some("worker-1".to_string()),
                target_id: Some("note-1".to_string()),
            },
            MaestroAckContext {
                actor_terminal_id: "manager-1".to_string(),
                source_id: Some("other-worker".to_string()),
                target_id: Some("note-1".to_string()),
            },
            MaestroAckContext {
                actor_terminal_id: "manager-1".to_string(),
                source_id: Some("worker-1".to_string()),
                target_id: Some("other-note".to_string()),
            },
        ] {
            assert!(router
                .resolve_with_context(result.clone(), context)
                .is_err());
        }
        assert_eq!(router.pending_len().unwrap(), 1);
        assert!(router
            .resolve_with_context(
                result.clone(),
                MaestroAckContext {
                    actor_terminal_id: "manager-1".to_string(),
                    source_id: Some("worker-1".to_string()),
                    target_id: Some("note-1".to_string()),
                },
            )
            .unwrap());
        assert_eq!(receiver.recv().unwrap(), result);
    }

    #[test]
    fn parses_strict_ack_context_and_rejects_missing_or_controlled_identity() {
        let payload = r#"{
            "requestId":"7c1e7e5f-9ad4-4fa7-9e3f-9d1a6f20d2c4",
            "action":"connect",
            "success":true,
            "actorTerminalId":"manager-1",
            "sourceId":"note-1",
            "targetId":"portal-1"
        }"#;
        assert_eq!(
            parse_strict_ack_context(payload).unwrap(),
            MaestroAckContext {
                actor_terminal_id: "manager-1".to_string(),
                source_id: Some("note-1".to_string()),
                target_id: Some("portal-1".to_string()),
            }
        );
        assert!(parse_strict_ack_context(r#"{"actorTerminalId":"manager-1"}"#).is_ok());
        assert!(parse_strict_ack_context(r#"{"sourceId":"note-1"}"#).is_err());
        assert!(parse_strict_ack_context(
            r#"{"actorTerminalId":"manager-1","sourceId":"bad\nid"}"#
        )
        .is_err());
    }

    #[test]
    fn strict_context_matches_the_ack_payload_before_resolution() {
        let command = MaestroCommand::Dismiss(MaestroDismissPayload {
            request_id: REQUEST_ID.to_string(),
            source_terminal_id: "manager-1".to_string(),
            target_terminal_id: "worker-1".to_string(),
        });
        let context = MaestroAckExpectation::from_command(&command);
        let payload = format!(
            r#"{{"requestId":"{REQUEST_ID}","action":"dismiss","success":true,"actorTerminalId":"{}","targetId":"{}"}}"#,
            context.actor_terminal_id,
            context.target_id.as_deref().unwrap(),
        );
        let parsed = parse_strict_ack_context(&payload).unwrap();
        assert_eq!(parsed.actor_terminal_id, context.actor_terminal_id);
        assert_eq!(parsed.target_id, context.target_id);
        let mismatched =
            parse_strict_ack_context(&payload.replace("worker-1", "other-worker")).unwrap();
        assert_ne!(mismatched.target_id, context.target_id);
    }

    #[test]
    fn cleanup_expired_pending_ack_releases_capacity() {
        let router = MaestroAckRouter::default();
        let request_id = new_request_id();
        let receiver = router
            .register_expected_with_timeout(
                &request_id,
                MaestroAckExpectation {
                    action: MaestroAction::Recruit,
                    actor_terminal_id: "manager-timeout".to_string(),
                    source_id: None,
                    target_id: None,
                },
                Duration::from_millis(1),
            )
            .unwrap();
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(router.cleanup_expired().unwrap(), 1);
        assert_eq!(router.pending_len().unwrap(), 0);
        drop(receiver);
        assert!(router
            .register_expected(
                &request_id,
                MaestroAckExpectation {
                    action: MaestroAction::Recruit,
                    actor_terminal_id: "manager-timeout".to_string(),
                    source_id: None,
                    target_id: None,
                },
            )
            .is_ok());
        router.cancel(&request_id).unwrap();
    }

    #[test]
    fn enforces_global_and_per_actor_pending_capacity() {
        let router = MaestroAckRouter::default();
        let mut actor_request_ids = Vec::new();
        for _ in 0..MAX_PENDING_ACKS_PER_ACTOR {
            let request_id = new_request_id();
            router
                .register_expected(
                    &request_id,
                    MaestroAckExpectation {
                        action: MaestroAction::Recruit,
                        actor_terminal_id: "capacity-actor".to_string(),
                        source_id: None,
                        target_id: None,
                    },
                )
                .unwrap();
            actor_request_ids.push(request_id);
        }
        assert!(router
            .register_expected(
                &new_request_id(),
                MaestroAckExpectation {
                    action: MaestroAction::Recruit,
                    actor_terminal_id: "capacity-actor".to_string(),
                    source_id: None,
                    target_id: None,
                },
            )
            .is_err());
        router.cancel(&actor_request_ids[0]).unwrap();
        assert!(router
            .register_expected(
                &new_request_id(),
                MaestroAckExpectation {
                    action: MaestroAction::Recruit,
                    actor_terminal_id: "capacity-actor".to_string(),
                    source_id: None,
                    target_id: None,
                },
            )
            .is_ok());

        let mut global_ids = Vec::new();
        while router.pending_len().unwrap() < MAX_PENDING_ACKS_GLOBAL {
            let request_id = new_request_id();
            router
                .register_expected(
                    &request_id,
                    MaestroAckExpectation {
                        action: MaestroAction::Recruit,
                        actor_terminal_id: format!("capacity-global-{}", global_ids.len()),
                        source_id: None,
                        target_id: None,
                    },
                )
                .unwrap();
            global_ids.push(request_id);
        }
        assert!(router
            .register_expected(
                &new_request_id(),
                MaestroAckExpectation {
                    action: MaestroAction::Recruit,
                    actor_terminal_id: "capacity-overflow".to_string(),
                    source_id: None,
                    target_id: None,
                },
            )
            .is_err());
        for request_id in actor_request_ids.into_iter().chain(global_ids) {
            router.cancel(&request_id).unwrap();
        }
    }

    #[test]
    fn concurrent_registration_is_bounded() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::thread;

        let router = Arc::new(MaestroAckRouter::default());
        let accepted = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();
        for _ in 0..(MAX_PENDING_ACKS_GLOBAL + 32) {
            let router = router.clone();
            let accepted = accepted.clone();
            workers.push(thread::spawn(move || {
                let request_id = new_request_id();
                if router
                    .register_expected(
                        &request_id,
                        MaestroAckExpectation {
                            action: MaestroAction::Recruit,
                            actor_terminal_id: format!("concurrent-{}", request_id),
                            source_id: None,
                            target_id: None,
                        },
                    )
                    .is_ok()
                {
                    accepted.fetch_add(1, Ordering::Relaxed);
                }
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(accepted.load(Ordering::Relaxed), MAX_PENDING_ACKS_GLOBAL);
        assert_eq!(router.pending_len().unwrap(), MAX_PENDING_ACKS_GLOBAL);
    }

    #[test]
    fn rejects_control_characters_in_names_roles_and_ids() {
        let mut command = recruit();
        if let MaestroCommand::Recruit(payload) = &mut command {
            payload.name = "Worker\n".to_string();
            assert!(matches!(
                payload.validate(),
                Err(MaestroValidationError::InvalidCharacters("name"))
            ));
            payload.name = "Worker".to_string();
            payload.role = Some("builder\t".to_string());
            assert!(matches!(
                payload.validate(),
                Err(MaestroValidationError::InvalidCharacters("role"))
            ));
            payload.role = None;
            payload.source_terminal_id = "manager-\u{0007}".to_string();
            assert!(matches!(
                payload.validate(),
                Err(MaestroValidationError::InvalidCharacters(
                    "sourceTerminalId"
                ))
            ));
        }
        let dismiss = MaestroDismissPayload {
            request_id: REQUEST_ID.to_string(),
            source_terminal_id: "manager-1".to_string(),
            target_terminal_id: "worker-\r1".to_string(),
        };
        assert!(matches!(
            dismiss.validate(),
            Err(MaestroValidationError::InvalidCharacters(
                "targetTerminalId"
            ))
        ));
    }

    #[test]
    fn generated_request_ids_are_validated_uuids() {
        let payload = MaestroDismissPayload {
            request_id: new_request_id(),
            source_terminal_id: "manager-1".to_string(),
            target_terminal_id: "worker-1".to_string(),
        };
        assert!(payload.validate().is_ok());
    }

    #[test]
    fn accepts_legacy_connect_payload_and_prefers_explicit_source_id() {
        let legacy: MaestroConnectPayload = serde_json::from_str(&format!(
            r#"{{"requestId":"{REQUEST_ID}","sourceTerminalId":"manager-1","targetId":"worker-1"}}"#
        ))
        .unwrap();
        assert_eq!(legacy.actor_terminal_id, "manager-1");
        assert_eq!(legacy.source_id, "");
        assert_eq!(
            MaestroCommand::Connect(legacy.clone()).connect_source_id(),
            Some("manager-1")
        );
        assert!(legacy.validate().is_ok());
        assert_eq!(classify_connection_type("note", "portal"), None);
        assert_eq!(
            classify_connection_type("terminal", "note"),
            Some(MaestroConnectionType::TerminalNote)
        );
    }
}
