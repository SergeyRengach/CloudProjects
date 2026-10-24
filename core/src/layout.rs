//! Force-directed graph layout. State persists across `step` calls so the UI can animate it.
//! Repulsion is O(n^2) per iteration: fine to ~1500 nodes on iPad; grid/Barnes-Hut is a TODO.

use crate::vault::{GraphData, NoteId};
use std::collections::HashMap;

pub struct Layout {
    pub ids: Vec<NoteId>,
    pub edges: Vec<(u32, u32)>,
    pos: Vec<f32>, // x0,y0,x1,y1...
    vel: Vec<f32>,
}

const REPULSION: f32 = 1800.0;
const SPRING_LEN: f32 = 70.0;
const SPRING_K: f32 = 0.04;
const GRAVITY: f32 = 0.012;
const DAMPING: f32 = 0.82;
const MAX_STEP: f32 = 24.0;

impl Layout {
    pub fn new(g: &GraphData) -> Self {
        let n = g.nodes.len();
        let ids: Vec<NoteId> = g.nodes.iter().map(|n| n.id).collect();
        let index: HashMap<NoteId, u32> = ids
            .iter()
            .enumerate()
            .map(|(i, &id)| (id, i as u32))
            .collect();
        let edges = g
            .edges
            .iter()
            .filter_map(|(a, b)| Some((*index.get(a)?, *index.get(b)?)))
            .collect();
        // Deterministic spiral start so results are reproducible.
        let mut pos = Vec::with_capacity(n * 2);
        for i in 0..n {
            let r = 20.0 * (i as f32 + 1.0).sqrt() * 2.0;
            let a = i as f32 * 2.399_963; // golden angle
            pos.push(r * a.cos());
            pos.push(r * a.sin());
        }
        Layout {
            ids,
            edges,
            pos,
            vel: vec![0.0; n * 2],
        }
    }

    pub fn positions(&self) -> &[f32] {
        &self.pos
    }

    pub fn step(&mut self, iterations: u32) {
        let n = self.ids.len();
        for _ in 0..iterations {
            let mut force = vec![0.0f32; n * 2];
            for i in 0..n {
                for j in (i + 1)..n {
                    let dx = self.pos[i * 2] - self.pos[j * 2];
                    let dy = self.pos[i * 2 + 1] - self.pos[j * 2 + 1];
                    let d2 = (dx * dx + dy * dy).max(1.0);
                    let d = d2.sqrt();
                    let f = REPULSION / d2;
                    let (fx, fy) = (f * dx / d, f * dy / d);
                    force[i * 2] += fx;
                    force[i * 2 + 1] += fy;
                    force[j * 2] -= fx;
                    force[j * 2 + 1] -= fy;
                }
            }
            for &(a, b) in &self.edges {
                let (a, b) = (a as usize, b as usize);
                let dx = self.pos[b * 2] - self.pos[a * 2];
                let dy = self.pos[b * 2 + 1] - self.pos[a * 2 + 1];
                let d = (dx * dx + dy * dy).sqrt().max(0.01);
                let f = (d - SPRING_LEN) * SPRING_K;
                let (fx, fy) = (f * dx / d, f * dy / d);
                force[a * 2] += fx;
                force[a * 2 + 1] += fy;
                force[b * 2] -= fx;
                force[b * 2 + 1] -= fy;
            }
            for i in 0..n {
                for k in 0..2 {
                    let idx = i * 2 + k;
                    force[idx] -= GRAVITY * self.pos[idx];
                    let v = ((self.vel[idx] + force[idx]) * DAMPING).clamp(-MAX_STEP, MAX_STEP);
                    self.vel[idx] = v;
                    self.pos[idx] += v;
                }
            }
        }
    }

    /// Kinetic energy; the UI stops animating when this is small.
    pub fn energy(&self) -> f32 {
        self.vel.iter().map(|v| v * v).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::Vault;

    #[test]
    fn converges_without_nan() {
        let mut v = Vault::new();
        v.create("A", "[[B]] [[C]]", 0.0).unwrap();
        v.create("B", "[[C]]", 0.0).unwrap();
        v.create("C", "", 0.0).unwrap();
        v.create("Lonely", "", 0.0).unwrap();
        let mut l = Layout::new(&v.graph(None, 0));
        l.step(400);
        assert!(l.positions().iter().all(|p| p.is_finite()));
        assert!(l.energy() < 1.0, "energy {}", l.energy());
        let p = l.positions();
        let dist = |i: usize, j: usize| {
            ((p[i * 2] - p[j * 2]).powi(2) + (p[i * 2 + 1] - p[j * 2 + 1]).powi(2)).sqrt()
        };
        assert!(dist(0, 1) > 5.0 && dist(0, 1) < 300.0);
        assert!(dist(0, 3) > 5.0); // no overlap
    }

    #[test]
    fn deterministic() {
        let mut v = Vault::new();
        v.create("A", "[[B]]", 0.0).unwrap();
        v.create("B", "", 0.0).unwrap();
        let g = v.graph(None, 0);
        let (mut a, mut b) = (Layout::new(&g), Layout::new(&g));
        a.step(50);
        b.step(50);
        assert_eq!(a.positions(), b.positions());
    }
}
