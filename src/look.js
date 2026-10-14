// ======================= LOOK =======================
// Small visual helpers shared by the lab and the game: colour conversion, star light presets, and each brand's
// render settings (plume and shield looks) derived from its catalog style.
const hexRGB = h => { h = String(h).replace('#', ''); return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]; };
const lin = c => c.map(v => Math.pow(v, 2.2)); // sRGB-ish to linear

const STARS = {
  sol:  { name: 'Yellow', col: [1.0, 0.95, 0.86], amb: [0.030, 0.034, 0.046], neb: [0.10, 0.12, 0.20] },
  red:  { name: 'Red dwarf', col: [1.0, 0.58, 0.38], amb: [0.040, 0.026, 0.030], neb: [0.20, 0.08, 0.07] },
  blue: { name: 'Blue giant', col: [0.72, 0.84, 1.0], amb: [0.024, 0.034, 0.055], neb: [0.06, 0.12, 0.24] }
};
const PATTERNS = { hex: 0, grid: 1, flow: 2, ragged: 3 };
const brandCache = new Map();
function brandRender(b) {
  let c = brandCache.get(b);
  if (!c) {
    const pl = b.style.plume || {}, sh = b.style.shield || {};
    c = {
      plCol: lin(hexRGB(pl.color || b.style.palette.engine)), plCore: lin(hexRGB(pl.core || '#ffffff')),
      plBurn: lin(hexRGB(pl.burn || '#c27bff')), // the burner's tint: a deliberate break from the cruise colour
      plLen: pl.len || 4, plWid: pl.width || 1, plTurb: pl.turb || 0, plDia: pl.diamonds || 0, plSput: pl.sputter || 0, plPulse: pl.pulse || 0, plSpread: pl.spread || 0.3,
      shCol: lin(hexRGB(sh.color || b.style.palette.emissive)), shPat: PATTERNS[sh.pattern] != null ? PATTERNS[sh.pattern] : 0, shStr: sh.strength == null ? 1 : sh.strength
    };
    brandCache.set(b, c);
  }
  return c;
}
// engine plume brightness from throttle (0..1); above 0.85 is the burner
function plumePower(th) { return 0.12 + 1.6 * Math.pow(th, 1.3) + (th > 0.85 ? (th - 0.85) * 4 : 0); }
