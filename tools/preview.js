// CPU bake of every brand x size, lit crudely, written to a PNG grid. Usage: node tools/preview.js [seed] [brandId] [out.png]
const path = require('path');
const fs = require('fs');
const { PNG } = require('pngjs');
const G = require(path.join(__dirname, '..', 'src', 'gen.js'));
const cat = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'catalog.json'), 'utf8'));
const seed = process.argv[2] || 'demo-1';
const only = process.argv[3]; // optional brand id
const CELL = 220;
const brands = only ? cat.brands.filter(b => b.id === only) : cat.brands;
const W = CELL * cat.sizes.length, H = CELL * brands.length;
const out = new PNG({ width: W, height: H });
for (let i = 0; i < W * H; i++) { out.data[i * 4] = 8; out.data[i * 4 + 1] = 10; out.data[i * 4 + 2] = 14; out.data[i * 4 + 3] = 255; }
const L = [-0.5, 0.6, 0.62]; const ll = Math.hypot(...L); L[0] /= ll; L[1] /= ll; L[2] /= ll;
const Hh = [L[0], L[1], L[2] + 1]; const hl = Math.hypot(...Hh); Hh[0] /= hl; Hh[1] /= hl; Hh[2] /= hl;
let total = 0;
brands.forEach((b, row) => cat.sizes.forEach((s, col) => {
  const t0 = Date.now();
  const { maps } = G.generate(cat, b.id, s.id, seed);
  const dt = Date.now() - t0; total += dt;
  console.log(b.id, s.id, maps.partCount, 'parts', dt + 'ms');
  const R = maps.res, gloss = b.style.material.gloss;
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    const u = Math.floor(x / CELL * R), v = Math.floor(y / CELL * R), o = (v * R + u) * 4;
    const a = maps.albedo[o + 3] / 255;
    const nx = maps.nrm[o] / 127.5 - 1, ny = maps.nrm[o + 1] / 127.5 - 1, nz = maps.nrm[o + 2] / 255;
    const nd = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
    const sp = Math.pow(Math.max(0, nx * Hh[0] + ny * Hh[1] + nz * Hh[2]), gloss) * (maps.emis[o + 3] / 255) * 1.2;
    const q = ((row * CELL + y) * W + col * CELL + x) * 4;
    for (let c = 0; c < 3; c++) {
      const alb = Math.pow(maps.albedo[o + c] / 255, 2.2);
      const em = maps.emis[o + c] / 255 * 2;
      let lin = alb * (nd * 1.1 + 0.08) + sp + em;
      lin = 1 - Math.exp(-lin * 1.4);
      const val = Math.pow(lin, 1 / 2.2) * 255;
      out.data[q + c] = out.data[q + c] * (1 - a) + val * a;
    }
  }
}));
console.log('total', total + 'ms');
fs.writeFileSync(process.argv[4] || 'preview.png', PNG.sync.write(out));
