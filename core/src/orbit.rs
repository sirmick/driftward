//! Orbiters: swarms of debris and small traffic circling a body, for looks only. They never touch the sim: not
//! in the snapshot, not in the hash, drawn from their own generator, and placed purely from the clock, so pausing
//! stops them and a replay shows the same sky.
//!
//! Each orbiter is a circular orbit (radius, plane, phase, rate) round its body, in the body's view space (x, y
//! as the world, z toward the camera). A frame evaluates every swarm near the view in one pass and writes only what
//! can be seen into `out`: on screen, not behind the body's disc (so an orbit curves round the limb and vanishes),
//! and, for debris, not in the body's shadow. Each orbiter carries a facet: debris tumbles, so it twinkles as the
//! facet sweeps through the mirror angle; traffic carries a fixed panel, square to its orbit, that flares at the
//! same point of every pass. Everything here is small (debris flecks under a metre; traffic is beacons, satellites
//! and pods, not ships, which the sim's own traffic flies), so the page draws each as a speck of light: sunlit
//! flecks, blinking beacons, and the flares with spikes and lens ghosts.
//!
//! Ferries are the same small traffic going somewhere: back and forth along a gently curved route between two points
//! near a world (its surface and an environmental station, or two stations), easing in and out at each end and out
//! of sight while docked, so a busy world's stations have specks coming and going. Drawn as traffic beacons.

use crate::cols::{soa, ColumnDesc};
use crate::math::{sin_cos, TAU};
use crate::rng::Rng;

pub const MAX_ORBITERS: usize = 32768;
pub const MAX_SWARMS: usize = 16;
/// floats per visible instance in `out`: x, y (world m), size (m), kind, light (sunlit and facing), glint, seed, depth
/// (z over the orbit radius)
pub const OUT_STRIDE: usize = 8;
pub const DEBRIS: u8 = 0;
pub const TRAFFIC: u8 = 1;
pub const MAX_FERRIES: usize = 512;

soa! {
    /// One ferry: its route from (ax, ay) to (bx, by) (world m) bowed sideways by `bend` of its length, round body
    /// `body` (for culling); its cycle `period` (s, out and back with a dwell at each end) and `phase` (0..1); the share
    /// of the cycle spent moving; its size (m) and seed.
    pub struct Ferries { body: u16, ax: f64, ay: f64, bx: f64, by: f64, bend: f32, period: f64, phase: f64, travel: f32, size: f32, seed: f32 }
}

soa! {
    /// One orbiter: its orbit's radius `a` (m) in the plane of the unit vectors e1, e2, its phase and rate (rad, rad/s);
    /// its size (m); its facet, tilted `tilt` from the radial toward the orbit normal and turning at `spin` rad/s (0 for
    /// traffic's fixed panels); and a seed for the page (nav light timing, tint).
    pub struct Orbiters { a: f64, e1x: f32, e1y: f32, e1z: f32, e2x: f32, e2y: f32, e2z: f32, phase: f64, w: f64, size: f32, tilt: f32, spin: f32, seed: f32 }
}

#[derive(Clone, Copy, Default)]
struct Swarm { body: usize, kind: u8, start: usize, count: usize }

pub struct Orbit {
    pub o: Orbiters,
    swarms: Vec<Swarm>,
    len: usize,
    f: Ferries,
    nf: usize,
    /// visible instances from the last `eval`, OUT_STRIDE floats each
    pub out: Vec<f32>,
}

fn unit(g: &mut Rng) -> [f64; 3] {
    loop {
        let v = [g.range(-1.0, 1.0), g.range(-1.0, 1.0), g.range(-1.0, 1.0)];
        let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        if l > 0.1 && l <= 1.0 { return [v[0] / l, v[1] / l, v[2] / l]; }
    }
}
fn norm(v: [f64; 3]) -> [f64; 3] { let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-12); [v[0] / l, v[1] / l, v[2] / l] }
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
/// two unit vectors spanning the plane with normal n
fn basis(n: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    let r = if n[2].abs() < 0.9 { [0.0, 0.0, 1.0] } else { [1.0, 0.0, 0.0] };
    let u = norm(cross(n, r));
    (u, cross(n, u))
}
fn smooth(e0: f64, e1: f64, x: f64) -> f64 { let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0); t * t * (3.0 - 2.0 * t) }

impl Orbit {
    pub fn new() -> Self {
        Orbit { o: Orbiters::with_capacity(MAX_ORBITERS), swarms: Vec::with_capacity(MAX_SWARMS), len: 0, f: Ferries::with_capacity(MAX_FERRIES), nf: 0,
            out: vec![0.0; (MAX_ORBITERS + MAX_FERRIES) * OUT_STRIDE] }
    }

    pub fn describe(&self, out: &mut Vec<ColumnDesc>) { out.push(ColumnDesc::of("orbit", "out", &self.out)); }

    pub fn clear(&mut self) { self.swarms.clear(); self.len = 0; self.nf = 0; }

    /// Add `count` ferries on a route between (ax, ay) and (bx, by) near body `body`, each ending within `spread_a` and
    /// `spread_b` metres of its end (so they don't stack), at 60 to 140 m/s, with their own bow, phase and dwell;
    /// returns how many fit.
    #[allow(clippy::too_many_arguments)]
    pub fn add_ferries(&mut self, body: usize, ax: f64, ay: f64, bx: f64, by: f64, spread_a: f64, spread_b: f64, count: usize, seed: u32) -> usize {
        let n = count.min(MAX_FERRIES - self.nf);
        let mut g = Rng::new(seed as u64 ^ 0x5eed_f322 ^ ((body as u64) << 40));
        for i in self.nf..self.nf + n {
            let (ta, tb) = (g.range(0.0, TAU), g.range(0.0, TAU));
            let (ra, rb) = (spread_a * g.next_f64().sqrt(), spread_b * g.next_f64().sqrt());
            let (sa, ca) = sin_cos(ta);
            let (sb, cb) = sin_cos(tb);
            let f = &mut self.f;
            f.body[i] = body as u16;
            (f.ax[i], f.ay[i]) = (ax + ca * ra, ay + sa * ra);
            (f.bx[i], f.by[i]) = (bx + cb * rb, by + sb * rb);
            let len = ((f.bx[i] - f.ax[i]).powi(2) + (f.by[i] - f.ay[i]).powi(2)).sqrt();
            let travel = g.range(0.55, 0.8);
            f.bend[i] = g.range(-0.18, 0.18) as f32;
            f.period[i] = 2.0 * len * 1.1 / g.range(60.0, 140.0) / travel; // both ways at that speed, plus the dwells
            f.phase[i] = g.next_f64();
            f.travel[i] = travel as f32;
            f.size[i] = g.range(0.5, 1.3) as f32;
            f.seed[i] = g.next_f64() as f32;
        }
        self.nf += n;
        n
    }

    /// Add `count` orbiters of `kind` round a body of radius `r`; returns how many fit.
    /// Debris: most of it in a few clouds (old breakups, each a clump strung along one orbit), the rest scattered, low
    /// orbits commonest, tumbling. Traffic: a few lanes (shared planes and shells, one direction each), fixed panels.
    pub fn add(&mut self, body: usize, r: f64, kind: u8, count: usize, seed: u32) -> usize {
        if self.swarms.len() >= MAX_SWARMS || count == 0 { return 0; }
        let n = count.min(MAX_ORBITERS - self.len);
        let mut g = Rng::new(seed as u64 ^ ((body as u64) << 32) ^ ((kind as u64) << 48));
        let traffic = kind == TRAFFIC;
        // shared planes: debris clouds or traffic lanes, each with a phase (where a cloud's clump is) and a direction
        let mut planes = [([0.0f64; 3], 0.0f64, 1.0f64, 0.0f64); 6];
        let axis = norm([g.range(-0.5, 0.5), g.range(-0.5, 0.5), 1.0]); // the body's spin axis, roughly face-on
        for p in planes.iter_mut() {
            let n = if traffic { norm([axis[0] + g.range(-0.6, 0.6), axis[1] + g.range(-0.6, 0.6), axis[2]]) } else { unit(&mut g) };
            let dir = if traffic { if g.next_f64() < 0.75 { 1.0 } else { -1.0 } } else if g.next_f64() < 0.85 { 1.0 } else { -1.0 };
            *p = (n, g.range(0.0, TAU), dir, g.range(1.06, 1.4));
        }
        for i in self.len..self.len + n {
            let shared = g.next_f64() < if traffic { 0.9 } else { 0.7 };
            let (pn, pphase, dir, shell) = planes[g.below(planes.len() as u32) as usize];
            let nrm = if shared {
                let j = if traffic { 0.02 } else { 0.06 };
                norm([pn[0] + g.range(-j, j), pn[1] + g.range(-j, j), pn[2] + g.range(-j, j)])
            } else { unit(&mut g) };
            let (e1, e2) = basis(nrm);
            let u = g.next_f64();
            let a = r * if traffic { shell + g.range(-0.015, 0.015) } else if shared { shell * (0.97 + 0.06 * u) } else { 1.02 + 0.9 * u * u * u }; // thickest low down, where ships fly
            // a cloud's pieces gather round its clump, spreading along the orbit; scattered pieces anywhere
            let phase = if shared && !traffic { pphase + (g.next_f64() + g.next_f64() + g.next_f64() - 1.5) * 1.6 } else { g.range(0.0, TAU) };
            let speed = 140.0 * (r / a).sqrt() * (r / 1500.0).sqrt(); // m/s: a few minutes round a planet, faster up close
            let o = &mut self.o;
            o.a[i] = a;
            o.e1x[i] = e1[0] as f32; o.e1y[i] = e1[1] as f32; o.e1z[i] = e1[2] as f32;
            o.e2x[i] = e2[0] as f32; o.e2y[i] = e2[1] as f32; o.e2z[i] = e2[2] as f32;
            o.phase[i] = phase;
            o.w[i] = speed / a * if shared { dir } else if g.next_f64() < 0.85 { 1.0 } else { -1.0 };
            o.size[i] = if traffic { g.range(0.4, 1.2) } else { 0.05 + 0.55 * g.next_f64().powi(3) } as f32; // specks, not ships
            o.tilt[i] = g.range(0.0, TAU) as f32;
            o.spin[i] = if traffic { 0.0 } else { g.range(0.4, 4.0) * if g.next_f64() < 0.5 { 1.0 } else { -1.0 } } as f32;
            o.seed[i] = g.next_f64() as f32;
        }
        self.swarms.push(Swarm { body, kind, start: self.len, count: n });
        self.len += n;
        n
    }

    /// Place every orbiter of every swarm near the view at time `t` (s) and write the visible ones to `out`; returns
    /// the count. `bodies` gives each body's centre and radius; the star is at (sx, sy) and lights a body from its
    /// direction raised out of the plane, as the page's shaders do; the view is the rectangle (cx, cy) +- (hw, hh);
    /// anything smaller than `min_m` metres that isn't glinting is skipped (too faint to see at this zoom).
    #[allow(clippy::too_many_arguments)]
    pub fn eval(&mut self, bx: &[f64], by: &[f64], br: &[f64], t: f64, sx: f64, sy: f64, cx: f64, cy: f64, hw: f64, hh: f64, min_m: f64) -> usize {
        let mut n = 0;
        let o = &self.o;
        for s in &self.swarms {
            let (px, py, r) = (bx[s.body], by[s.body], br[s.body]);
            let reach = r * 2.4;
            if (px - cx).abs() > hw + reach || (py - cy).abs() > hh + reach { continue; }
            let (dx, dy) = (sx - px, sy - py);
            let dl = (dx * dx + dy * dy).sqrt();
            let l = if dl > 1.0 { norm([dx / dl, dy / dl, 0.45]) } else { [0.0, 0.0, 1.0] };
            let h = norm([l[0], l[1], l[2] + 1.0]); // the mirror direction: sun to camera
            let (r2, kind) = (r * r, s.kind as f32);
            for i in s.start..s.start + s.count {
                let a = o.a[i];
                let (sn, cs) = sin_cos((o.phase[i] + o.w[i] * t) % TAU);
                let (e1, e2) = ([o.e1x[i] as f64, o.e1y[i] as f64, o.e1z[i] as f64], [o.e2x[i] as f64, o.e2y[i] as f64, o.e2z[i] as f64]);
                let rh = [cs * e1[0] + sn * e2[0], cs * e1[1] + sn * e2[1], cs * e1[2] + sn * e2[2]]; // radial unit
                let (x, y, z) = (rh[0] * a, rh[1] * a, rh[2] * a);
                let size = o.size[i] as f64;
                if (px + x - cx).abs() > hw + size * 40.0 || (py + y - cy).abs() > hh + size * 40.0 { continue; }
                if z < 0.0 && x * x + y * y < r2 { continue; } // behind the disc
                // the shadow: a cylinder behind the body, soft at its edge
                let d = x * l[0] + y * l[1] + z * l[2];
                let lit = if d < 0.0 { smooth(r2 * 0.94, r2 * 1.06, a * a - d * d) } else { 1.0 };
                if s.kind == DEBRIS && lit < 0.01 { continue; }
                // the facet: between the radial and the orbit normal, at an angle that turns with the tumble
                let nm = cross(e1, e2);
                let (fs, fc) = sin_cos((o.tilt[i] as f64 + o.spin[i] as f64 * t) % TAU);
                let f = [fc * rh[0] + fs * nm[0], fc * rh[1] + fs * nm[1], fc * rh[2] + fs * nm[2]];
                let fh = (f[0] * h[0] + f[1] * h[1] + f[2] * h[2]).abs();
                let mut gl = fh;
                for _ in 0..8 { gl *= gl; } // fh^256: a mirror flash, a degree or two wide
                let glint = gl * lit * if s.kind == TRAFFIC { 6.0 } else { 0.6 }; // debris twinkles; a panel flares
                let face = (f[0] * l[0] + f[1] * l[1] + f[2] * l[2]).abs() * 0.6 + 0.4;
                if size < min_m && glint < 0.02 && s.kind == DEBRIS { continue; }
                let k = n * OUT_STRIDE;
                let out = &mut self.out[k..k + OUT_STRIDE];
                out[0] = (px + x) as f32; out[1] = (py + y) as f32; out[2] = size as f32; out[3] = kind;
                out[4] = (lit * face) as f32; out[5] = glint as f32; out[6] = o.seed[i]; out[7] = (z / a) as f32;
                n += 1;
            }
        }
        // ferries: out (A to B) through the first half of the cycle, back through the second, each leg easing in and
        // out and taking `travel` of its half; docked (unseen) the rest
        let f = &self.f;
        for i in 0..self.nf {
            let u = (f.phase[i] + t / f.period[i]).fract();
            let (half, back) = if u < 0.5 { (u * 2.0, false) } else { (u * 2.0 - 1.0, true) };
            let tr = f.travel[i] as f64;
            let d = (half - (1.0 - tr) / 2.0) / tr; // 0..1 while moving
            if !(0.0..=1.0).contains(&d) { continue; }
            let s = smooth(0.0, 1.0, d);
            let s = if back { 1.0 - s } else { s };
            let (ax, ay, bx, by) = (f.ax[i], f.ay[i], f.bx[i], f.by[i]);
            let (mx, my) = ((ax + bx) / 2.0 - (by - ay) * f.bend[i] as f64, (ay + by) / 2.0 + (bx - ax) * f.bend[i] as f64); // the bow
            let w = 1.0 - s;
            let (x, y) = (w * w * ax + 2.0 * w * s * mx + s * s * bx, w * w * ay + 2.0 * w * s * my + s * s * by);
            if (x - cx).abs() > hw + 40.0 || (y - cy).abs() > hh + 40.0 { continue; }
            let k = n * OUT_STRIDE;
            let out = &mut self.out[k..k + OUT_STRIDE];
            out[0] = x as f32; out[1] = y as f32; out[2] = f.size[i]; out[3] = TRAFFIC as f32;
            out[4] = 1.0; out[5] = 0.0; out[6] = f.seed[i]; out[7] = 1.0;
            n += 1;
        }
        n
    }
}

impl Default for Orbit { fn default() -> Self { Self::new() } }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_behind_the_disc_and_in_the_shadow() {
        let mut orb = Orbit::new();
        let added = orb.add(0, 1000.0, DEBRIS, 5000, 7);
        assert_eq!(added, 5000);
        let (bx, by, br) = ([0.0], [0.0], [1000.0]);
        let mut seen_front = false;
        for step in 0..20 {
            let n = orb.eval(&bx, &by, &br, step as f64 * 3.0, 1e5, 0.0, 0.0, 0.0, 1e4, 1e4, 0.0);
            assert!(n > 0 && n < 5000, "some hidden, some seen: {n}");
            for k in 0..n {
                let v = &orb.out[k * OUT_STRIDE..(k + 1) * OUT_STRIDE];
                let (x, y, depth) = (v[0] as f64, v[1] as f64, v[7] as f64);
                assert!(depth >= 0.0 || x * x + y * y >= 1000.0 * 1000.0 * 0.999, "nothing drawn behind the disc");
                assert!(v[4] > 0.0, "debris in full shadow is skipped");
                seen_front |= depth > 0.0 && x * x + y * y < 1000.0 * 1000.0;
            }
        }
        assert!(seen_front, "orbits cross in front of the disc");
    }

    #[test]
    fn panels_flare_and_the_view_culls() {
        let mut orb = Orbit::new();
        orb.add(0, 1500.0, TRAFFIC, 2000, 3);
        let (bx, by, br) = ([0.0], [0.0], [1500.0]);
        let mut flared = false;
        for step in 0..600 {
            let n = orb.eval(&bx, &by, &br, step as f64 * 0.5, 1e5, 2e4, 0.0, 0.0, 1e4, 1e4, 0.0);
            flared |= (0..n).any(|k| orb.out[k * OUT_STRIDE + 5] > 1.0);
        }
        assert!(flared, "some panel catches the sun");
        assert_eq!(orb.eval(&bx, &by, &br, 0.0, 1e5, 0.0, 1e6, 1e6, 500.0, 500.0, 0.0), 0, "off-screen swarms are skipped");
    }

    #[test]
    fn ferries_shuttle_between_their_ends() {
        let mut orb = Orbit::new();
        assert_eq!(orb.add_ferries(0, 0.0, 0.0, 3000.0, 0.0, 50.0, 50.0, 8, 1), 8);
        let (bx, by, br) = ([0.0], [0.0], [1000.0]);
        let (mut seen, mut hidden, mut near_a, mut near_b) = (0, 0, false, false);
        for step in 0..400 {
            let n = orb.eval(&bx, &by, &br, step as f64 * 0.5, 1e5, 0.0, 1500.0, 0.0, 1e4, 1e4, 0.0);
            seen += n; hidden += 8 - n;
            for k in 0..n {
                let (x, y) = (orb.out[k * OUT_STRIDE] as f64, orb.out[k * OUT_STRIDE + 1] as f64);
                assert!((-60.0..3060.0).contains(&x) && y.abs() < 3000.0 * 0.2, "on the route: {x} {y}");
                near_a |= x < 100.0; near_b |= x > 2900.0;
            }
        }
        assert!(seen > 0 && hidden > 0 && near_a && near_b, "they travel end to end and dock: seen {seen} hidden {hidden}");
    }
}
