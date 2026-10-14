// ======================= BAKER =======================
// Ship and station bakes on a pool of Web Workers (gen.js runs in each), uploaded as four textures per asset.
// Shared by the lab and the game. Assets live in `ships`, keyed 'brand|size' (or a caller's own key with a
// request for stations); each entry gets { ready, pending, tex: [albedo, normal, emissive, aux], maps, aux, spec }.
// opts: { genText, tex(data, res), catalog(), defaultSeed(), onBaked(key, entry), onError(key, message) }
function makeBaker(opts) {
  const ships = new Map(), queue = [], busy = new Set();
  const keyOf = (b, s) => b + '|' + s;
  let jobCounter = 0, workers = [];
  function makeWorker() {
    const src = opts.genText + `
;self.onmessage = function (e) {
  const m = e.data;
  try {
    const r = m.station ? self.ShipGen.generateStation(m.catalog, m.station, m.brand, m.seed) : self.ShipGen.generate(m.catalog, m.brand, m.size, m.seed);
    const spec = self.ShipGen.describe(r.ship);
    const mp = r.maps;
    self.postMessage({ ok: true, key: m.key, job: m.job, spec, maps: mp }, [mp.albedo.buffer, mp.nrm.buffer, mp.emis.buffer, mp.aux.buffer]);
  } catch (err) { self.postMessage({ ok: false, key: m.key, job: m.job, error: String((err && err.message) || err) }); }
};`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    w.onmessage = e => { busy.delete(w); onResult(e.data); pump(); };
    w.onerror = () => { busy.delete(w); pump(); };
    return w;
  }
  try { const n = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1)); for (let i = 0; i < n; i++) workers.push(makeWorker()); } catch (e) { workers = []; }

  function onResult(m) {
    const s = ships.get(m.key);
    if (!s || s.job !== m.job) return; // superseded by a newer request
    if (!m.ok) { s.error = m.error; s.pending = false; if (opts.onError) opts.onError(m.key, m.error); return; }
    if (s.tex) s.tex.forEach(t => opts.gl.deleteTexture(t));
    const mp = m.maps;
    s.maps = { res: mp.res, extent: mp.extent, px: mp.px, hRange: mp.hRange, partCount: mp.partCount, engines: mp.engines, shieldS: mp.shieldS, Dmax: mp.Dmax };
    s.aux = mp.aux;
    s.tex = [opts.tex(mp.albedo, mp.res), opts.tex(mp.nrm, mp.res), opts.tex(mp.emis, mp.res), opts.tex(mp.aux, mp.res)];
    s.spec = m.spec; s.ready = true; s.pending = false; s.error = null;
    s.hits = s.hits || [];
    if (opts.onBaked) opts.onBaked(m.key, s);
  }
  function pump() {
    if (!workers.length) { // no workers (e.g. blocked): bake on the main thread, one per task
      if (!queue.length) return;
      const key = queue.shift(), s = ships.get(key); if (!s) return;
      const [b, z] = key.split('|'), q = s.req || { brand: b, size: z, seed: opts.defaultSeed() };
      setTimeout(() => {
        const catalog = opts.catalog();
        try { const r = q.station ? ShipGen.generateStation(catalog, q.station, q.brand, q.seed) : ShipGen.generate(catalog, q.brand, q.size, q.seed); onResult({ ok: true, key, job: s.job, spec: ShipGen.describe(r.ship), maps: r.maps }); }
        catch (err) { onResult({ ok: false, key, job: s.job, error: String(err.message || err) }); }
        pump();
      }, 0);
      return;
    }
    for (const w of workers) {
      if (busy.has(w) || !queue.length) continue;
      const key = queue.shift(), s = ships.get(key); if (!s) continue;
      const [b, z] = key.split('|'), q = s.req || { brand: b, size: z, seed: opts.defaultSeed() };
      busy.add(w);
      w.postMessage({ key, job: s.job, catalog: opts.catalog(), brand: q.brand, size: q.size, seed: q.seed, station: q.station });
    }
  }
  // queue a bake (front: next up); req overrides { brand, size, seed } or asks for a station
  function enqueue(key, front, req) {
    const s = ships.get(key) || {};
    if (req) s.req = req;
    s.job = ++jobCounter; s.pending = true; s.error = null;
    ships.set(key, s);
    const i = queue.indexOf(key); if (i >= 0) queue.splice(i, 1);
    front ? queue.unshift(key) : queue.push(key);
  }
  return { ships, queue, keyOf, enqueue, pump, workers };
}
