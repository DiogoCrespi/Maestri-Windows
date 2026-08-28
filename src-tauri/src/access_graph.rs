//! Thread-safe authorization graph for inter-agent communication.
//!
//! This module is intentionally independent from Tauri, terminal state, and
//! the HTTP transport.  The future IPC layer should resolve the caller and
//! target through this graph before dispatching `list`, `ask`, or `check`:
//!
//! ```text
//! graph.authorize(source, AccessAction::Ask, target)?;
//! ```
//!
//! A connection is undirected: an edge A--B authorizes either endpoint to
//! address the other.  The graph never exposes an implicit "all agents"
//! permission; listing returns only direct neighbors.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, RwLock};

use serde::Deserialize;
use tauri::State;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccessGraphError {
    InvalidUuid(String),
    InvalidReference(String),
    EmptyNodeName,
    NodeNotFound(String),
    AmbiguousName(String),
    DuplicateNode(NodeId),
    SelfConnection(NodeId),
    ConnectionNodeMissing(NodeId),
    DuplicateConnection,
    ConnectionNotFound,
    InvalidResourcePath(String),
    ResourcePathNotAllowed(NodeType),
    TargetTypeNotAllowed {
        action: AccessAction,
        target: NodeType,
    },
    SourceNotTerminal(NodeId),
    ManagerRequired(NodeId),
    LockPoisoned,
}

impl fmt::Display for AccessGraphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUuid(value) => write!(f, "invalid UUID '{value}'"),
            Self::InvalidReference(value) => write!(f, "invalid node reference '{value}'"),
            Self::EmptyNodeName => write!(f, "node name cannot be empty"),
            Self::NodeNotFound(value) => write!(f, "node '{value}' not found"),
            Self::AmbiguousName(value) => write!(f, "node name '{value}' is ambiguous"),
            Self::DuplicateNode(id) => write!(f, "node '{id}' already exists"),
            Self::SelfConnection(id) => write!(f, "node '{id}' cannot connect to itself"),
            Self::ConnectionNodeMissing(id) => {
                write!(f, "connection references missing node '{id}'")
            }
            Self::DuplicateConnection => write!(f, "connection already exists"),
            Self::ConnectionNotFound => write!(f, "connection not found"),
            Self::InvalidResourcePath(value) => write!(f, "invalid resource path '{value}'"),
            Self::ResourcePathNotAllowed(node_type) => {
                write!(
                    f,
                    "resource path is not allowed for node type {node_type:?}"
                )
            }
            Self::TargetTypeNotAllowed { action, target } => write!(
                f,
                "action {action:?} is not allowed for target type {target:?}"
            ),
            Self::SourceNotTerminal(id) => write!(f, "source '{id}' is not a terminal"),
            Self::ManagerRequired(id) => write!(f, "source terminal '{id}' is not a Manager"),
            Self::LockPoisoned => write!(f, "access graph lock is poisoned"),
        }
    }
}

impl std::error::Error for AccessGraphError {}

pub type Result<T> = std::result::Result<T, AccessGraphError>;

/// Canonical lowercase UUID (`8-4-4-4-12`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Ord, PartialOrd)]
pub struct NodeId(String);

impl NodeId {
    pub fn new(value: &str) -> Result<Self> {
        let value = value.trim();
        if !is_uuid(value) {
            return Err(AccessGraphError::InvalidUuid(value.to_owned()));
        }
        Ok(Self(value.to_ascii_lowercase()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for NodeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<&str> for NodeId {
    type Error = AccessGraphError;
    fn try_from(value: &str) -> Result<Self> {
        Self::new(value)
    }
}

impl TryFrom<String> for NodeId {
    type Error = AccessGraphError;
    fn try_from(value: String) -> Result<Self> {
        Self::new(&value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeType {
    Terminal,
    Note,
    Portal,
    Other,
}

impl Default for NodeType {
    fn default() -> Self {
        Self::Terminal
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphNode {
    pub id: NodeId,
    pub name: String,
    /// Alternate stable identities accepted by the IPC resolver, such as the
    /// React Flow node ID and a legacy/persisted content ID. Aliases are not
    /// display names and therefore do not need to be globally unique.
    pub aliases: Vec<String>,
    pub node_type: NodeType,
    pub is_manager: bool,
    /// A note's authorized filesystem resource. This is deliberately not an
    /// identity: IDs and connection endpoints always remain UUIDs.
    pub resource_path: Option<String>,
}

impl GraphNode {
    pub fn new(id: NodeId, name: impl Into<String>) -> Result<Self> {
        Self::new_with_type(id, name, NodeType::Terminal)
    }

    pub fn new_with_type(id: NodeId, name: impl Into<String>, node_type: NodeType) -> Result<Self> {
        Self::new_with_type_and_resource(id, name, node_type, None)
    }

    pub fn new_with_type_and_resource(
        id: NodeId,
        name: impl Into<String>,
        node_type: NodeType,
        resource_path: Option<String>,
    ) -> Result<Self> {
        Self::new_with_type_and_resource_and_manager(id, name, node_type, resource_path, false)
    }

    pub fn new_with_type_and_resource_and_manager(
        id: NodeId,
        name: impl Into<String>,
        node_type: NodeType,
        resource_path: Option<String>,
        is_manager: bool,
    ) -> Result<Self> {
        Self::new_with_aliases_type_resource_and_manager(
            id,
            name,
            Vec::new(),
            node_type,
            resource_path,
            is_manager,
        )
    }

    pub fn new_with_aliases_type_resource_and_manager(
        id: NodeId,
        name: impl Into<String>,
        aliases: Vec<String>,
        node_type: NodeType,
        resource_path: Option<String>,
        is_manager: bool,
    ) -> Result<Self> {
        let name = name.into().trim().to_owned();
        if name.is_empty() {
            return Err(AccessGraphError::EmptyNodeName);
        }
        validate_resource_path(node_type, resource_path.as_deref())?;
        let aliases = normalize_aliases(aliases)?;
        Ok(Self {
            id,
            name,
            aliases,
            node_type,
            is_manager,
            resource_path,
        })
    }
}

/// A canonical undirected edge. The lower NodeId is always stored in `a`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Ord, PartialOrd)]
pub struct Connection {
    pub a: NodeId,
    pub b: NodeId,
}

impl Connection {
    pub fn new(a: NodeId, b: NodeId) -> Result<Self> {
        if a == b {
            return Err(AccessGraphError::SelfConnection(a));
        }
        if a < b {
            Ok(Self { a, b })
        } else {
            Ok(Self { a: b, b: a })
        }
    }

    fn contains(&self, id: &NodeId) -> bool {
        self.a == *id || self.b == *id
    }

    fn other(&self, id: &NodeId) -> Option<&NodeId> {
        if self.a == *id {
            Some(&self.b)
        } else if self.b == *id {
            Some(&self.a)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessAction {
    List,
    Ask,
    Check,
    NoteRead,
    NoteWrite,
    PortalInspect,
    PortalClick,
    PortalFill,
    PortalEval,
    PortalNavigate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphSnapshot {
    pub generation: u64,
    pub nodes: Vec<GraphNode>,
    pub connections: Vec<Connection>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct GraphState {
    nodes: HashMap<NodeId, GraphNode>,
    connections: HashSet<Connection>,
    generation: u64,
}

/// A cloneable handle to one atomically updated graph.
#[derive(Clone, Debug, Default)]
pub struct AccessGraph {
    state: Arc<RwLock<GraphState>>,
}

/// Wire representation used by the canvas when publishing its current graph.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNodeInput {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub node_type: NodeType,
    #[serde(default)]
    pub is_manager: bool,
    /// Optional resource metadata. It is accepted for notes only and never
    /// participates in identity or connection resolution.
    #[serde(default, alias = "path", alias = "notePath")]
    pub resource_path: Option<String>,
}

/// Accepts the native `a`/`b` names as well as the names used by workspace
/// connections and React Flow edges. This keeps the command compatible with
/// both the persisted schema and the live canvas representation.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphConnectionInput {
    #[serde(alias = "source", alias = "nodeIdA", alias = "terminalIdA")]
    pub a: String,
    #[serde(alias = "target", alias = "nodeIdB", alias = "terminalIdB")]
    pub b: String,
}

/// Atomically publishes the canvas authorization graph used by the CLI IPC
/// backend. Invalid snapshots leave the previous graph untouched.
#[tauri::command]
pub fn access_graph_replace(
    graph: State<'_, AccessGraph>,
    nodes: Vec<GraphNodeInput>,
    connections: Vec<GraphConnectionInput>,
) -> std::result::Result<u64, String> {
    let nodes = nodes
        .into_iter()
        .map(|node| {
            let id = NodeId::new(&node.id).map_err(|error| error.to_string())?;
            GraphNode::new_with_aliases_type_resource_and_manager(
                id,
                node.name,
                node.aliases,
                node.node_type,
                node.resource_path,
                node.is_manager,
            )
            .map_err(|error| error.to_string())
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let connections = connections
        .into_iter()
        .map(|connection| {
            let a = NodeId::new(&connection.a).map_err(|error| error.to_string())?;
            let b = NodeId::new(&connection.b).map_err(|error| error.to_string())?;
            Connection::new(a, b).map_err(|error| error.to_string())
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;

    graph
        .replace_snapshot(nodes, connections)
        .map_err(|error| error.to_string())
}

impl AccessGraph {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a node or atomically replaces its display name. Replacing a node
    /// does not affect its edges. The generation advances once only if state
    /// changed.
    pub fn upsert_node(&self, node: GraphNode) -> Result<u64> {
        validate_node(&node)?;
        let mut state = self.write_state()?;
        let changed = state.nodes.get(&node.id) != Some(&node);
        state.nodes.insert(node.id.clone(), node);
        Ok(if changed {
            advance(&mut state)
        } else {
            state.generation
        })
    }

    /// Resolves a UUID or a case-insensitive node name. A syntactically valid
    /// UUID always has UUID semantics; if it is not registered, resolution
    /// returns `NodeNotFound` rather than falling back to a name.
    pub fn resolve(&self, reference: &str) -> Result<GraphNode> {
        let state = self.read_state()?;
        let id = resolve_in(&state, reference)?;
        state
            .nodes
            .get(&id)
            .cloned()
            .ok_or_else(|| AccessGraphError::NodeNotFound(reference.trim().to_owned()))
    }

    pub fn authorize_manager(&self, source: &str) -> Result<GraphNode> {
        let node = self.resolve(source)?;
        if node.node_type != NodeType::Terminal {
            return Err(AccessGraphError::SourceNotTerminal(node.id));
        }
        if !node.is_manager {
            return Err(AccessGraphError::ManagerRequired(node.id));
        }
        Ok(node)
    }

    /// Resolves both connection endpoints to canonical node records and
    /// rejects missing or self-referential edges before any event is emitted.
    pub fn canonicalize_connection(
        &self,
        source: &str,
        target: &str,
    ) -> Result<(GraphNode, GraphNode)> {
        let source_node = self.resolve(source)?;
        let target_node = self.resolve(target)?;
        Connection::new(source_node.id.clone(), target_node.id.clone())?;
        Ok((source_node, target_node))
    }

    pub fn generation(&self) -> Result<u64> {
        Ok(self.read_state()?.generation)
    }

    /// Creates one undirected edge. Validation and mutation happen under the
    /// same write lock, so an invalid operation cannot partially update state.
    pub fn connect(&self, source: &str, target: &str) -> Result<u64> {
        let mut state = self.write_state()?;
        let source = resolve_in(&state, source)?;
        let target = resolve_in(&state, target)?;
        let connection = Connection::new(source, target)?;
        if !state.nodes.contains_key(&connection.a) {
            return Err(AccessGraphError::ConnectionNodeMissing(connection.a));
        }
        if !state.nodes.contains_key(&connection.b) {
            return Err(AccessGraphError::ConnectionNodeMissing(connection.b));
        }
        if !state.connections.insert(connection) {
            return Err(AccessGraphError::DuplicateConnection);
        }
        Ok(advance(&mut state))
    }

    /// Removes one undirected edge atomically.
    pub fn disconnect(&self, source: &str, target: &str) -> Result<u64> {
        let mut state = self.write_state()?;
        let source = resolve_in(&state, source)?;
        let target = resolve_in(&state, target)?;
        let connection = Connection::new(source, target)?;
        if !state.connections.remove(&connection) {
            return Err(AccessGraphError::ConnectionNotFound);
        }
        Ok(advance(&mut state))
    }

    /// Removes a node and all incident edges as one generation update.
    pub fn remove_node(&self, reference: &str) -> Result<u64> {
        let mut state = self.write_state()?;
        let id = resolve_in(&state, reference)?;
        state.nodes.remove(&id);
        state
            .connections
            .retain(|connection| !connection.contains(&id));
        Ok(advance(&mut state))
    }

    pub fn is_connected(&self, source: &str, target: &str) -> Result<bool> {
        let state = self.read_state()?;
        let source = resolve_in(&state, source)?;
        let target = resolve_in(&state, target)?;
        Ok(Connection::new(source, target)
            .ok()
            .is_some_and(|edge| state.connections.contains(&edge)))
    }

    /// Returns only direct connected targets, sorted deterministically by
    /// case-insensitive name and then UUID.
    pub fn list_targets(&self, source: &str) -> Result<Vec<GraphNode>> {
        let state = self.read_state()?;
        let source = resolve_in(&state, source)?;
        let mut result: Vec<_> = state
            .connections
            .iter()
            .filter_map(|connection| connection.other(&source))
            .filter_map(|id| state.nodes.get(id).cloned())
            .collect();
        result.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.id.cmp(&right.id))
        });
        Ok(result)
    }

    /// Authorizes one directly connected target and validates the operation's
    /// target type. Terminal actions cannot be redirected to notes, and note
    /// actions cannot address terminals or portals.
    pub fn authorize(&self, source: &str, action: AccessAction, target: &str) -> Result<GraphNode> {
        let state = self.read_state()?;
        let source = resolve_in(&state, source)?;
        let target_id = resolve_authorized_target_in(&state, &source, target)?;
        let edge = Connection::new(source, target_id.clone())
            .map_err(|_| AccessGraphError::ConnectionNotFound)?;
        if !state.connections.contains(&edge) {
            return Err(AccessGraphError::ConnectionNotFound);
        }
        let node = state
            .nodes
            .get(&target_id)
            .cloned()
            .ok_or_else(|| AccessGraphError::NodeNotFound(target.to_owned()))?;
        if !action.allows(node.node_type) {
            return Err(AccessGraphError::TargetTypeNotAllowed {
                action,
                target: node.node_type,
            });
        }
        Ok(node)
    }

    /// Replaces nodes and edges in one transaction. All validation happens
    /// before the graph is changed, including dangling/self/duplicate edges.
    pub fn replace_snapshot(
        &self,
        nodes: Vec<GraphNode>,
        connections: Vec<Connection>,
    ) -> Result<u64> {
        let mut replacement = GraphState::default();
        for node in nodes {
            validate_node(&node)?;
            let id = node.id.clone();
            if replacement.nodes.insert(id.clone(), node).is_some() {
                return Err(AccessGraphError::DuplicateNode(id));
            }
        }
        for connection in connections {
            if !replacement.nodes.contains_key(&connection.a) {
                return Err(AccessGraphError::ConnectionNodeMissing(connection.a));
            }
            if !replacement.nodes.contains_key(&connection.b) {
                return Err(AccessGraphError::ConnectionNodeMissing(connection.b));
            }
            if !replacement.connections.insert(connection) {
                return Err(AccessGraphError::DuplicateConnection);
            }
        }
        let mut state = self.write_state()?;
        if state.nodes == replacement.nodes && state.connections == replacement.connections {
            return Ok(state.generation);
        }
        replacement.generation = advance(&mut state);
        *state = replacement;
        Ok(state.generation)
    }

    pub fn snapshot(&self) -> Result<GraphSnapshot> {
        let state = self.read_state()?;
        let mut nodes: Vec<_> = state.nodes.values().cloned().collect();
        nodes.sort_by(|a, b| a.id.cmp(&b.id));
        let mut connections: Vec<_> = state.connections.iter().cloned().collect();
        connections.sort();
        Ok(GraphSnapshot {
            generation: state.generation,
            nodes,
            connections,
        })
    }

    fn read_state(&self) -> Result<std::sync::RwLockReadGuard<'_, GraphState>> {
        self.state
            .read()
            .map_err(|_| AccessGraphError::LockPoisoned)
    }
    fn write_state(&self) -> Result<std::sync::RwLockWriteGuard<'_, GraphState>> {
        self.state
            .write()
            .map_err(|_| AccessGraphError::LockPoisoned)
    }
}

fn advance(state: &mut GraphState) -> u64 {
    state.generation = state.generation.saturating_add(1);
    state.generation
}

impl AccessAction {
    fn allows(self, node_type: NodeType) -> bool {
        match self {
            Self::List => true,
            Self::Ask | Self::Check => node_type == NodeType::Terminal,
            Self::NoteRead | Self::NoteWrite => node_type == NodeType::Note,
            Self::PortalInspect
            | Self::PortalClick
            | Self::PortalFill
            | Self::PortalEval
            | Self::PortalNavigate => node_type == NodeType::Portal,
        }
    }
}

fn validate_node(node: &GraphNode) -> Result<()> {
    if node.name.trim().is_empty() {
        return Err(AccessGraphError::EmptyNodeName);
    }
    normalize_aliases(node.aliases.clone())?;
    validate_resource_path(node.node_type, node.resource_path.as_deref())
}

fn normalize_aliases(aliases: Vec<String>) -> Result<Vec<String>> {
    let mut normalized = Vec::new();
    let mut seen = HashSet::new();
    for alias in aliases {
        let alias = alias.trim();
        if alias.is_empty() || alias.chars().any(char::is_control) {
            return Err(AccessGraphError::InvalidReference(alias.to_owned()));
        }
        let key = alias.to_lowercase();
        if seen.insert(key) {
            normalized.push(alias.to_owned());
        }
    }
    Ok(normalized)
}

fn validate_resource_path(node_type: NodeType, resource_path: Option<&str>) -> Result<()> {
    let Some(path) = resource_path else {
        return Ok(());
    };
    if node_type != NodeType::Note {
        return Err(AccessGraphError::ResourcePathNotAllowed(node_type));
    }
    if path.trim().is_empty() || path.chars().any(char::is_control) {
        return Err(AccessGraphError::InvalidResourcePath(path.to_owned()));
    }
    Ok(())
}

fn resolve_in(state: &GraphState, reference: &str) -> Result<NodeId> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err(AccessGraphError::InvalidReference(reference.to_owned()));
    }
    if let Some(id) = resolve_identity_in(state, reference)? {
        return Ok(id);
    }
    resolve_name_in(state.nodes.values(), reference)
}

/// Identity references (canonical UUID or alias) always identify the same
/// node globally and are checked against the edge afterwards. Display names
/// are resolved only among the caller's direct neighbors, so an unrelated
/// node with the same label cannot make a valid connection ambiguous.
fn resolve_authorized_target_in(
    state: &GraphState,
    source: &NodeId,
    reference: &str,
) -> Result<NodeId> {
    let reference = reference.trim();
    if reference.is_empty() {
        return Err(AccessGraphError::InvalidReference(reference.to_owned()));
    }
    if let Some(id) = resolve_identity_in(state, reference)? {
        return Ok(id);
    }
    let neighbors: HashSet<NodeId> = state
        .connections
        .iter()
        .filter_map(|connection| connection.other(source))
        .cloned()
        .collect();
    resolve_name_in(
        state
            .nodes
            .values()
            .filter(|node| neighbors.contains(&node.id)),
        reference,
    )
}

/// Resolves an exact canonical ID or alias before considering display names.
/// This lets UUID-shaped React Flow IDs work as aliases without weakening the
/// canonical UUID identity used for authorization and terminal lookup.
fn resolve_identity_in(state: &GraphState, reference: &str) -> Result<Option<NodeId>> {
    let normalized = reference.trim().to_lowercase();
    if is_uuid(&normalized) {
        let id = NodeId(normalized.clone());
        if state.nodes.contains_key(&id) {
            return Ok(Some(id));
        }
    }
    let matches: Vec<_> = state
        .nodes
        .values()
        .filter(|node| {
            node.aliases
                .iter()
                .any(|alias| alias.to_lowercase() == normalized)
        })
        .map(|node| node.id.clone())
        .collect();
    match matches.as_slice() {
        [] => Ok(None),
        [id] => Ok(Some(id.clone())),
        _ => Err(AccessGraphError::AmbiguousName(reference.trim().to_owned())),
    }
}

fn resolve_name_in<'a>(
    nodes: impl Iterator<Item = &'a GraphNode>,
    reference: &str,
) -> Result<NodeId> {
    let normalized = reference.trim().to_lowercase();
    let matches: Vec<_> = nodes
        .filter(|node| node.name.to_lowercase() == normalized)
        .map(|node| node.id.clone())
        .collect();
    match matches.as_slice() {
        [] => Err(AccessGraphError::NodeNotFound(reference.to_owned())),
        [id] => Ok(id.clone()),
        _ => Err(AccessGraphError::AmbiguousName(reference.to_owned())),
    }
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 || [8, 13, 18, 23].iter().any(|&index| bytes[index] != b'-') {
        return false;
    }
    bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    fn id(number: u64) -> NodeId {
        NodeId::new(&format!("00000000-0000-0000-0000-{number:012x}")).unwrap()
    }
    fn node(number: u64, name: &str) -> GraphNode {
        GraphNode::new(id(number), name).unwrap()
    }

    fn aliased_node(number: u64, name: &str, aliases: &[&str]) -> GraphNode {
        GraphNode::new_with_aliases_type_resource_and_manager(
            id(number),
            name,
            aliases.iter().map(|alias| (*alias).to_owned()).collect(),
            NodeType::Terminal,
            None,
            false,
        )
        .unwrap()
    }

    fn note(number: u64, name: &str, path: &str) -> GraphNode {
        GraphNode::new_with_type_and_resource(
            id(number),
            name,
            NodeType::Note,
            Some(path.to_owned()),
        )
        .unwrap()
    }

    #[test]
    fn resolves_uuid_case_insensitively_and_names_without_ambiguity() {
        let graph = AccessGraph::new();
        graph.upsert_node(node(1, "Builder")).unwrap();
        let resolved = graph
            .resolve("00000000-0000-0000-0000-000000000001")
            .unwrap();
        assert_eq!(resolved.name, "Builder");
        assert_eq!(graph.resolve("builder").unwrap().id, id(1));

        graph.upsert_node(node(2, "Builder")).unwrap();
        assert_eq!(
            graph.resolve("Builder"),
            Err(AccessGraphError::AmbiguousName("Builder".into()))
        );
        assert_eq!(
            graph
                .resolve("00000000-0000-0000-0000-000000000002")
                .unwrap()
                .id,
            id(2)
        );
    }

    #[test]
    fn resolves_react_flow_and_content_aliases_including_uuid_shaped_aliases() {
        let graph = AccessGraph::new();
        let react_flow_uuid = "00000000-0000-0000-0000-000000000099";
        graph
            .upsert_node(aliased_node(1, "Source", &["react-source"]))
            .unwrap();
        graph
            .upsert_node(aliased_node(
                2,
                "Worker",
                &[react_flow_uuid, "legacy-content-id"],
            ))
            .unwrap();

        graph.connect("react-source", react_flow_uuid).unwrap();
        assert_eq!(graph.resolve(react_flow_uuid).unwrap().id, id(2));
        assert_eq!(graph.resolve("LEGACY-CONTENT-ID").unwrap().id, id(2));
        assert!(graph
            .authorize("react-source", AccessAction::Ask, react_flow_uuid)
            .is_ok());
    }

    #[test]
    fn duplicate_names_are_resolved_within_direct_connections_only() {
        let graph = AccessGraph::new();
        graph.upsert_node(node(1, "Source")).unwrap();
        graph
            .upsert_node(aliased_node(2, "Antigravity CLI", &["rf-worker-a"]))
            .unwrap();
        graph
            .upsert_node(aliased_node(3, "Antigravity CLI", &["rf-worker-b"]))
            .unwrap();
        graph.connect(id(1).as_str(), id(2).as_str()).unwrap();

        let connected = graph
            .authorize("Source", AccessAction::Ask, "Antigravity CLI")
            .unwrap();
        assert_eq!(connected.id, id(2));
        assert_eq!(
            graph.authorize("Source", AccessAction::Ask, "rf-worker-b"),
            Err(AccessGraphError::ConnectionNotFound)
        );

        graph.connect(id(1).as_str(), id(3).as_str()).unwrap();
        assert_eq!(
            graph.authorize("Source", AccessAction::Ask, "Antigravity CLI"),
            Err(AccessGraphError::AmbiguousName("Antigravity CLI".into()))
        );
        assert_eq!(
            graph
                .authorize("Source", AccessAction::Ask, "rf-worker-b")
                .unwrap()
                .id,
            id(3)
        );
    }

    #[test]
    fn only_direct_neighbors_are_listed_and_authorized() {
        let graph = AccessGraph::new();
        graph.upsert_node(node(1, "Source")).unwrap();
        graph.upsert_node(node(2, "Direct")).unwrap();
        graph.upsert_node(node(3, "Transit")).unwrap();
        graph.upsert_node(node(4, "Remote")).unwrap();
        graph.connect("Source", "Direct").unwrap();
        graph.connect("Direct", "Transit").unwrap();
        graph.connect("Transit", "Remote").unwrap();

        assert_eq!(
            graph
                .list_targets("Source")
                .unwrap()
                .iter()
                .map(|node| node.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Direct"]
        );
        assert!(graph
            .authorize("Source", AccessAction::List, "Direct")
            .is_ok());
        assert!(graph
            .authorize("Source", AccessAction::Ask, "Remote")
            .is_err());
        assert!(graph
            .authorize("Source", AccessAction::Check, "Transit")
            .is_err());
    }

    #[test]
    fn note_resource_is_not_identity_and_note_actions_require_direct_edges() {
        let graph = AccessGraph::new();
        graph.upsert_node(node(1, "Terminal")).unwrap();
        graph
            .upsert_node(note(2, "Design", r"C:\work\notes\design.md"))
            .unwrap();
        graph.upsert_node(note(3, "Remote", "remote.md")).unwrap();
        graph.connect("Terminal", "Design").unwrap();
        graph.connect("Design", "Remote").unwrap();

        let authorized = graph
            .authorize("Terminal", AccessAction::NoteRead, "Design")
            .unwrap();
        assert_eq!(authorized.id, id(2));
        assert_eq!(
            authorized.resource_path.as_deref(),
            Some(r"C:\work\notes\design.md")
        );
        assert!(graph
            .authorize("Terminal", AccessAction::NoteWrite, "Design")
            .is_ok());
        assert!(matches!(
            graph.authorize("Terminal", AccessAction::Ask, "Design"),
            Err(AccessGraphError::TargetTypeNotAllowed {
                action: AccessAction::Ask,
                target: NodeType::Note
            })
        ));
        assert!(matches!(
            graph.authorize("Terminal", AccessAction::Check, "Design"),
            Err(AccessGraphError::TargetTypeNotAllowed {
                action: AccessAction::Check,
                target: NodeType::Note
            })
        ));
        assert_eq!(
            graph.authorize("Terminal", AccessAction::NoteRead, "Remote"),
            Err(AccessGraphError::ConnectionNotFound)
        );
    }

    #[test]
    fn resource_paths_are_allowed_only_on_notes() {
        assert!(GraphNode::new_with_type_and_resource(
            id(1),
            "Terminal",
            NodeType::Terminal,
            Some("terminal.exe".into())
        )
        .is_err());
        assert!(GraphNode::new_with_type_and_resource(
            id(2),
            "Note",
            NodeType::Note,
            Some("\0bad.md".into())
        )
        .is_err());
    }

    #[test]
    fn portal_actions_require_a_direct_portal_target() {
        let graph = AccessGraph::new();
        graph.upsert_node(node(10, "Terminal")).unwrap();
        graph
            .upsert_node(GraphNode::new_with_type(id(11), "Portal", NodeType::Portal).unwrap())
            .unwrap();
        graph.upsert_node(node(12, "Transit")).unwrap();
        graph
            .upsert_node(
                GraphNode::new_with_type(id(13), "Remote Portal", NodeType::Portal).unwrap(),
            )
            .unwrap();
        graph.connect("Terminal", "Portal").unwrap();
        graph.connect("Terminal", "Transit").unwrap();
        graph.connect("Portal", "Transit").unwrap();
        graph.connect("Transit", "Remote Portal").unwrap();

        assert!(graph
            .authorize("Terminal", AccessAction::PortalClick, "Portal")
            .is_ok());
        assert!(matches!(
            graph.authorize("Terminal", AccessAction::PortalInspect, "Transit"),
            Err(AccessGraphError::TargetTypeNotAllowed {
                action: AccessAction::PortalInspect,
                target: NodeType::Terminal
            })
        ));
        assert_eq!(
            graph.authorize("Terminal", AccessAction::PortalNavigate, "Remote Portal"),
            Err(AccessGraphError::ConnectionNotFound)
        );
    }

    #[test]
    fn invalid_updates_are_atomic_and_generation_changes_once() {
        let graph = AccessGraph::new();
        graph.upsert_node(node(1, "A")).unwrap();
        graph.upsert_node(node(2, "B")).unwrap();
        let before = graph.snapshot().unwrap();
        assert_eq!(
            graph.connect("A", "missing"),
            Err(AccessGraphError::NodeNotFound("missing".into()))
        );
        assert_eq!(graph.snapshot().unwrap(), before);
        assert_eq!(graph.connect("A", "B").unwrap(), before.generation + 1);
        assert_eq!(
            graph.connect("A", "B"),
            Err(AccessGraphError::DuplicateConnection)
        );
        assert_eq!(graph.generation().unwrap(), before.generation + 1);
        graph.remove_node("A").unwrap();
        assert!(graph.is_connected("B", "A").is_err());
        assert!(graph.snapshot().unwrap().connections.is_empty());
    }

    #[test]
    fn replacement_validates_before_publishing() {
        let graph = AccessGraph::new();
        graph.upsert_node(node(1, "A")).unwrap();
        let before = graph.snapshot().unwrap();
        let invalid_edge = Connection::new(id(1), id(2)).unwrap();
        assert_eq!(
            graph.replace_snapshot(vec![node(1, "New A")], vec![invalid_edge]),
            Err(AccessGraphError::ConnectionNodeMissing(id(2)))
        );
        assert_eq!(graph.snapshot().unwrap(), before);
        assert_eq!(
            graph
                .replace_snapshot(
                    vec![node(1, "New A"), node(2, "B")],
                    vec![Connection::new(id(1), id(2)).unwrap()]
                )
                .unwrap(),
            before.generation + 1
        );
    }

    #[test]
    fn concurrent_updates_are_safe_and_visible_as_complete_operations() {
        let graph = Arc::new(AccessGraph::new());
        graph.upsert_node(node(0, "Source")).unwrap();
        let mut workers = Vec::new();
        for number in 1..=16u64 {
            let graph = Arc::clone(&graph);
            workers.push(thread::spawn(move || {
                graph
                    .upsert_node(node(number, &format!("Agent-{number}")))
                    .unwrap();
                graph.connect("Source", &format!("Agent-{number}")).unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }
        assert_eq!(graph.list_targets("Source").unwrap().len(), 16);
        assert_eq!(graph.snapshot().unwrap().nodes.len(), 17);
    }

    #[test]
    fn manager_authorization_requires_terminal_manager_flag() {
        let graph = AccessGraph::new();
        graph
            .upsert_node(
                GraphNode::new_with_type_and_resource_and_manager(
                    id(20),
                    "Manager",
                    NodeType::Terminal,
                    None,
                    true,
                )
                .unwrap(),
            )
            .unwrap();
        graph.upsert_node(node(21, "Worker")).unwrap();
        assert!(graph.authorize_manager("Manager").unwrap().is_manager);
        assert!(matches!(
            graph.authorize_manager("Worker"),
            Err(AccessGraphError::ManagerRequired(_))
        ));
    }

    #[test]
    fn graph_node_input_defaults_is_manager_for_old_snapshots() {
        let input: GraphNodeInput = serde_json::from_str(
            r#"{"id":"00000000-0000-0000-0000-000000000023","name":"Legacy"}"#,
        )
        .unwrap();
        assert!(!input.is_manager);
        assert!(input.aliases.is_empty());
    }

    #[test]
    fn canonicalizes_named_connection_endpoints_and_rejects_self_edges() {
        let graph = AccessGraph::new();
        graph.upsert_node(node(30, "Alpha")).unwrap();
        graph.upsert_node(node(31, "Beta")).unwrap();
        let (source, target) = graph.canonicalize_connection("alpha", "Beta").unwrap();
        assert_eq!(source.id, id(30));
        assert_eq!(target.id, id(31));
        assert_eq!(
            graph.canonicalize_connection("Alpha", "alpha"),
            Err(AccessGraphError::SelfConnection(id(30)))
        );
        assert!(matches!(
            graph.canonicalize_connection("missing", "Beta"),
            Err(AccessGraphError::NodeNotFound(_))
        ));
    }
}
