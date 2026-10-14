//! Save and load: the whole world as one fixed-size byte image.
//!
//! Layout: an 80-byte little-endian header (magic, version, config, scalars, generator, player), then the
//! raw bytes of every column in manifest order. The size depends only on the config, so the buffer is
//! allocated with the world and nothing allocates at save or load time (WASM memory never grows, so the
//! page's column views stay valid). The page reaches the buffer through the "world/snapshot" column.

use crate::cols::ColumnDesc;
use crate::rng::Rng;
use crate::world::{Config, World};

pub const MAGIC: [u8; 4] = *b"DWSV";
/// Bump when the layout changes (a new column, a reordered header).
pub const VERSION: u32 = 9; // 2: ships.rot; 3, 4: Newtonian wells; 5: game wells; 6: bodies.kind/port, game, landing params;
// 7: types.cargo, game credits and debt, hold, market, economy params; 8: offers, missions, mission params;
// 9: ships.rail, bodies.pop, traffic, roles, lanes, traffic params
pub const HEADER_LEN: usize = 80;

#[derive(Debug, PartialEq, Eq)]
pub enum LoadError {
    BadMagic,
    BadVersion(u32),
    ConfigMismatch,
    Truncated,
}

impl LoadError {
    pub fn code(&self) -> i32 {
        match self { LoadError::BadMagic => 1, LoadError::BadVersion(_) => 2, LoadError::ConfigMismatch => 3, LoadError::Truncated => 4 }
    }
}

pub fn snapshot_len(cols: &[ColumnDesc]) -> usize {
    HEADER_LEN + cols.iter().map(|c| c.len * c.size).sum::<usize>()
}

struct Cursor<'a> { buf: &'a mut [u8], at: usize }
impl Cursor<'_> {
    fn put(&mut self, b: &[u8]) { self.buf[self.at..self.at + b.len()].copy_from_slice(b); self.at += b.len(); }
    fn take<const N: usize>(&mut self) -> [u8; N] { let mut a = [0u8; N]; a.copy_from_slice(&self.buf[self.at..self.at + N]); self.at += N; a }
    fn u32(&mut self) -> u32 { u32::from_le_bytes(self.take()) }
    fn u64(&mut self) -> u64 { u64::from_le_bytes(self.take()) }
    fn f64(&mut self) -> f64 { f64::from_le_bytes(self.take()) }
}

/// Config as stored in the header.
pub fn read_config(buf: &[u8]) -> Result<Config, LoadError> {
    if buf.len() < HEADER_LEN { return Err(LoadError::Truncated); }
    if buf[0..4] != MAGIC { return Err(LoadError::BadMagic); }
    let mut tmp = [0u8; HEADER_LEN];
    tmp.copy_from_slice(&buf[..HEADER_LEN]);
    let mut c = Cursor { buf: &mut tmp, at: 4 };
    let v = c.u32();
    if v != VERSION { return Err(LoadError::BadVersion(v)); }
    Ok(Config { max_ships: c.u32() as usize, max_types: c.u32() as usize, max_bodies: c.u32() as usize, env_n: c.u32() as usize, env_w: c.f64() })
}

impl World {
    /// Write the world into the snapshot buffer; returns its length.
    pub fn save(&mut self) -> usize {
        let (rs, ri) = self.rng.state();
        let mut snap = std::mem::take(&mut self.snap);
        {
            let mut c = Cursor { buf: &mut snap, at: 0 };
            c.put(&MAGIC);
            c.put(&VERSION.to_le_bytes());
            for v in [self.cfg.max_ships, self.cfg.max_types, self.cfg.max_bodies, self.cfg.env_n] { c.put(&(v as u32).to_le_bytes()); }
            c.put(&self.cfg.env_w.to_le_bytes());
            c.put(&(self.count as u32).to_le_bytes());
            c.put(&(self.n_bodies as u32).to_le_bytes());
            c.put(&self.tick.to_le_bytes());
            c.put(&rs.to_le_bytes());
            c.put(&ri.to_le_bytes());
            c.put(&self.player.slot.to_le_bytes());
            c.put(&self.player.set.to_le_bytes());
            c.put(&self.player.input.to_le_bytes());
            debug_assert_eq!(c.at, HEADER_LEN);
            for col in &self.cols {
                // SAFETY: each descriptor covers a live column of this world, never resized after creation
                c.put(unsafe { std::slice::from_raw_parts(col.ptr as *const u8, col.len * col.size) });
            }
        }
        let n = snap.len();
        self.snap = snap;
        n
    }

    /// Restore the world from the snapshot buffer (written by `save`, here or in another build).
    pub fn load(&mut self) -> Result<(), LoadError> {
        let cfg = read_config(&self.snap)?;
        if (cfg.max_ships, cfg.max_types, cfg.max_bodies, cfg.env_n) != (self.cfg.max_ships, self.cfg.max_types, self.cfg.max_bodies, self.cfg.env_n)
            || cfg.env_w.to_bits() != self.cfg.env_w.to_bits() {
            return Err(LoadError::ConfigMismatch);
        }
        let mut snap = std::mem::take(&mut self.snap);
        {
            let mut c = Cursor { buf: &mut snap, at: 32 }; // past magic, version and config
            self.count = c.u32() as usize;
            self.n_bodies = c.u32() as usize;
            self.tick = c.u64();
            let (rs, ri) = (c.u64(), c.u64());
            self.rng = Rng::from_state(rs, ri);
            self.player.slot = c.u32() as i32;
            self.player.set = c.f64();
            self.player.input = c.u32();
            debug_assert_eq!(c.at, HEADER_LEN);
            for col in &self.cols {
                let n = col.len * col.size;
                // SAFETY: as in save; the destination is this world's own column, disjoint from `snap`
                unsafe { std::slice::from_raw_parts_mut(col.ptr as *mut u8, n) }.copy_from_slice(&c.buf[c.at..c.at + n]);
                c.at += n;
            }
        }
        self.snap = snap;
        self.reset_clock();
        Ok(())
    }

    /// A new world restored from snapshot bytes, sized from the snapshot's own header (native tools).
    pub fn from_snapshot(bytes: &[u8]) -> Result<Box<World>, LoadError> {
        let cfg = read_config(bytes)?;
        let mut w = World::new(cfg, 0);
        if bytes.len() != w.snap.len() { return Err(LoadError::Truncated); }
        w.snap.copy_from_slice(bytes);
        w.load()?;
        Ok(w)
    }

    pub fn snapshot(&self) -> &[u8] { &self.snap }
    pub fn snapshot_mut(&mut self) -> &mut [u8] { &mut self.snap }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player::{IN_ASSIST, IN_LEFT, IN_THRUST};
    use crate::scenario;

    #[test]
    fn save_load_continue_matches_uninterrupted() {
        let mut a = scenario::build(5);
        a.player.slot = 0;
        a.player.input = IN_ASSIST | IN_THRUST;
        for _ in 0..300 { a.step(); }
        a.save();
        let bytes = a.snapshot().to_vec();
        let mut b = World::from_snapshot(&bytes).unwrap();
        assert_eq!(a.hash(), b.hash());
        for w in [&mut a, &mut b] {
            w.player.input = IN_ASSIST | IN_LEFT;
            for _ in 0..600 { w.step(); }
        }
        assert_eq!(a.hash(), b.hash());
        assert_eq!(a.player.set.to_bits(), b.player.set.to_bits());
        assert_eq!(a.rng.next_u32(), b.rng.next_u32());
    }

    #[test]
    fn load_rejects_bad_input() {
        let mut w = scenario::build(1);
        w.save();
        let mut bytes = w.snapshot().to_vec();
        bytes[0] = b'X';
        assert_eq!(World::from_snapshot(&bytes).err(), Some(LoadError::BadMagic));
        bytes[0] = b'D';
        bytes[4] = 99;
        assert_eq!(World::from_snapshot(&bytes).err(), Some(LoadError::BadVersion(99)));
        bytes[4] = VERSION as u8;
        assert_eq!(World::from_snapshot(&bytes[..100]).err(), Some(LoadError::Truncated));
        let mut other = World::new(Config { max_ships: 2, max_types: 1, max_bodies: 1, env_n: 4, env_w: 10.0 }, 1);
        let n = other.snapshot().len().min(bytes.len());
        other.snapshot_mut()[..n].copy_from_slice(&bytes[..n]);
        assert_eq!(other.load().err(), Some(LoadError::ConfigMismatch));
    }
}
