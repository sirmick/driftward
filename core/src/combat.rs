//! Weapons and combat (the Book's Weapons, Shields and Damage chapters, M2; docs/weapons.md): turret sites, the
//! light multicannon, its shells, hits on the hull's outline, damage through shields to the hull, and the combat AI.
//!
//! Geometry is content, per ship type (the page writes it from the generated hull, src/gen.js `footprint`): the
//! convex `outline` shells hit (local metres, +x right, +y forward, counter-clockwise) and the turret sites, `mount`
//! (light ones only for now: `types.guns` of them). A ship flies with a gun on each of its first `arms.guns` sites:
//! every one for traffic and the lab's fighters (their line's stock fit), the fit's for the player (fit.rs F_MC).
//!
//! Turrets traverse 360 degrees at `mc_traverse` and lead their target (a shell keeps its ship's velocity). The
//! player's fire while Fire is held, at the target or straight ahead; the AI's at their target, inside range and on
//! it. A shell flies `mc_speed` from the muzzle with a little spread and bursts on contact with an outline, or when
//! its fuse runs out: set to the target's range when it has one (flak), else `mc_fuse`. A burst hurts every ship in
//! `mc_blast` metres of it, fully inside `mc_core`, the one it struck fully, but never its own side's or its gunner.
//!
//! Damage goes to the shield first. A hit at or under the shield's hardness (`shield_hard` at 100 m of hull, going with
//! length squared) does only `hard_frac` of itself to the shield; a harder one does the rest to the shield and
//! `bleed_kin` of it through to the hull. A hit pauses regen for `shield_pause`; a shield run out collapses and
//! restarts after `shield_restart` (fit.rs, the player's; here, everyone else's, regenerating in `shield_refill`). A hull
//! at zero is lost: the player's ends the game (service.rs), anyone else's is destroyed.
//!
//! The lab's standing fight (the system file's `combat`; the page writes `side` and MIX_SIDE rows): each side keeps
//! `count` ships in flight, arriving one every `side_gap` seconds at its own jump zone, bound for the contested body.
//! Every side is hostile to every other; to the player only once it has joined another (CMD_SIDE) or fired on them.
//! The AI (a COMBAT ship's phase): LOITER round the contested body; ENGAGE the nearest hostile its sensors hold
//! (the signature model, sensors.rs) within `ai_leash` of the contested body (the player anywhere, once it has fired
//! on them), closing to `ai_range` of the guns' reach and circling; FLEE for its jump zone
//! once its hull is under `morale`, and leave.

use crate::atlas::MAX_SYSTEMS;
use crate::cols::soa;
use crate::fit::{F_MAG, F_MC};
use crate::math::{atan2, hypot, sin_cos, wrap};
use crate::player::IN_FIRE;
use crate::port::{MODE_FLYING, OK, WRONG_MODE};
use crate::traffic::End;
use crate::world::{World, DT, P};

/// Turret sites per type, and outline vertices per type.
pub const MAX_MOUNTS: usize = 8;
pub const MAX_OUTLINE: usize = 12;
/// Shells in flight at once (a new one past this is not fired), and bursts remembered for the page to draw.
pub const MAX_SHELLS: usize = 1024;
pub const MAX_BURSTS: usize = 128;
/// Sides in a lab's fight.
pub const MAX_SIDES: usize = 4;

/// A lab fighter's traffic role, and its mix rows' stream (`body`: the side).
pub const COMBAT: u8 = 6;
pub const MIX_SIDE: u8 = 5;
/// A COMBAT ship's phase once it has arrived (traffic.rs phases are below 10).
pub const A_LOITER: u8 = 10;
pub const A_ENGAGE: u8 = 11;
pub const A_FLEE: u8 = 12;

/// Bursts (`burst.kind`): a shell bursting in the open, on a shield, on a hull; a ship destroyed.
pub const B_AIR: u8 = 1;
pub const B_SHIELD: u8 = 2;
pub const B_HULL: u8 = 3;
pub const B_LOST: u8 = 4;

/// Debug: the player joins side a (0 neutral, 1..MAX_SIDES), and every side forgives it.
pub const CMD_SIDE: u32 = 104;

soa! {
    /// Each type's turret sites (type * MAX_MOUNTS + site), local metres, and their size (1 light).
    pub struct Mounts { x: f64, y: f64, size: u8 }
}

soa! {
    /// Each type's outline (type * MAX_OUTLINE + vertex), local metres, counter-clockwise; `types.outline` vertices.
    pub struct Outline { x: f64, y: f64 }
}

soa! {
    /// Per ship slot: its side (0 none, else side + 1); its shield's points and the seconds before it regenerates
    /// again; the ship it fights (a handle plus one, 0 none) and when it next looks again; rounds aboard; guns fitted;
    /// seconds since it was last hit (the page's shield flash).
    pub struct Arms { side: u8, shield: f64, shield_t: f64, target: u32, think: f64, ammo: f64, guns: u8, hit: f32, orbit: u8 }
}

soa! {
    /// Per ship slot and site (slot * MAX_MOUNTS + site): the turret's world angle and its cooldown, seconds.
    pub struct Turrets { ang: f64, cd: f64 }
}

soa! {
    /// Shells in flight: position and velocity, fuse left, the gunner (a handle) and its side; the previous-tick and
    /// render positions.
    pub struct Shells { live: u8, x: f64, y: f64, vx: f64, vy: f64, t: f64, owner: u32, side: u8, prev_x: f64, prev_y: f64, rx: f32, ry: f32 }
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
    /// flight, the body every side fights over, and when its next ship may arrive (game seconds).
    pub struct Sides { zone: u8, count: u8, contested: i16, next: f64 }
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
    pub(crate) fn step_combat(&mut self) {
        self.side_arrivals();
        for k in 0..self.count {
            if self.ships.alive[k] == 0 { continue; }
            self.arms.hit[k] += DT as f32;
            if self.traffic.role[k] == COMBAT && self.traffic.phase[k] >= A_LOITER { self.think(k); self.steer_fighter(k); }
            self.npc_shield(k);
            self.turrets(k);
        }
        self.fly_shells();
    }

    /// Ship i's outline in local metres (its type's; the player's fitted ship's is its hull's).
    fn outline_of(&self, i: usize) -> ([(f64, f64); MAX_OUTLINE], usize) {
        let k = self.look_kind(i);
        let n = (self.types.outline[k] as usize).min(MAX_OUTLINE);
        let mut p = [(0.0, 0.0); MAX_OUTLINE];
        for (v, q) in p.iter_mut().enumerate().take(n) { *q = (self.outline.x[k * MAX_OUTLINE + v], self.outline.y[k * MAX_OUTLINE + v]); }
        (p, n)
    }
    /// The type whose hull ship i has: the player's fitted ship looks like its catalog type.
    fn look_kind(&self, i: usize) -> usize {
        let k = self.ships.kind[i] as usize;
        if self.fitted() && k == self.player_kind() { self.game.base[0] as usize } else { k }
    }
    fn is_player(&self, i: usize) -> bool { usize::try_from(self.game.player[0]).ok() == Some(i) }
    /// A point in ship i's frame, in the world.
    fn to_world(&self, i: usize, lx: f64, ly: f64) -> (f64, f64) {
        let (s, c) = sin_cos(self.ships.ang[i]);
        (self.ships.x[i] + lx * c - ly * s, self.ships.y[i] + lx * s + ly * c)
    }
    /// A world point in ship i's frame.
    fn to_local(&self, i: usize, x: f64, y: f64) -> (f64, f64) {
        let (s, c) = sin_cos(self.ships.ang[i]);
        let (dx, dy) = (x - self.ships.x[i], y - self.ships.y[i]);
        (dx * c + dy * s, -dx * s + dy * c)
    }
    /// The shield's hardness on ship i: `shield_hard` at 100 m of hull, with length squared.
    fn hardness(&self, i: usize) -> f64 { let l = self.types.len[self.look_kind(i)] / 100.0; self.p(P::shield_hard) * l * l }
    /// How far a light gun reaches: its shells' speed times the fuse.
    pub fn gun_range(&self) -> f64 { self.p(P::mc_speed) * self.p(P::mc_fuse) }

    /// Arm a slot that has just become a ship: its type's guns on every site, a tonne of rounds each, its shield full,
    /// turrets facing forward; side `side` (0 none).
    pub(crate) fn arm(&mut self, k: usize, side: u8) {
        let t = self.ships.kind[k] as usize;
        let guns = self.types.guns[t].min(MAX_MOUNTS as u8);
        let a = &mut self.arms;
        (a.side[k], a.shield[k], a.shield_t[k], a.target[k], a.ammo[k], a.guns[k], a.hit[k]) = (side, self.types.shield[t], 0.0, 0, guns as f64 * self.params[P::mc_rounds as usize], guns, 99.0);
        a.think[k] = self.rng.range(0.0, self.params[P::ai_think as usize]);
        a.orbit[k] = (self.rng.next_f64() < 0.5) as u8;
        for m in 0..MAX_MOUNTS { (self.turrets.ang[k * MAX_MOUNTS + m], self.turrets.cd[k * MAX_MOUNTS + m]) = (self.ships.ang[k], 0.0); }
    }

    /// The player's guns and rounds from the fit (a new game, a refit, a landing's restock).
    pub(crate) fn arm_player(&mut self) {
        let Some(i) = usize::try_from(self.game.player[0]).ok().filter(|&i| i < self.count) else { return };
        let (guns, mag) = if self.fitted() { (self.fit.t[F_MC], self.fit.t[F_MAG]) } else { (0.0, 0.0) };
        let side = self.battle.player_side[0];
        let a = &mut self.arms;
        (a.side[i], a.guns[i], a.ammo[i], a.target[i], a.hit[i]) = (side, (guns as usize).min(MAX_MOUNTS) as u8, mag * self.params[P::mc_rounds as usize], 0, 99.0);
    }

    // ---------- the lab's sides ----------

    fn side_arrivals(&mut self) {
        let now = self.tick as f64 * DT;
        for s in 0..MAX_SIDES {
            let want = self.sides.count[s] as usize;
            let c = self.sides.contested[s];
            if want == 0 || c < 0 || c as usize >= self.n_bodies || now < self.sides.next[s] { continue; }
            let have = (0..self.count).filter(|&k| self.traffic.role[k] == COMBAT && self.ships.alive[k] != 0 && self.arms.side[k] == s as u8 + 1).count();
            if have >= want { continue; }
            self.sides.next[s] = now + self.p(P::side_gap);
            // the side's type by weight
            let rows: Vec<usize> = (0..crate::traffic::MAX_MIX).filter(|&m| self.mix.stream[m] == MIX_SIDE && self.mix.body[m] == s as i16 && self.mix.weight[m] > 0.0).collect();
            let total: f64 = rows.iter().map(|&m| self.mix.weight[m]).sum();
            if total <= 0.0 { continue; }
            let mut pick = self.rng.range(0.0, total);
            let m = *rows.iter().find(|&&m| { pick -= self.mix.weight[m]; pick <= 0.0 }).unwrap_or(&rows[rows.len() - 1]);
            let z = (self.sides.zone[s] as usize) % self.n_zones().max(1);
            if let Some(k) = self.spawn(COMBAT, End::Jump(z), End::Body(c as usize), Some(m)) { self.arm(k, s as u8 + 1); }
        }
    }

    /// Whether side `side` (1..) is at war with ship j.
    fn hostile(&self, side: u8, j: usize) -> bool {
        if side == 0 || self.ships.alive[j] == 0 || self.ships.rail[j] != 0 { return false; }
        if self.is_player(j) {
            if self.mode() != MODE_FLYING { return false; }
            let ps = self.battle.player_side[0];
            return (ps != 0 && ps != side) || self.battle.angry[0] & (1 << (side - 1)) != 0;
        }
        self.traffic.role[j] == COMBAT && self.arms.side[j] != 0 && self.arms.side[j] != side
    }
    /// Whether ship i's sensors hold ship j: the player through `seen` (sensors.rs), others by their signature now.
    fn holds(&self, i: usize, j: usize) -> bool {
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
        let (cx, cy, leash) = if c >= 0 && (c as usize) < self.n_bodies { (self.bodies.x[c as usize], self.bodies.y[c as usize], self.p(P::ai_leash)) } else { (x, y, f64::MAX) };
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
                Some(j) => circle(self.ships.x[j], self.ships.y[j], self.ships.vx[j], self.ships.vy[j], self.p(P::ai_range) * self.gun_range(), cruise * 0.7),
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
                    circle(self.bodies.x[j], self.bodies.y[j], self.bodies.vx[j], self.bodies.vy[j], self.bodies.r[j] * self.p(P::ai_orbit), cruise * 0.5)
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
    fn turrets(&mut self, k: usize) {
        let guns = self.arms.guns[k] as usize;
        if guns == 0 || self.ships.rail[k] != 0 { return; }
        let player = self.is_player(k);
        if player && self.mode() != MODE_FLYING { return; }
        let target = if player { self.target_ship() } else { self.arms.target[k].checked_sub(1).and_then(|h| self.resolve(h)) };
        let firing = if player { self.game.input[0] & IN_FIRE != 0 } else { target.is_some() && self.traffic.phase[k] == A_ENGAGE };
        let (speed, range, trav) = (self.p(P::mc_speed), self.gun_range(), self.p(P::mc_traverse) * DT);
        let look = self.look_kind(k);
        let (hot, mj) = (self.game.hot[0] != 0, self.p(P::mc_mj));
        for m in 0..guns {
            let o = k * MAX_MOUNTS + m;
            let mi = look * MAX_MOUNTS + m;
            let (mx, my) = self.to_world(k, self.mounts.x[mi], self.mounts.y[mi]);
            // the lead: where the target will be when a shell (with the ship's velocity) reaches it
            let aim = target.map(|j| {
                let (dx, dy) = (self.ships.x[j] - mx, self.ships.y[j] - my);
                let (ux, uy) = (self.ships.vx[j] - self.ships.vx[k], self.ships.vy[j] - self.ships.vy[k]);
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
            if !firing || self.turrets.cd[o] > 0.0 || self.arms.ammo[k] < 1.0 { continue; }
            if !player {
                let Some((_, _, d)) = aim else { continue };
                if d > range * 1.05 || err.abs() > 0.06 { continue; }
            } else if hot || (self.fitted() && self.game.energy[0] < mj) { continue; }
            // the fuse: burst at the target's range (flak), else at full reach
            let fuse = aim.map_or(self.p(P::mc_fuse), |a| (a.1 + 0.03).clamp(0.05, self.p(P::mc_fuse)));
            if self.fire(k, mx, my, self.turrets.ang[o], fuse) {
                self.turrets.cd[o] += 1.0 / self.p(P::mc_rate).max(0.1);
                self.arms.ammo[k] -= 1.0;
                if player && self.fitted() {
                    self.game.energy[0] = (self.game.energy[0] - mj).max(0.0);
                    let cap = self.stats(self.game.base[0] as usize, &self.fit.t, 0.0, 0.0).heat_cap.max(1.0);
                    self.game.heat[0] = (self.game.heat[0] + self.p(P::mc_heat) / cap).min(1.0);
                }
            }
        }
    }

    /// A shell from (x, y) along angle `ang`, give or take the spread, with ship k's velocity; false if every shell
    /// slot is in use.
    fn fire(&mut self, k: usize, x: f64, y: f64, ang: f64, fuse: f64) -> bool {
        let Some(n) = (0..MAX_SHELLS).find(|&n| self.shells.live[n] == 0) else { return false };
        let spread = self.p(P::mc_spread) * (self.rng.next_f64() + self.rng.next_f64() - 1.0);
        let (s, c) = sin_cos(ang + spread);
        let v = self.p(P::mc_speed);
        let (owner, side) = (self.handle(k), self.arms.side[k]);
        let (vx, vy) = (self.ships.vx[k], self.ships.vy[k]);
        let sh = &mut self.shells;
        (sh.live[n], sh.x[n], sh.y[n], sh.vx[n], sh.vy[n], sh.t[n], sh.owner[n], sh.side[n]) = (1, x, y, vx - s * v, vy + c * v, fuse, owner, side);
        (sh.prev_x[n], sh.prev_y[n], sh.rx[n], sh.ry[n]) = (x, y, x as f32, y as f32);
        true
    }

    /// Every shell a tick on: does its path enter a ship's outline? Then it bursts there; else when its fuse runs out.
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
            for j in 0..self.count {
                if self.ships.alive[j] == 0 || self.ships.rail[j] != 0 || Some(j) == owner || (side != 0 && self.arms.side[j] == side) { continue; }
                let r = self.types.rad[self.look_kind(j)];
                if r <= 0.0 || hypot(self.ships.x[j] - x1, self.ships.y[j] - y1) > r + seg { continue; }
                let (poly, nv) = self.outline_of(j);
                if let Some(t) = enter(&poly[..nv], self.to_local(j, x0, y0), self.to_local(j, x1, y1)) && hit.is_none_or(|h| t < h.1) { hit = Some((j, t)); }
            }
            if let Some((j, t)) = hit {
                self.shells.live[n] = 0;
                self.burst(n, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, Some(j));
            } else if self.shells.t[n] <= 0.0 {
                self.shells.live[n] = 0;
                self.burst(n, x1, y1, None);
            }
        }
    }

    /// Shell n bursts at (x, y), on ship `struck` if it hit one: every ship within the blast takes its share.
    fn burst(&mut self, n: usize, x: f64, y: f64, struck: Option<usize>) {
        let (blast, core, dmg) = (self.p(P::mc_blast), self.p(P::mc_core), self.p(P::mc_dmg));
        let (owner, side) = (self.resolve(self.shells.owner[n]), self.shells.side[n]);
        let mut kind = B_AIR;
        for j in 0..self.count {
            if self.ships.alive[j] == 0 || self.ships.rail[j] != 0 || Some(j) == owner || (side != 0 && self.arms.side[j] == side) { continue; }
            let d = if Some(j) == struck { 0.0 } else {
                let r = self.types.rad[self.look_kind(j)];
                if r <= 0.0 || hypot(self.ships.x[j] - x, self.ships.y[j] - y) > r + blast { continue; }
                let (poly, nv) = self.outline_of(j);
                distance(&poly[..nv], self.to_local(j, x, y))
            };
            if d >= blast { continue; }
            let share = if d <= core { 1.0 } else { 1.0 - (d - core) / (blast - core).max(1e-6) };
            let k = self.damage(j, dmg * share, owner);
            if Some(j) == struck { kind = k; }
        }
        self.note_burst(kind, x, y, blast, struck);
    }

    fn note_burst(&mut self, kind: u8, x: f64, y: f64, size: f64, ship: Option<usize>) {
        let b = (self.battle.burst[0] as usize) % MAX_BURSTS;
        let now = self.tick as f64 * DT;
        (self.bursts.kind[b], self.bursts.x[b], self.bursts.y[b], self.bursts.size[b], self.bursts.at[b]) = (kind, x, y, size, now);
        self.bursts.ship[b] = ship.map_or(0, |i| i as u16 + 1);
        self.battle.burst[0] = ((b + 1) % MAX_BURSTS) as u16;
    }

    /// `dmg` points of kinetic damage on ship j from `from`'s guns: shield, then hull (see the module comment).
    /// Returns what it struck (B_SHIELD or B_HULL).
    pub(crate) fn damage(&mut self, j: usize, dmg: f64, from: Option<usize>) -> u8 {
        let player = self.is_player(j);
        let (shield, st) = if player { (self.game.shield[0], self.game.shield_t[0]) } else { (self.arms.shield[j], self.arms.shield_t[j]) };
        let (mut shield, mut st, mut hull) = (shield, st, 0.0);
        let mut struck = B_HULL;
        if shield > 0.0 {
            struck = B_SHIELD;
            if dmg <= self.hardness(j) { shield -= dmg * self.p(P::hard_frac); }
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
            (self.sides.zone[s], self.sides.count[s], self.sides.contested[s], self.sides.next[s]) = (self.atlas_sides.zone[o], self.atlas_sides.count[o], self.atlas_sides.contested[o], 0.0);
        }
    }
    /// Shells and bursts go when the system changes (a jump, a new game).
    pub(crate) fn clear_fire(&mut self) {
        self.shells.clear();
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
    fn hardness_shrugs_off_light_hits_on_big_hulls() {
        let mut w = world();
        let a = ship(&mut w, 0.0, 0.0, 1);
        w.types.len[0] = 160.0; // a capital hull: hardness 2.56
        w.damage(a, 1.0, None);
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
        let fired = |w: &World| w.arms.ammo[a] < 800.0 && w.arms.ammo[b] < 800.0;
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
