// rows.js — Filas de la columna de cantidades.
//   fitGrid:       ajusta una grilla de N filas parejas a los renglones punteados de la tira
//   removeRuling:  borra el renglón punteado de cada fila (sin tocar los trazos de la lapicera)
//   rowInk:        decide qué filas tienen algo escrito
// Trabaja sobre {data,width,height} (RGBA) de la tira ya mejorada (blanco de papel, tinta oscura).
(function (root) {
  "use strict";

  const N_ROWS = 19;

  function toGray(img) {
    const n = img.width * img.height, g = new Uint8Array(n), d = img.data;
    for (let i = 0, p = 0; p < n; i += 4, p++) g[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    return g;
  }

  // Fracción de píxeles oscuros de cada fila de píxeles (el renglón punteado da un pico)
  function profile(g, w, h) {
    const xa = Math.round(w * 0.04), xb = Math.round(w * 0.96), span = Math.max(1, xb - xa);
    const prof = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      let c = 0;
      for (let x = xa; x < xb; x++) if (g[y * w + x] < 170) c++;
      prof[y] = c / span;
    }
    const sm = new Float32Array(h);
    for (let y = 0; y < h; y++) sm[y] = (prof[Math.max(0, y - 1)] + 2 * prof[y] + prof[Math.min(h - 1, y + 1)]) / 4;
    return sm;
  }

  // Devuelve {n, top, pitch, fitted, score}. Fila i va de top+i*pitch a top+(i+1)*pitch.
  function fitGrid(img, n) {
    n = n || N_ROWS;
    const w = img.width, h = img.height;
    const g = toGray(img), sm = profile(g, w, h);
    const p0 = h / n;
    const at = (y) => {
      const yi = Math.round(y);
      let m = 0;
      for (let d = -1; d <= 1; d++) { const v = sm[Math.min(h - 1, Math.max(0, yi + d))]; if (v > m) m = v; }
      return m;
    };
    const scoreOf = (p, t) => { let s = 0; for (let k = 1; k < n; k++) s += at(t + k * p); return s / (n - 1); };
    const nominal = scoreOf(p0, 0);
    let best = { score: nominal, p: p0, t: 0 };
    for (let f = 0.94; f <= 1.06; f += 0.0015) {
      const p = p0 * f;
      for (let t = -0.5 * p; t <= 0.5 * p; t += 0.5) {
        const s = scoreOf(p, t);
        if (s > best.score + 1e-6) best = { score: s, p, t };
      }
    }
    const fitted = best.score >= 0.1 && best.score >= nominal;
    if (!fitted) best = { score: nominal, p: p0, t: 0 };
    return { n, top: best.t, pitch: best.p, fitted, score: best.score, nominalScore: nominal, height: h };
  }

  function rowBounds(grid) {
    const out = [];
    for (let i = 0; i < grid.n; i++) {
      out.push({ y0: Math.max(0, grid.top + i * grid.pitch), y1: Math.min(grid.height, grid.top + (i + 1) * grid.pitch) });
    }
    return out;
  }

  // Borra los puntitos del renglón en los lugares donde arriba y abajo hay papel limpio
  // (si hay tinta que cruza el renglón, se respeta).
  function removeRuling(img, grid) {
    const w = img.width, h = img.height, d = img.data;
    const half = Math.max(2, Math.round(grid.pitch * 0.045));
    const gAt = (x, y) => (d[(y * w + x) * 4] * 77 + d[(y * w + x) * 4 + 1] * 150 + d[(y * w + x) * 4 + 2] * 29) >> 8;
    for (let k = 0; k <= grid.n; k++) {
      const r = Math.round(grid.top + k * grid.pitch);
      if (r < 0 || r >= h) continue;
      const up1 = r - half - 2, up2 = r - half - 3, dn1 = r + half + 2, dn2 = r + half + 3;
      for (let x = 0; x < w; x++) {
        const clean = (y) => y < 0 || y >= h || gAt(x, y) > 190;
        if (!(clean(up1) && clean(up2) && clean(dn1) && clean(dn2))) continue;
        for (let y = Math.max(0, r - half); y <= Math.min(h - 1, r + half); y++) {
          const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255;
        }
      }
    }
    return img;
  }

  // Componentes oscuros y tinta por fila. Devuelve un arreglo de n elementos:
  // {ink, nonEmpty, bbox:{x0,y0,x1,y1}|null, straddle}
  function rowInk(img, grid) {
    const w = img.width, h = img.height, n = grid.n, p = grid.pitch;
    const g = toGray(img);
    const dark = new Uint8Array(w * h);
    const xa = Math.round(w * 0.04), xb = Math.round(w * 0.96);
    for (let y = 0; y < h; y++) for (let x = xa; x < xb; x++) dark[y * w + x] = g[y * w + x] < 150 ? 1 : 0;

    const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
    const rows = Array.from({ length: n }, () => ({ ink: 0, nonEmpty: false, bbox: null, straddle: false }));
    const minArea = Math.max(20, 0.008 * p * p), minH = 0.18 * p;
    let cur = 0;
    const comps = [];
    for (let s = 0; s < dark.length; s++) {
      if (!dark[s] || lab[s]) continue;
      cur++;
      let sp = 0, area = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
      stack[sp++] = s; lab[s] = cur;
      while (sp) {
        const q = stack[--sp], x = q % w, y = (q - x) / w;
        area++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w || (!dx && !dy)) continue;
            const z = yy * w + xx;
            if (dark[z] && !lab[z]) { lab[z] = cur; stack[sp++] = z; }
          }
        }
      }
      const bh = y1 - y0 + 1;
      if (area < minArea || bh < minH) continue;
      comps.push({ area, x0, x1, y0, y1, bh });
    }

    // Primero los trazos que caben en una sola fila; después los que cruzan el renglón.
    const rowOf = (y) => Math.min(n - 1, Math.max(0, Math.floor((y - grid.top) / p)));
    const add = (ri, c, spillRatio) => {
      const row = rows[ri];
      row.ink += c.area;
      row.bbox = row.bbox
        ? { x0: Math.min(row.bbox.x0, c.x0), y0: Math.min(row.bbox.y0, c.y0), x1: Math.max(row.bbox.x1, c.x1), y1: Math.max(row.bbox.y1, c.y1) }
        : { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 };
      if (spillRatio > 0.35) row.spill = (row.spill || 0) + c.area;
    };
    const need0 = Math.max(60, 0.02 * p * p);
    const crossing = [];
    for (const c of comps) {
      const rt = rowOf(c.y0), rb = rowOf(c.y1);
      if (rt === rb) add(rt, c, 0);
      else if (rb - rt === 1) crossing.push({ c, rt, rb });
      else add(rowOf((c.y0 + c.y1) / 2), c, 0);
    }
    // Un trazo que cruza el renglón: si la mayor parte queda arriba, es de la fila de arriba (un número
    // apoyado sobre la línea). Si la mayor parte queda abajo (la "colita" de una coma, de un 9, de un 7),
    // es de la fila de arriba solo si esa fila ya tiene escritura; si no, es de la de abajo.
    const boundaryOf = (rb) => grid.top + rb * p;
    const frac = (x) => (boundaryOf(x.rb) - x.c.y0) / x.c.bh;
    crossing.sort((a, b) => frac(b) - frac(a));
    for (const x of crossing) {
      const { c, rt, rb } = x;
      const ri = frac(x) >= 0.5 || rows[rt].ink >= need0 ? rt : rb;
      const top = grid.top + ri * p, bottom = top + p;
      add(ri, c, Math.max(0, top - c.y0, c.y1 - bottom) / c.bh);
    }
    const need = Math.max(60, 0.02 * p * p);
    for (const r of rows) {
      r.nonEmpty = r.ink >= need;
      // "a caballo": solo si lo que se sale de la fila es una parte importante de la tinta (no una colita)
      r.straddle = (r.spill || 0) > 0.4 * r.ink;
      delete r.spill;
    }
    return rows;
  }

  const api = { fitGrid, rowBounds, removeRuling, rowInk, N_ROWS };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Rows = api;
})(typeof self !== "undefined" ? self : this);
