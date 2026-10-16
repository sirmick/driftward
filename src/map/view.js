// ======================= STAR MAP PAGE =======================
// map.html: the star map full-window, with the shared panel (src/map/panel.js) beside it; F centres on the
// selection, H goes back to Sol. Its data, the real stars and the universe index, come through src/data.js.
const $ = id => document.getElementById(id);
const canvas = $('view'), labels = $('labels');
const G = makeGfx(canvas);
if (!G) { $('glerr').hidden = false; return; }
const DATA = makeData();
Promise.all([DATA.catalogue(), DATA.universe()]).then(([catalogue, universe]) => {
  const M = makeStarMap(G, canvas, labels, { catalogue, universe });

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = labels.width = Math.round(w * dpr); canvas.height = labels.height = Math.round(h * dpr);
    G.buildTargets(1);
  }
  window.addEventListener('resize', resize); resize();

  const style = document.createElement('style'); style.textContent = STAR_MAP_PANEL_CSS; document.head.appendChild(style);
  $('sm-panel').innerHTML = starMapPanelHtml();
  const panel = mountStarMapPanel($('sm-panel'), M, canvas);
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.code === 'KeyF') panel.centre();
    if (e.code === 'KeyH') panel.home();
  });

  let last = performance.now();
  function frame(now) {
    M.tick(Math.min(.1, (now - last) / 1000)); last = now;
    M.draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}, err => { $('glerr').textContent = `The map's data didn't load: ${err.message}`; $('glerr').hidden = false; });
