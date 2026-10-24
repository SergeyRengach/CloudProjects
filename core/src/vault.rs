//! The note store: notes, link/tag indexes, backlinks, full-text search, graph queries.

use crate::parse::{self, basename, normalize_path, tokenize, ParsedLink};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

pub type NoteId = u32;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Note {
    pub id: NoteId,
    pub path: String,
    pub body: String,
    pub created: f64,
    pub updated: f64,
    #[serde(skip)]
    pub links: Vec<ParsedLink>,
    #[serde(skip)]
    pub tags: Vec<String>,
}

impl Note {
    pub fn title(&self) -> &str {
        basename(&self.path)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct NoteInfo {
    pub id: NoteId,
    pub path: String,
    pub title: String,
    pub updated: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Backlink {
    pub from: NoteId,
    pub path: String,
    pub snippet: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct SearchHit {
    pub id: NoteId,
    pub path: String,
    pub score: f32,
    pub snippet: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphNode {
    pub id: NoteId,
    pub title: String,
    pub path: String,
    pub degree: u32,
    pub tag: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<(NoteId, NoteId)>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind")]
pub enum ChangeEvent {
    NoteCreated {
        id: NoteId,
    },
    NoteUpdated {
        id: NoteId,
    },
    NoteRenamed {
        id: NoteId,
        from: String,
        to: String,
    },
    NoteDeleted {
        id: NoteId,
    },
}

#[derive(Default)]
pub struct Vault {
    notes: BTreeMap<NoteId, Note>,
    next_id: NoteId,
    by_path: HashMap<String, NoteId>,
    by_base: HashMap<String, Vec<NoteId>>,
    /// term -> (note -> term frequency)
    index: HashMap<String, HashMap<NoteId, u32>>,
    doc_len: HashMap<NoteId, u32>,
    pub changes: Vec<ChangeEvent>,
}

impl Vault {
    pub fn new() -> Self {
        Vault {
            next_id: 1,
            ..Default::default()
        }
    }

    pub fn len(&self) -> usize {
        self.notes.len()
    }
    pub fn is_empty(&self) -> bool {
        self.notes.is_empty()
    }
    pub fn get(&self, id: NoteId) -> Option<&Note> {
        self.notes.get(&id)
    }
    pub fn notes(&self) -> impl Iterator<Item = &Note> {
        self.notes.values()
    }

    // ---------- mutation ----------

    /// Insert a note with a known id (used when loading from storage).
    pub fn insert_raw(&mut self, mut note: Note) {
        note.path = normalize_path(&note.path);
        self.next_id = self.next_id.max(note.id + 1);
        self.reindex_fields(&mut note);
        self.by_path.insert(note.path.to_lowercase(), note.id);
        self.by_base
            .entry(basename(&note.path).to_lowercase())
            .or_default()
            .push(note.id);
        self.index_note(&note);
        self.notes.insert(note.id, note);
    }

    pub fn create(&mut self, path: &str, body: &str, now: f64) -> Result<NoteId, String> {
        let path = normalize_path(path);
        if path.is_empty() {
            return Err("empty note name".into());
        }
        if self.by_path.contains_key(&path.to_lowercase()) {
            return Err(format!("note already exists: {path}"));
        }
        let id = self.next_id;
        self.insert_raw(Note {
            id,
            path,
            body: body.to_string(),
            created: now,
            updated: now,
            links: vec![],
            tags: vec![],
        });
        self.changes.push(ChangeEvent::NoteCreated { id });
        Ok(id)
    }

    pub fn update(&mut self, id: NoteId, body: &str, now: f64) -> Result<(), String> {
        let mut note = self.notes.remove(&id).ok_or("no such note")?;
        self.unindex_note(&note);
        note.body = body.to_string();
        note.updated = now;
        self.reindex_fields(&mut note);
        self.index_note(&note);
        self.notes.insert(id, note);
        self.changes.push(ChangeEvent::NoteUpdated { id });
        Ok(())
    }

    pub fn delete(&mut self, id: NoteId) -> bool {
        match self.notes.remove(&id) {
            Some(n) => {
                self.unindex_note(&n);
                self.by_path.remove(&n.path.to_lowercase());
                self.remove_base(&n);
                self.changes.push(ChangeEvent::NoteDeleted { id });
                true
            }
            None => false,
        }
    }

    /// Rename a note and rewrite `[[links]]` pointing at it. Returns ids of all modified notes.
    pub fn rename(&mut self, id: NoteId, new_path: &str, now: f64) -> Result<Vec<NoteId>, String> {
        let new_path = normalize_path(new_path);
        if new_path.is_empty() {
            return Err("empty note name".into());
        }
        let old = self.notes.get(&id).ok_or("no such note")?.clone();
        if old.path == new_path {
            return Ok(vec![]);
        }
        if let Some(&other) = self.by_path.get(&new_path.to_lowercase()) {
            if other != id {
                return Err(format!("note already exists: {new_path}"));
            }
        }
        // Collect rewrites against the *old* resolution state.
        let mut rewrites: Vec<(NoteId, String)> = Vec::new();
        for n in self.notes.values() {
            let mut body = n.body.clone();
            let mut changed = false;
            for l in n.links.iter().rev() {
                if self.resolve(&l.target) == Some(id) {
                    let target = if l.target.contains('/') {
                        new_path.clone()
                    } else {
                        basename(&new_path).to_string()
                    };
                    body.replace_range(l.start..l.end, &l.render(&target));
                    changed = true;
                }
            }
            if changed {
                rewrites.push((n.id, body));
            }
        }
        // Re-key the note.
        self.by_path.remove(&old.path.to_lowercase());
        self.remove_base(&old);
        self.by_path.insert(new_path.to_lowercase(), id);
        self.by_base
            .entry(basename(&new_path).to_lowercase())
            .or_default()
            .push(id);
        let n = self.notes.get_mut(&id).unwrap();
        n.path = new_path.clone();
        n.updated = now;
        let mut modified = vec![id];
        for (nid, body) in rewrites {
            self.update(nid, &body, now)?;
            if !modified.contains(&nid) {
                modified.push(nid);
            }
        }
        // Self-links rewritten above go through `update`, which keeps the new path.
        self.changes.push(ChangeEvent::NoteRenamed {
            id,
            from: old.path,
            to: new_path,
        });
        Ok(modified)
    }

    fn remove_base(&mut self, n: &Note) {
        let key = basename(&n.path).to_lowercase();
        if let Some(v) = self.by_base.get_mut(&key) {
            v.retain(|&x| x != n.id);
            if v.is_empty() {
                self.by_base.remove(&key);
            }
        }
    }

    fn reindex_fields(&self, n: &mut Note) {
        let body = parse::strip_front_matter(&n.body);
        let off = n.body.len() - body.len();
        let mut links = parse::parse_links(&n.body);
        links.retain(|l| l.start >= off);
        n.links = links;
        n.tags = parse::parse_tags(body);
    }

    fn index_note(&mut self, n: &Note) {
        let mut tf: HashMap<String, u32> = HashMap::new();
        let mut len = 0;
        for t in tokenize(n.title())
            .into_iter()
            .chain(tokenize(&n.path))
            .chain(tokenize(&n.body))
        {
            *tf.entry(t).or_default() += 1;
            len += 1;
        }
        // Title matches count extra.
        for t in tokenize(n.title()) {
            *tf.entry(t).or_default() += 3;
        }
        for (t, c) in tf {
            self.index.entry(t).or_default().insert(n.id, c);
        }
        self.doc_len.insert(n.id, len);
    }

    fn unindex_note(&mut self, n: &Note) {
        let terms: HashSet<String> = tokenize(n.title())
            .into_iter()
            .chain(tokenize(&n.path))
            .chain(tokenize(&n.body))
            .collect();
        for t in terms {
            if let Some(m) = self.index.get_mut(&t) {
                m.remove(&n.id);
                if m.is_empty() {
                    self.index.remove(&t);
                }
            }
        }
        self.doc_len.remove(&n.id);
    }

    // ---------- links ----------

    /// Resolve a link target to a note: exact path first, then unique-ish basename.
    pub fn resolve(&self, target: &str) -> Option<NoteId> {
        let t = normalize_path(target).to_lowercase();
        if let Some(&id) = self.by_path.get(&t) {
            return Some(id);
        }
        let ids = self.by_base.get(basename(&t))?;
        if t.contains('/') {
            // `a/b` should only match a note whose path ends with it.
            return ids
                .iter()
                .copied()
                .find(|id| self.notes[id].path.to_lowercase().ends_with(&t));
        }
        ids.iter().copied().min_by_key(|id| &self.notes[id].path)
    }

    pub fn outgoing(&self, id: NoteId) -> Vec<NoteId> {
        let mut out = Vec::new();
        if let Some(n) = self.notes.get(&id) {
            for l in &n.links {
                if let Some(t) = self.resolve(&l.target) {
                    if t != id && !out.contains(&t) {
                        out.push(t);
                    }
                }
            }
        }
        out
    }

    pub fn unresolved(&self, id: NoteId) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        if let Some(n) = self.notes.get(&id) {
            for l in &n.links {
                if self.resolve(&l.target).is_none() && !out.contains(&l.target) {
                    out.push(l.target.clone());
                }
            }
        }
        out
    }

    pub fn backlinks(&self, id: NoteId) -> Vec<Backlink> {
        let mut out = Vec::new();
        for n in self.notes.values() {
            if n.id == id {
                continue;
            }
            if let Some(l) = n.links.iter().find(|l| self.resolve(&l.target) == Some(id)) {
                out.push(Backlink {
                    from: n.id,
                    path: n.path.clone(),
                    snippet: snippet_around(&n.body, l.start, l.end),
                });
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out
    }

    /// Notes that mention this note's title as plain text without linking to it.
    pub fn unlinked_mentions(&self, id: NoteId) -> Vec<Backlink> {
        let Some(me) = self.notes.get(&id) else {
            return vec![];
        };
        let title = me.title().to_lowercase();
        if title.len() < 3 {
            return vec![];
        }
        let mut out = Vec::new();
        for n in self.notes.values() {
            if n.id == id || n.links.iter().any(|l| self.resolve(&l.target) == Some(id)) {
                continue;
            }
            if let Some(pos) = n.body.to_lowercase().find(&title) {
                if n.body.is_char_boundary(pos) {
                    out.push(Backlink {
                        from: n.id,
                        path: n.path.clone(),
                        snippet: snippet_around(&n.body, pos, pos + title.len()),
                    });
                }
            }
        }
        out
    }

    pub fn list(&self) -> Vec<NoteInfo> {
        self.notes
            .values()
            .map(|n| NoteInfo {
                id: n.id,
                path: n.path.clone(),
                title: n.title().to_string(),
                updated: n.updated,
            })
            .collect()
    }

    /// Path/title autocomplete for `[[`.
    pub fn suggest(&self, prefix: &str, limit: usize) -> Vec<NoteInfo> {
        let p = prefix.trim().to_lowercase();
        let mut v: Vec<(u8, NoteInfo)> = self
            .notes
            .values()
            .filter_map(|n| {
                let path = n.path.to_lowercase();
                let rank = if n.title().to_lowercase().starts_with(&p) {
                    0
                } else if path.contains(&p) {
                    1
                } else {
                    return None;
                };
                Some((
                    rank,
                    NoteInfo {
                        id: n.id,
                        path: n.path.clone(),
                        title: n.title().to_string(),
                        updated: n.updated,
                    },
                ))
            })
            .collect();
        v.sort_by(|a, b| {
            a.0.cmp(&b.0).then(
                b.1.updated
                    .partial_cmp(&a.1.updated)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
        });
        v.into_iter().take(limit).map(|x| x.1).collect()
    }

    // ---------- tags ----------

    /// Tag -> number of notes, counting parents (`a/b` also counts toward `a`).
    pub fn tag_counts(&self) -> Vec<(String, u32)> {
        let mut m: BTreeMap<String, u32> = BTreeMap::new();
        for n in self.notes.values() {
            let mut seen: HashSet<String> = HashSet::new();
            for t in &n.tags {
                let mut acc = String::new();
                for part in t.split('/') {
                    if !acc.is_empty() {
                        acc.push('/');
                    }
                    acc.push_str(part);
                    seen.insert(acc.clone());
                }
            }
            for t in seen {
                *m.entry(t).or_default() += 1;
            }
        }
        m.into_iter().collect()
    }

    pub fn notes_with_tag(&self, tag: &str) -> Vec<NoteInfo> {
        let tag = tag.trim_start_matches('#').to_lowercase();
        let pre = format!("{tag}/");
        self.notes
            .values()
            .filter(|n| n.tags.iter().any(|t| *t == tag || t.starts_with(&pre)))
            .map(|n| NoteInfo {
                id: n.id,
                path: n.path.clone(),
                title: n.title().to_string(),
                updated: n.updated,
            })
            .collect()
    }

    // ---------- search ----------

    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        let toks = tokenize(query);
        if toks.is_empty() {
            return vec![];
        }
        let n_docs = self.notes.len() as f32;
        let avg_len = (self.doc_len.values().sum::<u32>() as f32 / n_docs.max(1.0)).max(1.0);
        let (k1, b) = (1.2f32, 0.75f32);
        let mut scores: HashMap<NoteId, f32> = HashMap::new();
        let mut matched_terms: HashMap<NoteId, usize> = HashMap::new();
        for (qi, tok) in toks.iter().enumerate() {
            let last = qi == toks.len() - 1;
            // Per-note best contribution for this query token (prefix match for the last one).
            let mut best: HashMap<NoteId, f32> = HashMap::new();
            let mut feed = |term: &str, postings: &HashMap<NoteId, u32>| {
                let df = postings.len() as f32;
                let idf = ((n_docs - df + 0.5) / (df + 0.5) + 1.0).ln();
                let exact = if term == tok { 1.0 } else { 0.6 };
                for (&id, &tf) in postings {
                    let dl = *self.doc_len.get(&id).unwrap_or(&1) as f32;
                    let tf = tf as f32;
                    let s =
                        exact * idf * tf * (k1 + 1.0) / (tf + k1 * (1.0 - b + b * dl / avg_len));
                    let e = best.entry(id).or_insert(0.0);
                    if s > *e {
                        *e = s;
                    }
                }
            };
            if last {
                for (term, postings) in &self.index {
                    if term.starts_with(tok.as_str()) {
                        feed(term, postings);
                    }
                }
            } else if let Some(postings) = self.index.get(tok) {
                feed(tok, postings);
            }
            for (id, s) in best {
                *scores.entry(id).or_default() += s;
                *matched_terms.entry(id).or_default() += 1;
            }
        }
        let mut hits: Vec<SearchHit> = scores
            .into_iter()
            .filter(|(id, _)| matched_terms[id] == toks.len()) // AND semantics
            .filter_map(|(id, score)| {
                let n = self.notes.get(&id)?;
                let pos = n.body.to_lowercase().find(toks[0].as_str()).unwrap_or(0);
                let pos = if n.body.is_char_boundary(pos) { pos } else { 0 };
                Some(SearchHit {
                    id,
                    path: n.path.clone(),
                    score,
                    snippet: snippet_around(&n.body, pos, pos),
                })
            })
            .collect();
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap()
                .then(a.path.cmp(&b.path))
        });
        hits.truncate(limit);
        hits
    }

    // ---------- graph ----------

    fn edge_list(&self) -> Vec<(NoteId, NoteId)> {
        let mut seen = HashSet::new();
        let mut edges = Vec::new();
        for n in self.notes.values() {
            for t in self.outgoing(n.id) {
                let key = if n.id < t { (n.id, t) } else { (t, n.id) };
                if seen.insert(key) {
                    edges.push((n.id, t));
                }
            }
        }
        edges
    }

    /// Whole graph, or the neighbourhood of `focus` up to `depth` hops (undirected).
    pub fn graph(&self, focus: Option<NoteId>, depth: u32) -> GraphData {
        let all = self.edge_list();
        let keep: Option<HashSet<NoteId>> = focus
            .filter(|f| self.notes.contains_key(f))
            .map(|f| self.neighbors_within(f, depth, &all));
        let edges: Vec<_> = all
            .into_iter()
            .filter(|(a, b)| keep.as_ref().is_none_or(|k| k.contains(a) && k.contains(b)))
            .collect();
        let mut degree: HashMap<NoteId, u32> = HashMap::new();
        for (a, b) in &edges {
            *degree.entry(*a).or_default() += 1;
            *degree.entry(*b).or_default() += 1;
        }
        let nodes = self
            .notes
            .values()
            .filter(|n| keep.as_ref().is_none_or(|k| k.contains(&n.id)))
            .map(|n| GraphNode {
                id: n.id,
                title: n.title().to_string(),
                path: n.path.clone(),
                degree: degree.get(&n.id).copied().unwrap_or(0),
                tag: n
                    .tags
                    .first()
                    .map(|t| t.split('/').next().unwrap_or(t).to_string()),
            })
            .collect();
        GraphData { nodes, edges }
    }

    fn neighbors_within(
        &self,
        start: NoteId,
        depth: u32,
        edges: &[(NoteId, NoteId)],
    ) -> HashSet<NoteId> {
        let mut adj: HashMap<NoteId, Vec<NoteId>> = HashMap::new();
        for &(a, b) in edges {
            adj.entry(a).or_default().push(b);
            adj.entry(b).or_default().push(a);
        }
        let mut seen: HashSet<NoteId> = HashSet::from([start]);
        let mut q = VecDeque::from([(start, 0u32)]);
        while let Some((n, d)) = q.pop_front() {
            if d == depth {
                continue;
            }
            for &m in adj.get(&n).into_iter().flatten() {
                if seen.insert(m) {
                    q.push_back((m, d + 1));
                }
            }
        }
        seen
    }

    pub fn neighbors(&self, id: NoteId, depth: u32) -> Vec<NoteId> {
        let edges = self.edge_list();
        let mut v: Vec<_> = self
            .neighbors_within(id, depth, &edges)
            .into_iter()
            .filter(|&n| n != id)
            .collect();
        v.sort();
        v
    }
}

/// ~120 chars of context around a byte range, single line.
pub fn snippet_around(body: &str, start: usize, end: usize) -> String {
    let mut s = start.saturating_sub(60);
    while !body.is_char_boundary(s) {
        s -= 1;
    }
    let mut e = (end + 60).min(body.len());
    while !body.is_char_boundary(e) {
        e += 1;
    }
    let text = body[s..e].replace('\n', " ");
    format!(
        "{}{}{}",
        if s > 0 { "…" } else { "" },
        text.trim(),
        if e < body.len() { "…" } else { "" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> Vault {
        let mut v = Vault::new();
        v.create(
            "Home",
            "Welcome. See [[Ideas]] and [[Projects/Rust]] #hub",
            1.0,
        )
        .unwrap();
        v.create(
            "Ideas",
            "Idea about rust and wasm. Back to [[Home]] #idea/big",
            2.0,
        )
        .unwrap();
        v.create("Projects/Rust", "Rust notes. [[Missing]]", 3.0)
            .unwrap();
        v
    }

    #[test]
    fn resolve_and_backlinks() {
        let v = vault();
        let home = v.resolve("home").unwrap();
        let rust = v.resolve("Rust").unwrap();
        assert_eq!(v.get(rust).unwrap().path, "Projects/Rust");
        let bl = v.backlinks(home);
        assert_eq!(bl.len(), 1);
        assert_eq!(bl[0].path, "Ideas");
        assert_eq!(v.unresolved(rust), vec!["Missing"]);
        assert_eq!(v.outgoing(home).len(), 2);
    }

    #[test]
    fn rename_rewrites_links() {
        let mut v = vault();
        let ideas = v.resolve("Ideas").unwrap();
        let home = v.resolve("Home").unwrap();
        let changed = v.rename(ideas, "Thoughts", 9.0).unwrap();
        assert!(changed.contains(&home));
        assert!(v.get(home).unwrap().body.contains("[[Thoughts]]"));
        assert_eq!(v.resolve("Ideas"), None);
        assert_eq!(v.backlinks(ideas).len(), 1);
        assert!(v.rename(ideas, "home", 9.0).is_err());
    }

    #[test]
    fn rename_keeps_alias_and_path_style() {
        let mut v = Vault::new();
        let a = v.create("A", "x", 1.0).unwrap();
        let b = v.create("B", "[[A|the a]] [[A#Sec]]", 1.0).unwrap();
        v.rename(a, "Dir/A2", 2.0).unwrap();
        assert_eq!(v.get(b).unwrap().body, "[[A2|the a]] [[A2#Sec]]");
    }

    #[test]
    fn tags() {
        let v = vault();
        let counts: HashMap<_, _> = v.tag_counts().into_iter().collect();
        assert_eq!(counts["idea"], 1);
        assert_eq!(counts["idea/big"], 1);
        assert_eq!(v.notes_with_tag("#idea").len(), 1);
    }

    #[test]
    fn search_ranking_and_prefix() {
        let mut v = vault();
        let hits = v.search("rust", 10);
        assert_eq!(hits[0].path, "Projects/Rust"); // title match wins
        assert_eq!(v.search("was", 10).len(), 1); // prefix on last token
        assert!(v.search("rust zzz", 10).is_empty()); // AND
        let id = v.resolve("Ideas").unwrap();
        v.update(id, "nothing here", 5.0).unwrap();
        assert_eq!(v.search("wasm", 10).len(), 0); // index updated
        v.delete(id);
        assert!(v.search("ideas", 10).iter().all(|h| h.id != id));
    }

    #[test]
    fn search_cyrillic() {
        let mut v = Vault::new();
        v.create("Нотатка", "Привіт, Світ! Це тест", 1.0).unwrap();
        assert_eq!(v.search("світ", 5).len(), 1);
        assert_eq!(v.search("прив", 5).len(), 1);
    }

    #[test]
    fn graph_local_and_global() {
        let v = vault();
        let g = v.graph(None, 0);
        assert_eq!(g.nodes.len(), 3);
        assert_eq!(g.edges.len(), 2);
        let ideas = v.resolve("Ideas").unwrap();
        assert_eq!(v.graph(Some(ideas), 1).nodes.len(), 2);
        assert_eq!(v.graph(Some(ideas), 2).nodes.len(), 3);
    }

    #[test]
    fn unlinked_mentions() {
        let mut v = vault();
        v.create("Scratch", "thinking about ideas today", 4.0)
            .unwrap();
        let ideas = v.resolve("Ideas").unwrap();
        let m = v.unlinked_mentions(ideas);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].path, "Scratch");
    }

    #[test]
    fn duplicate_and_front_matter() {
        let mut v = Vault::new();
        v.create("A", "---\ntitle: x\n---\n#tag [[B]]", 1.0)
            .unwrap();
        assert!(v.create("a", "", 1.0).is_err());
        assert_eq!(v.get(1).unwrap().tags, vec!["tag"]);
    }
}
