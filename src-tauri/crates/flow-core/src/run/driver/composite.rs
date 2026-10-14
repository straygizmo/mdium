//! Driver: composite.

use super::*;

impl Driver {
    /// Starts a sub-flow node: renders its params and `projectRoot`, then
    /// opens its scope, in a worktree of the project when `projectRoot`
    /// renders to a non-empty path. `acknowledged`: the `show` of the
    /// `FLOW_SUBFLOW_ROOT_DIFFERS` request the user approved.
    pub(super) fn start_subflow(
        &mut self,
        prefix: &str,
        key: &str,
        sub: &SubflowNode,
        attempt: u32,
        acknowledged: Option<&BTreeMap<String, ShowValue>>,
    ) {
        let given = self.with_ctx(prefix, None, None, None, |ctx| {
            ctx.render_json(&Value::Object(sub.params.clone().into_iter().collect()))
        });
        let given: BTreeMap<String, Value> = match given {
            Ok(Value::Object(given)) => given.into_iter().collect(),
            Ok(_) => return,
            Err(reason) => return self.fail_node(key, attempt, reason),
        };
        // Strict: a skipped or not-yet-run node must not render to "" and
        // silently run the child in the project root.
        let root = match &sub.project_root {
            Some(text) => self
                .with_ctx(prefix, None, None, None, |ctx| ctx.render_string_strict(text))
                .map_err(|reason| {
                    if reason.code == "FLOW_TEMPLATE_UNRESOLVED" {
                        let mut invalid = Reason::new(FLOW_SUBFLOW_ROOT_INVALID)
                            .with("root", text.as_str())
                            .with("reason", "unresolved");
                        if let Some(reference) = reason.params.get("ref") {
                            invalid = invalid.with("ref", reference.clone());
                        }
                        invalid
                    } else {
                        reason
                    }
                }),
            None => Ok(String::new()),
        };
        let opened = match root {
            Err(reason) => Err(reason),
            Ok(root) if root.trim().is_empty() => self.open_file_scope(
                prefix,
                key,
                &sub.flow,
                &subflow_prefix(key),
                &given,
                None,
                None,
            ),
            Ok(root) => self.open_worktree_scope(
                prefix,
                key,
                attempt,
                &sub.flow,
                &given,
                root.trim(),
                acknowledged,
            ),
        };
        if let Err(reason) = opened {
            self.fail_node(key, attempt, reason);
        }
    }

    /// The user decided on a `FLOW_SUBFLOW_ROOT_DIFFERS` request: approving
    /// starts the sub-flow again, acknowledged with what was shown (a child
    /// that changed once more asks again).
    pub(super) fn subflow_root_decided(
        &mut self,
        key: &str,
        attempt: u32,
        request: &ApprovalRequest,
        choice: &str,
    ) {
        if choice != "approve" {
            return self.fail_node(key, attempt, Reason::new(FLOW_APPROVAL_REJECTED));
        }
        let Some((prefix, node)) = self.def_of(key) else {
            return;
        };
        let NodeKind::Subflow(sub) = &node.kind else {
            return;
        };
        if self.offline {
            // No loop runs here: resuming starts (and asks) a new attempt.
            self.set_node(key, NodeStatus::Ready, attempt, None, None);
            return;
        }
        self.set_node(key, NodeStatus::Running, attempt, None, None);
        self.start_subflow(&prefix, key, sub, attempt, Some(&request.show));
    }

    /// A rendered `projectRoot` as a working root: an existing directory
    /// (relative values resolve against the project root), registered as a
    /// linked worktree of the project's repository, and neither the project
    /// root nor the main checkout. The project must be its repository's
    /// top level (a subdirectory project cannot map into a worktree).
    /// Checked before anything there is read; `reason` says which rule failed.
    pub(super) fn resolve_scope_root(&self, raw: &str) -> Result<PathBuf, Reason> {
        let invalid = |why: &str| {
            Reason::new(FLOW_SUBFLOW_ROOT_INVALID)
                .with("root", raw)
                .with("reason", why)
        };
        let project = self.store.project_root();
        let given = Path::new(raw);
        let joined = if given.is_absolute() {
            given.to_path_buf()
        } else {
            project.join(given)
        };
        let canonical = std::fs::canonicalize(&joined).map_err(|_| invalid("not-found"))?;
        if !canonical.is_dir() {
            return Err(invalid("not-a-directory"));
        }
        let project_key = fsutil::project_key(project);
        let top = gitops::repo_root(project).map_err(|_| invalid("project-not-a-repo"))?;
        if fsutil::project_key(&top) != project_key {
            return Err(invalid("project-not-repo-root"));
        }
        let root = fsutil::normalize_root(&canonical);
        let key = fsutil::project_key(&root);
        if key == project_key {
            return Err(invalid("project-root"));
        }
        let worktrees = gitops::list_worktrees(project).map_err(|_| invalid("project-not-a-repo"))?;
        // The first entry is the main working tree: never a scope root.
        if worktrees.first().is_some_and(|main| fsutil::project_key(main) == key) {
            return Err(invalid("main-checkout"));
        }
        if !worktrees.iter().skip(1).any(|w| fsutil::project_key(w) == key) {
            return Err(invalid("not-a-worktree"));
        }
        Ok(root)
    }

    /// Loads the child flow `display` (and everything it references) from
    /// the worktree `root`, as a start would load it from the project.
    pub(super) fn load_worktree_child(
        &self,
        root: &Path,
        reference: &str,
        display: &str,
    ) -> Result<Bundle, Reason> {
        let invalid = |message: String, details: Vec<Reason>| {
            Reason::new(FLOW_SUBFLOW_INVALID)
                .with("ref", reference)
                .with("errorCount", details.len().max(1))
                .with("message", message)
                .with(
                    "details",
                    serde_json::to_value(&details).unwrap_or(Value::Null),
                )
        };
        let bundle = load_bundle_at(root, display).map_err(|e| invalid(e.message, e.details))?;
        // A broken manifest in the worktree is an error, not empty runtimes to approve.
        if let Some(project) = bundle.project.as_ref().filter(|p| !p.issues.is_empty()) {
            let details = project
                .issues
                .iter()
                .map(|i| {
                    Reason {
                        code: i.code.clone(),
                        params: i.params.clone(),
                    }
                    .with("path", i.path.clone())
                })
                .collect();
            return Err(invalid(
                format!("{} has validation errors", crate::project::PROJECT_FILE),
                details,
            ));
        }
        let problems = check_runnable(&bundle.files());
        if !problems.is_empty() {
            return Err(invalid(
                "the flow uses features this version cannot run".to_string(),
                problems,
            ));
        }
        Ok(bundle)
    }

    /// Compares a child loaded from a worktree with the run's confirmed
    /// definitions of snapshot file `file` (and the files it references):
    /// commands, python stages, and the manifest's runtimes and setup.
    /// `None` when they match, else the worktree's side to show.
    pub(super) fn confirmed_differences(&self, file: &str, child: &Bundle) -> Option<BTreeMap<String, Value>> {
        let mut confirmed: BTreeMap<String, &FlowDef> = BTreeMap::new();
        let mut queue = vec![file.to_string()];
        while let Some(current) = queue.pop() {
            if confirmed.contains_key(&current) {
                continue;
            }
            let Some(flow) = scope::flow_of(&self.meta, &current) else {
                continue;
            };
            confirmed.insert(current.clone(), flow);
            let owned = ref_key(&current, "");
            queue.extend(
                self.meta
                    .refs
                    .iter()
                    .filter(|(k, _)| k.starts_with(&owned))
                    .map(|(_, v)| v.clone()),
            );
        }
        // Same order as `Bundle::files`: the file itself, then the others by path.
        let mut files: Vec<(&str, &FlowDef)> = Vec::new();
        if let Some(flow) = confirmed.remove(file) {
            files.push((scope::unrooted_file(file), flow));
        }
        let others: BTreeMap<&str, &FlowDef> = confirmed
            .iter()
            .map(|(k, f)| (scope::unrooted_file(k), *f))
            .collect();
        files.extend(others);
        let child_files = child.files();
        let commands = command_summaries(&child_files);
        let stages = stage_summaries(&child_files);
        let runtimes = runtimes_and_setup(child.project.as_ref().and_then(|p| p.project.as_ref()));
        if commands == command_summaries(&files)
            && stages == stage_summaries(&files)
            && runtimes == runtimes_and_setup(self.meta.project.as_ref())
        {
            return None;
        }
        let value = |v: serde_json::Result<Value>| v.unwrap_or(Value::Null);
        Some(BTreeMap::from([
            ("commands".to_string(), value(serde_json::to_value(&commands))),
            ("stages".to_string(), value(serde_json::to_value(&stages))),
            ("runtimes".to_string(), runtimes),
        ]))
    }

    /// Opens a sub-flow scope whose child flow comes from `raw_root`, a
    /// worktree of the project. A child that differs from the confirmed
    /// definitions waits for the user's approval (unless `acknowledged`
    /// shows exactly that difference). Opening records the child's
    /// definitions in `run.json` under `<root>::<path>`.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn open_worktree_scope(
        &mut self,
        prefix: &str,
        key: &str,
        attempt: u32,
        reference: &str,
        given: &BTreeMap<String, Value>,
        raw_root: &str,
        acknowledged: Option<&BTreeMap<String, ShowValue>>,
    ) -> Result<(), Reason> {
        let root = self.resolve_scope_root(raw_root)?;
        let root_text = root.to_string_lossy().into_owned();
        let owner_file = self
            .scope_init(prefix)
            .map(|i| i.graph.file)
            .unwrap_or_default();
        let resolved = self
            .meta
            .refs
            .get(&ref_key(&owner_file, reference))
            .cloned()
            .ok_or_else(|| Reason::new(FLOW_SUBFLOW_MISSING).with("ref", reference))?;
        // `project:main` resolves through the worktree's own manifest.
        let load_ref = if reference == crate::load::PROJECT_MAIN_REF {
            reference.to_string()
        } else {
            scope::unrooted_file(&resolved).to_string()
        };
        let child = self.load_worktree_child(&root, reference, &load_ref)?;
        let display = child.display.clone();
        if let Some(show) = self.confirmed_differences(&resolved, &child) {
            let show: BTreeMap<String, ShowValue> = show
                .into_iter()
                .map(|(name, value)| (name, ShowValue::Value(value)))
                .collect();
            if acknowledged != Some(&show) {
                self.set_node(key, NodeStatus::AwaitingApproval, attempt, None, None);
                let request = ApprovalRequest {
                    node_key: Some(key.to_string()),
                    options: COMMAND_APPROVAL_OPTIONS
                        .iter()
                        .map(|s| RequestOption::plain(*s))
                        .collect(),
                    message: None,
                    show,
                    reason: Reason::new(FLOW_SUBFLOW_ROOT_DIFFERS).with("root", root_text),
                };
                self.emit(Some(key), EventBody::ApprovalRequested(request));
                return Ok(());
            }
        }
        let rooted = |display: &str| scope::rooted_file(&root_text, display);
        let file = rooted(&display);
        let Bundle {
            flow, others, refs, ..
        } = child;
        for (path, (_, def)) in others {
            self.meta.subflows.insert(rooted(&path), def);
        }
        self.meta.subflows.insert(file.clone(), flow);
        for (k, target) in refs {
            if let Some((owner, reference)) = k.split_once('\n') {
                self.meta
                    .refs
                    .insert(ref_key(&rooted(owner), reference), rooted(&target));
            }
        }
        self.store.save_meta(&self.meta).map_err(|e| {
            Reason::new(FLOW_SUBFLOW_INVALID)
                .with("ref", reference)
                .with("message", e.to_string())
        })?;
        self.open_file_scope(
            prefix,
            key,
            reference,
            &subflow_prefix(key),
            given,
            None,
            Some((root_text.clone(), file)),
        )
    }

    /// Opens a child scope running another flow file (sub-flow or file loop
    /// body). `worktree`: `(root, snapshot file)` of a child loaded from a
    /// worktree (see [`Self::open_worktree_scope`]); otherwise the reference
    /// resolves through the snapshot.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn open_file_scope(
        &mut self,
        prefix: &str,
        owner: &str,
        reference: &str,
        child: &str,
        given: &BTreeMap<String, Value>,
        iteration: Option<(Value, usize)>,
        worktree: Option<(String, String)>,
    ) -> Result<(), Reason> {
        let (project_root, resolved) = match worktree {
            Some((root, file)) => (Some(root), file),
            None => {
                let owner_file = self
                    .scope_init(prefix)
                    .map(|i| i.graph.file)
                    .unwrap_or_default();
                let resolved = self
                    .meta
                    .refs
                    .get(&ref_key(&owner_file, reference))
                    .cloned()
                    .ok_or_else(|| Reason::new(FLOW_SUBFLOW_MISSING).with("ref", reference))?;
                (None, resolved)
            }
        };
        let flow = scope::flow_of(&self.meta, &resolved)
            .cloned()
            .ok_or_else(|| Reason::new(FLOW_SUBFLOW_MISSING).with("ref", reference))?;
        let params = prepare_params(&flow, given).map_err(|problems| {
            problems
                .into_iter()
                .next()
                .unwrap_or_else(|| Reason::new("FLOW_PARAM_INVALID"))
        })?;
        let (item, index) = match iteration {
            Some((item, index)) => (Some(item), Some(index)),
            None => (None, None),
        };
        let init = ScopeInit {
            owner: Some(owner.to_string()),
            parent: Some(prefix.to_string()),
            inherits: false,
            graph: GraphLoc {
                file: resolved,
                path: Vec::new(),
            },
            params,
            var: None,
            item,
            index,
            project_root,
        };
        let nodes = flow.nodes.iter().map(|n| n.id.clone()).collect();
        self.emit(
            Some(owner),
            EventBody::ScopeStarted {
                prefix: child.to_string(),
                init,
                nodes,
            },
        );
        Ok(())
    }

    /// Advances running loops and sub-flows of a scope.
    pub(super) fn progress_composites(&mut self, prefix: &str) {
        for id in self.ids(prefix) {
            let key = self.state.current_key(prefix, &id);
            if self.node(&key).status != NodeStatus::Running {
                continue;
            }
            let Some(node) = self.graph_of(prefix).and_then(|g| g.node(&id)).cloned() else {
                continue;
            };
            match &node.kind {
                NodeKind::Loop(lp) => self.progress_loop(prefix, &key, &node, lp),
                NodeKind::Subflow(_) => self.progress_subflow(&key),
                _ => {}
            }
            if !self.state.status.is_active() {
                return;
            }
        }
    }

    pub(super) fn progress_subflow(&mut self, key: &str) {
        let child = subflow_prefix(key);
        let Some(scope) = self.state.scopes.get(&child).cloned() else {
            return;
        };
        let attempt = self.node(key).attempt;
        match scope.status {
            ScopeStatus::Running => {}
            ScopeStatus::Completed => {
                for (name, value) in scope.outputs {
                    self.emit(Some(key), EventBody::NodeOutput { key: name, value });
                }
                self.settle(key, attempt, NodeStatus::Succeeded, PORT_SUCCESS, None);
            }
            ScopeStatus::Failed => {
                self.fail_node(key, attempt, Reason::new(FLOW_SUBFLOW_FAILED));
            }
        }
    }

    /// Iteration scopes of a loop instance, by index.
    pub(super) fn iterations(&self, key: &str) -> Vec<(String, ScopeRecord)> {
        let mut out: Vec<(String, ScopeRecord)> = self
            .state
            .scopes
            .iter()
            .filter(|(_, s)| s.init.owner.as_deref() == Some(key) && s.init.index.is_some())
            .map(|(p, s)| (p.clone(), s.clone()))
            .collect();
        out.sort_by_key(|(_, s)| s.init.index);
        out
    }

    pub(super) fn progress_loop(&mut self, prefix: &str, key: &str, node: &FlowNode, lp: &LoopNode) {
        let attempt = self.node(key).attempt;
        let children = self.iterations(key);
        let active = children
            .iter()
            .filter(|(_, s)| s.status == ScopeStatus::Running)
            .count();
        let failed: Vec<usize> = children
            .iter()
            .filter(|(_, s)| s.status == ScopeStatus::Failed)
            .filter_map(|(_, s)| s.init.index)
            .collect();
        let stop_on_failure = lp.on_item_failure != Some(OnItemFailure::Continue);
        if stop_on_failure && !failed.is_empty() {
            if active == 0 {
                self.fail_node(
                    key,
                    attempt,
                    Reason::new(FLOW_LOOP_ITERATION_FAILED).with("index", failed[0]),
                );
            }
            return;
        }
        if active > 0 || self.stop_requested {
            return;
        }
        let max = lp.max_iterations.unwrap_or(0) as usize;
        match lp.mode {
            LoopMode::Foreach => {
                let record = self.state.loops.get(key).cloned().unwrap_or(LoopRecord {
                    items: Vec::new(),
                    limit_reached: false,
                });
                if children.len() < record.items.len() {
                    let index = children.len();
                    let item = record.items[index].clone();
                    self.start_iteration(prefix, key, node, lp, index, item);
                } else {
                    self.finish_loop(key, attempt, &children, record.limit_reached);
                }
            }
            LoopMode::While => {
                if let Some((_, last)) = children.last() {
                    let iteration = last.outputs.clone();
                    let until = lp.until.clone().expect("validated: while has until");
                    match self.evaluate(prefix, &until, Some(&iteration)) {
                        Ok(true) => return self.finish_loop(key, attempt, &children, false),
                        Ok(false) => {}
                        Err(reason) => return self.fail_node(key, attempt, reason),
                    }
                    if children.len() >= max {
                        return self.finish_loop(key, attempt, &children, true);
                    }
                }
                let index = children.len();
                self.start_iteration(prefix, key, node, lp, index, Value::from(index));
            }
        }
    }

    pub(super) fn start_iteration(
        &mut self,
        prefix: &str,
        key: &str,
        node: &FlowNode,
        lp: &LoopNode,
        index: usize,
        item: Value,
    ) {
        let child = iteration_prefix(key, index);
        let var = lp.loop_var().to_string();
        match &lp.body {
            LoopBody::Inline(body) => {
                let Some(init) = self.scope_init(prefix) else {
                    return;
                };
                let mut path = init.graph.path.clone();
                path.push(node.id.clone());
                let scope = ScopeInit {
                    owner: Some(key.to_string()),
                    parent: Some(prefix.to_string()),
                    inherits: true,
                    graph: GraphLoc {
                        file: init.graph.file.clone(),
                        path,
                    },
                    params: init.params.clone(),
                    var: Some(var),
                    item: Some(item),
                    index: Some(index),
                    project_root: None,
                };
                let nodes = body.nodes.iter().map(|n| n.id.clone()).collect();
                self.emit(
                    Some(key),
                    EventBody::ScopeStarted {
                        prefix: child,
                        init: scope,
                        nodes,
                    },
                );
            }
            LoopBody::File(file) => {
                let loop_var = LoopVar {
                    name: var,
                    item: item.clone(),
                    index,
                };
                let given = self.with_ctx(prefix, Some(loop_var), None, None, |ctx| {
                    ctx.render_json(&Value::Object(lp.params.clone().into_iter().collect()))
                });
                let attempt = self.node(key).attempt;
                match given {
                    Ok(Value::Object(given)) => {
                        let given: BTreeMap<String, Value> = given.into_iter().collect();
                        if let Err(reason) = self.open_file_scope(
                            prefix,
                            key,
                            file,
                            &child,
                            &given,
                            Some((item, index)),
                            None,
                        ) {
                            self.fail_node(key, attempt, reason);
                        }
                    }
                    Ok(_) => {}
                    Err(reason) => self.fail_node(key, attempt, reason),
                }
            }
        }
    }

    pub(super) fn finish_loop(
        &mut self,
        key: &str,
        attempt: u32,
        children: &[(String, ScopeRecord)],
        limit_reached: bool,
    ) {
        let failed = children
            .iter()
            .filter(|(_, s)| s.status == ScopeStatus::Failed)
            .count();
        let results: Vec<Value> = children
            .iter()
            .map(|(_, s)| Value::Object(s.outputs.clone().into_iter().collect()))
            .collect();
        let outputs = [
            ("iterations", Value::from(children.len())),
            ("failedIterations", Value::from(failed)),
            ("limitReached", Value::from(limit_reached)),
            ("results", Value::Array(results)),
        ];
        for (name, value) in outputs {
            self.emit(
                Some(key),
                EventBody::NodeOutput {
                    key: name.to_string(),
                    value,
                },
            );
        }
        self.settle(key, attempt, NodeStatus::Succeeded, PORT_SUCCESS, None);
    }
}
