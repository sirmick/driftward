// ======================= LOOK =======================
// Small visual helpers shared by the lab and the game: colour conversion, star light presets, a planet look's shader
// uniforms, and each brand's render settings (plume and shield looks) derived from its catalog style.
const hexRGB = h => { h = String(h).replace('#', ''); return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]; };
const lin = c => c.map(v => Math.pow(v, 2.2)); // sRGB-ish to linear

const STARS = {
  sol:  { name: 'Yellow', col: [1.0, 0.95, 0.86], amb: [0.030, 0.034, 0.046], neb: [0.10, 0.12, 0.20] },
  red:  { name: 'Red dwarf', col: [1.0, 0.58, 0.38], amb: [0.040, 0.026, 0.030], neb: [0.20, 0.08, 0.07] },
  blue: { name: 'Blue giant', col: [0.72, 0.84, 1.0], amb: [0.024, 0.034, 0.055], neb: [0.06, 0.12, 0.24] },
  orange: { name: 'Orange', col: [1.0, 0.76, 0.52], amb: [0.036, 0.030, 0.034], neb: [0.16, 0.10, 0.08] },
  white: { name: 'White', col: [0.9, 0.93, 1.0], amb: [0.028, 0.032, 0.044], neb: [0.08, 0.11, 0.18] }
};
// A planet or moon's look (system.schema.json, every field filled by the clamp) as the planet shader's uniforms
// (PLANET_FS), worked out once; bindPlanet sets them. One reading of a look for the game, the lab and the tools.
const PLANET_KIND = { terran: 0, giant: 1, rock: 2 };
function planetUniforms(L) {
  const R = L.rings || {}, on = R.density > 0;
  const t = (R.tilt ?? 65) * Math.PI / 180, a = ((R.angle ?? 0) + 90) * Math.PI / 180, outer = Math.max(R.outer ?? 2.2, (R.inner ?? 1.4) + 0.1);
  const [ra, rb] = R.colours || ['#dfe9f2', '#94a8bc'];
  return {
    c1: hexRGB(L.palette[0]), c2: hexRGB(L.palette[1]), c3: hexRGB(L.palette[2]), atm: lin(hexRGB(L.atmosphere)),
    seed: L.seed, kind: PLANET_KIND[L.surface], city: L.cityLights, air: L.air, storm: L.lightning,
    // ringless worlds leave the pole unset (the screen's up, exactly as before rings existed)
    axis: on ? [Math.sin(t) * Math.cos(a), Math.sin(t) * Math.sin(a), Math.cos(t)] : [0, 0, 0],
    ring: on ? [R.density, R.inner, outer] : [0, 0, 0], ringA: hexRGB(ra), ringB: hexRGB(rb),
    ext: on ? Math.max(1.3, outer * 1.03) : 1.3
  };
}
function bindPlanet(gl, u, pu) {
  gl.uniform3fv(u.uC1, pu.c1); gl.uniform3fv(u.uC2, pu.c2); gl.uniform3fv(u.uC3, pu.c3); gl.uniform3fv(u.uAtm, pu.atm);
  gl.uniform1f(u.uSeed, pu.seed); gl.uniform1i(u.uKind, pu.kind); gl.uniform1f(u.uCity, pu.city); gl.uniform1f(u.uAir, pu.air); gl.uniform1f(u.uStorm, pu.storm);
  gl.uniform3fv(u.uAxis, pu.axis); gl.uniform3fv(u.uRing, pu.ring); gl.uniform3fv(u.uRingA, pu.ringA); gl.uniform3fv(u.uRingB, pu.ringB); gl.uniform1f(u.uExt, pu.ext);
}

const PATTERNS = { hex: 0, grid: 1, flow: 2, ragged: 3 };
const brandCache = new Map();
function brandRender(b) {
  let c = brandCache.get(b);
  if (!c) {
    const pl = b.style.plume || {}, sh = b.style.shield || {};
    c = {
      plCol: lin(hexRGB(pl.color || b.style.palette.engine)), plCore: lin(hexRGB(pl.core || '#ffffff')),
      plBurn: lin(hexRGB(pl.burn || '#c27bff')), // the burner's tint: a deliberate break from the cruise colour
      plLen: pl.len ?? 4, plWid: pl.width ?? 1, plTurb: pl.turb ?? 0, plDia: pl.diamonds ?? 0, plSput: pl.sputter ?? 0, plPulse: pl.pulse ?? 0, plSpread: pl.spread ?? 0.3,
      shCol: lin(hexRGB(sh.color || b.style.palette.emissive)), shPat: PATTERNS[sh.pattern] != null ? PATTERNS[sh.pattern] : 0, shStr: sh.strength == null ? 1 : sh.strength
    };
    brandCache.set(b, c);
  }
  return c;
}
// engine plume brightness from throttle (0..1); above 0.85 is the burner
function plumePower(th) { return 0.12 + 1.6 * Math.pow(th, 1.3) + (th > 0.85 ? (th - 0.85) * 4 : 0); }
