//! Missiles (docs/weapons.md): forward bays, the missiles they launch, waves, and point defence's targets.
//!
//! Bays are turret sites of size G_BAY (combat.rs `mount`, from src/gen.js `footprint`): fixed, launching along the
//! hull's axis. A type's magazine of missiles is content (`types.missiles`, the loadout's `missiles`). A launch is a
//! volley, a missile from every bay, and the bays then reload for `ms_reload` seconds.
//!
//! A missile flies by the ships' physics, without their assist: thrust along its heading, gravity wells pulling it as
//! they pull a ship of `ms_well` sensitivity, and the gas's drag; no drive taper and no dampers, so it can outrun what
//! launched it. It leaves its bay at its ship's velocity plus `ms_eject_v`, and its motor lights after `ms_eject`
//! seconds, burning `ms_burn` seconds; then it coasts, and after `ms_life` seconds it destroys itself.
//!
//! Guidance is proportional navigation: an acceleration across the line of sight of `ms_nav` times the closing speed
//! times the line of sight's turn rate, which holds the bearing constant as the range falls (CBDR), so a missile heads a
//! target off instead of chasing it. What the motor has left over goes along the line of sight. The missile turns at
//! `ms_turn` toward that acceleration's direction and thrusts along its heading. Its seeker holds the target while the
//! target's signature, seen from the missile, makes a contact (the sensors' model times `ms_seek`); lost, the missile
//! flies on straight.
//!
//! It bursts when its path comes within `ms_prox` of a hostile ship's shield (or hull, the shield down), its warhead
//! doing `ms_dmg` through `ms_blast` metres (full inside `ms_core`) by the shells' rules (combat.rs `blast`). Shells hit
//! it as a circle of `ms_rad` metres, and a burst's blast reaches it too; `ms_hp` points of damage destroy it.
//!
//! Waves: every `ms_wave` seconds (give or take `ms_wave_jit`) a lab side picks the most valuable enemy its ships are
//! fighting (the longest hull), and every ship of the side with missiles, its bays loaded and that target within
//! `ms_range` launches a volley at it. Those nearer wait out the difference in flight time, so the wave arrives
//! together and floods the target's point defence.
//!
//! Point defence (combat.rs `turrets`): light guns shoot first at the nearest missile within their reach that is
//! homing on their ship, or another side's within `ms_pd_near` of it. A ship defends itself, not its neighbours.

use crate::cols::soa;
use crate::combat::{A_FLEE, B_SHOT, COMBAT, G_BAY, MAX_MOUNTS, MAX_SIDES};
use crate::flight::{heading, well_field};
use crate::math::{atan2, hypot, sin_cos, wrap};
use crate::player::IN_MISSILE;
use crate::port::MODE_FLYING;
use crate::world::{World, DT, P};

/// Missiles in flight at once (a launch past this is not made).
pub const MAX_MISSILES: usize = 512;

soa! {
    /// Missiles in flight: position, velocity, heading; seconds of motor and of life left; the ship it homes on (a handle
    /// plus one, 0 none), its launcher (a handle) and side; points left; the previous-tick and render poses, and the
    /// motor's glow for the page (0 or 1).
    pub struct Missiles { live: u8, x: f64, y: f64, vx: f64, vy: f64, ang: f64, burn: f64, t: f64, target: u32, owner: u32, side: u8, hp: f64,
        prev_x: f64, prev_y: f64, rx: f32, ry: f32, ra: f32, thr: f32 }
}

impl World {
    /// Ship i's bays (its look's sites of size G_BAY): how many.
    pub fn bays(&self, i: usize) -> usize {
        let k = self.look_kind(i);
        (0..(self.types.guns[k] as usize).min(MAX_MOUNTS)).filter(|&m| self.mounts.size[k * MAX_MOUNTS + m] == G_BAY).count()
    }

    /// Seconds a missile takes to fly `d` metres from rest (its motor at full, then coasting).
    fn flight_time(&self, d: f64) -> f64 {
        let (a, b) = (self.p(P::ms_accel).max(1e-6), self.p(P::ms_burn));
        let lit = 0.5 * a * b * b;
        self.p(P::ms_eject) + if d <= lit { (2.0 * d / a).sqrt() } else { b + (d - lit) / (a * b).max(1e-6) }
    }

    /// The lab sides' missile waves: each side, when its wave is due, picks a target and its ships' launch times.
    pub(crate) fn side_waves(&mut self) {
        let now = self.tick as f64 * DT;
        for s in 0..MAX_SIDES {
            if self.sides.count[s] == 0 { continue; }
            let gap = self.p(P::ms_wave);
            if self.sides.wave[s] <= 0.0 { self.sides.wave[s] = now + gap * self.rng.range(0.3, 1.0); continue; }
            if now < self.sides.wave[s] { continue; }
            let side = s as u8 + 1;
            let ours = |w: &World, k: usize| w.traffic.role[k] == COMBAT && w.ships.alive[k] != 0 && w.arms.side[k] == side && w.traffic.phase[k] != A_FLEE;
            // the most valuable ship the side is fighting: the longest hull, the most hurt of those
            let mut best: Option<(usize, f64, f64)> = None;
            for k in 0..self.count {
                if !ours(self, k) { continue; }
                let Some(j) = self.arms.target[k].checked_sub(1).and_then(|h| self.resolve(h)) else { continue };
                let kind = self.look_kind(j);
                let (len, hurt) = (self.types.len[kind], -self.ships.hull[j] / self.types.hull[kind].max(1e-6));
                if best.is_none_or(|(_, bl, bh)| len > bl || (len == bl && hurt > bh)) { best = Some((j, len, hurt)); }
            }
            // and the ships that can reach it with a volley
            let range = self.p(P::ms_range);
            let mut launchers: Vec<(usize, f64)> = Vec::new();
            if let Some((j, _, _)) = best {
                for k in 0..self.count {
                    if !ours(self, k) || self.arms.missiles[k] == 0 || self.arms.reload[k] > 0.0 || self.arms.wave_tgt[k] != 0 || self.bays(k) == 0 { continue; }
                    let d = hypot(self.ships.x[j] - self.ships.x[k], self.ships.y[j] - self.ships.y[k]);
                    if d <= range { launchers.push((k, self.flight_time(d))); }
                }
            }
            if launchers.is_empty() { self.sides.wave[s] = now + 2.0; continue; }
            let j = best.map(|b| b.0).unwrap_or(0);
            // the farthest launches at once, the nearer wait, so they all arrive together
            let last = launchers.iter().map(|l| l.1).fold(0.0, f64::max);
            let h = self.handle(j) + 1;
            for (k, tf) in launchers { (self.arms.wave_tgt[k], self.arms.wave_t[k]) = (h, last - tf); }
            let jit = self.p(P::ms_wave_jit);
            self.sides.wave[s] = now + gap * (1.0 + jit * (self.rng.next_f64() * 2.0 - 1.0));
        }
    }

    /// Ship k's bays: reloading, a wave's volley when its time comes, the player's while Missile is held.
    pub(crate) fn bays_step(&mut self, k: usize) {
        self.arms.reload[k] = (self.arms.reload[k] - DT).max(0.0);
        if self.ships.rail[k] != 0 { return; }
        if self.is_player(k) {
            if self.mode() != MODE_FLYING || self.game.input[0] & IN_MISSILE == 0 || self.arms.reload[k] > 0.0 { return; }
            if let Some(j) = self.target_ship() { self.volley(k, j); }
            return;
        }
        if self.arms.wave_tgt[k] == 0 { return; }
        self.arms.wave_t[k] -= DT;
        if self.arms.wave_t[k] > 0.0 { return; }
        let target = self.arms.wave_tgt[k].checked_sub(1).and_then(|h| self.resolve(h));
        self.arms.wave_tgt[k] = 0;
        if let Some(j) = target && self.traffic.phase[k] != A_FLEE { self.volley(k, j); }
    }

    /// A missile from each of ship k's bays at ship j (as many as it has left); the bays reload.
    fn volley(&mut self, k: usize, j: usize) {
        if self.arms.missiles[k] == 0 { return; }
        let look = self.look_kind(k);
        let mut fired = false;
        for m in 0..(self.types.guns[look] as usize).min(MAX_MOUNTS) {
            let mi = look * MAX_MOUNTS + m;
            if self.mounts.size[mi] != G_BAY || self.arms.missiles[k] == 0 { continue; }
            let Some(n) = (0..MAX_MISSILES).find(|&n| self.missiles.live[n] == 0) else { break };
            let (s, c) = sin_cos(self.ships.ang[k]);
            let (x, y) = (self.ships.x[k] + self.mounts.x[mi] * c - self.mounts.y[mi] * s, self.ships.y[k] + self.mounts.x[mi] * s + self.mounts.y[mi] * c);
            // out of the bay a little off the axis, so a volley fans before it turns in
            let ang = wrap(self.ships.ang[k] + 0.08 * (self.rng.next_f64() * 2.0 - 1.0));
            let (hx, hy) = heading(ang);
            let ev = self.p(P::ms_eject_v);
            let (owner, side, tgt) = (self.handle(k), self.arms.side[k], self.handle(j) + 1);
            let (vx, vy) = (self.ships.vx[k] + hx * ev, self.ships.vy[k] + hy * ev);
            let (burn, life, hp) = (self.p(P::ms_burn), self.p(P::ms_life), self.p(P::ms_hp));
            let ms = &mut self.missiles;
            (ms.live[n], ms.x[n], ms.y[n], ms.vx[n], ms.vy[n], ms.ang[n], ms.burn[n], ms.t[n]) = (1, x, y, vx, vy, ang, burn, life);
            (ms.target[n], ms.owner[n], ms.side[n], ms.hp[n], ms.thr[n]) = (tgt, owner, side, hp, 0.0);
            (ms.prev_x[n], ms.prev_y[n], ms.rx[n], ms.ry[n], ms.ra[n]) = (x, y, x as f32, y as f32, ang as f32);
            self.arms.missiles[k] -= 1;
            fired = true;
        }
        if fired { self.arms.reload[k] = self.p(P::ms_reload); }
    }

    /// Whether missile n's seeker holds ship j: the target's signature, seen from the missile, makes a contact.
    fn seeker_holds(&self, n: usize, j: usize) -> bool {
        let d = hypot(self.ships.x[j] - self.missiles.x[n], self.ships.y[j] - self.missiles.y[n]);
        self.p(P::sens_k) * self.p(P::ms_seek) * self.ships.sig[j] / (d * d / 1e6 + 0.04) >= self.p(P::contact_snr)
    }

    /// Every missile a tick on: guidance, motor, gravity and drag, then a burst if its path met a hostile ship's shield
    /// (with the proximity fuse's reach), or when its life runs out. Needs the ships' grid (combat.rs `build_grid`).
    pub(crate) fn fly_missiles(&mut self) {
        let (acc, nav, turn, eject, life) = (self.p(P::ms_accel), self.p(P::ms_nav), self.p(P::ms_turn) * DT, self.p(P::ms_eject), self.p(P::ms_life));
        let (reach, g_ref, pull, sens, prox) = (self.p(P::well_reach), self.p(P::g_ref), self.p(P::pull), self.p(P::ms_well), self.p(P::ms_prox));
        for n in 0..MAX_MISSILES {
            if self.missiles.live[n] == 0 { continue; }
            let (x0, y0) = (self.missiles.x[n], self.missiles.y[n]);
            self.missiles.t[n] -= DT;
            // the seeker: the target, while it holds it
            let mut tgt = self.missiles.target[n].checked_sub(1).and_then(|h| self.resolve(h));
            if let Some(j) = tgt && (self.ships.rail[j] != 0 || !self.seeker_holds(n, j)) { tgt = None; self.missiles.target[n] = 0; }
            let lit = life - self.missiles.t[n] >= eject && self.missiles.burn[n] > 0.0;
            let (mut ax, mut ay) = (0.0, 0.0);
            if lit {
                if let Some(j) = tgt {
                    // proportional navigation: across the line of sight, nav x closing speed x its turn rate; the rest along it
                    let (rx, ry) = (self.ships.x[j] - x0, self.ships.y[j] - y0);
                    let (ux, uy) = (self.ships.vx[j] - self.missiles.vx[n], self.ships.vy[j] - self.missiles.vy[n]);
                    let r2 = (rx * rx + ry * ry).max(1.0);
                    let r = r2.sqrt();
                    let los_rate = (rx * uy - ry * ux) / r2;
                    let closing = (-(rx * ux + ry * uy) / r).max(0.0);
                    let lat = (nav * closing * los_rate).clamp(-acc, acc);
                    let (lx, ly) = (rx / r, ry / r);
                    let along = (acc * acc - lat * lat).max(0.0).sqrt();
                    let (wx, wy) = (lx * along - ly * lat, ly * along + lx * lat);
                    let want = atan2(-wx, wy);
                    let err = wrap(want - self.missiles.ang[n]);
                    self.missiles.ang[n] = wrap(self.missiles.ang[n] + err.clamp(-turn, turn));
                }
                let (hx, hy) = heading(self.missiles.ang[n]);
                (ax, ay) = (hx * acc, hy * acc);
                self.missiles.burn[n] -= DT;
            }
            self.missiles.thr[n] = lit as u8 as f32;
            // the well's pull, as on a ship of ms_well sensitivity (a share of its thrust), and the gas's drag
            let (wx, wy) = well_field(&self.bodies, self.n_bodies, x0, y0, reach, g_ref);
            let wl = hypot(wx, wy);
            if wl > 0.0 { let g = wl.min(1.5) * sens * pull * acc / wl; ax += wx * g; ay += wy * g; }
            let (gh, gd, gi) = crate::flight::gas_at(self, x0, y0);
            let cd = self.p(P::drag_h) * gh + self.p(P::drag_d) * gd + self.p(P::drag_i) * gi;
            let sp = hypot(self.missiles.vx[n], self.missiles.vy[n]);
            ax -= cd * sp * self.missiles.vx[n];
            ay -= cd * sp * self.missiles.vy[n];
            let ms = &mut self.missiles;
            ms.vx[n] += ax * DT;
            ms.vy[n] += ay * DT;
            let (x1, y1) = (x0 + ms.vx[n] * DT, y0 + ms.vy[n] * DT);
            (ms.prev_x[n], ms.prev_y[n], ms.x[n], ms.y[n]) = (x0, y0, x1, y1);
            // the proximity fuse: the first hostile ship whose shield (grown by ms_prox) its path meets
            let (owner, side) = (self.resolve(self.missiles.owner[n]), self.missiles.side[n]);
            let seg = hypot(x1 - x0, y1 - y0);
            let mut hit: Option<(usize, f64)> = None;
            self.grid.near(x0, y0, x1, y1, prox, |j| {
                if self.ships.alive[j] == 0 || Some(j) == owner || (side != 0 && self.arms.side[j] == side) { return; }
                let (r, s) = (self.types.rad[self.look_kind(j)], self.standoff(j) + prox);
                if r <= 0.0 || hypot(self.ships.x[j] - x1, self.ships.y[j] - y1) > r + s + seg { return; }
                let (poly, nv) = self.outline_of(j);
                if let Some(t) = crate::combat::enter_round(&poly[..nv], s, self.to_local(j, x0, y0), self.to_local(j, x1, y1))
                    && hit.is_none_or(|h| t < h.1 || (t == h.1 && j < h.0)) { hit = Some((j, t)); }
            });
            if let Some((j, t)) = hit { self.detonate(n, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, Some(j)); }
            else if self.missiles.t[n] <= 0.0 { self.detonate(n, x1, y1, None); }
        }
    }

    /// Missile n's warhead goes off at (x, y), beside ship `near` if its fuse found one.
    fn detonate(&mut self, n: usize, x: f64, y: f64, near: Option<usize>) {
        self.missiles.live[n] = 0;
        let (owner, side) = (self.resolve(self.missiles.owner[n]), self.missiles.side[n]);
        let (blast, core, dmg) = (self.p(P::ms_blast), self.p(P::ms_core), self.p(P::ms_dmg));
        // the ship whose shield the fuse found takes it full, as a shell's struck ship does
        let kind = self.blast(x, y, near, blast, core, dmg, owner, side);
        self.note_burst(kind, x, y, blast, near);
    }

    /// Damage `dmg` to missile n (from a shell or a burst's blast); destroyed at no points left.
    pub(crate) fn hurt_missile(&mut self, n: usize, dmg: f64) {
        if self.missiles.live[n] == 0 { return; }
        self.missiles.hp[n] -= dmg;
        if self.missiles.hp[n] <= 0.0 {
            self.missiles.live[n] = 0;
            let (x, y) = (self.missiles.x[n], self.missiles.y[n]);
            self.note_burst(B_SHOT, x, y, self.p(P::ms_rad) * 4.0, None);
        }
    }

    /// Whether missile n threatens ship k: not its own, and homing on k, or another side's within `ms_pd_near` of it.
    /// A ship defends itself, not its neighbours: a wave meets its target's guns, not the whole fleet's.
    pub(crate) fn threatens(&self, n: usize, k: usize) -> bool {
        if self.missiles.live[n] == 0 || self.resolve(self.missiles.owner[n]) == Some(k) { return false; }
        if self.missiles.target[n].checked_sub(1).and_then(|h| self.resolve(h)) == Some(k) { return true; }
        let (ms, ks) = (self.missiles.side[n], self.arms.side[k]);
        ms != 0 && ks != 0 && ms != ks && hypot(self.missiles.x[n] - self.ships.x[k], self.missiles.y[n] - self.ships.y[k]) <= self.p(P::ms_pd_near)
    }

    /// The missiles by where they are, for shells and point defence (grid.rs; `mgrid`).
    pub(crate) fn build_missile_grid(&mut self) {
        let mut g = std::mem::take(&mut self.mgrid);
        let r = self.p(P::ms_rad);
        g.build(MAX_MISSILES, |n| (self.missiles.live[n] != 0).then(|| (self.missiles.x[n], self.missiles.y[n], r)));
        self.mgrid = g;
    }

    /// The nearest missile threatening ship k within `range` of (x, y), for its light guns.
    pub(crate) fn pd_target(&self, k: usize, x: f64, y: f64, range: f64) -> Option<usize> {
        let mut best: Option<(usize, f64)> = None;
        self.mgrid.near(x, y, x, y, range, |n| {
            if !self.threatens(n, k) { return; }
            let d = hypot(self.missiles.x[n] - x, self.missiles.y[n] - y);
            if d <= range && best.is_none_or(|(bn, bd)| d < bd || (d == bd && n < bn)) { best = Some((n, d)); }
        });
        best.map(|b| b.0)
    }

    /// Missiles go when the system changes.
    pub(crate) fn clear_missiles(&mut self) { self.missiles.clear(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::combat::{A_ENGAGE, A_LOITER, G_LIGHT, MAX_OUTLINE};
    use crate::port::BODY_STATION;
    use crate::world::Config;

    /// Type 0: a 66 m hull with two bays and two light guns; type 1: a 145 m target with four light guns.
    fn world() -> Box<World> {
        let mut w = World::new(Config { max_ships: 32, max_types: 2, max_bodies: 2, env_n: 4, env_w: 1000.0 }, 5);
        for k in 0..2 {
            let (hw, hl) = if k == 0 { (10.0, 33.0) } else { (22.0, 72.0) };
            let t = &mut w.types;
            (t.accel[k], t.turn[k], t.vmax[k], t.well[k], t.len[k], t.hull[k], t.shield[k], t.outline[k], t.rad[k]) = (40.0, 1.0, 200.0, 0.5, 2.0 * hl, 400.0, 200.0, 4, hypot(hw, hl));
            for (v, (x, y)) in [(-hw, -hl), (hw, -hl), (hw, hl), (-hw, hl)].into_iter().enumerate() { (w.outline.x[k * MAX_OUTLINE + v], w.outline.y[k * MAX_OUTLINE + v]) = (x, y); }
            let sites: &[(f64, f64, u8)] = if k == 0 { &[(-5.0, 0.0, G_LIGHT), (5.0, 0.0, G_LIGHT), (-6.0, 25.0, G_BAY), (6.0, 25.0, G_BAY)] } else { &[(-15.0, 30.0, G_LIGHT), (15.0, 30.0, G_LIGHT), (-15.0, -30.0, G_LIGHT), (15.0, -30.0, G_LIGHT)] };
            for (m, &(x, y, z)) in sites.iter().enumerate() { let o = k * MAX_MOUNTS + m; (w.mounts.x[o], w.mounts.y[o], w.mounts.size[o]) = (x, y, z); }
            w.types.guns[k] = sites.len() as u8;
        }
        w.types.missiles[0] = 16;
        w.n_bodies = 1;
        (w.bodies.r[0], w.bodies.kind[0]) = (400.0, BODY_STATION);
        w.sides.contested.fill(0);
        w.params[P::ai_leash as usize] = 1e9;
        w
    }
    fn ship(w: &mut World, kind: u16, x: f64, y: f64, side: u8) -> usize {
        let k = w.count;
        w.count += 1;
        let s = &mut w.ships;
        (s.alive[k], s.kind[k], s.x[k], s.y[k], s.hull[k], s.ctl[k]) = (1, kind, x, y, 400.0, 1);
        w.slot_reset(k, true);
        w.arm(k, side);
        (w.traffic.role[k], w.traffic.phase[k]) = (COMBAT, A_LOITER);
        k
    }
    fn run(w: &mut World, secs: f64) { for _ in 0..(secs / DT).round() as usize { w.step(); } }

    #[test]
    fn bays_are_not_turrets() {
        let mut w = world();
        let a = ship(&mut w, 0, 0.0, 0.0, 1);
        assert_eq!(w.bays(a), 2);
        assert_eq!(w.arms.guns[a], 2, "two guns; the bays carry none");
        assert_eq!(w.arms.missiles[a], 16);
        assert_eq!(w.site_counts(0), [2, 0, 0]);
    }

    #[test]
    fn a_missile_heads_off_a_crossing_target() {
        let mut w = world();
        let a = ship(&mut w, 0, 0.0, -5000.0, 1);
        let b = ship(&mut w, 1, -3000.0, 0.0, 2);
        // b crosses ahead of the missile at 300 m/s, guns silent; a holds still
        for k in [a, b] { w.traffic.role[k] = 0; w.ships.ctl[k] = 0; }
        for m in 0..MAX_MOUNTS { w.turrets.gun[b * MAX_MOUNTS + m] = 0; }
        w.arms.guns[b] = 0;
        w.ships.vx[b] = 300.0;
        w.ships.sig[b] = 50.0;
        w.volley(a, b);
        assert_eq!(w.arms.missiles[a], 14, "one a bay");
        // pure pursuit would lag behind; PN leads: within a few seconds the missiles point ahead of the target's bearing
        run(&mut w, 3.0);
        let n = (0..MAX_MISSILES).find(|&n| w.missiles.live[n] != 0).expect("in flight");
        let bearing = atan2(-(w.ships.x[b] - w.missiles.x[n]), w.ships.y[b] - w.missiles.y[n]);
        assert!(wrap(w.missiles.ang[n] - bearing) < -0.02, "leads the target (clockwise of its bearing): {} vs {}", w.missiles.ang[n], bearing);
        run(&mut w, 15.0);
        assert!((0..MAX_MISSILES).all(|n| w.missiles.live[n] == 0), "gone");
        // each through the shield (25 over a hardness of 5.2): a tenth to the hull (the shield has regenerated since)
        assert!(w.ships.hull[b] < 400.0 - 4.0, "and struck: {}", w.ships.hull[b]);
        assert!((0..crate::combat::MAX_BURSTS).filter(|&q| w.bursts.kind[q] == crate::combat::B_SHIELD && w.bursts.ship[q] as usize == b + 1).count() == 2, "both on its shield");
    }

    #[test]
    fn point_defence_shoots_missiles_first() {
        let mut w = world();
        let a = ship(&mut w, 0, 0.0, -3000.0, 1);
        let b = ship(&mut w, 1, 0.0, 0.0, 2);
        let c = ship(&mut w, 0, 400.0, 200.0, 1); // an enemy fighter beside b, in its guns' reach
        for k in [a, b, c] { w.traffic.role[k] = 0; w.ships.ctl[k] = 0; }
        w.ships.sig[b] = 50.0;
        w.arms.target[b] = w.handle(c) + 1;
        w.volley(a, b);
        let mut shot = false;
        for _ in 0..(12.0 / DT) as usize {
            w.step();
            shot |= (0..crate::combat::MAX_BURSTS).any(|q| w.bursts.kind[q] == B_SHOT);
        }
        assert!(shot, "the guns shot a missile down");
    }

    #[test]
    fn a_side_fires_a_wave_together() {
        let mut w = world();
        (w.params[P::ms_wave as usize], w.params[P::ms_reload as usize]) = (1.0, 1e9);
        w.sides.count[0] = 3; w.sides.count[1] = 1;
        let l: Vec<usize> = [-4000.0, -6000.0, -7000.0].iter().map(|&x| ship(&mut w, 0, x, 0.0, 1)).collect();
        let b = ship(&mut w, 1, 0.0, 0.0, 2);
        for &k in &l { w.arms.target[k] = w.handle(b) + 1; (w.traffic.phase[k], w.arms.think[k]) = (A_ENGAGE, 1e9); }
        // nobody moves or shoots: only the wave
        for k in 0..w.count { w.ships.ctl[k] = 0; w.traffic.role[k] = if l.contains(&k) { COMBAT } else { 0 }; for m in 0..MAX_MOUNTS { w.turrets.gun[k * MAX_MOUNTS + m] = 0; } }
        w.mix.weight.fill(0.0);
        w.ships.sig[b] = 50.0;
        w.sides.wave[0] = 0.05;
        w.sides.wave[1] = 1e9;
        run(&mut w, 0.2);
        assert!(l.iter().all(|&k| w.arms.wave_tgt[k] != 0 || w.arms.missiles[k] < 16), "every ship in the wave");
        assert!(w.arms.wave_t[l[0]] > w.arms.wave_t[l[2]] + 0.5, "the nearest waits longest: {} {}", w.arms.wave_t[l[0]], w.arms.wave_t[l[2]]);
        // they arrive together: every missile is gone within a short spell of the first burst
        let mut first: Option<f64> = None;
        let mut last = 0.0;
        for t in 0..(25.0 / DT) as usize {
            let before = (0..MAX_MISSILES).filter(|&n| w.missiles.live[n] != 0).count();
            w.step();
            let after = (0..MAX_MISSILES).filter(|&n| w.missiles.live[n] != 0).count();
            if after < before { let at = t as f64 * DT; first.get_or_insert(at); last = at; }
        }
        let first = first.expect("they arrived");
        assert!(last - first < 2.0, "together: {first} to {last}");
        assert!(l.iter().all(|&k| w.arms.missiles[k] == 14));
    }

    #[test]
    fn missiles_replay() {
        let go = || {
            let mut w = world();
            let a = ship(&mut w, 0, 0.0, -3000.0, 1);
            let b = ship(&mut w, 1, 200.0, 0.0, 2);
            w.ships.sig[b] = 50.0;
            w.volley(a, b);
            run(&mut w, 6.0);
            w.hash()
        };
        assert_eq!(go(), go());
    }
}
