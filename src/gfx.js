// ======================= GRAPHICS KIT =======================
// The page-agnostic WebGL2 layer shared by the lab (index.html) and the game (play.html): context, shader
// compilation, the core programs (sky, single ships, shields, plumes, bloom chain, composite), the full-screen
// quad, baked-map textures, HDR render targets and the bloom + tone-map post pass.
// Needs shaders.js in scope. Returns null when WebGL2 is unavailable.
function makeGfx(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: false });
  if (!gl) return null;
  let HDR = !!gl.getExtension('EXT_color_buffer_float');

  function compile(vs, fs, attrs) {
    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    if (attrs) for (const k in attrs) gl.bindAttribLocation(p, attrs[k], k);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  const P = {
    bg: compile(FS_VS, BG_FS), ship: compile(SHIP_VS, SHIP_FS), shield: compile(SHIP_VS, SHIELD_FS),
    plume: compile(PLUME_VS, PLUME_FS), mark: compile(MARK_VS, MARK_FS),
    bright: compile(FS_VS, BRIGHT_FS), down: compile(FS_VS, DOWN_FS), up: compile(FS_VS, UP_FS), comp: compile(FS_VS, COMP_FS)
  };
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const draw = () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // an RGBA8 texture with mipmaps from baked map bytes (res x res)
  function tex(data, res) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, res, res, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function makeRT(w, h) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    if (HDR) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { t, f, w, h, ok };
  }
  function freeRT(r) { if (r) { gl.deleteTexture(r.t); gl.deleteFramebuffer(r.f); } }

  // the scene target (HDR when float targets work) and the bloom chain of six half-size levels. renderScale (0 to 1)
  // draws the scene at that fraction of the canvas's size, which the composite scales back up: a slow GPU's knob
  const targets = { scene: null, chain: [] };
  function buildTargets(renderScale) {
    const rs = Math.min(1, Math.max(0.25, renderScale || 1)), sw = Math.max(1, Math.round(canvas.width * rs)), sh = Math.max(1, Math.round(canvas.height * rs));
    freeRT(targets.scene); targets.chain.forEach(freeRT); targets.chain = [];
    targets.scene = makeRT(sw, sh);
    if (!targets.scene.ok && HDR) { HDR = false; freeRT(targets.scene); targets.scene = makeRT(sw, sh); }
    let w = sw, h = sh;
    for (let i = 0; i < 6; i++) { w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); targets.chain.push(makeRT(w, h)); }
    return targets;
  }

  // scene target -> screen: bloom (bright pass, downsample, additive upsample), ACES tone map, vignette, gamma.
  // debug 1: paint non-finite scene pixels magenta, non-finite bloom cyan, negative scene values yellow
  function postProcess(bloom, debug) {
    const { scene, chain } = targets;
    gl.bindVertexArray(null);
    const RW = canvas.width, RH = canvas.height, SW = scene.w, SH = scene.h; // the screen, and the scene as drawn
    const useBloom = bloom > 0.001;
    if (useBloom) {
      gl.useProgram(P.bright.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, chain[0].f); gl.viewport(0, 0, chain[0].w, chain[0].h);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, scene.t);
      gl.uniform1i(P.bright.u.uSrc, 0); gl.uniform2f(P.bright.u.uTexel, 1 / SW, 1 / SH); gl.uniform1f(P.bright.u.uThresh, HDR ? 0.9 : 0.7);
      draw();
      gl.useProgram(P.down.p); gl.uniform1i(P.down.u.uSrc, 0);
      for (let i = 1; i < chain.length; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, chain[i].f); gl.viewport(0, 0, chain[i].w, chain[i].h);
        gl.bindTexture(gl.TEXTURE_2D, chain[i - 1].t); gl.uniform2f(P.down.u.uTexel, 1 / chain[i - 1].w, 1 / chain[i - 1].h);
        draw();
      }
      gl.useProgram(P.up.p); gl.uniform1i(P.up.u.uSrc, 0);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = chain.length - 1; i > 0; i--) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, chain[i - 1].f); gl.viewport(0, 0, chain[i - 1].w, chain[i - 1].h);
        gl.bindTexture(gl.TEXTURE_2D, chain[i].t); gl.uniform2f(P.up.u.uTexel, 1 / chain[i].w, 1 / chain[i].h);
        draw();
      }
      gl.disable(gl.BLEND);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, RW, RH);
    gl.useProgram(P.comp.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, scene.t);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, chain[0].t);
    gl.uniform1i(P.comp.u.uScene, 0); gl.uniform1i(P.comp.u.uBloom, 1);
    gl.uniform1f(P.comp.u.uBloomK, useBloom ? bloom * 0.55 : 0);
    gl.uniform1f(P.comp.u.uExposure, 1.15);
    gl.uniform1i(P.comp.u.uDebug, debug || 0);
    draw();
  }

  // Read the last frame's scene target back and summarise it (debugging; slow): counts of non-finite and
  // negative pixels, their bounding box in target pixels (y up), and the largest finite channel value.
  function inspectScene() {
    const { scene } = targets, w = scene.w, h = scene.h, px = new Float32Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.f);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let bad = 0, neg = 0, max = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let i = 0; i < w * h; i++) {
      let isBad = false;
      for (let c = 0; c < 3; c++) {
        const v = px[i * 4 + c];
        if (!Number.isFinite(v)) isBad = true; else { if (v < 0) neg++; if (v > max) max = v; }
      }
      if (isBad) { bad++; const x = i % w, y = (i / w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    return { w, h, hdr: HDR, bad, neg, max, box: bad ? [x0, y0, x1, y1] : null };
  }

  return { gl, get HDR() { return HDR; }, compile, P, quad, draw, tex, makeRT, freeRT, targets, buildTargets, postProcess, inspectScene };
}
