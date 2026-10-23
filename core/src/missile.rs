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
//! It bursts when its path comes within `ms_prox` of its target's shield (or hull, the shield down), passing through
//! every other ship; one that has lost its target flies on until its life runs out. Its warhead does `ms_dmg` through
//! `ms_blast` metres (full inside `ms_core`) by the shells' rules (combat.rs `blast`), so ships close by the target take
//! some too. Shells hit it as a circle of `ms_rad` metres, and a burst's blast reaches it too; `ms_hp` points of damage
//! destroy it.
//!
//! Waves (`side_waves`): each lab ship with missiles and its bays loaded picks the biggest enemy in range worth a
//! missile (class III up, `ms_worthy`). When `ms_wave_min` ships of a side have picked the same one, they launch together
//! (up to `ms_wave_max` missiles, every `ms_wave_gap` at most), each missile knowing when the wave is to arrive: when
//! the farthest can, plus `ms_tot_slack`. In flight one ahead of its time drops its push along the line of sight and
//! only steers (time on target), so the wave arrives at once and floods the target's point defence. Too few, they hold; after `ms_patience` a ship fires alone at a big one (`ms_lone`, class IV up). A missile
//! whose target is gone, or has slipped its seeker, takes the nearest enemy its seeker holds within `ms_retarget`.
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
    /// motor's glow for the page (0 or 1); a wave's missile, the game time its wave is to arrive (0 none).
    pub struct Missiles { live: u8, x: f64, y: f64, vx: f64, vy: f64, ang: f64, burn: f64, t: f64, target: u32, owner: u32, side: u8, hp: f64, eta: f64,
        prev_x: f64, prev_y: f64, rx: f32, ry: f32, ra: f32, thr: f32 }
}

impl World {
    /// Ship i's bays (its look's sites of size G_BAY): how many.
    pub fn bays(&self, i: usize) -> usize {
        let k = self.look_kind(i);
        (0..(self.types.guns[k] as usize).min(MAX_MOUNTS)).filter(|&m| self.mounts.size[k * MAX_MOUNTS + m] == G_BAY).count()
    }

    /// Seconds a missile launched by ship k takes to reach ship j: out of the bay, then under power and coasting, from
    /// the speed it closes at already (its ship's velocity toward j, less j's away, plus the bay's push).
    fn flight_time(&self, k: usize, j: usize) -> f64 {
        let (a, b) = (self.p(P::ms_accel).max(1e-6), self.p(P::ms_burn));
        let (dx, dy) = (self.ships.x[j] - self.ships.x[k], self.ships.y[j] - self.ships.y[k]);
        let d = hypot(dx, dy).max(1.0);
        let v0 = (((self.ships.vx[k] - self.ships.vx[j]) * dx + (self.ships.vy[k] - self.ships.vy[j]) * dy) / d + self.p(P::ms_eject_v)).max(0.0);
        let lit = v0 * b + 0.5 * a * b * b;
        self.p(P::ms_eject) + if d <= lit { ((v0 * v0 + 2.0 * a * d).sqrt() - v0) / a } else { b + (d - lit) / (v0 + a * b) }
    }

    /// The worthy enemies ship k could fire missiles at: hostile, held by its sensors, within `ms_range`, hulls at least
    /// `ms_worthy` long; the biggest of them alone (several, if alike).
    fn missile_options(&self, k: usize) -> Vec<usize> {
        let (side, range, worthy) = (self.arms.side[k], self.p(P::ms_range), self.p(P::ms_worthy));
        let (mut out, mut top) = (Vec::new(), worthy);
        for j in 0..self.count {
            if j == k || !self.hostile(side, j) || !self.holds(k, j) { continue; }
            let len = self.types.len[self.look_kind(j)];
            if len < top || hypot(self.ships.x[j] - self.ships.x[k], self.ships.y[j] - self.ships.y[k]) > range { continue; }
            if len > top { out.clear(); top = len; }
            out.push(j);
        }
        out
    }

    /// The lab sides' missile fire, every `ai_think` seconds a side. Each ship with missiles and its bays loaded has
    /// its options, the biggest worthy enemies in range (`missile_options`). Once `ms_wave_gap` has passed since the
    /// side's last wave, the enemy most of them can reach becomes a wave's target if `ms_wave_min` can: its nearest
    /// ships fire until the wave holds `ms_wave_max` missiles, the farthest at once and the nearer waiting out the
    /// difference in flight time, so the missiles arrive together; the rest go on to the next target. A ship left out
    /// holds its missiles, and after `ms_patience` seconds (the side between waves) fires alone at a big one (`ms_lone`
    /// long or more); with no worthy enemy in range it saves them.
    pub(crate) fn side_waves(&mut self) {
        let now = self.tick as f64 * DT;
        let think = self.p(P::ai_think);
        for s in 0..MAX_SIDES {
            if self.sides.count[s] == 0 || now < self.sides.wave[s] { continue; }
            self.sides.wave[s] = now + think;
            let side = s as u8 + 1;
            // the loaded ships of the side and their options (the biggest worthy enemies each can reach)
            let mut opts: Vec<(usize, Vec<usize>)> = Vec::new();
            for k in 0..self.count {
                if self.traffic.role[k] != COMBAT || self.ships.alive[k] == 0 || self.arms.side[k] != side || self.traffic.phase[k] == A_FLEE { continue; }
                if self.arms.missiles[k] == 0 || self.arms.reload[k] > 0.0 || self.arms.wave_tgt[k] != 0 || self.bays(k) == 0 { continue; }
                let o = self.missile_options(k);
                if o.is_empty() { self.arms.wait[k] = 0.0; } else { opts.push((k, o)); }
            }
            let (min, cap) = (self.p(P::ms_wave_min).max(1.0) as usize, self.p(P::ms_wave_max).max(1.0) as usize);
            let (lone, patience) = (self.p(P::ms_lone), self.p(P::ms_patience));
            let ready = now >= self.sides.wave_ok[s];
            let mut fired = false;
            // waves, once the last has had time to reload: the target the most loaded ships can reach (the lower slot
            // of those alike), its nearest ships until the wave has `ms_wave_max` missiles; then the next target for the
            // rest, while enough are left for a wave
            while ready {
                let mut best: Option<(usize, usize)> = None;
                for (_, o) in &opts { for &j in o {
                    let n = opts.iter().filter(|(_, p)| p.contains(&j)).count();
                    if best.is_none_or(|(bj, bn)| n > bn || (n == bn && j < bj)) { best = Some((j, n)); }
                } }
                let Some((j, _)) = best.filter(|b| b.1 >= min) else { break };
                let mut group: Vec<(usize, f64)> = opts.iter().filter(|(_, o)| o.contains(&j))
                    .map(|(k, _)| (*k, hypot(self.ships.x[j] - self.ships.x[*k], self.ships.y[j] - self.ships.y[*k]))).collect();
                group.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
                let (mut take, mut load) = (Vec::new(), 0);
                for &(k, _) in &group { if load >= cap && take.len() >= min { break; } load += self.bays(k).min(self.arms.missiles[k] as usize); take.push(k); }
                // launch times so the missiles arrive together
                // they launch at once, to arrive together when the farthest can (time on target, `fly_missiles`)
                let eta = now + take.iter().map(|&k| self.flight_time(k, j)).fold(0.0, f64::max) + self.p(P::ms_tot_slack);
                let h = self.handle(j) + 1;
                for &k in &take { (self.arms.wave_tgt[k], self.arms.wave_t[k], self.arms.wait[k]) = (h, eta, 0.0); }
                opts.retain(|(k, _)| !take.contains(k));
                for (_, o) in opts.iter_mut() { o.retain(|&x| x != j); }
                opts.retain(|(_, o)| !o.is_empty());
                fired = true;
            }
            if fired { self.sides.wave_ok[s] = now + self.p(P::ms_wave_gap); }
            // the rest hold for the next wave; in time, with the side between waves over, one fires alone at a big one
            for (k, o) in opts {
                self.arms.wait[k] += think;
                let Some(&j) = o.first() else { continue };
                if ready && self.types.len[self.look_kind(j)] >= lone && self.arms.wait[k] >= patience {
                    (self.arms.wave_tgt[k], self.arms.wave_t[k], self.arms.wait[k]) = (self.handle(j) + 1, 0.0, 0.0);
                }
            }
        }
    }

    /// Ship k's bays: reloading, a wave's volley when its time comes, the player's while Missile is held.
    pub(crate) fn bays_step(&mut self, k: usize) {
        self.arms.reload[k] = (self.arms.reload[k] - DT).max(0.0);
        if self.ships.rail[k] != 0 { return; }
        if self.is_player(k) {
            if self.mode() != MODE_FLYING || self.game.input[0] & IN_MISSILE == 0 || self.arms.reload[k] > 0.0 { return; }
            if let Some(j) = self.target_ship() { self.volley(k, j, 0.0); }
            return;
        }
        if self.arms.wave_tgt[k] == 0 { return; }
        let target = self.arms.wave_tgt[k].checked_sub(1).and_then(|h| self.resolve(h));
        self.arms.wave_tgt[k] = 0;
        if let Some(j) = target && self.traffic.phase[k] != A_FLEE { self.volley(k, j, self.arms.wave_t[k]); }
    }

    /// A missile from each of ship k's bays at ship j (as many as it has left); the bays reload.
    fn volley(&mut self, k: usize, j: usize, eta: f64) {
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
            (ms.target[n], ms.owner[n], ms.side[n], ms.hp[n], ms.thr[n], ms.eta[n]) = (tgt, owner, side, hp, 0.0, eta);
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
            // its target gone: while it has fuel, a few times a second it looks for the nearest enemy its seeker holds
            if tgt.is_none() && self.missiles.burn[n] > 0.0 && (self.tick + n as u64) % 10 == 0 {
                tgt = self.reacquire(n);
                self.missiles.target[n] = tgt.map_or(0, |j| self.handle(j) + 1);
            }
            let lit = life - self.missiles.t[n] >= eject && self.missiles.burn[n] > 0.0;
            let (mut ax, mut ay) = (0.0, 0.0);
            let mut power = 1.0;
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
                    let mut along = (acc * acc - lat * lat).max(0.0).sqrt();
                    // time on target: a wave's missile ahead of its time (range over closing speed sooner than its wave's
                    // arrival) drops its push along the line of sight, steering only, fading back in within a second of on time
                    let eta = self.missiles.eta[n];
                    if eta > 0.0 && closing > 1.0 {
                        let early = (eta - self.tick as f64 * DT) - r / closing;
                        along *= (1.0 - early).clamp(0.0, 1.0);
                    }
                    power = hypot(lat, along) / acc;
                    let (wx, wy) = (lx * along - ly * lat, ly * along + lx * lat);
                    let want = atan2(-wx, wy);
                    let err = wrap(want - self.missiles.ang[n]);
                    self.missiles.ang[n] = wrap(self.missiles.ang[n] + err.clamp(-turn, turn));
                }
                let (hx, hy) = heading(self.missiles.ang[n]);
                (ax, ay) = (hx * acc * power, hy * acc * power);
                self.missiles.burn[n] -= DT * power;
            }
            self.missiles.thr[n] = (lit && power > 0.1) as u8 as f32;
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
            // the proximity fuse: its target alone (it passes through every other ship), when its path, seen from the
            // target as it moved this tick, comes within ms_prox of the target's shield (its hull, the shield down)
            let mut hit: Option<(usize, f64)> = None;
            if let Some(j) = tgt && self.ships.alive[j] != 0 {
                let (r, s) = (self.types.rad[self.look_kind(j)], self.standoff(j) + prox);
                let (dx, dy) = (self.ships.x[j] - self.ships.prev_x[j], self.ships.y[j] - self.ships.prev_y[j]);
                let seg = hypot(x1 - x0 - dx, y1 - y0 - dy);
                if r > 0.0 && hypot(self.ships.x[j] - x1, self.ships.y[j] - y1) <= r + s + seg {
                    let (poly, nv) = self.outline_of(j);
                    hit = crate::combat::enter_round(&poly[..nv], s, self.to_local(j, x0 + dx, y0 + dy), self.to_local(j, x1, y1)).map(|t| (j, t));
                }
            }
            if let Some((j, t)) = hit { self.detonate(n, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, Some(j)); }
            else if self.missiles.t[n] <= 0.0 { self.detonate(n, x1, y1, None); }
        }
    }

    /// The nearest enemy of missile n's side within `ms_retarget` that its seeker holds, if any.
    fn reacquire(&self, n: usize) -> Option<usize> {
        let (x, y, side, r) = (self.missiles.x[n], self.missiles.y[n], self.missiles.side[n], self.p(P::ms_retarget));
        let mut best: Option<(usize, f64)> = None;
        self.grid.near(x, y, x, y, r, |j| {
            if !self.hostile(side, j) || !self.seeker_holds(n, j) { return; }
            let d = hypot(self.ships.x[j] - x, self.ships.y[j] - y);
            if d <= r && best.is_none_or(|(bj, bd)| d < bd || (d == bd && j < bj)) { best = Some((j, d)); }
        });
        best.map(|b| b.0)
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
    use crate::combat::{A_LOITER, G_LIGHT, MAX_OUTLINE};
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
        w.volley(a, b, 0.0);
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
    fn missiles_pass_through_ships_that_are_not_their_target() {
        let mut w = world();
        let a = ship(&mut w, 0, 0.0, -4000.0, 1);
        let c = ship(&mut w, 1, 0.0, -2000.0, 2); // squarely in the way, its guns silent
        let b = ship(&mut w, 1, 0.0, 0.0, 2);
        for k in [a, b, c] { w.traffic.role[k] = 0; w.ships.ctl[k] = 0; }
        for k in [b, c] { for m in 0..MAX_MOUNTS { w.turrets.gun[k * MAX_MOUNTS + m] = 0; } w.arms.guns[k] = 0; }
        w.volley(a, b, 0.0);
        run(&mut w, 15.0);
        assert!((0..crate::combat::MAX_BURSTS).all(|q| w.bursts.kind[q] == 0 || w.bursts.ship[q] as usize != c + 1), "nothing burst on the ship in the way");
        assert_eq!(w.ships.hull[c], 400.0);
        assert!(w.ships.hull[b] < 400.0, "the target was struck: {}", w.ships.hull[b]);
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
        w.volley(a, b, 0.0);
        let mut shot = false;
        for _ in 0..(12.0 / DT) as usize {
            w.step();
            shot |= (0..crate::combat::MAX_BURSTS).any(|q| w.bursts.kind[q] == B_SHOT);
        }
        assert!(shot, "the guns shot a missile down");
    }

    /// Side 1's launchers at (x, 0), all class III with bays, and side 2's target of type `kind` at the origin; nobody
    /// moves (all but no drive) or shoots guns, and the AI never looks round (so never flees): only the missiles.
    fn standoff_scene(xs: &[f64], kind: u16) -> (Box<World>, Vec<usize>, usize) {
        let mut w = world();
        w.params[P::ms_reload as usize] = 1e9;
        (w.sides.count[0], w.sides.count[1]) = (1, 1);
        let l: Vec<usize> = xs.iter().map(|&x| ship(&mut w, 0, x, 0.0, 1)).collect();
        let b = ship(&mut w, kind, 0.0, 0.0, 2);
        for t in 0..2 { (w.types.accel[t], w.types.vmax[t]) = (1e-3, 1e-3); }
        for k in 0..w.count { w.arms.think[k] = 1e9; for m in 0..MAX_MOUNTS { w.turrets.gun[k * MAX_MOUNTS + m] = 0; } w.arms.guns[k] = 0; }
        w.mix.weight.fill(0.0);
        (w, l, b)
    }

    #[test]
    fn four_ships_on_one_target_fire_a_wave_that_arrives_together() {
        let (mut w, l, _) = standoff_scene(&[-4000.0, -5000.0, -6000.0, -7000.0], 1);
        run(&mut w, 0.6);
        assert!(l.iter().all(|&k| w.arms.missiles[k] == 14), "every ship launched at once");
        let etas: Vec<f64> = (0..MAX_MISSILES).filter(|&n| w.missiles.live[n] != 0).map(|n| w.missiles.eta[n]).collect();
        assert!(etas.len() == 8 && etas.iter().all(|&e| e > 0.0 && e == etas[0]), "one arrival time for the wave: {etas:?}");
        let mut first: Option<f64> = None;
        let mut last = 0.0;
        for t in 0..(25.0 / DT) as usize {
            let before = (0..MAX_MISSILES).filter(|&n| w.missiles.live[n] != 0).count();
            w.step();
            let after = (0..MAX_MISSILES).filter(|&n| w.missiles.live[n] != 0).count();
            if after < before { let at = t as f64 * DT; first.get_or_insert(at); last = at; }
        }
        let first = first.expect("they arrived");
        assert!(last - first < 1.0, "together: {first} to {last}");
        assert!(l.iter().all(|&k| w.arms.missiles[k] == 14), "one volley each");
    }

    #[test]
    fn too_few_for_a_wave_hold_for_a_mid_sized_target() {
        // two ships, a class III target (worth missiles, not big enough to fire on alone)
        let (mut w, l, _) = standoff_scene(&[-4000.0, -5000.0], 0);
        run(&mut w, 20.0);
        assert!(l.iter().all(|&k| w.arms.missiles[k] == 16 && w.arms.wait[k] > 10.0), "they hold");
    }

    #[test]
    fn a_lone_ship_fires_at_a_big_target_after_waiting() {
        let (mut w, l, _) = standoff_scene(&[-5000.0], 1);
        let patience = w.p(P::ms_patience);
        run(&mut w, patience - 1.0);
        assert_eq!(w.arms.missiles[l[0]], 16, "waits for a wave first");
        run(&mut w, 2.5);
        assert_eq!(w.arms.missiles[l[0]], 14, "then fires alone");
    }

    #[test]
    fn small_ships_are_not_worth_missiles() {
        let (mut w, l, b) = standoff_scene(&[-3000.0, -3500.0, -4000.0, -4500.0], 1);
        w.types.len[1] = 30.0; // a class II
        let _ = b;
        run(&mut w, 15.0);
        assert!(l.iter().all(|&k| w.arms.missiles[k] == 16));
    }

    #[test]
    fn a_missile_whose_target_dies_takes_another() {
        let (mut w, l, b) = standoff_scene(&[-5000.0], 1);
        let c = ship(&mut w, 1, 600.0, 400.0, 2);
        w.arms.think[c] = 1e9;
        w.volley(l[0], b, 0.0);
        run(&mut w, 3.0);
        w.despawn(b);
        run(&mut w, 12.0);
        assert!((0..crate::combat::MAX_BURSTS).any(|q| w.bursts.kind[q] != 0 && w.bursts.ship[q] as usize == c + 1), "it found the other ship");
    }

    #[test]
    fn missiles_replay() {
        let go = || {
            let mut w = world();
            let a = ship(&mut w, 0, 0.0, -3000.0, 1);
            let b = ship(&mut w, 1, 200.0, 0.0, 2);
            w.ships.sig[b] = 50.0;
            w.volley(a, b, 0.0);
            run(&mut w, 6.0);
            w.hash()
        };
        assert_eq!(go(), go());
    }
}
