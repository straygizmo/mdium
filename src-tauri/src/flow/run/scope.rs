//! Scopes and node instance keys (spec 2.4, 4.3).
//!
//! A run has a root scope; every loop iteration and every sub-flow opens a
//! child scope whose node keys are prefixed: `docs[3]/summarize`,
//! `sub/inner`. A node re-entered through a back-edge gets a new instance
//! in a new pass: `design@2`. One key always names one instance.

use crate::flow::model::{FlowDef, FlowEdge, FlowNode, LoopBody, NodeKind};
use crate::flow::run::store::RunMeta;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Key of a node instance: `<prefix><id>` plus `@<pass>` from pass 2 on.
pub fn instance_key(prefix: &str, id: &str, pass: u32) -> String {
    if pass > 1 {
        format!("{prefix}{id}@{pass}")
    } else {
        format!("{prefix}{id}")
    }
}

/// `(prefix, id, pass)` of an instance key (the prefix keeps its trailing `/`).
pub fn split_key(key: &str) -> (&str, &str, u32) {
    let cut = key.rfind('/').map(|i| i + 1).unwrap_or(0);
    let (prefix, last) = key.split_at(cut);
    match last.split_once('@') {
        Some((id, pass)) => (prefix, id, pass.parse().unwrap_or(1)),
        None => (prefix, last, 1),
    }
}

/// Prefix of the scope of iteration `index` of the loop instance `loop_key`.
pub fn iteration_prefix(loop_key: &str, index: usize) -> String {
    format!("{loop_key}[{index}]/")
}

/// Prefix of the scope of the sub-flow instance `key`.
pub fn subflow_prefix(key: &str) -> String {
    format!("{key}/")
}

/// Where a scope's graph is defined: a flow file (project-relative path)
/// and, for inline loop bodies, the chain of loop node ids inside it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLoc {
    pub file: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub path: Vec<String>,
}

/// A scope's graph and the flow file it belongs to.
#[derive(Clone, Copy)]
pub struct Graph<'a> {
    pub nodes: &'a [FlowNode],
    pub edges: &'a [FlowEdge],
    pub outputs: &'a BTreeMap<String, String>,
    /// The file's flow (defaults, env, envPassthrough).
    pub flow: &'a FlowDef,
}

impl<'a> Graph<'a> {
    pub fn node(&self, id: &str) -> Option<&'a FlowNode> {
        self.nodes.iter().find(|n| n.id == id)
    }

    /// Forward edges (back-edges carry `maxTraversals`).
    pub fn forward(&self) -> impl Iterator<Item = &'a FlowEdge> {
        self.edges.iter().filter(|e| e.max_traversals.is_none())
    }

    /// `(index, edge)` of the back-edges leaving `id` through `port`.
    pub fn back_edges(&self, id: &str, port: &str) -> Vec<(usize, &'a FlowEdge)> {
        self.edges
            .iter()
            .enumerate()
            .filter(|(_, e)| e.max_traversals.is_some() && e.from == id && e.port() == port)
            .collect()
    }

    pub fn has_edge_from(&self, id: &str, port: &str) -> bool {
        self.edges.iter().any(|e| e.from == id && e.port() == port)
    }

    fn successors(&self) -> BTreeMap<&'a str, Vec<&'a str>> {
        let mut out: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for edge in self.forward() {
            out.entry(edge.from.as_str())
                .or_default()
                .push(edge.to.as_str());
        }
        out
    }

    fn reachable(&self, from: &[&str]) -> BTreeSet<String> {
        let successors = self.successors();
        let mut seen = BTreeSet::new();
        let mut stack: Vec<&str> = from.to_vec();
        while let Some(id) = stack.pop() {
            if seen.insert(id.to_string()) {
                stack.extend(successors.get(id).into_iter().flatten().copied());
            }
        }
        seen
    }

    /// Nodes on the cycle a back-edge `source → target` closes: the target,
    /// the source, and every node forward-reachable from the target that
    /// forward-reaches the source.
    pub fn cycle(&self, target: &str, source: &str) -> BTreeSet<String> {
        let from_target = self.reachable(&[target]);
        let mut out: BTreeSet<String> = from_target
            .iter()
            .filter(|id| self.reachable(&[id.as_str()]).contains(source))
            .cloned()
            .collect();
        out.insert(target.to_string());
        out.insert(source.to_string());
        out
    }

    /// Nodes forward-reachable from `ids`, excluding `ids` themselves.
    pub fn downstream(&self, ids: &BTreeSet<String>) -> BTreeSet<String> {
        let start: Vec<&str> = ids.iter().map(String::as_str).collect();
        let mut all = self.reachable(&start);
        for id in ids {
            all.remove(id);
        }
        all
    }
}

/// The flow of a project-relative file in a run snapshot.
pub fn flow_of<'a>(meta: &'a RunMeta, file: &str) -> Option<&'a FlowDef> {
    if file == meta.flow_path {
        Some(&meta.flow)
    } else {
        meta.subflows.get(file)
    }
}

/// Resolves a scope's graph.
pub fn graph<'a>(meta: &'a RunMeta, loc: &GraphLoc) -> Option<Graph<'a>> {
    let flow = flow_of(meta, &loc.file)?;
    let mut nodes: &[FlowNode] = &flow.nodes;
    let mut edges: &[FlowEdge] = &flow.edges;
    let mut outputs = &flow.outputs;
    for loop_id in &loc.path {
        let node = nodes.iter().find(|n| &n.id == loop_id)?;
        match &node.kind {
            NodeKind::Loop(lp) => match &lp.body {
                LoopBody::Inline(body) => {
                    nodes = &body.nodes;
                    edges = &body.edges;
                    outputs = &body.outputs;
                }
                LoopBody::File(_) => return None,
            },
            _ => return None,
        }
    }
    Some(Graph {
        nodes,
        edges,
        outputs,
        flow,
    })
}

/// Key under which a snapshot records where `reference` (written in `file`) resolved.
pub fn ref_key(file: &str, reference: &str) -> String {
    format!("{file}\n{reference}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::load::check_text;
    use crate::flow::parse::FlowFormat;

    #[test]
    fn keys_round_trip() {
        assert_eq!(instance_key("", "a", 1), "a");
        assert_eq!(instance_key("", "a", 2), "a@2");
        assert_eq!(
            instance_key("docs[3]/", "summarize", 1),
            "docs[3]/summarize"
        );
        assert_eq!(split_key("a"), ("", "a", 1));
        assert_eq!(split_key("design@3"), ("", "design", 3));
        assert_eq!(
            split_key("docs@2[3]/sub/inner@4"),
            ("docs@2[3]/sub/", "inner", 4)
        );
        assert_eq!(iteration_prefix("docs@2", 0), "docs@2[0]/");
        assert_eq!(subflow_prefix("s"), "s/");
    }

    fn flow(yaml: &str) -> FlowDef {
        let (flow, issues) = check_text(
            &format!("schemaVersion: 1\nid: t\nname: T\n{yaml}"),
            FlowFormat::Yaml,
        );
        assert!(issues.errors.is_empty(), "{:#?}", issues.errors);
        flow.unwrap()
    }

    #[test]
    fn cycles_and_downstream() {
        let def = flow(
            "nodes:\n  - { id: s, kind: approval }\n  - { id: a, kind: approval }\n  - { id: b, kind: approval }\n  - { id: c, kind: approval }\n  - { id: d, kind: approval }\nedges:\n  - { from: s, to: a, port: approve }\n  - { from: a, to: b, port: approve }\n  - { from: b, to: c, port: approve }\n  - { from: b, to: a, port: reject, maxTraversals: 2 }\n  - { from: c, to: d, port: approve }\n",
        );
        let g = Graph {
            nodes: &def.nodes,
            edges: &def.edges,
            outputs: &def.outputs,
            flow: &def,
        };
        let cycle = g.cycle("a", "b");
        assert_eq!(cycle, BTreeSet::from(["a".to_string(), "b".to_string()]));
        assert_eq!(
            g.downstream(&cycle),
            BTreeSet::from(["c".to_string(), "d".to_string()])
        );
        assert_eq!(g.back_edges("b", "reject").len(), 1);
        assert!(g.back_edges("b", "approve").is_empty());
        assert_eq!(g.cycle("b", "b"), BTreeSet::from(["b".to_string()]));
    }
}
