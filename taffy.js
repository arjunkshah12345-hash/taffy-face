/*!
 * taffy-face — grab any part of an image, stretch it like taffy, watch it spring back.
 * Zero dependencies. WebGL2. MIT License.
 */

const VS = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
in float a_w;
uniform vec2 u_res;
out vec2 v_uv;
void main() {
  vec2 c = a_pos / u_res * 2.0 - 1.0;
  // Vertices closer to the grab point draw on top, so the pulled part overlaps the rest.
  gl_Position = vec4(c.x, -c.y, 0.5 - 0.49 * a_w, 1.0);
  v_uv = a_uv;
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 o;
void main() {
  vec4 c = texture(u_tex, v_uv);
  if (c.a < 0.02) discard;
  o = c;
}`;

const DEFAULTS = {
  src: null, // image shown at rest (URL, File/Blob, <img>, <canvas>)
  grabSrc: null, // optional image shown while being pulled (same size & framing as src)
  grid: 56, // mesh resolution
  radius: 0.16, // size of the pulled region, as a fraction of image width
  maxStretch: 1.1, // how far you can pull, in image widths (rubber-banded)
  stiffness: 240, // spring-back strength
  damping: 10, // lower = more jiggle
  dragStiffness: 1400, // how tightly the skin follows the cursor
  dragDamping: 70,
  ouchDistance: 0.05, // pull distance (image widths) before switching to grabSrc
  align: "center", // 'center' | 'bottom' — where the image sits inside its box
  layout: null, // (cssWidth, cssHeight) => {x, y, w, h}; default is a 15% inset
  maxTextureSize: 1600,
};

export function createTaffy(canvas, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: true, alpha: true });
  if (!gl) throw new Error("taffy-face: WebGL2 is not supported in this browser");

  const prog = program(gl, VS, FS);
  const loc = {
    pos: gl.getAttribLocation(prog, "a_pos"),
    uv: gl.getAttribLocation(prog, "a_uv"),
    w: gl.getAttribLocation(prog, "a_w"),
    res: gl.getUniformLocation(prog, "u_res"),
  };

  // Mesh
  const N = o.grid;
  const n = (N + 1) * (N + 1);
  const uvs = new Float32Array(n * 2);
  for (let y = 0, i = 0; y <= N; y++)
    for (let x = 0; x <= N; x++, i++) {
      uvs[i * 2] = x / N;
      uvs[i * 2 + 1] = y / N;
    }
  const idx = new Uint16Array(N * N * 6);
  for (let y = 0, k = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const a = y * (N + 1) + x, b = a + 1, c = a + N + 1, d = c + 1;
      idx.set([a, b, c, b, d, c], k);
      k += 6;
    }

  const rest = new Float32Array(n * 2);
  const off = new Float32Array(n * 2);
  const vel = new Float32Array(n * 2);
  const pos = new Float32Array(n * 2);
  const wt = new Float32Array(n);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const posBuf = attrib(gl, loc.pos, 2, pos, gl.DYNAMIC_DRAW);
  attrib(gl, loc.uv, 2, uvs, gl.STATIC_DRAW);
  const wBuf = attrib(gl, loc.w, 1, wt, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

  const images = { idle: null, grab: null };
  let showing = "idle";
  let cssW = 0, cssH = 0;
  let img = { x: 0, y: 0, w: 0, h: 0 };
  let drag = null;
  let releasedAt = 0;
  let raf = 0, last = 0;
  let destroyed = false;
  const listeners = {};

  // ---------- layout ----------
  function relayout() {
    const r = canvas.getBoundingClientRect();
    cssW = r.width;
    cssH = r.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    const box = o.layout ? o.layout(cssW, cssH) : { x: cssW * 0.15, y: cssH * 0.15, w: cssW * 0.7, h: cssH * 0.7 };
    const src = images.idle;
    const aspect = src ? src.w / src.h : 1;
    let w = box.w, h = w / aspect;
    if (h > box.h) { h = box.h; w = h * aspect; }
    img = {
      x: box.x + (box.w - w) / 2,
      y: o.align === "bottom" ? box.y + box.h - h : box.y + (box.h - h) / 2,
      w, h,
    };
    for (let i = 0; i < n; i++) {
      rest[i * 2] = img.x + uvs[i * 2] * w;
      rest[i * 2 + 1] = img.y + uvs[i * 2 + 1] * h;
    }
    off.fill(0);
    vel.fill(0);
    wake();
  }

  // ---------- input ----------
  function point(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // Map a screen point back to the undeformed image, using the nearest mesh vertex.
  function toRest(px, py) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = rest[i * 2] + off[i * 2] - px, dy = rest[i * 2 + 1] + off[i * 2 + 1] - py;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    if (bd > (img.w / N) ** 2 * 4) return null;
    return [px - off[best * 2], py - off[best * 2 + 1]];
  }

  function opaqueAt(rx, ry) {
    const u = (rx - img.x) / img.w, v = (ry - img.y) / img.h;
    if (u < 0 || u > 1 || v < 0 || v > 1) return false;
    const src = images.idle;
    if (!src || !src.alpha) return !!src;
    const ax = Math.min(src.w - 1, (u * src.w) | 0), ay = Math.min(src.h - 1, (v * src.h) | 0);
    return src.alpha[ay * src.w + ax] > 25;
  }

  function onDown(e) {
    if (drag || !images.idle) return;
    const [px, py] = point(e);
    const r = toRest(px, py);
    if (!r || !opaqueAt(r[0], r[1])) return;
    e.preventDefault();
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // pointer already gone (or synthetic); dragging still works without capture
    }
    const sigma = o.radius * img.w;
    const s2 = 2 * sigma * sigma;
    for (let i = 0; i < n; i++) {
      const dx = rest[i * 2] - r[0], dy = rest[i * 2 + 1] - r[1];
      wt[i] = Math.exp(-(dx * dx + dy * dy) / s2);
    }
    drag = { id: e.pointerId, gx: r[0], gy: r[1], px, py };
    canvas.style.cursor = "grabbing";
    emit("grab");
    wake();
  }

  function onMove(e) {
    const [px, py] = point(e);
    if (drag && e.pointerId === drag.id) {
      drag.px = px;
      drag.py = py;
      wake();
      return;
    }
    if (!drag && e.pointerType === "mouse") {
      const r = toRest(px, py);
      canvas.style.cursor = r && opaqueAt(r[0], r[1]) ? "grab" : "";
    }
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    releasedAt = performance.now();
    canvas.style.cursor = "grab";
    emit("release");
    wake();
  }

  // ---------- simulation ----------
  function step(dt) {
    let dx = 0, dy = 0;
    if (drag) {
      dx = drag.px - drag.gx;
      dy = drag.py - drag.gy;
      const len = Math.hypot(dx, dy);
      const max = o.maxStretch * img.w;
      if (len > 0) {
        const k = (max * Math.tanh(len / max)) / len; // rubber band
        dx *= k;
        dy *= k;
      }
      if (Math.hypot(dx, dy) > o.ouchDistance * img.w) setShowing("grab");
    }
    const sub = 4, h = dt / sub;
    const k = drag ? o.dragStiffness : o.stiffness;
    const c = drag ? o.dragDamping : o.damping;
    let energy = 0;
    for (let s = 0; s < sub; s++) {
      for (let i = 0; i < n; i++) {
        const j = i * 2;
        const tx = drag ? dx * wt[i] : 0, ty = drag ? dy * wt[i] : 0;
        vel[j] += (k * (tx - off[j]) - c * vel[j]) * h;
        vel[j + 1] += (k * (ty - off[j + 1]) - c * vel[j + 1]) * h;
        off[j] += vel[j] * h;
        off[j + 1] += vel[j + 1] * h;
      }
    }
    for (let i = 0; i < n * 2; i++) energy = Math.max(energy, Math.abs(off[i]) + Math.abs(vel[i]) * 0.05);
    if (!drag && showing === "grab" && performance.now() - releasedAt > 450 && energy < 3) setShowing("idle");
    return drag || energy > 0.05 || showing === "grab";
  }

  function setShowing(which) {
    if (which === "grab" && !images.grab) return;
    if (showing !== which) {
      showing = which;
      emit(which === "grab" ? "ouch" : "calm");
    }
  }

  function render() {
    for (let i = 0; i < n * 2; i++) pos[i] = rest[i] + off[i];
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const tex = (showing === "grab" && images.grab) || images.idle;
    if (!tex) return;
    gl.useProgram(prog);
    gl.uniform2f(loc.res, cssW, cssH);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
    gl.bindBuffer(gl.ARRAY_BUFFER, wBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, wt);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
  }

  function frame(t) {
    raf = 0;
    if (destroyed) return;
    const dt = Math.min(1 / 30, (t - last) / 1000 || 1 / 60);
    last = t;
    const alive = step(dt);
    render();
    if (alive) raf = requestAnimationFrame(frame);
  }

  function wake() {
    if (!raf && !destroyed) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  // ---------- images ----------
  async function setImage(source, which = "idle") {
    if (source == null) {
      if (images[which]) gl.deleteTexture(images[which].tex);
      images[which] = null;
      if (which === "grab") setShowing("idle");
      wake();
      return;
    }
    const el = await loadImage(source);
    const iw = el.naturalWidth || el.width, ih = el.naturalHeight || el.height;
    const scale = Math.min(1, o.maxTextureSize / Math.max(iw, ih));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(iw * scale));
    c.height = Math.max(1, Math.round(ih * scale));
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(el, 0, 0, c.width, c.height);
    let alpha = null;
    try {
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      alpha = new Uint8Array(c.width * c.height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
    } catch {
      // cross-origin image without CORS: the whole rectangle becomes grabbable
    }
    if (destroyed) return;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (images[which]) gl.deleteTexture(images[which].tex);
    images[which] = { tex, w: c.width, h: c.height, alpha };
    if (which === "idle") relayout();
    else wake();
  }

  // ---------- events / lifecycle ----------
  function emit(name) {
    (listeners[name] || []).forEach((fn) => fn());
  }

  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  const ro = new ResizeObserver(relayout);
  ro.observe(canvas);

  const ready = Promise.all([
    o.src ? setImage(o.src, "idle") : null,
    o.grabSrc ? setImage(o.grabSrc, "grab") : null,
  ]);

  return {
    ready,
    setImage,
    on(name, fn) {
      (listeners[name] ||= []).push(fn);
      return this;
    },
    set(opts) {
      Object.assign(o, opts);
      relayout();
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

function loadImage(source) {
  if (source instanceof HTMLCanvasElement || (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap))
    return Promise.resolve(source);
  if (source instanceof HTMLImageElement && source.complete && source.naturalWidth) return Promise.resolve(source);
  return new Promise((resolve, reject) => {
    const el = source instanceof HTMLImageElement ? source : new Image();
    let url = null;
    el.onload = () => {
      if (url) URL.revokeObjectURL(url);
      resolve(el);
    };
    el.onerror = () => reject(new Error("taffy-face: could not load image"));
    if (source instanceof Blob) el.src = url = URL.createObjectURL(source);
    else if (typeof source === "string") {
      if (!source.startsWith("data:") && !source.startsWith("blob:")) el.crossOrigin = "anonymous";
      el.src = source;
    }
  });
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

function attrib(gl, location, size, data, usage) {
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, data, usage);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  return buf;
}
