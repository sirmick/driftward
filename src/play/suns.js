// ======================= SUNS =======================
// The debug screen's Suns tab (the lab's old Suns tab, moved here): every star class and the system's own stars,
// drawn into the game's GL canvas behind the tab's cells with the game's star kit (src/stars.js), each framed to its
// cell; with lens flares, and the star open in the builder drawn big with a full flare and its ghosts.
function makeSunGallery(o) {
  const { gl, P, draw, kit } = o;
  const STAR = STARS.sol, sky = { star: STAR.col, neb: STAR.neb, sd: [-Math.SQRT1_2, Math.SQRT1_2], off: [0, 0] };
  // how a star sits in a cell `cell` pixels across: its radius in pixels and its glow's and quad's reach in radii
  function fit(s, cell) {
    const T = STAR_CLASSES[s.class];
    if (T.kind === 'hole') { const ext = s.jets > 0.01 ? 26 : 16; return { rpx: cell * 0.47 / ext, glowR: 1, ext }; }
    const rpx = Math.max(1.5, cell * 0.11 * (s.radius || 1)), glowR = Math.max(0.6, cell * 0.07 / rpx);
    return { rpx, glowR, ext: T.kind === 'pulsar' ? cell * 0.5 / rpx : Math.min(cell * 0.5 / rpx, Math.max(4, s.shell > 0.01 ? 3.6 : 1 + glowR * 4.5)) };
  }
  // cells: [{ el, look, big }]; opts: { flares, clipTop }
  function render(t, cells, opts) {
    const canvas = gl.canvas, RT = o.target(), RW = RT.w, RH = RT.h, dpr = RW / canvas.clientWidth;
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, RT.f); gl.viewport(0, 0, RW, RH);
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(P.bg.p);
    gl.uniform2f(P.bg.u.uRes, RW, RH); gl.uniform1f(P.bg.u.uTime, t);
    gl.uniform3fv(P.bg.u.uStar, STAR.col); gl.uniform3fv(P.bg.u.uNeb, STAR.neb);
    gl.uniform2f(P.bg.u.uSunDir, sky.sd[0], sky.sd[1]); gl.uniform2f(P.bg.u.uOff, 0, 0);
    draw();
    gl.enable(gl.BLEND);
    if (opts.clipTop) { gl.enable(gl.SCISSOR_TEST); gl.scissor(0, 0, RW, Math.max(0, RH - Math.round(opts.clipTop * dpr))); }
    const drawn = [];
    cells.forEach((c, i) => {
      const r = c.el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > canvas.clientHeight || r.width < 4) return;
      const box = Math.min(r.width, r.height - (c.big ? 0 : 40)) * dpr, cx = (r.left + r.width / 2) * dpr, cy = (canvas.clientHeight - (r.top + (c.big ? r.height / 2 : (r.height - 40) / 2))) * dpr;
      const f = fit(c.look, box);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const info = kit.star(c.look, Object.assign({ res: [RW, RH], cx, cy, t: t + i * 7.1, gain: 1, sky }, f));
      drawn.push([c, cx, cy, info, box]);
    });
    if (opts.flares) {
      gl.blendFunc(gl.ONE, gl.ONE);
      for (const [c, cx, cy, info, box] of drawn) {
        if (c.big) kit.flare(c.look, cx, cy, info, Math.min(RW, RH), 1, t, [RW, RH]);
        else kit.flare(c.look, cx, cy, { col: info.col, k: info.k * 0.5 }, box * 0.6, 0, t, [RW, RH]);
      }
    }
    gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST);
  }
  return { render };
}
