//! Graphnote core. Pure-Rust logic (`vault`, `parse`, `layout`, `ai`, `render`) plus a thin
//! wasm-bindgen facade (`Graphnote`) that exchanges JSON strings and typed arrays with the UI.

pub mod ai;
pub mod layout;
pub mod parse;
pub mod render;
pub mod vault;

use ai::KnowledgeProvider;
use layout::Layout;
use serde::{Deserialize, Serialize};
use vault::{Note, Vault};
use wasm_bindgen::prelude::*;

#[derive(Serialize, Deserialize)]
struct StoredNote {
    #[serde(default)]
    id: u32,
    path: String,
    body: String,
    #[serde(default)]
    created: f64,
    #[serde(default)]
    updated: f64,
}

fn js<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

fn err(e: impl ToString) -> JsValue {
    JsValue::from_str(&e.to_string())
}

#[wasm_bindgen]
pub struct Graphnote {
    vault: Vault,
    layout: Option<Layout>,
}

#[wasm_bindgen]
impl Graphnote {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Graphnote {
        Graphnote {
            vault: Vault::new(),
            layout: None,
        }
    }

    /// Load notes from a JSON array `[{id,path,body,created,updated}]`.
    pub fn load(&mut self, json: &str) -> Result<u32, JsValue> {
        let notes: Vec<StoredNote> = serde_json::from_str(json).map_err(err)?;
        let mut n = 0;
        for s in notes {
            if s.id == 0 {
                continue;
            }
            self.vault.insert_raw(Note {
                id: s.id,
                path: s.path,
                body: s.body,
                created: s.created,
                updated: s.updated,
                links: vec![],
                tags: vec![],
            });
            n += 1;
        }
        self.vault.changes.clear();
        Ok(n)
    }

    pub fn reserve_ids(&mut self, next: u32) {
        self.vault.reserve_ids(next);
    }

    pub fn note_count(&self) -> u32 {
        self.vault.len() as u32
    }

    pub fn create_note(&mut self, path: &str, body: &str, now: f64) -> Result<u32, JsValue> {
        self.vault.create(path, body, now).map_err(err)
    }

    pub fn update_note(&mut self, id: u32, body: &str, now: f64) -> Result<(), JsValue> {
        self.vault.update(id, body, now).map_err(err)
    }

    /// Returns JSON array of ids of every note whose stored data changed.
    pub fn rename_note(&mut self, id: u32, new_path: &str, now: f64) -> Result<String, JsValue> {
        self.vault
            .rename(id, new_path, now)
            .map(|v| js(&v))
            .map_err(err)
    }

    pub fn delete_note(&mut self, id: u32) -> bool {
        self.vault.delete(id)
    }

    /// `{id,path,body,created,updated}` for persistence.
    pub fn get_note(&self, id: u32) -> String {
        match self.vault.get(id) {
            Some(n) => js(&StoredNote {
                id: n.id,
                path: n.path.clone(),
                body: n.body.clone(),
                created: n.created,
                updated: n.updated,
            }),
            None => "null".into(),
        }
    }

    pub fn list_notes(&self) -> String {
        js(&self.vault.list())
    }

    pub fn resolve(&self, target: &str) -> Option<u32> {
        self.vault.resolve(target)
    }

    pub fn suggest(&self, prefix: &str, limit: u32) -> String {
        js(&self.vault.suggest(prefix, limit as usize))
    }

    pub fn backlinks(&self, id: u32) -> String {
        js(&self.vault.backlinks(id))
    }

    pub fn unlinked_mentions(&self, id: u32) -> String {
        js(&self.vault.unlinked_mentions(id))
    }

    pub fn outgoing(&self, id: u32) -> String {
        let v: Vec<_> = self
            .vault
            .outgoing(id)
            .into_iter()
            .filter_map(|t| self.vault.get(t).map(|n| (n.id, n.path.clone())))
            .collect();
        js(&v)
    }

    pub fn unresolved(&self, id: u32) -> String {
        js(&self.vault.unresolved(id))
    }

    pub fn tags(&self) -> String {
        js(&self.vault.tag_counts())
    }

    pub fn notes_with_tag(&self, tag: &str) -> String {
        js(&self.vault.notes_with_tag(tag))
    }

    pub fn search(&self, query: &str, limit: u32) -> String {
        js(&self.vault.search(query, limit as usize))
    }

    /// Headings `[{level,text,line}]` for the outline panel.
    pub fn outline(&self, id: u32) -> String {
        js(&self
            .vault
            .get(id)
            .map(|n| parse::parse_outline(&n.body))
            .unwrap_or_default())
    }

    pub fn render_html(&self, id: u32) -> String {
        self.vault
            .get(id)
            .map(|n| render::render_html(&n.body))
            .unwrap_or_default()
    }

    // ----- graph -----

    /// Graph metadata as JSON `{nodes,edges}`; `focus < 0` means the whole vault.
    pub fn graph(&self, focus: i32, depth: u32) -> String {
        js(&self.vault.graph(u32::try_from(focus).ok(), depth))
    }

    /// Build a fresh layout for the same selection as `graph`. Returns node ids in layout order.
    pub fn layout_init(&mut self, focus: i32, depth: u32) -> Vec<u32> {
        let l = Layout::new(&self.vault.graph(u32::try_from(focus).ok(), depth));
        let ids = l.ids.clone();
        self.layout = Some(l);
        ids
    }

    /// Flattened `[a0,b0,a1,b1,...]` of node indexes.
    pub fn layout_edges(&self) -> Vec<u32> {
        self.layout
            .as_ref()
            .map(|l| l.edges.iter().flat_map(|&(a, b)| [a, b]).collect())
            .unwrap_or_default()
    }

    /// Advance the simulation; returns `[x0,y0,x1,y1,...]`.
    pub fn layout_step(&mut self, iterations: u32) -> Vec<f32> {
        match self.layout.as_mut() {
            Some(l) => {
                l.step(iterations);
                l.positions().to_vec()
            }
            None => vec![],
        }
    }

    pub fn layout_energy(&self) -> f32 {
        self.layout.as_ref().map_or(0.0, |l| l.energy())
    }

    // ----- AI-ready layer -----

    pub fn context_bundle(&self, id: u32, token_budget: u32) -> String {
        js(&self.vault.get_context_bundle(id, token_budget as usize))
    }

    pub fn link_suggestions(&self, id: u32) -> String {
        js(&ai::heuristic_link_suggestions(&self.vault, id))
    }

    pub fn chunks(&self, id: u32) -> String {
        js(&self
            .vault
            .get(id)
            .map(|n| ai::chunk_note(&n.body))
            .unwrap_or_default())
    }

    /// Drain the change log (`NoteCreated`, `NoteUpdated`, ...).
    pub fn take_changes(&mut self) -> String {
        js(&std::mem::take(&mut self.vault.changes))
    }
}

impl Default for Graphnote {
    fn default() -> Self {
        Self::new()
    }
}
