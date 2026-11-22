// digits-core.js — Lector de dígitos manuscritos/impresos de los remitos (sin librerías, sin conexión, sin costo).
// Pasos: aplanar sombras → binarizar (varias "estrategias") → quitar renglones → separar caracteres → clasificar cada dígito
// con una red pequeña → decidir comparando contra los valores posibles que da el contexto (Excel / OC).
// Funciones puras sobre arreglos de bytes: se prueban en Node y corren igual en el navegador.
(function (root) {
  "use strict";
  const R = {};

  // ---------------------------------------------------------------- modelo
  let M = null;
  const b64f32 = (b64) => {
    let bin;
    if (typeof atob === "function") bin = atob(b64); else bin = Buffer.from(b64, "base64").toString("binary");
    const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Float32Array(u.buffer);
  };
  R.loadModel = function (d) {
    M = { nin: d.in, hid: d.hid, out: d.out, w1: b64f32(d.w1), b1: b64f32(d.b1), w2: b64f32(d.w2), b2: b64f32(d.b2) };
    M.w2init = M.w2.slice(); M.b2init = M.b2.slice();
    return M;
  };
  R.model = () => M;
  if (root.DigitsModelData) R.loadModel(root.DigitsModelData);

  // Pasa un vector de características por la red. Devuelve {h: capa oculta, p: probabilidades de las 11 clases (0-9 y 10 = "otro")}
  R.forward = function (x) {
    const nin = M.nin, hid = M.hid, out = M.out, h = new Float32Array(hid);
    for (let j = 0; j < hid; j++) h[j] = M.b1[j];
    for (let i = 0; i < nin; i++) { const xi = x[i]; if (xi === 0) continue; const o = i * hid; for (let j = 0; j < hid; j++) h[j] += xi * M.w1[o + j]; }
    for (let j = 0; j < hid; j++) if (h[j] < 0) h[j] = 0;
    return { h, p: R.head(h) };
  };
  R.head = function (h) {
    const hid = M.hid, out = M.out, z = new Float32Array(out);
    for (let k = 0; k < out; k++) z[k] = M.b2[k];
    for (let j = 0; j < hid; j++) { const hj = h[j]; if (hj === 0) continue; const o = j * out; for (let k = 0; k < out; k++) z[k] += hj * M.w2[o + k]; }
    let mx = -1e9; for (let k = 0; k < out; k++) if (z[k] > mx) mx = z[k];
    let s = 0; for (let k = 0; k < out; k++) { z[k] = Math.exp(z[k] - mx); s += z[k]; }
    for (let k = 0; k < out; k++) z[k] /= s;
    return z;
  };

  // Características de un dibujo recortado justo (mask: 1 = tinta). Idéntico a feat.py (entrenamiento).
  function areaWeights(nIn, nOut) {
    const W = new Float64Array(nOut * nIn), sc = nIn / nOut;
    for (let i = 0; i < nOut; i++) {
      const a = i * sc, b = (i + 1) * sc;
      for (let k = Math.floor(a); k < Math.min(nIn, Math.ceil(b)); k++) { const ov = Math.min(b, k + 1) - Math.max(a, k); if (ov > 0) W[i * nIn + k] = ov / sc; }
    }
    return W;
  }
  R.glyphFeatures = function (mask, h, w) {
    const s = 12 / Math.max(h, w);
    const nh = Math.max(1, Math.floor(h * s + 0.5)), nw = Math.max(1, Math.floor(w * s + 0.5));
    const Wy = areaWeights(h, nh), Wx = areaWeights(w, nw);
    const tmp = new Float64Array(nh * w);
    for (let i = 0; i < nh; i++) for (let k = 0; k < h; k++) { const wk = Wy[i * h + k]; if (!wk) continue; for (let x = 0; x < w; x++) { const v = mask[k * w + x]; if (v) tmp[i * w + x] += wk * v; } }
    const img = new Float64Array(nh * nw);
    for (let i = 0; i < nh; i++) for (let j = 0; j < nw; j++) { let a = 0; for (let x = 0; x < w; x++) { const wx = Wx[j * w + x]; if (wx) a += tmp[i * w + x] * wx; } img[i * nw + j] = a; }
    let m = 0, cy = 0, cx = 0;
    for (let i = 0; i < nh; i++) for (let j = 0; j < nw; j++) { const v = img[i * nw + j]; m += v; cy += v * i; cx += v * j; }
    if (m <= 0) { cy = (nh - 1) / 2; cx = (nw - 1) / 2; } else { cy /= m; cx /= m; }
    let oy = Math.floor(7.5 - cy + 0.5), ox = Math.floor(7.5 - cx + 0.5);
    oy = Math.max(0, Math.min(16 - nh, oy)); ox = Math.max(0, Math.min(16 - nw, ox));
    const f = new Float32Array(257);
    for (let i = 0; i < nh; i++) for (let j = 0; j < nw; j++) f[(oy + i) * 16 + ox + j] = img[i * nw + j];
    f[256] = Math.min(w / h, 1.5) / 1.5;
    return f;
  };

  // ---------------------------------------------------------------- imagen
  R.toGray = function (rgba, w, h) {
    const g = new Uint8Array(w * h);
    for (let i = 0, p = 0; p < w * h; i += 4, p++) g[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    return g;
  };
  function integral(g, w, h, sq) {
    const W = w + 1, I = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { const v = g[y * w + x]; row += sq ? v * v : v; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + row; } }
    return I;
  }
  const boxSum = (I, W, x0, y0, x1, y1) => I[(y1 + 1) * W + x1 + 1] - I[y0 * W + x1 + 1] - I[(y1 + 1) * W + x0] + I[y0 * W + x0];
  // Aplana sombras: divide por el fondo (promedio local grande)
  function flatten(g, w, h) {
    const r = Math.max(8, Math.round(Math.min(w, h) / 3)), I = integral(g, w, h, false), W = w + 1, out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r), n = (x1 - x0 + 1) * (y1 - y0 + 1);
        const bg = boxSum(I, W, x0, y0, x1, y1) / n;
        out[y * w + x] = Math.max(0, Math.min(255, Math.round(g[y * w + x] / Math.max(40, bg) * 215)));
      }
    }
    return out;
  }
  function sauvola(g, w, h, r, k, minDrop) {
    const I = integral(g, w, h, false), I2 = integral(g, w, h, true), W = w + 1, mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r), n = (x1 - x0 + 1) * (y1 - y0 + 1);
        const m = boxSum(I, W, x0, y0, x1, y1) / n, v = Math.max(0, boxSum(I2, W, x0, y0, x1, y1) / n - m * m), s = Math.sqrt(v);
        const t = m * (1 + k * (s / 128 - 1)), px = g[y * w + x];
        if (px < t && px < m - minDrop) mask[y * w + x] = 1;
      }
    }
    return mask;
  }
  function meanAdaptive(g, w, h, r, c) {
    const I = integral(g, w, h, false), W = w + 1, mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) { const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r); for (let x = 0; x < w; x++) { const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r); const m = boxSum(I, W, x0, y0, x1, y1) / ((x1 - x0 + 1) * (y1 - y0 + 1)); if (g[y * w + x] < m - c) mask[y * w + x] = 1; } }
    return mask;
  }
  function otsuMask(g, w, h) {
    const hist = new Array(256).fill(0); for (let i = 0; i < g.length; i++) hist[g[i]]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, best = -1, thr = 128; const tot = g.length;
    for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF, b = wB * wF * (mB - mF) * (mB - mF); if (b > best) { best = b; thr = i; } }
    const mask = new Uint8Array(w * h); for (let i = 0; i < g.length; i++) if (g[i] <= thr - 6) mask[i] = 1;
    return mask;
  }
  function dilate(mask, w, h) {
    const o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = y * w + x; if (mask[p] || (x > 0 && mask[p - 1]) || (x < w - 1 && mask[p + 1]) || (y > 0 && mask[p - w]) || (y < h - 1 && mask[p + w])) o[p] = 1; }
    return o;
  }

  // Estrategias de binarización: el aprendizaje por refuerzo decide cuáles son más confiables en cada caso.
  R.ARMS = [
    { id: "fina", name: "Sauvola fino", run: (g, w, h, d) => sauvola(g, w, h, Math.max(8, Math.round(d * 0.9)), 0.30, 10) },
    { id: "gruesa", name: "Sauvola amplio", run: (g, w, h, d) => sauvola(g, w, h, Math.max(12, Math.round(d * 1.8)), 0.22, 8) },
    { id: "oscura", name: "Solo lo más oscuro", run: (g, w, h, d) => sauvola(g, w, h, Math.max(8, Math.round(d * 1.2)), 0.42, 18) },
    { id: "media", name: "Media local", run: (g, w, h, d) => meanAdaptive(g, w, h, Math.max(10, Math.round(d * 1.4)), 14) },
    { id: "otsu", name: "Umbral global", run: (g, w, h) => otsuMask(g, w, h) },
    { id: "gruesa+", name: "Trazo engrosado", run: (g, w, h, d) => dilate(sauvola(g, w, h, Math.max(8, Math.round(d * 0.9)), 0.30, 10), w, h) }
  ];
  R.armIds = () => R.ARMS.map((a) => a.id);

  // Borra renglones largos (horizontales y verticales) que no son escritura
  function removeLines(mask, w, h, minH, minV) {
    const out = mask.slice();
    for (let y = 0; y < h; y++) {
      let x = 0;
      while (x < w) {
        if (!mask[y * w + x]) { x++; continue; }
        let s = x, e = x, gap = 0;
        while (e < w && (mask[y * w + e] || gap < 2)) { if (mask[y * w + e]) { gap = 0; } else gap++; e++; }
        e -= gap;
        if (e - s >= minH) for (let k = s; k < e; k++) out[y * w + k] = 0;
        x = e + 1;
      }
    }
    for (let x = 0; x < w; x++) {
      let y = 0;
      while (y < h) {
        if (!mask[y * w + x]) { y++; continue; }
        let s = y, e = y, gap = 0;
        while (e < h && (mask[e * w + x] || gap < 2)) { if (mask[e * w + x]) gap = 0; else gap++; e++; }
        e -= gap;
        if (e - s >= minV) for (let k = s; k < e; k++) out[k * w + x] = 0;
        y = e + 1;
      }
    }
    return out;
  }

  // Componentes conexas (8 vecinos)
  function components(mask, w, h) {
    const lab = new Int32Array(w * h), comps = [], stack = new Int32Array(w * h);
    for (let p0 = 0; p0 < w * h; p0++) {
      if (!mask[p0] || lab[p0]) continue;
      const id = comps.length + 1; let sp = 0; stack[sp++] = p0; lab[p0] = id;
      let x0 = w, y0 = h, x1 = 0, y1 = 0, area = 0;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0; area++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; const q = yy * w + xx; if (mask[q] && !lab[q]) { lab[q] = id; stack[sp++] = q; } } }
      }
      comps.push({ id, x0, y0, x1, y1, area, w: x1 - x0 + 1, h: y1 - y0 + 1 });
    }
    return { lab, comps };
  }

  const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

  // Recorta los píxeles de una lista de componentes (o de un rango de columnas) y arma las características
  function glyphOf(lab, w, ids, box, colRange) {
    let { x0, y0, x1, y1 } = box;
    if (colRange) { x0 = Math.max(x0, colRange[0]); x1 = Math.min(x1, colRange[1]); }
    const gw = x1 - x0 + 1, gh = y1 - y0 + 1, m = new Uint8Array(gw * gh), set = new Set(ids);
    let cnt = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (set.has(lab[y * w + x])) { m[(y - y0) * gw + (x - x0)] = 1; cnt++; }
    // recorte justo
    let a = gh, b = -1, c = gw, d = -1;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (m[y * gw + x]) { if (y < a) a = y; if (y > b) b = y; if (x < c) c = x; if (x > d) d = x; }
    if (b < 0) return null;
    const tw = d - c + 1, th = b - a + 1, t = new Uint8Array(tw * th);
    for (let y = a; y <= b; y++) for (let x = c; x <= d; x++) t[(y - a) * tw + (x - c)] = m[y * gw + x];
    return { x0: x0 + c, x1: x0 + d, y0: y0 + a, y1: y0 + b, mask: t, w: tw, h: th, area: cnt };
  }

  // ---------------------------------------------------------------- separar caracteres de una franja de texto
  // Devuelve fichas ordenadas de izquierda a derecha: {k:"d", probs, feat, box} (dígito) o {k:"s", box} (coma o punto)
  function tokenizeBand(mask, w, h, Hd) {
    const { lab, comps } = components(mask, w, h);
    const minA = Math.max(6, Hd * Hd * 0.012);
    const big = [], small = [], sepC = [];
    const tall = comps.filter((c) => c.area >= minA && c.h >= Hd * 0.7);
    const baseline = tall.length ? median(tall.map((c) => c.y1)) : h;
    for (const c of comps) {
      if (c.area < minA) continue;
      if (c.h > Hd * 1.5) continue;                                                  // más alto que un renglón: resto de línea o trazo de otro renglón
      if (c.w <= Math.max(3, Hd * 0.1) && (c.x0 <= 2 || c.x1 >= w - 3)) continue;    // hilo pegado al borde de la zona (borde de la tabla)
      if (c.h >= Hd * 0.7) big.push(c);
      else if (c.y0 >= baseline - Hd * 0.42 && c.w <= Hd * 0.45 && c.h <= Hd * 0.9) sepC.push(c);      // coma o punto: nace cerca de la línea de base
      else if (c.h >= Hd * 0.55) big.push(c);
      else small.push(c);
    }
    // unir trozos de un mismo dígito (por ejemplo el palito de un 4 o 5 cortado): se superponen en horizontal
    big.sort((a, b) => a.x0 - b.x0);
    const groups = [];
    for (const c of big) {
      const last = groups[groups.length - 1];
      if (last) {
        const ov = Math.min(last.x1, c.x1) - Math.max(last.x0, c.x0) + 1, nar = Math.min(last.x1 - last.x0 + 1, c.w);
        const vgap = Math.max(0, Math.max(last.y0, c.y0) - Math.min(last.y1, c.y1));
        if (ov > 0.45 * nar && vgap < Hd * 0.35 && Math.max(last.x1, c.x1) - Math.min(last.x0, c.x0) + 1 < Hd * 1.1) { last.ids.push(c.id); last.x0 = Math.min(last.x0, c.x0); last.x1 = Math.max(last.x1, c.x1); last.y0 = Math.min(last.y0, c.y0); last.y1 = Math.max(last.y1, c.y1); continue; }
      }
      groups.push({ ids: [c.id], x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 });
    }
    const seps = sepC.slice();
    for (const c of small) {
      const g = groups.find((q) => { const ov = Math.min(q.x1, c.x1) - Math.max(q.x0, c.x0) + 1; return ov > 0.4 * c.w && ov > 0 && Math.max(0, Math.max(q.y0, c.y0) - Math.min(q.y1, c.y1)) < Hd * 0.4 && c.w > Hd * 0.18 && Math.max(q.x1, c.x1) - Math.min(q.x0, c.x0) + 1 < Hd * 1.1; });
      if (g && c.w > Hd * 0.2) { g.ids.push(c.id); g.x0 = Math.min(g.x0, c.x0); g.x1 = Math.max(g.x1, c.x1); g.y0 = Math.min(g.y0, c.y0); g.y1 = Math.max(g.y1, c.y1); }
      else seps.push(c);
    }
    const toks = [];
    for (const g of groups) {
      const gw = g.x1 - g.x0 + 1;
      const n = gw > Hd * 1.15 ? Math.max(2, Math.round(gw / (Hd * 0.62))) : 1;
      const parts = [];
      if (n === 1) parts.push(null);
      else {
        // cortar donde hay menos tinta cerca de los puntos esperados
        const prof = new Float32Array(gw);
        for (let y = g.y0; y <= g.y1; y++) for (let x = g.x0; x <= g.x1; x++) if (g.ids.includes(lab[y * w + x])) prof[x - g.x0]++;
        const cuts = [];
        for (let i = 1; i < n; i++) {
          const ctr = Math.round(gw * i / n), rad = Math.max(2, Math.round(gw / n * 0.3)); let best = ctr, bv = 1e9;
          for (let x = Math.max(1, ctr - rad); x <= Math.min(gw - 2, ctr + rad); x++) if (prof[x] < bv) { bv = prof[x]; best = x; }
          cuts.push(best);
        }
        let s = 0; for (const c of cuts.concat([gw])) { parts.push([g.x0 + s, g.x0 + c - 1]); s = c; }
      }
      for (const cr of parts) {
        const gl = glyphOf(lab, w, g.ids, g, cr);
        if (!gl || gl.area < minA) continue;
        const feat = R.glyphFeatures(gl.mask, gl.h, gl.w), f = R.forward(feat);
        toks.push({ k: "d", x0: gl.x0, x1: gl.x1, y0: gl.y0, y1: gl.y1, p: f.p, feat });
      }
    }
    // comas y puntos: manchas chicas en la parte baja del renglón
    const bandBottom = toks.length ? Math.max.apply(null, toks.map((t) => t.y1)) : h;
    const bandTop = toks.length ? Math.min.apply(null, toks.map((t) => t.y0)) : 0;
    for (const c of seps) {
      const cy = (c.y0 + c.y1) / 2;
      if (c.h > Hd * 0.9 || c.w > Hd * 0.45) continue;
      if (cy < bandTop + (bandBottom - bandTop) * 0.55) continue;
      const left = toks.filter((t) => t.k === "d" && t.x1 <= c.x0 + 2).length, right = toks.filter((t) => t.k === "d" && t.x0 >= c.x1 - 2).length;
      if (!left || !right) continue;                 // una coma siempre está entre dígitos
      toks.push({ k: "s", x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 });
    }
    toks.sort((a, b) => a.x0 - b.x0);
    return toks;
  }

  // Divide una zona (varios renglones) en renglones según la altura de los dibujos
  function splitRows(mask, w, h, Hd) {
    const { comps } = components(mask, w, h);
    const items = comps.filter((c) => c.area >= Math.max(6, Hd * Hd * 0.012) && c.h <= Hd * 1.5 && !(c.w <= Math.max(3, Hd * 0.1) && (c.x0 <= 2 || c.x1 >= w - 3))).map((c) => ({ cy: (c.y0 + c.y1) / 2, y0: c.y0, y1: c.y1, h: c.h })).sort((a, b) => a.cy - b.cy);
    const rows = [];
    for (const it of items) {
      const r = rows[rows.length - 1];
      if (r && it.cy - r.cy < Hd * 0.75) { r.items.push(it); r.cy = r.items.reduce((s, x) => s + x.cy, 0) / r.items.length; r.y0 = Math.min(r.y0, it.y0); r.y1 = Math.max(r.y1, it.y1); }
      else rows.push({ cy: it.cy, y0: it.y0, y1: it.y1, items: [it] });
    }
    return rows.filter((r) => r.items.some((i) => i.h >= Hd * 0.38));
  }

  // Un renglón "real" tiene fichas que se parecen a dígitos (no restos de líneas ni manchas)
  function isReal(r, ratio) {
    const dt = r.toks.filter((t) => t.k === "d"); if (!dt.length) return false;
    const good = dt.filter((t) => { let b = 0; for (let k = 1; k < 11; k++) if (t.p[k] > t.p[b]) b = k; return b !== 10 && t.p[b] >= 0.45; });
    return good.length >= Math.max(1, Math.ceil(dt.length * (ratio || 0.6)));
  }

  // Estima la altura de un dígito en la zona
  function estimateHd(mask, w, h, hint) {
    const { comps } = components(mask, w, h);
    const hs = comps.filter((c) => c.area > 20 && c.h > 8).map((c) => c.h).sort((a, b) => b - a);
    if (!hs.length) return hint || 20;
    const top = hs.slice(0, Math.max(1, Math.ceil(hs.length * 0.6)));
    const m = median(top);
    return hint ? Math.min(hint * 1.35, Math.max(hint * 0.7, m)) : m;
  }

  // ---------------------------------------------------------------- análisis de una zona con una estrategia
  // zone: {g, w, h} (gris). kind: "qty" | "date" | "nro" | "oc". Devuelve {rows:[{y0,y1,cy,toks}], Hd, ink}
  R.analyze = function (zone, kind, armId, opts) {
    opts = opts || {};
    const arm = R.ARMS.find((a) => a.id === armId) || R.ARMS[0];
    const { w, h } = zone;
    const g = flatten(zone.g, w, h);
    const hint = opts.digitH || Math.max(14, h * (kind === "qty" ? 0.1 : 0.55));
    let mask = arm.run(g, w, h, hint);
    mask = removeLines(mask, w, h, Math.round(w * (kind === "qty" ? 0.5 : 0.6)), Math.round(h * (kind === "qty" ? 0.5 : 0.85)));
    let ink = 0; for (let i = 0; i < mask.length; i++) ink += mask[i];
    const Hd = kind === "oc" && opts.digitH ? opts.digitH : estimateHd(mask, w, h, hint);
    let rows;
    if (kind === "qty" || kind === "oc") {
      rows = splitRows(mask, w, h, Hd).map((r) => {
        const y0 = Math.max(0, Math.floor(r.y0 - Hd * 0.35)), y1 = Math.min(h - 1, Math.ceil(r.y1 + Hd * 0.35)), bh = y1 - y0 + 1;
        const band = mask.subarray(y0 * w, (y1 + 1) * w);
        return { y0, y1, cy: r.cy, toks: tokenizeBand(band, w, bh, Hd) };
      }).filter((r) => isReal(r, kind === "oc" ? 0.4 : 0.6));
    } else {
      rows = [{ y0: 0, y1: h - 1, cy: h / 2, toks: tokenizeBand(mask, w, h, Hd) }];
    }
    return { rows, Hd, ink: ink / (w * h), w, h, kind, arm: armId };
  };

  // ---------------------------------------------------------------- decisión contra valores posibles
  const NL = (p) => -Math.log(Math.max(p, 1e-4));
  // Parámetros de decisión: el aprendizaje por refuerzo (rl.js) los va ajustando con tus confirmaciones.
  R.params = { temp: 0.55, tempDate: 0.9, priorExcel: 0.9, subCap: 3.2, ins: 3.2 };

  // Costo de alinear la cadena de dígitos `str` con las fichas de dígitos `dt`. Menor = más parecido.
  function alignCost(str, dt, cap) {
    const SC = cap || R.params.subCap;
    const n = dt.length, m = str.length, D = [];
    for (let i = 0; i <= n; i++) { D.push(new Float64Array(m + 1)); }
    const del = (t) => Math.min(NL(t.p[10]) + 0.8, 3.6);
    for (let i = 1; i <= n; i++) D[i][0] = D[i - 1][0] + del(dt[i - 1]);
    for (let j = 1; j <= m; j++) D[0][j] = D[0][j - 1] + R.params.ins;
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
      const c = str.charCodeAt(j - 1) - 48;
      D[i][j] = Math.min(D[i - 1][j - 1] + Math.min(NL(dt[i - 1].p[c]), SC), D[i - 1][j] + del(dt[i - 1]), D[i][j - 1] + R.params.ins);
    }
    return D[n][m];
  }
  R.alignCost = alignCost;

  // Lectura libre: dígito más probable de cada ficha (se ignoran las fichas "otro")
  function freeRead(toks) {
    let s = "", cost = 0; const kept = [];
    let digits = [];
    for (const t of toks) {
      if (t.k === "s") { digits.push({ sep: true }); continue; }
      let best = 0; for (let k = 1; k < 11; k++) if (t.p[k] > t.p[best]) best = k;
      if (best === 10 || t.p[best] < 0.2) continue;
      digits.push({ d: best, p: t.p[best] }); cost += NL(t.p[best]);
    }
    let sepAt = -1, out = "";
    digits.forEach((e) => { if (e.sep) { if (sepAt < 0 && out.length) sepAt = out.length; } else out += e.d; });
    return { digits: out, sepAt, cost, n: out.length };
  }
  R.freeRead = freeRead;

  // Texto con coma a partir de dígitos y posición de la coma (si no se vio la coma, se supone 2 decimales cuando hay 4 o más dígitos)
  function formatRead(fr) {
    const d = fr.digits; if (!d) return "";
    let at = fr.sepAt;
    if (at < 0 && d.length >= 4) at = d.length - 2;
    return at > 0 && at < d.length ? d.slice(0, at) + "," + d.slice(at) : d;
  }
  R.formatRead = formatRead;

  // Formas en que se suele escribir un valor: con 2 decimales (36,40) o con los mínimos (36,4). Las dos se prueban.
  function valueVariants(v) {
    const r = Math.round(v * 100) / 100;
    if (Number.isInteger(r)) return [{ digits: String(r), sepAt: -1, text: String(r) }];
    const out = [], two = r.toFixed(2), one = r.toFixed(1);
    const mk = (s) => { const p = s.split("."); return { digits: p[0] + p[1], sepAt: p[0].length, text: s.replace(".", ",") }; };
    out.push(mk(two)); if (two.endsWith("0")) out.push(mk(one));
    return out;
  }
  R.valueVariants = valueVariants;
  R.valueText = (v) => valueVariants(v)[0].text;

  // Puntaje de que las fichas de un renglón sean el valor `v`: devuelve costo (menor = mejor)
  function costOfValue(row, v) {
    const dt = row.toks.filter((t) => t.k === "d"), seps = row.toks.filter((t) => t.k === "s");
    let best = 1e9;
    valueVariants(v).forEach((vd) => {
      let c = alignCost(vd.digits, dt);
      if (vd.sepAt > 0) {
        if (seps.length) { const dd = dt.filter((t) => t.x1 <= seps[0].x0 + 2).length; if (dd !== vd.sepAt) c += 1.8; } else c += 0.6;
      } else if (seps.length) c += 1.5;
      if (c < best) best = c;
    });
    return best;
  }
  R.costOfValue = costOfValue;

  // ---------------------------------------------------------------- fecha, cantidades, N° de remito y OC
  function softmaxNeg(costs, priors, temp) {
    const lp = costs.map((c, i) => -c * (temp || R.params.temp) + Math.log(priors[i])), mx = Math.max.apply(null, lp);
    const e = lp.map((x) => Math.exp(x - mx)), s = e.reduce((a, b) => a + b, 0);
    return e.map((x) => x / s);
  }

  // Parte las fichas de la zona de fecha en tres casilleros (día, mes, año)
  function splitDate(row, w) {
    const dt = row.toks.filter((t) => t.k === "d");
    if (!dt.length) return [[], [], []];
    const cuts = [w * 0.31, w * 0.62];
    const cells = [[], [], []];
    const gaps = [];
    for (let i = 1; i < dt.length; i++) gaps.push({ i, gap: dt[i].x0 - dt[i - 1].x1 });
    // los dos huecos más grandes separan los casilleros (si hay suficientes fichas)
    if (dt.length >= 4) {
      const top = gaps.slice().sort((a, b) => b.gap - a.gap).slice(0, 2).sort((a, b) => a.i - b.i);
      let c = 0; dt.forEach((t, i) => { if (c < 2 && top[c] && i >= top[c].i) c++; cells[c].push(t); });
      if (cells[0].length <= 2 && cells[1].length <= 2 && cells[2].length >= 1) return cells;
    }
    dt.forEach((t) => { const x = (t.x0 + t.x1) / 2; cells[x < cuts[0] ? 0 : x < cuts[1] ? 1 : 2].push(t); });
    return cells;
  }

  R.splitDateCells = splitDate;
  R.decodeDate = function (analyses, w8, ctx) {
    // analyses: lista [{arm, an}] ; w8: pesos por estrategia (id -> peso)
    ctx = ctx || {};
    const dayRange = ctx.period || { from: 1, to: 31 };
    const mCands = [], today = new Date();
    const mPrior = (m) => (ctx.month ? (m === ctx.month ? 0.8 : 0.2 / 11) : (m === today.getMonth() + 1 ? 0.45 : m === ((today.getMonth() + 11) % 12) + 1 ? 0.35 : 0.2 / 10));
    for (let m = 1; m <= 12; m++) mCands.push(m);
    const yCands = []; const cy = ctx.year || today.getFullYear();
    [cy, cy - 1].forEach((y) => yCands.push(y));
    // costos por estrategia
    const per = analyses.map((a) => ({ arm: a.arm, cells: splitDate(a.an.rows[0] || { toks: [] }, a.an.w) }));
    const wsum = per.reduce((s, p) => s + (w8[p.arm] || 1), 0) || 1;
    const costOf = (cellIdx, str) => per.reduce((s, p) => s + (w8[p.arm] || 1) * alignCost(str, p.cells[cellIdx], 6), 0) / wsum;
    const lastDay = (m) => new Date(2000 + (cy % 100), m, 0).getDate();
    const dCands = []; for (let d = 1; d <= 31; d++) dCands.push(d);
    const dCost = dCands.map((d) => Math.min(costOf(0, String(d).padStart(2, "0")), costOf(0, String(d))));
    const dPri = dCands.map((d) => (d >= dayRange.from && d <= dayRange.to ? 1 : 0.25));
    const mCost = mCands.map((m) => Math.min(costOf(1, String(m).padStart(2, "0")), costOf(1, String(m))));
    const TD = R.params.tempDate, mPost = softmaxNeg(mCost, mCands.map(mPrior), TD);
    const yStr = (y) => [String(y), String(y % 100).padStart(2, "0")];
    const yCost = yCands.map((y) => Math.min.apply(null, yStr(y).map((s) => costOf(2, s))));
    const yPost = softmaxNeg(yCost, yCands.map((y, i) => (i === 0 ? 0.85 : 0.15)), TD);
    const dPost = softmaxNeg(dCost, dPri, TD);
    const bi = (a) => a.indexOf(Math.max.apply(null, a));
    const order = dPost.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]);
    return { d: dCands[bi(dPost)], m: mCands[bi(mPost)], y: yCands[bi(yPost)], conf: { d: dPost[bi(dPost)], m: mPost[bi(mPost)], y: yPost[bi(yPost)] },
      dayOptions: order.slice(0, 3).map(([p, i]) => ({ d: dCands[i], p })), lastDay: lastDay(mCands[bi(mPost)]) };
  };

  // Número de remito (impreso): las últimas 8 cifras
  R.decodeNro = function (analyses, w8) {
    let best = null;
    for (const a of analyses) {
      const row = a.an.rows[0]; if (!row) continue;
      const fr = freeRead({ toks: row.toks }.toks), conf = fr.n ? Math.exp(-fr.cost / fr.n * 0.8) : 0;
      const wgt = w8[a.arm] || 1; const score = conf * wgt + (fr.n >= 12 ? 0.3 : 0);
      if (!best || score > best.score) best = { score, digits: fr.digits, conf };
    }
    if (!best || best.digits.length < 8) return { text: "", conf: 0, digits: best ? best.digits : "" };
    const d = best.digits, tail = d.slice(-8);
    return { text: String(Number(tail)), pv: d.length >= 13 ? d.slice(-13, -8) : "", conf: Math.min(1, best.conf), digits: d };
  };

  // Cantidades de cada renglón. ctx.dayData[d] = { clientId: { rowIndex|"any": [valores] } }
  // Devuelve {rows:[{row, text, value, conf, source, alts}], client:{id, conf}}
  R.decodeQty = function (analyses, w8, ctx, day, geom) {
    ctx = ctx || {};
    const nArms = analyses.length; if (!nArms) return { rows: [], client: null };
    const wsum = analyses.reduce((s, a) => s + (w8[a.arm] || 1), 0) || 1;
    // renglón del Excel (0..) de cada fila leída según la posición vertical
    const rowIdx = (an, r) => {
      if (!geom || !geom.pitch) return an.rows.indexOf(r);
      return Math.max(0, Math.round((r.cy - geom.firstCy) / geom.pitch));
    };
    // unificar renglones entre estrategias: se toma la estrategia con más fichas como referencia de posiciones
    const slots = new Map();   // rowIndex -> [{arm, row}]
    analyses.forEach((a) => a.an.rows.forEach((r) => { if (!r.toks.some((t) => t.k === "d")) return; const k = rowIdx(a.an, r); if (!slots.has(k)) slots.set(k, []); slots.get(k).push({ arm: a.arm, row: r }); }));
    const wtot = analyses.reduce((s, a) => s + (w8[a.arm] || 1), 0);
    slots.forEach((arr, k) => { const sup = arr.reduce((s, e) => s + (w8[e.arm] || 1), 0); if (sup < wtot * 0.4) slots.delete(k); });   // renglones que casi ninguna estrategia ve: son manchas
    const slotKeys = Array.from(slots.keys()).sort((a, b) => a - b);
    const costSlot = (k, v) => { const arr = slots.get(k) || []; if (!arr.length) return 5; let s = 0, w = 0; arr.forEach((e) => { const ww = w8[e.arm] || 1; s += ww * costOfValue(e.row, v); w += ww; }); const miss = nArms - arr.length; return (s + miss * 5 * 0.5) / Math.max(1, w + miss * 0.5); };
    // lectura libre por renglón: la de la estrategia con más peso y menor costo
    const freeOf = (k) => {
      const arr = slots.get(k) || []; let best = null;
      arr.forEach((e) => { const fr = freeRead(e.row.toks); const sc = (w8[e.arm] || 1) / (1 + fr.cost / Math.max(1, fr.n)); if (fr.n && (!best || sc > best.sc)) best = { sc, fr, arm: e.arm }; });
      return best;
    };
    const free = {}; slotKeys.forEach((k) => { free[k] = freeOf(k); });
    const freeVal = (k) => { const f = free[k]; if (!f) return null; const t = formatRead(f.fr), v = Number(t.replace(",", ".")); return t && isFinite(v) ? { text: t, value: v, cost: costSlot(k, v) } : null; };

    // hipótesis: cada cliente con entregas ese día + "libre". Los renglones del remito no coinciden por nombre con los productos del Excel
    // (el remito dice "PAN MIGNON BLANCO" y el Excel "PAN BLANCO FRANCES"), así que cada valor escrito se compara con TODOS los valores de ese cliente ese día.
    const hyps = [];
    const dayEntries = (ctx.dayData && day && ctx.dayData[day]) || null;
    if (dayEntries) {
      Object.keys(dayEntries).forEach((cid) => {
        const e = dayEntries[cid], vals = (e.any || []).slice(); let cost = 0; const picks = {};
        const pairs = [];
        slotKeys.forEach((k) => vals.forEach((v, vi) => pairs.push({ k, vi, v, c: costSlot(k, v) })));
        pairs.sort((x, y) => x.c - y.c);
        const usedK = new Set(), usedV = new Set();
        pairs.forEach((p) => { if (usedK.has(p.k) || usedV.has(p.vi) || p.c > 5.5) return; usedK.add(p.k); usedV.add(p.vi); cost += p.c; picks[p.k] = { text: R.valueText(p.v), value: p.v, src: "excel", cost: p.c, name: (e.names && e.names[String(p.v)]) || "" }; });
        slotKeys.forEach((k) => { if (picks[k]) return; const fv = freeVal(k); cost += (fv ? fv.cost : 4) + 4; picks[k] = fv ? { text: fv.text, value: fv.value, src: "libre", cost: fv.cost } : null; });
        cost += 0.7 * (vals.length - usedV.size);                                           // valores del Excel que en este remito no se ven (puede haber otro remito ese día)
        hyps.push({ id: cid, cost, picks, kind: "excel" });
      });
    }
    // hipótesis libre
    { let cost = 0; const picks = {}; slotKeys.forEach((k) => { const fv = freeVal(k); if (fv) { cost += fv.cost; picks[k] = { text: fv.text, value: fv.value, src: "libre", cost: fv.cost }; } else cost += 4; }); hyps.push({ id: null, cost, picks, kind: "libre" }); }
    const nEx = Math.max(1, hyps.length - 1), pe = R.params.priorExcel;
    const priors = hyps.map((h) => (h.kind === "excel" ? pe / nEx : (dayEntries ? 1 - pe : 1)));
    const post = softmaxNeg(hyps.map((h) => h.cost / Math.max(1, slotKeys.length)), priors);
    let bi = 0; post.forEach((p, i) => { if (p > post[bi]) bi = i; });
    const best = hyps[bi];
    const rows = slotKeys.map((k) => {
      const pk = best.picks[k]; if (!pk) return { row: k, text: "", value: null, conf: 0, source: "nada" };
      // confianza: probabilidad total de las hipótesis que eligen este mismo valor para el renglón (si dos clientes tienen el mismo valor, suman)
      let c = 0; hyps.forEach((h, i) => { const q = h.picks[k]; if (q && Math.abs(q.value - pk.value) < 0.005) c += post[i]; });
      if (pk.src === "libre") c = Math.min(c, 0.7);
      const fv = freeVal(k); if (fv && Math.abs(fv.value - pk.value) >= 0.005) c *= 0.85;
      return { row: k, text: pk.text, value: pk.value, conf: Math.min(0.99, c), source: pk.src, freeText: fv ? fv.text : "", excelName: pk.name || "" };
    });
    const ranking = hyps.map((h, i) => ({ id: h.id, p: post[i], kind: h.kind })).sort((a, b) => b.p - a.p);
    return { rows, client: best.kind === "excel" ? { id: best.id, conf: post[bi], ranking } : { id: null, conf: 0, ranking }, hypotheses: hyps.length };
  };

  // OC anotada a mano: se busca entre las OC conocidas el número cuyas cifras aparecen en algún renglón de la zona
  R.decodeOc = function (analyses, w8, ocList) {
    if (!ocList || !ocList.length) return { num: "", conf: 0 };
    const res = ocList.map((num) => {
      let s = 0, w = 0;
      analyses.forEach((a) => {
        let best = 1e9;
        a.an.rows.forEach((row) => {
          const dt = row.toks.filter((t) => t.k === "d");
          for (let st = 0; st < dt.length; st++) { const sub = dt.slice(st, st + num.length + 1); if (sub.length >= num.length - 1) best = Math.min(best, alignCost(num, sub)); }
        });
        const ww = w8[a.arm] || 1; s += ww * (best === 1e9 ? 20 : best); w += ww;
      });
      return { num, cost: w ? s / w : 20 };
    }).sort((a, b) => a.cost - b.cost);
    const top = res[0], second = res[1];
    if (top.cost > 6) return { num: "", conf: 0 };
    const post = softmaxNeg(res.map((r) => r.cost), res.map(() => 1));
    return { num: top.num, conf: post[0], cost: top.cost, second: second ? second.num : "" };
  };

  // ---------------------------------------------------------------- zonas
  R.DEFAULT_ZONES = {
    nro:  { x0: 0.60, y0: 0.052, x1: 0.97, y1: 0.095 },
    date: { x0: 0.69, y0: 0.100, x1: 0.97, y1: 0.150 },
    qty:  { x0: 0.025, y0: 0.385, x1: 0.215, y1: 0.80, rows: 14 },
    oc:   { x0: 0.50, y0: 0.385, x1: 0.97, y1: 0.80 }
  };

  // Recorta una zona (fracciones de la página) y, si es más grande de lo necesario, la achica promediando (así leer no depende de la resolución de la foto)
  const crop = (g, w, h, z, targetH, rowsInZone) => {
    const x0 = Math.max(0, Math.round(z.x0 * w)), x1 = Math.min(w, Math.round(z.x1 * w)), y0 = Math.max(0, Math.round(z.y0 * h)), y1 = Math.min(h, Math.round(z.y1 * h));
    const cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0);
    const per = rowsInZone ? ch / rowsInZone : ch;                     // alto de un renglón (o de la zona entera)
    const f = Math.min(1, targetH / per);
    if (f > 0.9) { const out = new Uint8Array(cw * ch); for (let y = 0; y < ch; y++) out.set(g.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + cw), y * cw); return { g: out, w: cw, h: ch, f: 1 }; }
    const ow = Math.max(1, Math.round(cw * f)), oh = Math.max(1, Math.round(ch * f)), out = new Uint8Array(ow * oh);
    for (let y = 0; y < oh; y++) {
      const ya = y0 + y / f, yb = y0 + (y + 1) / f;
      for (let x = 0; x < ow; x++) {
        const xa = x0 + x / f, xb = x0 + (x + 1) / f; let sum = 0, n = 0;
        for (let yy = Math.floor(ya); yy < Math.min(h, Math.ceil(yb)); yy++) for (let xx = Math.floor(xa); xx < Math.min(w, Math.ceil(xb)); xx++) { sum += g[yy * w + xx]; n++; }
        out[y * ow + x] = n ? Math.round(sum / n) : 255;
      }
    }
    return { g: out, w: ow, h: oh, f };
  };
  // Ajusta los bordes de la columna CANTIDAD a las líneas impresas de la tabla (borde izquierdo, línea de encabezado y línea que la separa de DETALLE).
  // Así una zona marcada con unos píxeles de error (o una foto un poco desplazada) no deja basura adentro.
  function snapQty(g, w, h, z) {
    const mx = Math.round(0.05 * w), my = Math.round(0.035 * h);
    const wx0 = Math.max(0, Math.round(z.x0 * w) - mx), wx1 = Math.min(w, Math.round(z.x1 * w) + mx), wy0 = Math.max(0, Math.round(z.y0 * h) - my), wy1 = Math.min(h, Math.round(z.y1 * h) + my);
    const ww = wx1 - wx0, wh = wy1 - wy0, sub = new Uint8Array(ww * wh);
    for (let y = 0; y < wh; y++) sub.set(g.subarray((wy0 + y) * w + wx0, (wy0 + y) * w + wx0 + ww), y * ww);
    const mask = sauvola(flatten(sub, ww, wh), ww, wh, Math.max(10, Math.round(w * 0.012)), 0.3, 10);
    const X0 = Math.round(z.x0 * w) - wx0, X1 = Math.round(z.x1 * w) - wx0, Y0 = Math.round(z.y0 * h) - wy0, Y1 = Math.round(z.y1 * h) - wy0;
    const vrun = (x, ya, yb) => { let run = 0, mxr = 0, gap = 0; for (let y = ya; y < yb; y++) { if (mask[y * ww + x] || (x > 0 && mask[y * ww + x - 1]) || (x < ww - 1 && mask[y * ww + x + 1])) { run++; gap = 0; if (run > mxr) mxr = run; } else { gap++; if (gap > 3) run = 0; } } return mxr; };
    const hrun = (y, xa, xb) => { let run = 0, mxr = 0, gap = 0; for (let x = xa; x < xb; x++) { if (mask[y * ww + x] || (y > 0 && mask[(y - 1) * ww + x]) || (y < wh - 1 && mask[(y + 1) * ww + x])) { run++; gap = 0; if (run > mxr) mxr = run; } else { gap++; if (gap > 3) run = 0; } } return mxr; };
    const out = Object.assign({}, z, { snapped: false });
    // línea derecha (separador CANTIDAD | DETALLE) y borde izquierdo: la columna con la línea vertical más larga cerca del borde marcado
    const bestV = (xa, xb) => { let best = -1, bv = 0; for (let x = Math.max(1, xa); x < Math.min(ww - 1, xb); x++) { const r = vrun(x, Y0 + Math.round((Y1 - Y0) * 0.1), Y1); if (r > bv) { bv = r; best = x; } } return { x: best, v: bv }; };
    const need = (Y1 - Y0) * 0.5;
    const R1 = bestV(X1 - mx, X1 + mx); if (R1.x >= 0 && R1.v >= need) { out.x1 = (wx0 + R1.x - 3) / w; out.snapped = true; }
    const L1 = bestV(X0 - mx, X0 + mx); if (L1.x >= 0 && L1.v >= need && L1.x < X1 - 20) { out.x0 = (wx0 + L1.x + 4) / w; out.snapped = true; }
    // línea horizontal de arriba de la primera fila
    const xa = Math.round((out.x0 * w) - wx0) + 6, xb = Math.round((out.x1 * w) - wx0) - 6;
    let by = -1, bd = 1e9; const win = Math.round(0.022 * h);
    for (let y = Math.max(1, Y0 - win); y < Math.min(wh - 1, Y0 + win); y++) { if (hrun(y, xa, xb) >= (xb - xa) * 0.6 && Math.abs(y - Y0) < bd) { bd = Math.abs(y - Y0); by = y; } }   // la línea fuerte más cercana a lo marcado
    if (by >= 0) { let yy = by; while (yy + 1 < wh - 1 && hrun(yy + 1, xa, xb) >= (xb - xa) * 0.5) yy++; out.y0 = (wy0 + yy + 3) / h; out.snapped = true; }
    return out;
  }

  // Recorta las zonas de la página (gris completo) y devuelve {nro,date,qty,oc, geom}
  R.TARGET_PITCH = 52;
  R.extract = function (g, w, h, zones) {
    zones = zones || R.DEFAULT_ZONES;
    const qz = snapQty(g, w, h, zones.qty), rows = zones.qty.rows || 14;
    const pitchFull = (zones.qty.y1 - zones.qty.y0) * h / rows;
    const out = { nro: crop(g, w, h, zones.nro, 70), date: crop(g, w, h, zones.date, 90), qty: crop(g, w, h, qz, R.TARGET_PITCH, rows), oc: crop(g, w, h, zones.oc, R.TARGET_PITCH, rows * (zones.oc.y1 - zones.oc.y0) / (zones.qty.y1 - zones.qty.y0)) };
    const f = out.qty.f, pitch = pitchFull * f;
    out.geom = { pitch, firstCy: pitch / 2, rows, snapped: !!qz.snapped, scale: f };
    return out;
  };

  // Análisis con todas las estrategias (se guarda para poder reevaluar sin repetir el trabajo pesado)
  R.analyzeAll = function (crops, armIds) {
    armIds = armIds || R.armIds();
    const res = { nro: [], date: [], qty: [], oc: [], geom: crops.geom };
    armIds.forEach((id) => {
      res.nro.push({ arm: id, an: R.analyze(crops.nro, "nro", id) });
      res.date.push({ arm: id, an: R.analyze(crops.date, "date", id) });
      res.qty.push({ arm: id, an: R.analyze(crops.qty, "qty", id, { digitH: crops.geom.pitch * 0.62 }) });
      res.oc.push({ arm: id, an: R.analyze(crops.oc, "oc", id, { digitH: crops.geom.pitch * 0.62 }) });
    });
    return res;
  };

  // Lectura completa de una página a partir del análisis. wz = pesos por zona: {date, qty, nro, oc} (cada uno {estrategia: peso})
  R.decodeAll = function (an, ctx, wz) {
    ctx = ctx || {}; wz = wz || {};
    const W = (z) => wz[z] || {};
    const date = R.decodeDate(an.date, W("date"), ctx);
    // el detalle del Excel sirve solo si es del mismo mes que la fecha leída
    const useDay = ctx.dayData && (!ctx.month || date.m === ctx.month);
    const dctx = useDay ? ctx : Object.assign({}, ctx, { dayData: null });
    // varias fechas posibles: se prueba cada una con el Excel y se elige la combinación más probable
    let best = null;
    const opts = useDay ? date.dayOptions : [{ d: date.d, p: date.conf.d }];
    opts.forEach((o) => {
      const q = R.decodeQty(an.qty, W("qty"), dctx, o.d, an.geom);
      const qs = q.client && q.client.id ? q.client.conf : 0.15;
      const score = Math.log(Math.max(o.p, 1e-3)) + Math.log(Math.max(qs, 0.02));
      if (!best || score > best.score) best = { score, d: o.d, p: o.p, q };
    });
    const q = best.q, chosenD = best.d;
    // si las cantidades coinciden con una entrega del Excel de ese día, eso confirma también el día (evidencia que se suma)
    const cc = q.client && q.client.id ? q.client.conf : 0;
    const dateConf = chosenD !== date.d ? Math.min(0.92, Math.max(0.4, cc)) : Math.min(0.99, 1 - (1 - date.conf.d) * (1 - cc * 0.9));
    const nro = R.decodeNro(an.nro, W("nro"));
    const oc = R.decodeOc(an.oc, W("oc"), ctx.ocs || []);
    return { date: { d: chosenD, m: date.m, y: date.y, conf: { d: dateConf, m: date.conf.m, y: date.conf.y }, byContext: chosenD !== date.d }, nro, qty: q, oc, usedExcel: !!useDay };
  };

  if (typeof module === "object" && module.exports) module.exports = R; else root.DigitsCore = R;
})(typeof self !== "undefined" ? self : this);
