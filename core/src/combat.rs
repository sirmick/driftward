//! Weapons and combat (the Book's Weapons, Shields and Damage chapters, M2; docs/weapons.md): turret sites, the
//! multicannons, their shells, hits on shields and the hull's outline, damage through shields to the hull, and the
//! combat AI.
//!
//! Geometry is content, per ship type (the page writes it from the generated hull, src/gen.js `footprint`): the
//! convex `outline` shells hit (local metres, +x right, +y forward, counter-clockwise) and the turret sites, `mount`
//! (`types.guns` of them, each light, medium or heavy). The guns are the multicannon line (`Gun`, by size: light `mc_*`,
//! medium `mm_*`, heavy `ml_*` params); a site takes a gun of its size or smaller. Traffic and the lab's fighters fly
//! with a gun of its size on every site (their line's stock fit); the player with the fit's (fit.rs F_MC, F_MM, F_ML),
//! the biggest on the biggest sites (`place_guns`). Every calibre shares one magazine, in tonnes.
//!
//! Turrets traverse 360 degrees at their gun's rate and lead their target (a shell keeps its ship's velocity). The
//! player's fire while Fire is held, at the target or straight ahead; the AI's at their target, inside the gun's reach
//! and on it. A shell flies at its gun's speed with a little spread and bursts on contact with a shield's surface
//! (`types.standoff` out from the outline) while the shield holds, or with the outline, or when
//! its fuse runs out: set to the target's range when it has one (flak), else the gun's longest. A burst hurts every
//! ship within its gun's blast, fully inside its core, the one it struck fully, but never its own side's or its
//! gunner.
//!
//! Damage goes to the shield first. A hit at or under the shield's hardness (`shield_hard` at 100 m of hull, going with
//! length to the 1.5) does only `hard_frac` of itself to the shield; a harder one does the rest to the shield and
//! `bleed_kin` of it through to the hull. A hit pauses regen for `shield_pause`; a shield run out collapses and
//! restarts after `shield_restart` (fit.rs, the player's; here, everyone else's, regenerating in `shield_refill`). A hull
//! at zero is lost: the player's ends the game (service.rs), anyone else's is destroyed.
//!
//! The lab's standing fight (the system file's `combat`; the page writes `side` and MIX_SIDE rows): each side keeps
//! `count` ships in the fight (those fleeing don't count), arriving one every `side_gap` seconds out of a jump along
//! the route from its own jump zone, `side_drop` short of the contested body.
//! Every side is hostile to every other; to the player only once it has joined another (CMD_SIDE) or fired on them.
//! The AI (a COMBAT ship's phase): LOITER round the contested body; ENGAGE the nearest hostile its sensors hold
//! (the signature model, sensors.rs) within `ai_leash` of the contested body's surface (the player anywhere, once it has fired
//! on them), closing to `ai_range` of the guns' reach and circling; FLEE for its jump zone
//! once its hull is under `morale`, and leave.

use crate::atlas::MAX_SYSTEMS;
use crate::cols::soa;
use crate::fit::{F_MAG, F_MC, F_ML, F_MM};
use crate::math::{atan2, hypot, sin_cos, wrap};
use crate::player::IN_FIRE;
use crate::port::{MODE_FLYING, OK, WRONG_MODE};
use crate::traffic::End;
use crate::world::{World, DT, P};

/// Turret sites per type, and outline vertices per type.
pub const MAX_MOUNTS: usize = 16;
pub const MAX_OUTLINE: usize = 12;
/// Shells in flight at once (a new one past this is not fired), and bursts remembered for the page to draw.
pub const MAX_SHELLS: usize = 8192;
pub const MAX_BURSTS: usize = 1024;
/// Sides in a lab's fight.
pub const MAX_SIDES: usize = 4;

/// A lab fighter's traffic role, and its mix rows' stream (`body`: the side).
pub const COMBAT: u8 = 6;
pub const MIX_SIDE: u8 = 5;
/// A COMBAT ship's phase once it has arrived (traffic.rs phases are below 10).
pub const A_LOITER: u8 = 10;
pub const A_ENGAGE: u8 = 11;
pub const A_FLEE: u8 = 12;

/// Bursts (`burst.kind`): a shell bursting in the open, on a shield, on a hull; a ship destroyed; a shell on a shield
/// it is no harder than (shrugged off); a burst in the open whose blast reached a ship's shield (one per ship, with it).
pub const B_AIR: u8 = 1;
pub const B_SHIELD: u8 = 2;
pub const B_HULL: u8 = 3;
pub const B_LOST: u8 = 4;
pub const B_SHRUG: u8 = 5;
pub const B_SPLASH: u8 = 6;
/// A missile shot down (missile.rs).
pub const B_SHOT: u8 = 7;

/// Debug: the player joins side a (0 neutral, 1..MAX_SIDES), and every side forgives it.
pub const CMD_SIDE: u32 = 104;

/// Gun and site sizes: light, medium, heavy.
pub const G_LIGHT: u8 = 1;
pub const G_MEDIUM: u8 = 2;
pub const G_HEAVY: u8 = 3;
/// A forward missile bay's site (missile.rs): fixed, no gun.
pub const G_BAY: u8 = 4;
/// Tonnes of magazine a stock fit carries for each gun, by size (about 40 s of fire each).
pub const STOCK_MAG: [f64; 3] = [1.0, 2.0, 4.0];

/// A multicannon's numbers (the size's params).
#[derive(Clone, Copy, Debug)]
pub struct Gun { pub rate: f64, pub speed: f64, pub fuse: f64, pub spread: f64, pub blast: f64, pub core: f64, pub dmg: f64, pub traverse: f64, pub mj: f64, pub heat: f64, pub rounds: f64, pub t: f64 }
impl Gun {
    /// How far it reaches: muzzle speed times the longest fuse.
    pub fn reach(&self) -> f64 { self.speed * self.fuse }
}

soa! {
    /// Each type's turret sites (type * MAX_MOUNTS + site), local metres, and their size (G_*).
    pub struct Mounts { x: f64, y: f64, size: u8 }
}

soa! {
    /// Each type's outline (type * MAX_OUTLINE + vertex), local metres, counter-clockwise; `types.outline` vertices.
    pub struct Outline { x: f64, y: f64 }
}

soa! {
    /// Per ship slot: its side (0 none, else side + 1); its shield's points and the seconds before it regenerates
    /// again; the ship it fights (a handle plus one, 0 none) and when it next looks again; the magazine, tonnes; guns
    /// fitted; seconds since it was last hit (the page's shield flash). Missiles (missile.rs): how many are aboard, the
    /// seconds before its bays are loaded again, and a volley to come: its target (a handle plus one, 0 none) and, a
    /// wave's, the game time the wave is to arrive (0 a lone volley); the seconds it has held its missiles for want of a
    /// wave.
    pub struct Arms { side: u8, shield: f64, shield_t: f64, target: u32, think: f64, ammo: f64, guns: u8, hit: f32, orbit: u8,
        missiles: u16, reload: f64, wave_tgt: u32, wave_t: f64, wait: f64 }
}

soa! {
    /// Per ship slot and site (slot * MAX_MOUNTS + site): the gun on it (G_*, 0 none), the turret's world angle and its
    /// cooldown, seconds.
    pub struct Turrets { gun: u8, ang: f64, cd: f64 }
}

soa! {
    /// Shells in flight: the gun's size, position and velocity, fuse left, the gunner (a handle) and its side; the
    /// previous-tick and render positions.
    pub struct Shells { live: u8, gun: u8, x: f64, y: f64, vx: f64, vy: f64, t: f64, owner: u32, side: u8, prev_x: f64, prev_y: f64, rx: f32, ry: f32 }
}

soa! {
    /// Bursts for the page to draw, a ring (`battle.burst` the next written): kind (B_*), where, its size (metres), the
    /// game time it happened, and the ship it struck (its slot plus one; 0 none).
    pub struct Bursts { kind: u8, x: f64, y: f64, size: f64, at: f64, ship: u16 }
}

soa! {
    /// The fight's one row: the next burst slot, the side the player is on (0 none), and the sides it has fired on
    /// (bit s for side s + 1).
    pub struct Battle { burst: u16, player_side: u8, angry: u8 }
}

soa! {
    /// The lab's sides (content: the system file's `combat`): the jump zone each arrives at, the ships it keeps in
    /// flight, the body every side fights over, when its next ship may arrive, when it next looks over its missile fire,
    /// and the earliest its next missile wave may go (game seconds).
    pub struct Sides { zone: u8, count: u8, contested: i16, next: f64, wave: f64, wave_ok: f64 }
}

soa! {
    /// Per system and side (system * MAX_SIDES + side): the lab's sides as the page wrote them (Sides).
    pub struct AtlasSides { zone: u8, count: u8, contested: i16 }
}

/// Where a segment from a to b first enters a convex counter-clockwise polygon: its parameter, 0 to 1 (0 if a is
/// inside), or None.
fn enter(poly: &[(f64, f64)], a: (f64, f64), b: (f64, f64)) -> Option<f64> {
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    let d = (b.0 - a.0, b.1 - a.1);
    let n = poly.len();
    if n < 3 { return None; }
    for i in 0..n {
        let (p, q) = (poly[i], poly[(i + 1) % n]);
        // outward normal of a counter-clockwise edge
        let nrm = (q.1 - p.1, -(q.0 - p.0));
        let num = nrm.0 * (a.0 - p.0) + nrm.1 * (a.1 - p.1); // > 0: a outside this edge
        let den = nrm.0 * d.0 + nrm.1 * d.1;
        if den.abs() < 1e-12 { if num > 0.0 { return None; } continue; }
        let t = -num / den;
        if den < 0.0 { t0 = t0.max(t); } else { t1 = t1.min(t); }
        if t0 > t1 { return None; }
    }
    Some(t0)
}

/// Where segment a->b first comes within `s` of a convex counter-clockwise polygon (its outline grown by s: the shield's
/// surface), as a share of the way along; 0 if a is already that close; None if it never is.
pub(crate) fn enter_round(poly: &[(f64, f64)], s: f64, a: (f64, f64), b: (f64, f64)) -> Option<f64> {
    if s <= 0.0 { return enter(poly, a, b); }
    let n = poly.len();
    if n < 3 { return None; }
    if distance(poly, a) <= s { return Some(0.0); }
    let d = (b.0 - a.0, b.1 - a.1);
    let mut best: Option<f64> = None;
    let mut take = |t: f64| if (0.0..=1.0).contains(&t) && best.is_none_or(|x| t < x) { best = Some(t); };
    for i in 0..n {
        let (p, q) = (poly[i], poly[(i + 1) % n]);
        let (ex, ey) = (q.0 - p.0, q.1 - p.1);
        let len = hypot(ex, ey).max(1e-12);
        let nrm = (ey / len, -ex / len); // outward
        // the edge pushed out by s: crossed going in
        let den = nrm.0 * d.0 + nrm.1 * d.1;
        if den < -1e-12 {
            let t = (s - (nrm.0 * (a.0 - p.0) + nrm.1 * (a.1 - p.1))) / den;
            let (hx, hy) = (a.0 + d.0 * t - p.0, a.1 + d.1 * t - p.1);
            let u = (hx * ex + hy * ey) / (len * len);
            if (0.0..=1.0).contains(&u) { take(t); }
        }
        // the corner's arc: the nearer root of |a + t d - p| = s
        let (wx, wy) = (a.0 - p.0, a.1 - p.1);
        let (qa, qb, qc) = (d.0 * d.0 + d.1 * d.1, 2.0 * (wx * d.0 + wy * d.1), wx * wx + wy * wy - s * s);
        let disc = qb * qb - 4.0 * qa * qc;
        if qa > 1e-12 && disc >= 0.0 { take((-qb - disc.sqrt()) / (2.0 * qa)); }
    }
    best
}

/// Distance from p to a convex counter-clockwise polygon (0 inside).
fn distance(poly: &[(f64, f64)], p: (f64, f64)) -> f64 {
    let n = poly.len();
    if n < 3 { return f64::MAX; }
    let (mut inside, mut best) = (true, f64::MAX);
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        let (ex, ey) = (b.0 - a.0, b.1 - a.1);
        let (wx, wy) = (p.0 - a.0, p.1 - a.1);
        if ex * wy - ey * wx < 0.0 { inside = false; }
        let t = ((wx * ex + wy * ey) / (ex * ex + ey * ey).max(1e-12)).clamp(0.0, 1.0);
        best = best.min(hypot(wx - ex * t, wy - ey * t));
    }
    if inside { 0.0 } else { best }
}

impl World {
    /// The lab's fighters and everyone's guns, once per tick after the sensors: sides keep their numbers, the AI picks
    /// targets and steers (for the next tick's control), turrets turn and fire, shells fly and burst, shields recover.
    /// Missiles (missile.rs) fly before the guns turn, so point defence aims at where they are now.
    pub(crate) fn step_combat(&mut self) {
        self.side_arrivals();
        self.side_waves();
        self.build_grid();
        self.fly_missiles();
        self.build_missile_grid();
        for k in 0..self.count {
            if self.ships.alive[k] == 0 { continue; }
            self.arms.hit[k] += DT as f32;
            if self.traffic.role[k] == COMBAT && self.traffic.phase[k] >= A_LOITER { self.think(k); self.steer_fighter(k); }
            self.npc_shield(k);
            self.bays_step(k);
            self.turrets(k);
        }
        self.fly_shells();
    }

    /// The ships shells can hit, by where they are (grid.rs): alive, off their rails, each as far out as its shield.
    fn build_grid(&mut self) {
        let mut g = std::mem::take(&mut self.grid);
        g.build(self.count, |i| (self.ships.alive[i] != 0 && self.ships.rail[i] == 0)
            .then(|| (self.ships.x[i], self.ships.y[i], self.types.rad[self.look_kind(i)] + self.standoff(i))));
        self.grid = g;
    }

    /// Ship i's outline in local metres (its type's; the player's fitted ship's is its hull's).
    pub(crate) fn outline_of(&self, i: usize) -> ([(f64, f64); MAX_OUTLINE], usize) {
        let k = self.look_kind(i);
        let n = (self.types.outline[k] as usize).min(MAX_OUTLINE);
        let mut p = [(0.0, 0.0); MAX_OUTLINE];
        for (v, q) in p.iter_mut().enumerate().take(n) { *q = (self.outline.x[k * MAX_OUTLINE + v], self.outline.y[k * MAX_OUTLINE + v]); }
        (p, n)
    }
    /// The type whose hull ship i has: the player's fitted ship looks like its catalog type.
    pub(crate) fn look_kind(&self, i: usize) -> usize {
        let k = self.ships.kind[i] as usize;
        if self.fitted() && k == self.player_kind() { self.game.base[0] as usize } else { k }
    }
    pub(crate) fn is_player(&self, i: usize) -> bool { usize::try_from(self.game.player[0]).ok() == Some(i) }
    /// How far out ship i's shield stands from its hull while it holds, metres (0 when it is down).
    pub(crate) fn standoff(&self, i: usize) -> f64 {
        let up = if self.is_player(i) { self.game.shield[0] } else { self.arms.shield[i] } > 0.0;
        if up { self.types.standoff[self.look_kind(i)] } else { 0.0 }
    }
    /// A point in ship i's frame, in the world.
    fn to_world(&self, i: usize, lx: f64, ly: f64) -> (f64, f64) {
        let (s, c) = sin_cos(self.ships.ang[i]);
        (self.ships.x[i] + lx * c - ly * s, self.ships.y[i] + lx * s + ly * c)
    }
    /// A world point in ship i's frame.
    pub(crate) fn to_local(&self, i: usize, x: f64, y: f64) -> (f64, f64) {
        let (s, c) = sin_cos(self.ships.ang[i]);
        let (dx, dy) = (x - self.ships.x[i], y - self.ships.y[i]);
        (dx * c + dy * s, -dx * s + dy * c)
    }
    /// The shield's hardness on ship i: `shield_hard` at 100 m of hull, with length to the 1.5.
    fn hardness(&self, i: usize) -> f64 { let l = self.types.len[self.look_kind(i)] / 100.0; self.p(P::shield_hard) * l * l.sqrt() }
    /// A gun's numbers, by size (G_*).
    pub fn gun(&self, size: u8) -> Gun {
        let p = |q: P| self.p(q);
        match size {
            G_HEAVY => Gun { rate: p(P::ml_rate), speed: p(P::ml_speed), fuse: p(P::ml_fuse), spread: p(P::ml_spread), blast: p(P::ml_blast), core: p(P::ml_core), dmg: p(P::ml_dmg), traverse: p(P::ml_traverse), mj: p(P::ml_mj), heat: p(P::ml_heat), rounds: p(P::ml_rounds), t: p(P::ml_t) },
            G_MEDIUM => Gun { rate: p(P::mm_rate), speed: p(P::mm_speed), fuse: p(P::mm_fuse), spread: p(P::mm_spread), blast: p(P::mm_blast), core: p(P::mm_core), dmg: p(P::mm_dmg), traverse: p(P::mm_traverse), mj: p(P::mm_mj), heat: p(P::mm_heat), rounds: p(P::mm_rounds), t: p(P::mm_t) },
            _ => Gun { rate: p(P::mc_rate), speed: p(P::mc_speed), fuse: p(P::mc_fuse), spread: p(P::mc_spread), blast: p(P::mc_blast), core: p(P::mc_core), dmg: p(P::mc_dmg), traverse: p(P::mc_traverse), mj: p(P::mc_mj), heat: p(P::mc_heat), rounds: p(P::mc_rounds), t: p(P::mc_t) },
        }
    }
    /// How far a light gun reaches.
    pub fn gun_range(&self) -> f64 { self.gun(G_LIGHT).reach() }
    /// The farthest reach of ship k's guns (a light gun's if it has none).
    fn reach(&self, k: usize) -> f64 {
        let big = (0..MAX_MOUNTS).map(|m| self.turrets.gun[k * MAX_MOUNTS + m]).max().unwrap_or(0);
        self.gun(big.max(G_LIGHT)).reach()
    }
    /// Type k's turret sites by size: light, medium, heavy.
    pub fn site_counts(&self, k: usize) -> [usize; 3] {
        let mut c = [0; 3];
        for m in 0..(self.types.guns[k] as usize).min(MAX_MOUNTS) { let z = self.mounts.size[k * MAX_MOUNTS + m]; if (G_LIGHT..=G_HEAVY).contains(&z) { c[(z - 1) as usize] += 1; } }
        c
    }
    /// `light`, `medium` and `heavy` guns on type k's sites, the biggest first on the biggest sites (a site takes a
    /// gun of its size or smaller): the gun on each site, or None if they don't all go on.
    pub fn place_guns(&self, k: usize, light: usize, medium: usize, heavy: usize) -> Option<[u8; MAX_MOUNTS]> {
        let n = (self.types.guns[k] as usize).min(MAX_MOUNTS);
        let mut on = [0u8; MAX_MOUNTS];
        for (size, mut want) in [(G_HEAVY, heavy), (G_MEDIUM, medium), (G_LIGHT, light)] {
            // the smallest free site that takes it first, so the big ones stay free for big guns
            for site in size..=G_HEAVY {
                for m in 0..n { if want > 0 && on[m] == 0 && self.mounts.size[k * MAX_MOUNTS + m] == site { on[m] = size; want -= 1; } }
            }
            if want > 0 { return None; }
        }
        Some(on)
    }

    /// Arm a slot that has just become a ship: a gun of its size on every turret site of its type and the stock
    /// magazine for them, its missiles if it has bays, its shield full, turrets facing forward; side `side` (0 none).
    pub(crate) fn arm(&mut self, k: usize, side: u8) {
        let t = self.ships.kind[k] as usize;
        let n = (self.types.guns[t] as usize).min(MAX_MOUNTS);
        let (mut mag, mut guns) = (0.0, 0);
        for m in 0..MAX_MOUNTS {
            let z = if m < n { self.mounts.size[t * MAX_MOUNTS + m] } else { 0 };
            let g = if (G_LIGHT..=G_HEAVY).contains(&z) { z } else { 0 };
            if g > 0 { mag += STOCK_MAG[(g - 1) as usize]; guns += 1; }
            let o = k * MAX_MOUNTS + m;
            (self.turrets.gun[o], self.turrets.ang[o], self.turrets.cd[o]) = (g, self.ships.ang[k], 0.0);
        }
        let missiles = if self.bays(k) > 0 { self.types.missiles[t] } else { 0 };
        let a = &mut self.arms;
        (a.side[k], a.shield[k], a.shield_t[k], a.target[k], a.ammo[k], a.guns[k], a.hit[k]) = (side, self.types.shield[t], 0.0, 0, mag, guns, 99.0);
        (a.missiles[k], a.reload[k], a.wave_tgt[k], a.wave_t[k], a.wait[k]) = (missiles, 0.0, 0, 0.0, 0.0);
        a.think[k] = self.rng.range(0.0, self.params[P::ai_think as usize]);
        a.orbit[k] = (self.rng.next_f64() < 0.5) as u8;
    }

    /// The player's guns and magazine from the fit (a new game, a refit, a landing's restock).
    pub(crate) fn arm_player(&mut self) {
        let Some(i) = usize::try_from(self.game.player[0]).ok().filter(|&i| i < self.count) else { return };
        let on = if self.fitted() {
            let f = &self.fit.t;
            self.place_guns(self.game.base[0] as usize, f[F_MC] as usize, f[F_MM] as usize, f[F_ML] as usize).unwrap_or([0; MAX_MOUNTS])
        } else { [0; MAX_MOUNTS] };
        for (m, &g) in on.iter().enumerate() { self.turrets.gun[i * MAX_MOUNTS + m] = g; }
        let mag = if self.fitted() { self.fit.t[F_MAG] } else { 0.0 };
        // the bays' missiles, the hull's stock load (restocked free on landing for now, as the magazine is)
        let missiles = if self.fitted() && self.bays(i) > 0 { self.types.missiles[self.game.base[0] as usize] } else { 0 };
        let side = self.battle.player_side[0];
        let a = &mut self.arms;
        (a.side[i], a.guns[i], a.ammo[i], a.target[i], a.hit[i]) = (side, on.iter().filter(|&&g| g > 0).count() as u8, mag, 0, 99.0);
        (a.missiles[i], a.reload[i], a.wave_tgt[i], a.wave_t[i], a.wait[i]) = (missiles, 0.0, 0, 0.0, 0.0);
    }

    // ---------- the lab's sides ----------

    fn side_arrivals(&mut self) {
        let now = self.tick as f64 * DT;
        for s in 0..MAX_SIDES {
            let want = self.sides.count[s] as usize;
            let c = self.sides.contested[s];
            if want == 0 || c < 0 || c as usize >= self.n_bodies || now < self.sides.next[s] { continue; }
            // ships fleeing are out of the fight: others come in their place
            let have = (0..self.count).filter(|&k| self.traffic.role[k] == COMBAT && self.ships.alive[k] != 0 && self.arms.side[k] == s as u8 + 1 && self.traffic.phase[k] != A_FLEE).count();
            if have >= want { continue; }
            self.sides.next[s] = now + self.p(P::side_gap);
            // the side's type by weight
            let rows: Vec<usize> = (0..crate::traffic::MAX_MIX).filter(|&m| self.mix.stream[m] == MIX_SIDE && self.mix.body[m] == s as i16 && self.mix.weight[m] > 0.0).collect();
            let total: f64 = rows.iter().map(|&m| self.mix.weight[m]).sum();
            if total <= 0.0 { continue; }
            let mut pick = self.rng.range(0.0, total);
            let m = *rows.iter().find(|&&m| { pick -= self.mix.weight[m]; pick <= 0.0 }).unwrap_or(&rows[rows.len() - 1]);
            let z = (self.sides.zone[s] as usize) % self.n_zones().max(1);
            if let Some(k) = self.spawn(COMBAT, End::Jump(z), End::Body(c as usize), Some(m)) {
                // dropped in close to the fight, not at the system's edge: its arrival starts side_drop short of the body
                let drop = self.p(P::side_drop);
                if drop > 0.0 && self.traffic.len[k] > drop {
                    self.traffic.s[k] = self.traffic.len[k] - drop;
                    self.arriving_step(k, 0.0);
                    self.slot_reset(k, true);
                }
                self.arm(k, s as u8 + 1);
            }
        }
    }

    /// Whether side `side` (1..) is at war with ship j.
    pub(crate) fn hostile(&self, side: u8, j: usize) -> bool {
        if side == 0 || self.ships.alive[j] == 0 || self.ships.rail[j] != 0 { return false; }
        if self.is_player(j) {
            if self.mode() != MODE_FLYING { return false; }
            let ps = self.battle.player_side[0];
            return (ps != 0 && ps != side) || self.battle.angry[0] & (1 << (side - 1)) != 0;
        }
        self.traffic.role[j] == COMBAT && self.arms.side[j] != 0 && self.arms.side[j] != side
    }
    /// Whether ship i's sensors hold ship j: the player through `seen` (sensors.rs), others by their signature now.
    pub(crate) fn holds(&self, i: usize, j: usize) -> bool {
        if self.is_player(j) { return self.ships.seen[i] >= self.p(P::contact_snr); }
        let d = hypot(self.ships.x[j] - self.ships.x[i], self.ships.y[j] - self.ships.y[i]);
        self.p(P::sens_k) * self.ships.sig[j] / (d * d / 1e6 + 0.04) >= self.p(P::contact_snr)
    }

    /// A fighter looks round every `ai_think` seconds: flee when hurt, else the nearest hostile its sensors hold.
    fn think(&mut self, k: usize) {
        self.arms.think[k] -= DT;
        if self.arms.think[k] > 0.0 || self.traffic.phase[k] == A_FLEE { return; }
        self.arms.think[k] += self.p(P::ai_think);
        if self.ships.hull[k] < self.p(P::morale) * self.types.hull[self.ships.kind[k] as usize] { self.traffic.phase[k] = A_FLEE; self.arms.target[k] = 0; return; }
        let side = self.arms.side[k];
        let (x, y) = (self.ships.x[k], self.ships.y[k]);
        // the fight is over the contested body: enemies within the leash of it
        let c = self.sides.contested[((side.max(1) - 1) as usize).min(MAX_SIDES - 1)];
        let (cx, cy, leash) = if c >= 0 && (c as usize) < self.n_bodies { let j = c as usize; (self.bodies.x[j], self.bodies.y[j], self.bodies.r[j] + self.p(P::ai_leash)) } else { (x, y, f64::MAX) };
        let mut best: Option<(usize, f64)> = None;
        for j in 0..self.count {
            if j == k || !self.hostile(side, j) || !self.holds(k, j) { continue; }
            if hypot(self.ships.x[j] - cx, self.ships.y[j] - cy) > leash { continue; }
            let d = hypot(self.ships.x[j] - x, self.ships.y[j] - y);
            if best.is_none_or(|(_, bd)| d < bd) { best = Some((j, d)); }
        }
        // keep one that shot at it if it still sees it (the hit sets the target), else the nearest
        let cur = self.arms.target[k].checked_sub(1).and_then(|h| self.resolve(h)).filter(|&j| self.hostile(side, j) && self.holds(k, j)
            && (self.is_player(j) || hypot(self.ships.x[j] - cx, self.ships.y[j] - cy) <= leash));
        let pick = cur.or(best.map(|b| b.0));
        self.arms.target[k] = pick.map_or(0, |j| self.handle(j) + 1);
        self.traffic.phase[k] = if pick.is_some() { A_ENGAGE } else { A_LOITER };
    }

    /// The fighter's wanted velocity for the assist: round the contested body, round its target, or out to its zone.
    fn steer_fighter(&mut self, k: usize) {
        let kind = self.ships.kind[k] as usize;
        let cruise = self.types.vmax[kind] * self.p(P::ai_cruise);
        let (x, y) = (self.ships.x[k], self.ships.y[k]);
        let dir = if self.arms.orbit[k] != 0 { 1.0 } else { -1.0 };
        // circle point c at radius r (moving at cv): tangent at `speed`, plus a pull back to the radius; from far off,
        // straight in as fast as open space allows (flight.rs caps it)
        let far = self.types.vmax[kind] * self.p(P::cruise_max);
        let circle = |cx: f64, cy: f64, cvx: f64, cvy: f64, r: f64, speed: f64| {
            let (dx, dy) = (x - cx, y - cy);
            let d = hypot(dx, dy).max(1.0);
            let (ux, uy) = (dx / d, dy / d);
            if d > 2.5 * r { let v = if d > 6.0 * r { far } else { cruise }; return (cvx - ux * v, cvy - uy * v); }
            let (tx, ty) = (-uy * dir, ux * dir);
            let pull = ((r - d) / r * 2.0).clamp(-1.0, 1.0) * speed;
            (cvx + tx * speed + ux * pull, cvy + ty * speed + uy * pull)
        };
        let (vx, vy) = match self.traffic.phase[k] {
            A_ENGAGE => match self.arms.target[k].checked_sub(1).and_then(|h| self.resolve(h)) {
                Some(j) => circle(self.ships.x[j], self.ships.y[j], self.ships.vx[j], self.ships.vy[j], self.p(P::ai_range) * self.reach(k), cruise * 0.7),
                None => { self.traffic.phase[k] = A_LOITER; (0.0, 0.0) }
            },
            A_FLEE => {
                let s = (self.arms.side[k].max(1) - 1) as usize;
                let z = (self.sides.zone[s.min(MAX_SIDES - 1)] as usize) % self.n_zones().max(1);
                let (zx, zy) = self.jump_point(z);
                let (dx, dy) = (zx - x, zy - y);
                let d = hypot(dx, dy).max(1.0);
                if d < 1500.0 { self.flee_out(k, z); return; }
                (dx / d * self.types.vmax[kind], dy / d * self.types.vmax[kind])
            }
            _ => {
                let c = self.sides.contested[((self.arms.side[k].max(1) - 1) as usize).min(MAX_SIDES - 1)];
                if c < 0 || c as usize >= self.n_bodies { (0.0, 0.0) } else {
                    let j = c as usize;
                    // ai_orbit radii out, but no more than half a leash above it (a planet's would be far outside the fight)
                    let r = self.bodies.r[j];
                    circle(self.bodies.x[j], self.bodies.y[j], self.bodies.vx[j], self.bodies.vy[j], (r * self.p(P::ai_orbit)).min(r + 0.5 * self.p(P::ai_leash)), cruise * 0.5)
                }
            }
        };
        let s = &mut self.ships;
        (s.want_vx[k], s.want_vy[k], s.ctl[k]) = (vx, vy, 1);
    }

    /// A fleeing fighter at its jump zone lights its torch and goes.
    fn flee_out(&mut self, k: usize, z: usize) {
        self.traffic.to[k] = -1 - z as i16;
        self.light_torch(k, z);
    }

    /// Everyone but the player regenerates its shield (the player's is the fit's, fit.rs).
    fn npc_shield(&mut self, k: usize) {
        if self.is_player(k) { return; }
        let cap = self.types.shield[self.ships.kind[k] as usize];
        let a = &mut self.arms;
        if a.shield_t[k] > 0.0 { a.shield_t[k] = (a.shield_t[k] - DT).max(0.0); return; }
        if a.shield[k] < cap { a.shield[k] = (a.shield[k] + cap / self.params[P::shield_refill as usize].max(0.1) * DT).min(cap); }
    }

    // ---------- guns ----------

    /// Ship k's turrets: turn toward the lead on its target and fire when on it (the player's: while Fire is held).
    /// Light guns defend first (missile.rs): the nearest missile threatening the ship within their reach is their
    /// target, fired on unbidden, the player's too.
    fn turrets(&mut self, k: usize) {
        if self.arms.guns[k] == 0 || self.ships.rail[k] != 0 { return; }
        let player = self.is_player(k);
        if player && self.mode() != MODE_FLYING { return; }
        let target = if player { self.target_ship() } else { self.arms.target[k].checked_sub(1).and_then(|h| self.resolve(h)) };
        let firing = if player { self.game.input[0] & IN_FIRE != 0 } else { target.is_some() && self.traffic.phase[k] == A_ENGAGE };
        let light = (0..MAX_MOUNTS).any(|m| self.turrets.gun[k * MAX_MOUNTS + m] == G_LIGHT);
        let pd = if light { self.pd_target(k, self.ships.x[k], self.ships.y[k], self.gun(G_LIGHT).reach()) } else { None };
        let look = self.look_kind(k);
        let hot = self.game.hot[0] != 0;
        for m in 0..MAX_MOUNTS {
            let o = k * MAX_MOUNTS + m;
            let size = self.turrets.gun[o];
            if size == 0 { continue; }
            let g = self.gun(size);
            let (speed, range, trav, mj) = (g.speed, g.reach(), g.traverse * DT, g.mj);
            let mi = look * MAX_MOUNTS + m;
            let (mx, my) = self.to_world(k, self.mounts.x[mi], self.mounts.y[mi]);
            // what it shoots at: a light gun the threatening missile, else the target (position, velocity)
            let defend = if size == G_LIGHT { pd } else { None };
            let mark = match defend {
                Some(n) => Some((self.missiles.x[n], self.missiles.y[n], self.missiles.vx[n], self.missiles.vy[n])),
                None => target.map(|j| (self.ships.x[j], self.ships.y[j], self.ships.vx[j], self.ships.vy[j])),
            };
            let firing = firing || defend.is_some();
            // the lead: where the mark will be when a shell (with the ship's velocity) reaches it
            let aim = mark.map(|(jx, jy, jvx, jvy)| {
                let (dx, dy) = (jx - mx, jy - my);
                let (ux, uy) = (jvx - self.ships.vx[k], jvy - self.ships.vy[k]);
                let a = ux * ux + uy * uy - speed * speed;
                let b = 2.0 * (dx * ux + dy * uy);
                let c = dx * dx + dy * dy;
                let disc = b * b - 4.0 * a * c;
                let t = if a.abs() < 1e-9 { if b.abs() > 1e-9 { -c / b } else { 0.0 } } else if disc < 0.0 { 0.0 } else {
                    let r = disc.sqrt();
                    let (t1, t2) = ((-b - r) / (2.0 * a), (-b + r) / (2.0 * a));
                    if t1 > 0.0 && t2 > 0.0 { t1.min(t2) } else { t1.max(t2).max(0.0) }
                };
                (atan2(-(dx + ux * t), dy + uy * t), t, hypot(dx, dy))
            });
            let want = aim.map_or(self.ships.ang[k], |a| a.0);
            let err = wrap(want - self.turrets.ang[o]);
            self.turrets.ang[o] = wrap(self.turrets.ang[o] + err.clamp(-trav, trav));
            self.turrets.cd[o] = (self.turrets.cd[o] - DT).max(-DT);
            let round = 1.0 / g.rounds.max(1e-6);
            if !firing || self.turrets.cd[o] > 0.0 || self.arms.ammo[k] < round - 1e-9 { continue; }
            if !player || defend.is_some() {
                let Some((_, _, d)) = aim else { continue };
                if d > range * 1.05 || err.abs() > 0.06 { continue; }
            }
            if player && (hot || (self.fitted() && self.game.energy[0] < mj)) { continue; }
            // the fuse: burst at the target's range (flak), else at full reach
            let fuse = aim.map_or(g.fuse, |a| (a.1 + 0.03).clamp(0.05, g.fuse));
            if self.fire(k, mx, my, self.turrets.ang[o], fuse, size) {
                self.turrets.cd[o] += 1.0 / g.rate.max(0.01);
                self.arms.ammo[k] = (self.arms.ammo[k] - round).max(0.0);
                if player && self.fitted() {
                    self.game.energy[0] = (self.game.energy[0] - mj).max(0.0);
                    let cap = self.stats(self.game.base[0] as usize, &self.fit.t, 0.0, 0.0).heat_cap.max(1.0);
                    self.game.heat[0] = (self.game.heat[0] + g.heat / cap).min(1.0);
                }
            }
        }
    }

    /// A shell from (x, y) along angle `ang`, give or take the spread, with ship k's velocity; its speed and fuse a
    /// little off (`mc_jitter`), so a stream scatters; false if every shell slot is in use.
    fn fire(&mut self, k: usize, x: f64, y: f64, ang: f64, fuse: f64, size: u8) -> bool {
        let Some(n) = (0..MAX_SHELLS).find(|&n| self.shells.live[n] == 0) else { return false };
        let g = self.gun(size);
        let spread = g.spread * (self.rng.next_f64() + self.rng.next_f64() - 1.0);
        let (s, c) = sin_cos(ang + spread);
        let j = self.p(P::mc_jitter);
        let v = g.speed * (1.0 + j * (self.rng.next_f64() * 2.0 - 1.0));
        let fuse = fuse * (1.0 + j * (self.rng.next_f64() * 2.0 - 1.0));
        let (owner, side) = (self.handle(k), self.arms.side[k]);
        let (vx, vy) = (self.ships.vx[k], self.ships.vy[k]);
        let sh = &mut self.shells;
        (sh.live[n], sh.x[n], sh.y[n], sh.vx[n], sh.vy[n], sh.t[n], sh.owner[n], sh.side[n]) = (1, x, y, vx - s * v, vy + c * v, fuse, owner, side);
        (sh.prev_x[n], sh.prev_y[n], sh.rx[n], sh.ry[n], sh.gun[n]) = (x, y, x as f32, y as f32, size);
        true
    }

    /// Every shell a tick on: does its path reach a ship's shield, or its outline with the shield down? Then it bursts
    /// there; else when its fuse runs out.
    fn fly_shells(&mut self) {
        for n in 0..MAX_SHELLS {
            if self.shells.live[n] == 0 { continue; }
            let (x0, y0) = (self.shells.x[n], self.shells.y[n]);
            let (x1, y1) = (x0 + self.shells.vx[n] * DT, y0 + self.shells.vy[n] * DT);
            (self.shells.prev_x[n], self.shells.prev_y[n], self.shells.x[n], self.shells.y[n]) = (x0, y0, x1, y1);
            self.shells.t[n] -= DT;
            let (owner, side) = (self.resolve(self.shells.owner[n]), self.shells.side[n]);
            let seg = hypot(x1 - x0, y1 - y0);
            let mut hit: Option<(usize, f64)> = None;
            // only the ships near its path this tick (grid.rs); the first it meets, the lower slot on a tie
            self.grid.near(x0, y0, x1, y1, 0.0, |j| {
                if self.ships.alive[j] == 0 || Some(j) == owner || (side != 0 && self.arms.side[j] == side) { return; }
                let (r, s) = (self.types.rad[self.look_kind(j)], self.standoff(j));
                if r <= 0.0 || hypot(self.ships.x[j] - x1, self.ships.y[j] - y1) > r + s + seg { return; }
                let (poly, nv) = self.outline_of(j);
                if let Some(t) = enter_round(&poly[..nv], s, self.to_local(j, x0, y0), self.to_local(j, x1, y1))
                    && hit.is_none_or(|h| t < h.1 || (t == h.1 && j < h.0)) { hit = Some((j, t)); }
            });
            // and the missiles near it (missile.rs), each a circle of ms_rad moving along its own last step: the
            // first met, if before the ship
            let rad = self.p(P::ms_rad);
            let mut mhit: Option<(usize, f64)> = None;
            self.mgrid.near(x0, y0, x1, y1, 0.0, |q| {
                if self.missiles.live[q] == 0 || self.missiles.owner[q] == self.shells.owner[n] || (side != 0 && self.missiles.side[q] == side) { return; }
                let (mx0, my0) = (self.missiles.prev_x[q], self.missiles.prev_y[q]);
                // relative motion over the tick: the shell from the missile's frame
                let (px, py) = (x0 - mx0, y0 - my0);
                let (dx, dy) = ((x1 - x0) - (self.missiles.x[q] - mx0), (y1 - y0) - (self.missiles.y[q] - my0));
                let (a, b, c) = (dx * dx + dy * dy, 2.0 * (px * dx + py * dy), px * px + py * py - rad * rad);
                let t = if c <= 0.0 { 0.0 } else {
                    let disc = b * b - 4.0 * a * c;
                    if a < 1e-12 || disc < 0.0 { return; }
                    (-b - disc.sqrt()) / (2.0 * a)
                };
                if (0.0..=1.0).contains(&t) && mhit.is_none_or(|h| t < h.1 || (t == h.1 && q < h.0)) { mhit = Some((q, t)); }
            });
            if let Some((q, t)) = mhit && hit.is_none_or(|h| t < h.1) {
                self.shells.live[n] = 0;
                self.burst(n, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, None, Some(q));
            } else if let Some((j, t)) = hit {
                self.shells.live[n] = 0;
                self.burst(n, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, Some(j), None);
            } else if self.shells.t[n] <= 0.0 {
                self.shells.live[n] = 0;
                self.burst(n, x1, y1, None, None);
            }
        }
    }

    /// Shell n bursts at (x, y), on ship `struck` or missile `on` if it hit one: the blast (`blast`), and every
    /// missile not its side's within it takes its share too, the one it struck all of it.
    fn burst(&mut self, n: usize, x: f64, y: f64, struck: Option<usize>, on: Option<usize>) {
        let g = self.gun(self.shells.gun[n]);
        let (owner, side) = (self.resolve(self.shells.owner[n]), self.shells.side[n]);
        let kind = self.blast(x, y, struck, g.blast, g.core, g.dmg, owner, side);
        let mut near = std::mem::take(&mut self.grid.buf);
        near.clear();
        self.mgrid.near(x, y, x, y, g.blast, |q| near.push(q));
        near.sort_unstable();
        let rad = self.p(P::ms_rad);
        for &q in &near {
            if self.missiles.live[q] == 0 || self.missiles.owner[q] == self.shells.owner[n] || (side != 0 && self.missiles.side[q] == side) { continue; }
            let d = if Some(q) == on { 0.0 } else { (hypot(self.missiles.x[q] - x, self.missiles.y[q] - y) - rad).max(0.0) };
            if d >= g.blast { continue; }
            let share = if d <= g.core { 1.0 } else { 1.0 - (d - g.core) / (g.blast - g.core).max(1e-6) };
            self.hurt_missile(q, g.dmg * share);
        }
        self.grid.buf = near;
        self.note_burst(kind, x, y, g.blast, struck);
    }

    /// A blast at (x, y) of `blast` metres, full inside `core`, `dmg` at full: every ship within it takes its share,
    /// measured to its shield's surface while that holds, ship `struck` all of it, but not side `side`'s or the
    /// gunner. A blast that reaches a shield it didn't strike notes a splash on it. Returns what `struck` took (B_*;
    /// B_AIR if none).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn blast(&mut self, x: f64, y: f64, struck: Option<usize>, blast: f64, core: f64, dmg: f64, owner: Option<usize>, side: u8) -> u8 {
        let mut kind = B_AIR;
        // the ships near enough (grid.rs), in slot order; gathered first, as damage changes the world
        let mut near = std::mem::take(&mut self.grid.buf);
        near.clear();
        self.grid.near(x, y, x, y, blast, |j| near.push(j));
        near.sort_unstable();
        for &j in &near {
            if self.ships.alive[j] == 0 || Some(j) == owner || (side != 0 && self.arms.side[j] == side) { continue; }
            let d = if Some(j) == struck { 0.0 } else {
                let (r, s) = (self.types.rad[self.look_kind(j)], self.standoff(j));
                if r <= 0.0 || hypot(self.ships.x[j] - x, self.ships.y[j] - y) > r + s + blast { continue; }
                let (poly, nv) = self.outline_of(j);
                (distance(&poly[..nv], self.to_local(j, x, y)) - s).max(0.0)
            };
            if d >= blast { continue; }
            let share = if d <= core { 1.0 } else { 1.0 - (d - core) / (blast - core).max(1e-6) };
            let k = self.damage(j, dmg * share, owner);
            if Some(j) == struck { kind = k; } else if k == B_SHIELD || k == B_SHRUG { self.note_burst(B_SPLASH, x, y, blast, Some(j)); }
        }
        self.grid.buf = near;
        kind
    }

    pub(crate) fn note_burst(&mut self, kind: u8, x: f64, y: f64, size: f64, ship: Option<usize>) {
        let b = (self.battle.burst[0] as usize) % MAX_BURSTS;
        let now = self.tick as f64 * DT;
        (self.bursts.kind[b], self.bursts.x[b], self.bursts.y[b], self.bursts.size[b], self.bursts.at[b]) = (kind, x, y, size, now);
        self.bursts.ship[b] = ship.map_or(0, |i| i as u16 + 1);
        self.battle.burst[0] = ((b + 1) % MAX_BURSTS) as u16;
    }

    /// `dmg` points of kinetic damage on ship j from `from`'s guns: shield, then hull (see the module comment).
    /// Returns what it struck (B_SHIELD, B_SHRUG for a hit no harder than the shield, or B_HULL).
    pub(crate) fn damage(&mut self, j: usize, dmg: f64, from: Option<usize>) -> u8 {
        let player = self.is_player(j);
        let (shield, st) = if player { (self.game.shield[0], self.game.shield_t[0]) } else { (self.arms.shield[j], self.arms.shield_t[j]) };
        let (mut shield, mut st, mut hull) = (shield, st, 0.0);
        let mut struck = B_HULL;
        if shield > 0.0 {
            struck = B_SHIELD;
            if dmg <= self.hardness(j) { shield -= dmg * self.p(P::hard_frac); struck = B_SHRUG; }
            else { let b = self.p(P::bleed_kin); shield -= dmg * (1.0 - b); hull = dmg * b; }
            if shield <= 0.0 { (shield, st) = (0.0, self.p(P::shield_restart)); } else { st = st.max(self.p(P::shield_pause)); }
        } else { hull = dmg; st = st.max(self.p(P::shield_pause)); }
        if player { (self.game.shield[0], self.game.shield_t[0]) = (shield, st); } else { (self.arms.shield[j], self.arms.shield_t[j]) = (shield, st); }
        self.arms.hit[j] = 0.0;
        // the side hit remembers who did it: the player made an enemy, a fighter turns on its attacker
        if let Some(f) = from {
            let vs = self.arms.side[j];
            if self.is_player(f) && vs != 0 && !player { self.battle.angry[0] |= 1 << (vs - 1); }
            if !player && self.traffic.role[j] == COMBAT && self.arms.target[j] == 0 && self.hostile(vs, f) { self.arms.target[j] = self.handle(f) + 1; }
        }
        self.ships.hull[j] -= hull;
        if self.ships.hull[j] <= 0.0 {
            self.ships.hull[j] = 0.0;
            let (x, y, r) = (self.ships.x[j], self.ships.y[j], self.types.rad[self.look_kind(j)].max(10.0));
            self.note_burst(B_LOST, x, y, r * 1.6, Some(j));
            if player { self.lose_ship(j); } else { self.despawn(j); }
        }
        struck
    }

    /// CMD_SIDE (debug): the player joins side a (0 for none), and no side holds a grudge.
    pub(crate) fn side_command(&mut self, a: i32) -> i32 {
        let Some(s) = u8::try_from(a).ok().filter(|&s| (s as usize) <= MAX_SIDES) else { return WRONG_MODE };
        (self.battle.player_side[0], self.battle.angry[0]) = (s, 0);
        if let Some(i) = usize::try_from(self.game.player[0]).ok().filter(|&i| i < self.count) { self.arms.side[i] = s; }
        OK
    }

    /// The live system's sides into atlas slot k, and back.
    pub(crate) fn atlas_store_sides(&mut self, k: usize) {
        for s in 0..MAX_SIDES {
            let o = k * MAX_SIDES + s;
            (self.atlas_sides.zone[o], self.atlas_sides.count[o], self.atlas_sides.contested[o]) = (self.sides.zone[s], self.sides.count[s], self.sides.contested[s]);
        }
    }
    pub(crate) fn atlas_load_sides(&mut self, k: usize) {
        for s in 0..MAX_SIDES {
            let o = k * MAX_SIDES + s;
            (self.sides.zone[s], self.sides.count[s], self.sides.contested[s], self.sides.next[s], self.sides.wave[s], self.sides.wave_ok[s]) = (self.atlas_sides.zone[o], self.atlas_sides.count[o], self.atlas_sides.contested[o], 0.0, 0.0, 0.0);
        }
    }
    /// Shells and bursts go when the system changes (a jump, a new game).
    pub(crate) fn clear_fire(&mut self) {
        self.shells.clear();
        self.clear_missiles();
        self.bursts.clear();
        self.battle.burst[0] = 0;
    }
}

/// Slots the atlas keeps the sides for.
pub const ATLAS_SIDES: usize = MAX_SYSTEMS * MAX_SIDES;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::BODY_STATION;
    use crate::world::Config;

    /// Two light fighters' type (an 18 m hull, a 6 x 11 m box for an outline, two sites), a station at the origin.
    fn world() -> Box<World> {
        let mut w = World::new(Config { max_ships: 32, max_types: 2, max_bodies: 2, env_n: 4, env_w: 1000.0 }, 3);
        let t = &mut w.types;
        (t.accel[0], t.turn[0], t.vmax[0], t.well[0], t.len[0], t.hull[0], t.shield[0]) = (130.0, 3.4, 600.0, 0.35, 18.0, 60.0, 40.0);
        (t.guns[0], t.outline[0], t.rad[0]) = (2, 4, 7.0);
        for (v, (x, y)) in [(-3.0, -5.5), (3.0, -5.5), (3.0, 5.5), (-3.0, 5.5)].into_iter().enumerate() { (w.outline.x[v], w.outline.y[v]) = (x, y); }
        for (m, x) in [-2.0, 2.0].into_iter().enumerate() { (w.mounts.x[m], w.mounts.y[m], w.mounts.size[m]) = (x, 1.0, 1); }
        w.n_bodies = 1;
        (w.bodies.r[0], w.bodies.kind[0]) = (400.0, BODY_STATION);
        w
    }
    fn ship(w: &mut World, x: f64, y: f64, side: u8) -> usize {
        let k = w.count;
        w.count += 1;
        let s = &mut w.ships;
        (s.alive[k], s.kind[k], s.x[k], s.y[k], s.hull[k], s.ctl[k]) = (1, 0, x, y, 60.0, 1);
        w.slot_reset(k, true);
        w.arm(k, side);
        k
    }
    fn run(w: &mut World, secs: f64) { for _ in 0..(secs / DT).round() as usize { w.step(); } }

    #[test]
    fn segments_enter_outlines() {
        let sq = [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)];
        assert!((enter(&sq, (-3.0, 0.0), (3.0, 0.0)).unwrap() - 1.0 / 3.0).abs() < 1e-9);
        assert_eq!(enter(&sq, (0.0, 0.0), (3.0, 0.0)), Some(0.0));
        assert_eq!(enter(&sq, (-3.0, 2.0), (3.0, 2.0)), None);
        assert_eq!(enter(&sq, (-3.0, 0.0), (-2.0, 0.0)), None);
        assert!((distance(&sq, (3.0, 0.0)) - 2.0).abs() < 1e-9 && distance(&sq, (0.5, 0.5)) == 0.0);
    }

    #[test]
    fn a_hit_takes_the_shield_then_the_hull() {
        let mut w = world();
        let a = ship(&mut w, 0.0, 0.0, 1);
        w.params[P::bleed_kin as usize] = 0.1;
        assert_eq!(w.damage(a, 10.0, None), B_SHIELD);
        assert!((w.arms.shield[a] - 31.0).abs() < 1e-9 && (w.ships.hull[a] - 59.0).abs() < 1e-9, "{} {}", w.arms.shield[a], w.ships.hull[a]);
        w.damage(a, 40.0, None);
        assert_eq!(w.arms.shield[a], 0.0, "collapsed");
        assert!(w.arms.shield_t[a] > 1.0);
        let h = w.ships.hull[a];
        assert_eq!(w.damage(a, 5.0, None), B_HULL);
        assert!((w.ships.hull[a] - (h - 5.0)).abs() < 1e-9);
        w.damage(a, 1000.0, None);
        assert_eq!(w.ships.alive[a], 0, "destroyed");
    }

    #[test]
    fn shells_meet_the_shield_standoff_out() {
        let sq = [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)];
        // head on: the grown edge, 0.5 out
        let t = enter_round(&sq, 0.5, (-5.0, 0.0), (5.0, 0.0)).unwrap();
        assert!((t - 0.35).abs() < 1e-9, "{t}");
        // past a corner: its arc, not the square's diagonal
        let t = enter_round(&sq, 0.5, (-5.0, 1.3), (5.0, 1.3)).unwrap();
        assert!((-5.0 + 10.0 * t - (-1.0 - (0.25f64 - 0.09).sqrt())).abs() < 1e-9, "{t}");
        assert_eq!(enter_round(&sq, 0.5, (-5.0, 1.6), (5.0, 1.6)), None, "misses wide");
        assert_eq!(enter_round(&sq, 0.5, (1.2, 0.0), (5.0, 0.0)), Some(0.0), "starts inside the shield");
        assert_eq!(enter_round(&sq, 0.0, (-5.0, 0.0), (5.0, 0.0)), enter(&sq, (-5.0, 0.0), (5.0, 0.0)), "no shield: the outline");
    }

    #[test]
    fn hardness_shrugs_off_light_hits_on_big_hulls() {
        let mut w = world();
        let a = ship(&mut w, 0.0, 0.0, 1);
        w.types.len[0] = 320.0; // a capital hull: hardness 17.2
        assert_eq!(w.damage(a, 1.0, None), B_SHRUG);
        assert!((w.arms.shield[a] - (40.0 - 0.1)).abs() < 1e-9 && w.ships.hull[a] == 60.0, "a tenth, nothing through: {}", w.arms.shield[a]);
    }

    #[test]
    fn two_sides_fight_and_shells_hit() {
        let mut w = world();
        let a = ship(&mut w, -400.0, 0.0, 1);
        let b = ship(&mut w, 400.0, 0.0, 2);
        for k in [a, b] { (w.traffic.role[k], w.traffic.phase[k]) = (COMBAT, A_LOITER); }
        w.sides.contested.fill(0);
        run(&mut w, 1.0);
        assert_eq!((w.traffic.phase[a], w.traffic.phase[b]), (A_ENGAGE, A_ENGAGE), "each sees the other");
        let fired = |w: &World| w.arms.ammo[a] < 2.0 && w.arms.ammo[b] < 2.0; // two tonnes each to start
        run(&mut w, 3.0);
        assert!(fired(&w), "both fire: {} {}", w.arms.ammo[a], w.arms.ammo[b]);
        assert!(w.arms.shield[a] < 40.0 || w.ships.hull[a] < 60.0 || w.ships.alive[a] == 0, "a is hit");
        assert!((0..MAX_BURSTS).any(|n| w.bursts.kind[n] == B_SHIELD || w.bursts.kind[n] == B_HULL), "a burst on a ship");
    }

    #[test]
    fn sides_keep_their_numbers() {
        let mut w = world();
        w.mix.stream[0] = MIX_SIDE; w.mix.body[0] = 0; w.mix.weight[0] = 1.0;
        (w.sides.count[0], w.sides.zone[0], w.sides.contested[0]) = (3, 1, 0);
        w.params[P::side_gap as usize] = 1.0;
        run(&mut w, 8.0);
        let n = (0..w.count).filter(|&k| w.traffic.role[k] == COMBAT && w.ships.alive[k] != 0).count();
        assert_eq!(n, 3);
        assert!((0..w.count).all(|k| w.traffic.role[k] != COMBAT || w.arms.side[k] == 1));
    }

    #[test]
    fn guns_go_on_sites_their_size_or_bigger() {
        let mut w = world();
        // sites: light, light, medium, heavy
        w.types.guns[0] = 4;
        for (m, z) in [G_LIGHT, G_LIGHT, G_MEDIUM, G_HEAVY].into_iter().enumerate() { w.mounts.size[m] = z; }
        assert_eq!(w.site_counts(0), [2, 1, 1]);
        assert_eq!(&w.place_guns(0, 2, 1, 1).unwrap()[..4], &[1, 1, 2, 3]);
        assert_eq!(&w.place_guns(0, 1, 2, 0).unwrap()[..4], &[1, 0, 2, 2], "a medium gun on the heavy site");
        assert_eq!(&w.place_guns(0, 4, 0, 0).unwrap()[..4], &[1, 1, 1, 1], "light guns anywhere");
        assert!(w.place_guns(0, 0, 0, 2).is_none(), "one heavy site");
        assert!(w.place_guns(0, 3, 2, 0).is_none(), "five guns, four sites");
    }

    #[test]
    fn a_heavy_gun_hits_hard_and_reaches_far() {
        let mut w = world();
        w.mounts.size[0] = G_HEAVY;
        w.types.guns[0] = 1;
        let a = ship(&mut w, -1800.0, 0.0, 1);
        let b = ship(&mut w, 0.0, 0.0, 2);
        // b: a sitting duck (type 1: the same hull, all but no drive, no guns)
        let t = &mut w.types;
        (t.accel[1], t.turn[1], t.vmax[1], t.well[1], t.len[1], t.hull[1], t.shield[1], t.outline[1], t.rad[1]) = (1.0, 0.1, 1.0, 0.35, 18.0, 60.0, 40.0, 4, 7.0);
        for v in 0..4 { (w.outline.x[MAX_OUTLINE + v], w.outline.y[MAX_OUTLINE + v]) = (w.outline.x[v], w.outline.y[v]); }
        w.ships.kind[b] = 1;
        w.arms.guns[b] = 0;
        for k in [a, b] { (w.traffic.role[k], w.traffic.phase[k]) = (COMBAT, A_LOITER); }
        w.sides.contested.fill(0);
        w.params[P::ai_leash as usize] = 1e9;
        w.params[P::ml_spread as usize] = 0.0;
        w.params[P::mc_jitter as usize] = 0.0;
        assert!(w.gun(G_HEAVY).reach() > 1800.0 && w.gun_range() < 1800.0);
        run(&mut w, 8.0);
        assert!(w.arms.ammo[a] < STOCK_MAG[2], "it fired: {}", w.arms.ammo[a]);
        assert!(w.ships.alive[b] == 0 || w.ships.hull[b] < 60.0 || w.arms.shield[b] < 40.0 - 20.0, "and hit hard: {} {}", w.ships.hull[b], w.arms.shield[b]);
    }

    #[test]
    fn combat_replays() {
        let go = || { let mut w = world(); let a = ship(&mut w, -300.0, 0.0, 1); let b = ship(&mut w, 300.0, 50.0, 2);
            for k in [a, b] { (w.traffic.role[k], w.traffic.phase[k]) = (COMBAT, A_LOITER); } run(&mut w, 6.0); w.hash() };
        assert_eq!(go(), go());
    }

    #[test]
    fn traffic_never_starts_fights() {
        // two neutral armed ships side by side: nobody fires
        let mut w = world();
        ship(&mut w, 0.0, 0.0, 0);
        ship(&mut w, 100.0, 0.0, 0);
        run(&mut w, 2.0);
        assert!((0..MAX_SHELLS).all(|n| w.shells.live[n] == 0));
    }
}
