//! AI-ready layer. Nothing here talks to a model: it defines the interfaces a future
//! Claude integration (tool use / RAG) plugs into. See docs/AI_INTEGRATION.md.

use crate::parse::strip_front_matter;
use crate::vault::{Backlink, NoteId, NoteInfo, SearchHit, Vault};
use serde::Serialize;
use std::collections::HashMap;

/// Read-only view of the knowledge base for an AI agent.
pub trait KnowledgeProvider {
    fn get_note(&self, id: NoteId) -> Option<NoteView>;
    fn search(&self, query: &str, limit: usize) -> Vec<SearchHit>;
    fn neighbors(&self, id: NoteId, depth: u32) -> Vec<NoteId>;
    fn backlinks(&self, id: NoteId) -> Vec<Backlink>;
    fn list_tags(&self) -> Vec<(String, u32)>;
    fn get_context_bundle(&self, id: NoteId, token_budget: usize) -> Option<ContextBundle>;
}

#[derive(Clone, Debug, Serialize)]
pub struct NoteView {
    pub id: NoteId,
    pub path: String,
    pub body: String,
    pub tags: Vec<String>,
    pub links_to: Vec<NoteId>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ContextItem {
    pub id: NoteId,
    pub path: String,
    /// "focus" | "outgoing" | "backlink" | "neighbor"
    pub relation: &'static str,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ContextBundle {
    pub focus: NoteId,
    pub items: Vec<ContextItem>,
    pub approx_tokens: usize,
    pub truncated: bool,
}

/// Rough token estimate (~4 chars/token); good enough for budgeting.
pub fn approx_tokens(s: &str) -> usize {
    s.chars().count().div_ceil(4)
}

impl KnowledgeProvider for Vault {
    fn get_note(&self, id: NoteId) -> Option<NoteView> {
        let n = Vault::get(self, id)?;
        Some(NoteView {
            id,
            path: n.path.clone(),
            body: n.body.clone(),
            tags: n.tags.clone(),
            links_to: self.outgoing(id),
        })
    }
    fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        Vault::search(self, query, limit)
    }
    fn neighbors(&self, id: NoteId, depth: u32) -> Vec<NoteId> {
        Vault::neighbors(self, id, depth)
    }
    fn backlinks(&self, id: NoteId) -> Vec<Backlink> {
        Vault::backlinks(self, id)
    }
    fn list_tags(&self) -> Vec<(String, u32)> {
        self.tag_counts()
    }

    /// Focus note first, then outgoing links, backlinks and 2-hop neighbours, until the budget is spent.
    fn get_context_bundle(&self, id: NoteId, token_budget: usize) -> Option<ContextBundle> {
        let focus = Vault::get(self, id)?;
        let mut order: Vec<(NoteId, &'static str)> = vec![(id, "focus")];
        for t in self.outgoing(id) {
            order.push((t, "outgoing"));
        }
        for b in Vault::backlinks(self, id) {
            order.push((b.from, "backlink"));
        }
        for n in Vault::neighbors(self, id, 2) {
            order.push((n, "neighbor"));
        }
        let mut seen = std::collections::HashSet::new();
        let (mut items, mut used, mut truncated) = (Vec::new(), 0usize, false);
        for (nid, rel) in order {
            if !seen.insert(nid) {
                continue;
            }
            let n = Vault::get(self, nid).unwrap();
            let mut text = strip_front_matter(&n.body).trim().to_string();
            let cost = approx_tokens(&text) + approx_tokens(&n.path) + 4;
            if used + cost > token_budget {
                let room = token_budget.saturating_sub(used + approx_tokens(&n.path) + 4) * 4;
                if rel != "focus" && room < 80 {
                    truncated = true;
                    break;
                }
                text = text.chars().take(room).collect::<String>() + "…";
                truncated = true;
            }
            used += approx_tokens(&text) + approx_tokens(&n.path) + 4;
            items.push(ContextItem {
                id: nid,
                path: n.path.clone(),
                relation: rel,
                text,
            });
            if truncated {
                break;
            }
        }
        let _ = focus;
        Some(ContextBundle {
            focus: id,
            items,
            approx_tokens: used,
            truncated,
        })
    }
}

// ---------- embeddings (stub) ----------

pub trait EmbeddingProvider {
    fn embed(&self, text: &str) -> Option<Vec<f32>>;
}

/// v1 default: no model, no vectors.
pub struct NoopProvider;
impl EmbeddingProvider for NoopProvider {
    fn embed(&self, _: &str) -> Option<Vec<f32>> {
        None
    }
}

pub trait EmbeddingStore {
    fn upsert(&mut self, key: &str, vector: Vec<f32>);
    fn remove_prefix(&mut self, prefix: &str);
    fn nearest(&self, vector: &[f32], k: usize) -> Vec<(String, f32)>;
}

#[derive(Default)]
pub struct InMemoryEmbeddingStore {
    items: HashMap<String, Vec<f32>>,
}

impl EmbeddingStore for InMemoryEmbeddingStore {
    fn upsert(&mut self, key: &str, vector: Vec<f32>) {
        self.items.insert(key.to_string(), vector);
    }
    fn remove_prefix(&mut self, prefix: &str) {
        self.items.retain(|k, _| !k.starts_with(prefix));
    }
    fn nearest(&self, vector: &[f32], k: usize) -> Vec<(String, f32)> {
        let mut v: Vec<_> = self
            .items
            .iter()
            .map(|(key, e)| (key.clone(), cosine(vector, e)))
            .collect();
        v.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.0.cmp(&b.0))
        });
        v.truncate(k);
        v
    }
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let (na, nb) = (
        a.iter().map(|x| x * x).sum::<f32>().sqrt(),
        b.iter().map(|x| x * x).sum::<f32>().sqrt(),
    );
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Chunk {
    pub heading: String,
    pub text: String,
}

/// Split a note into chunks at markdown headings (code fences respected).
pub fn chunk_note(body: &str) -> Vec<Chunk> {
    let body = strip_front_matter(body);
    let (mut chunks, mut heading, mut buf, mut in_fence) =
        (Vec::new(), String::new(), String::new(), false);
    let flush = |chunks: &mut Vec<Chunk>, heading: &str, buf: &mut String| {
        if !buf.trim().is_empty() {
            chunks.push(Chunk {
                heading: heading.to_string(),
                text: buf.trim().to_string(),
            });
        }
        buf.clear();
    };
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
        }
        if !in_fence && line.starts_with('#') && line.trim_start_matches('#').starts_with(' ') {
            flush(&mut chunks, &heading, &mut buf);
            heading = line.trim_start_matches('#').trim().to_string();
        } else {
            buf.push_str(line);
            buf.push('\n');
        }
    }
    flush(&mut chunks, &heading, &mut buf);
    chunks
}

// ---------- suggestions (UI panel placeholder) ----------

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind")]
pub enum SuggestionKind {
    LinkSuggestion { to: NoteId },
    TagSuggestion { tag: String },
    Summary { text: String },
    NewNote { path: String, body: String },
}

#[derive(Clone, Debug, Serialize)]
pub struct Suggestion {
    pub target: NoteId,
    #[serde(flatten)]
    pub kind: SuggestionKind,
    pub confidence: f32,
}

/// Cheap non-AI baseline: suggest linking to notes whose title appears in this note's text.
pub fn heuristic_link_suggestions(v: &Vault, id: NoteId) -> Vec<Suggestion> {
    let Some(me) = Vault::get(v, id) else {
        return vec![];
    };
    let body = me.body.to_lowercase();
    let linked: Vec<NoteId> = v.outgoing(id);
    v.list()
        .into_iter()
        .filter(|n: &NoteInfo| {
            n.id != id
                && n.title.chars().count() >= 4
                && !linked.contains(&n.id)
                && body.contains(&n.title.to_lowercase())
        })
        .map(|n| Suggestion {
            target: id,
            kind: SuggestionKind::LinkSuggestion { to: n.id },
            confidence: 0.5,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> Vault {
        let mut v = Vault::new();
        v.create("Home", "# Home\nLinks: [[Ideas]]", 0.0).unwrap();
        v.create("Ideas", "back to [[Home]] ".repeat(50).as_str(), 0.0)
            .unwrap();
        v.create("Far", "[[Ideas]] far away", 0.0).unwrap();
        v
    }

    #[test]
    fn bundle_respects_budget() {
        let v = vault();
        let home = v.resolve("Home").unwrap();
        let big = v.get_context_bundle(home, 10_000).unwrap();
        assert_eq!(big.items[0].relation, "focus");
        assert_eq!(big.items.len(), 3);
        assert!(!big.truncated);
        let small = v.get_context_bundle(home, 60).unwrap();
        assert!(small.truncated);
        assert!(small.approx_tokens <= 70, "{}", small.approx_tokens);
    }

    #[test]
    fn chunking() {
        let c = chunk_note("intro\n# A\none\n```\n# not heading\n```\n## B\ntwo");
        assert_eq!(c.len(), 3);
        assert_eq!(c[1].heading, "A");
        assert!(c[1].text.contains("# not heading"));
        assert_eq!(c[2].heading, "B");
    }

    #[test]
    fn embeddings_nearest() {
        let mut s = InMemoryEmbeddingStore::default();
        s.upsert("a#0", vec![1.0, 0.0]);
        s.upsert("b#0", vec![0.0, 1.0]);
        assert_eq!(s.nearest(&[0.9, 0.1], 1)[0].0, "a#0");
        assert!(NoopProvider.embed("x").is_none());
    }

    #[test]
    fn heuristic_suggestions() {
        let mut v = vault();
        let id = v.create("Scratch", "I like Home and Ideas", 0.0).unwrap();
        let s = heuristic_link_suggestions(&v, id);
        assert_eq!(s.len(), 2);
    }
}
