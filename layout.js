// layout.js — Ubica en la hoja del remito la TABLA y su columna de cantidades.
// Busca las líneas negras del marco: el separador vertical entre CANTIDAD y DETALLE, la línea que
// está justo debajo de los títulos y la línea inferior de la tabla. Con eso devuelve el recuadro de
// la columna de cantidades (en fracciones del ancho y alto de la hoja). Si no las encuentra, usa la
// posición habitual del remito y lo avisa con ok:false.
(function (root) {
  "use strict";

  // Posición habitual (medida en remitos reales), como fracción de la hoja
  const DEFAULT_BOX = { x0: 0.066, x1: 0.220, y0: 0.396, y1: 0.803 };
  const TARGET_W = 800;

  function toSmallGray(img) {
    const s = Math.min(1, TARGET_W / img.width);
    const w = Math.max(8, Math.round(img.width * s)), h = Math.max(8, Math.round(img.height * s));
    const g = new Uint8Array(w * h);
    const d = img.data;
    // promedio por área (así las líneas punteadas quedan grises y las del marco, negras)
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y / s), y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) / s)));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x / s), x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) / s)));
        let sum = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          for (let xx = x0; xx < x1; xx++) {
            const i = (yy * img.width + xx) * 4;
            sum += (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8; n++;
          }
        }
        g[y * w + x] = n ? sum / n : 255;
      }
    }
    return { g, w, h, s };
  }

  function clusters(flags, minGap) {
    const out = [];
    let start = -1, last = -1;
    for (let i = 0; i < flags.length; i++) {
      if (!flags[i]) continue;
      if (start < 0) { start = i; last = i; }
      else if (i - last <= (minGap || 1)) last = i;
      else { out.push([start, last]); start = i; last = i; }
    }
    if (start >= 0) out.push([start, last]);
    return out;
  }

  // Corrida vertical oscura más larga de la columna x (se toleran 1 px de inclinación)
  function vRun(dark, w, h, x) {
    let best = 0, bs = 0, cur = 0, cs = 0;
    for (let y = 0; y < h; y++) {
      const on = dark[y * w + x] || (x > 0 && dark[y * w + x - 1]) || (x < w - 1 && dark[y * w + x + 1]);
      if (on) { if (!cur) cs = y; cur++; if (cur > best) { best = cur; bs = cs; } } else cur = 0;
    }
    return { len: best, start: bs, end: bs + best - 1 };
  }

  function hRun(dark, w, h, y, xa, xb) {
    let best = 0, cur = 0;
    for (let x = xa; x <= xb; x++) {
      const on = dark[y * w + x] || (y > 0 && dark[(y - 1) * w + x]) || (y < h - 1 && dark[(y + 1) * w + x]);
      if (on) { cur++; if (cur > best) best = cur; } else cur = 0;
    }
    return best;
  }

  // img: {data,width,height} de la hoja ya enderezada (conviene la versión mejorada).
  function findTable(img) {
    const { g, w, h } = toSmallGray(img);
    const dark = new Uint8Array(w * h);
    for (let i = 0; i < dark.length; i++) dark[i] = g[i] < 150 ? 1 : 0;
    const fail = (why) => ({ ...DEFAULT_BOX, ok: false, score: 0, why });

    // 1) separador vertical CANTIDAD | DETALLE: línea larga (30%–70% del alto) en el 12%–34% del ancho
    const sepFlags = new Uint8Array(w), runs = [];
    for (let x = Math.round(0.12 * w); x <= Math.round(0.34 * w); x++) {
      const r = vRun(dark, w, h, x);
      runs[x] = r;
      if (r.len >= 0.3 * h && r.len <= 0.7 * h) sepFlags[x] = 1;
    }
    const sc = clusters(sepFlags, 1);
    if (!sc.length) return fail("sin separador");
    let sep = null, bestLen = 0;
    for (const [a, b] of sc) {
      let m = 0;
      for (let x = a; x <= b; x++) m = Math.max(m, runs[x].len);
      if (m > bestLen) { bestLen = m; sep = { a, b }; }
    }
    let ya = Infinity, yb = -Infinity, n = 0;
    for (let x = sep.a; x <= sep.b; x++) { if (runs[x].len >= bestLen * 0.85) { ya = Math.min(ya, runs[x].start); yb = Math.max(yb, runs[x].end); n++; } }
    const sepLeft = sep.a;

    // 2) marco izquierdo: la línea vertical larga más cercana a la izquierda del separador
    const lf = new Uint8Array(w), lruns = [];
    for (let x = Math.round(0.01 * w); x < sepLeft - Math.round(0.06 * w); x++) {
      const r = vRun(dark, w, h, x); lruns[x] = r;
      if (r.len >= 0.25 * h) lf[x] = 1;
    }
    const lc = clusters(lf, 1);
    let frameRight = null;
    if (lc.length) {
      let m = 0, pick = null;
      for (const [a, b] of lc) { let mm = 0; for (let x = a; x <= b; x++) mm = Math.max(mm, lruns[x].len); if (mm > m) { m = mm; pick = [a, b]; } }
      frameRight = pick[1];
    }
    const foundFrame = frameRight !== null;
    if (!foundFrame) frameRight = Math.round(0.06 * w);

    // 3) líneas horizontales dentro de la columna de cantidades
    const xa = frameRight + 2, xb = sepLeft - 2;
    const need = 0.85 * (xb - xa);
    const hf = new Uint8Array(h);
    for (let y = Math.max(0, ya - 3); y <= Math.min(h - 1, yb + 3); y++) if (hRun(dark, w, h, y, xa, xb) >= need) hf[y] = 1;
    const hc = clusters(hf, 1);
    // línea de abajo: la que está al final de la corrida vertical
    let bottom = null, header = null;
    for (const c of hc) if (Math.abs(c[1] - yb) <= 0.03 * h || Math.abs(c[0] - yb) <= 0.03 * h) bottom = c;
    // línea debajo de los títulos: la primera después de la línea superior del recuadro de títulos
    const upper = hc.filter((c) => c[0] <= ya + 0.14 * h && c !== bottom);
    if (upper.length >= 2) header = upper[1];
    else if (upper.length === 1 && upper[0][0] > ya + 0.02 * h) header = upper[0];
    const foundHeader = !!header, foundBottom = !!bottom;
    const y0px = foundHeader ? header[1] + 1 : ya + 0.057 * (yb - ya);
    const y1px = foundBottom ? bottom[0] - 1 : yb - 2;

    const bandH = (y1px - y0px) / h, sepPos = sepLeft / w;
    if (sepPos < 0.14 || sepPos > 0.31) return fail("separador en posición rara");
    if (bandH < 0.3 || bandH > 0.55) return fail("alto de tabla raro");
    const score = (1 + (foundFrame ? 1 : 0) + (foundHeader ? 1 : 0) + (foundBottom ? 1 : 0)) / 4;
    const mx = 0.004 * w;
    return {
      x0: (frameRight + mx + 1) / w, x1: (sepLeft - mx) / w, y0: y0px / h, y1: y1px / h,
      ok: true, score, found: { frame: foundFrame, header: foundHeader, bottom: foundBottom }
    };
  }

  const api = { findTable, DEFAULT_BOX };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Layout = api;
})(typeof self !== "undefined" ? self : this);
