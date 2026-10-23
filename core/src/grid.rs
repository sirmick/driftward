//! A spatial hash of the ships, rebuilt each tick, so a shell or a burst only looks at the ships near it (combat.rs).
//!
//! Each ship that can be hit (alive, off its rails) goes in the cell of `CELL` metres holding its centre. Cells hash into
//! `buckets` (a power of two, a few per ship slot); a counting sort lays the ships out bucket by bucket in `items`, with
//! bucket b's at `start[b]..start[b + 1]`. A query names a box; it visits every cell the box touches, grown by the
//! farthest any ship's shield reaches from its centre (`reach`, measured at build), and yields the ships whose own cell
//! is that one, so two cells hashing alike never yield a ship twice. Scratch only: outside the snapshot and the hash,
//! rebuilt from the ships whenever it is used, so saves and replays never see it.

/// A cell's side, metres: about a big hull's reach, so a query touches few cells.
pub const CELL: f64 = 250.0;

#[derive(Default)]
pub struct Grid {
    mask: usize,
    start: Vec<u32>,
    fill: Vec<u32>,
    items: Vec<u16>,
    cx: Vec<i32>,
    cy: Vec<i32>,
    /// how far from its centre any ship in the grid can be hit (outline radius plus shield), metres
    pub reach: f64,
    /// a query's ships, for a caller that changes the world as it goes through them (taken and put back)
    pub buf: Vec<usize>,
}

fn cell(v: f64) -> i32 { (v / CELL).floor() as i32 }
fn hash(cx: i32, cy: i32, mask: usize) -> usize { ((cx as u32).wrapping_mul(0x9E37_79B1) ^ (cy as u32).wrapping_mul(0x85EB_CA77)) as usize & mask }

impl Grid {
    pub fn new(max_ships: usize) -> Grid {
        let n = (max_ships * 4).max(64).next_power_of_two();
        Grid { mask: n - 1, start: vec![0; n + 1], fill: vec![0; n + 1], items: vec![0; max_ships], cx: vec![0; max_ships], cy: vec![0; max_ships], reach: 0.0, buf: Vec::with_capacity(max_ships) }
    }

    /// Lay out ships 0..n: `put(i)` gives ship i's position and how far from it it can be hit, or None to leave it out.
    pub fn build(&mut self, n: usize, mut put: impl FnMut(usize) -> Option<(f64, f64, f64)>) {
        self.start.fill(0);
        self.reach = 0.0;
        // count each bucket's ships (at start[b + 1]), remembering each ship's cell
        let mut inside = 0;
        for i in 0..n {
            let Some((x, y, r)) = put(i) else { self.cx[i] = i32::MIN; continue };
            (self.cx[i], self.cy[i]) = (cell(x), cell(y));
            self.reach = self.reach.max(r);
            self.start[hash(self.cx[i], self.cy[i], self.mask) + 1] += 1;
            inside += 1;
        }
        // running totals: bucket b starts at start[b]
        for k in 1..self.start.len() { self.start[k] += self.start[k - 1]; }
        debug_assert_eq!(self.start[self.mask + 1] as usize, inside);
        // place them, in slot order within each bucket
        self.fill.copy_from_slice(&self.start);
        for i in 0..n {
            if self.cx[i] == i32::MIN { continue; }
            let h = hash(self.cx[i], self.cy[i], self.mask);
            self.items[self.fill[h] as usize] = i as u16;
            self.fill[h] += 1;
        }
    }

    /// Every ship that could be hit inside the box (x0, y0)-(x1, y1) grown by `pad` metres, once each, in a fixed order.
    pub fn near(&self, x0: f64, y0: f64, x1: f64, y1: f64, pad: f64, mut f: impl FnMut(usize)) {
        let g = self.reach + pad;
        let (ax, bx) = (cell(x0.min(x1) - g), cell(x0.max(x1) + g));
        let (ay, by) = (cell(y0.min(y1) - g), cell(y0.max(y1) + g));
        for cy in ay..=by {
            for cx in ax..=bx {
                let h = hash(cx, cy, self.mask);
                for &i in &self.items[self.start[h] as usize..self.start[h + 1] as usize] {
                    let i = i as usize;
                    if self.cx[i] == cx && self.cy[i] == cy { f(i); }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_ships_near_and_each_once() {
        let mut g = Grid::new(8);
        let pos = [(0.0, 0.0), (240.0, 10.0), (260.0, 10.0), (5000.0, 5000.0), (-30.0, -30.0)];
        g.build(pos.len(), |i| if i == 4 { None } else { Some((pos[i].0, pos[i].1, 20.0)) });
        let mut seen = vec![];
        g.near(-10.0, -10.0, 10.0, 10.0, 0.0, |i| seen.push(i));
        seen.sort();
        assert!(seen.contains(&0) && !seen.contains(&3) && !seen.contains(&4), "{seen:?}");
        // a box over everything yields each ship once
        let mut all = vec![];
        g.near(-100.0, -100.0, 5100.0, 5100.0, 0.0, |i| all.push(i));
        all.sort();
        assert_eq!(all, vec![0, 1, 2, 3]);
    }
}
