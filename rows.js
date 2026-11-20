// rows.js — Filas de la columna de cantidades.
//   fitGrid:       ajusta una grilla de N filas parejas a los renglones punteados de la tira
//   removeRuling:  borra el renglón punteado de cada fila (sin tocar los trazos de la lapicera)
//   rowInk:        probabilidad de que cada fila tenga un número (según la forma de los trazos)
//   maskRow:       imagen de la tira sin los trazos de otras filas
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

  // ---------- ¿Qué filas tienen un número? Modelo probabilístico basado en la FORMA de los trazos ----------
  // 1) Se separan los trazos (componentes conectados de tinta).
  // 2) Cada trazo recibe d = probabilidad de ser parte de un dígito, según su forma: alto respecto de la fila,
  //    no demasiado largo, ni un renglón horizontal, ni una mancha maciza.
  // 3) Un trazo es de UNA sola fila (un número no se reparte). Su fila se elige por cuánta tinta tiene en
  //    cada una (más una pequeña ventaja a la fila donde apoya la base); si queda repartido, la fila
  //    de segunda opción se anota ("alt") y el número queda marcado como dudoso.
  // 4) Los trazos chicos pegados a un dígito (coma, punto, colita de un 9 o un 7, cruz de un 5) no cuentan
  //    como escritura propia: se suman al número vecino y viajan con él.
  // 5) P(fila) = 1 − Π(1 − d·π) sobre los trazos de la fila ("al menos un dígito real").
  const TH = { send: 0.35, sure: 0.7 };
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const smooth = (x, a, b) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

  // d: parecido de un trazo a un dígito escrito a mano (0..1). h, w y ancho/alto en unidades de fila.
  function digitness(c, p) {
    const hh = c.bh / p, ww = c.bw / p;
    const heightScore = smooth(hh, 0.18, 0.38);                    // una colita o un punto no son un dígito
    const tallScore = 1 - smooth(hh, 1.5, 2.2);                    // más alto que 1,5 filas: borde o garabato
    const fill = c.area / (c.bw * c.bh);
    const denseScore = 1 - smooth(fill, 0.62, 0.92);               // mancha maciza
    const ar = c.bw / c.bh;
    const streakScore = 1 - smooth(ar, 4.5, 8);                    // raya horizontal (renglón, subrayado)
    const vlineScore = hh > 0.8 ? smooth(ar, 0.03, 0.09) : 1;      // raya vertical larga y finita
    const smallScore = smooth(c.area / (p * p), 0.006, 0.02);      // pelusa
    void ww;
    return heightScore * tallScore * denseScore * streakScore * vlineScore * smallScore;
  }

  function rowInk(img, grid, opts) {
    opts = opts || {};
    const w = img.width, h = img.height, n = grid.n, p = grid.pitch;
    const g = toGray(img);
    const dark = new Uint8Array(w * h);
    const xa = Math.round(w * 0.04), xb = Math.round(w * 0.96);
    for (let y = 0; y < h; y++) for (let x = xa; x < xb; x++) dark[y * w + x] = g[y * w + x] < 150 ? 1 : 0;

    const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
    const comps = [null];                       // comps[label]
    let cur = 0;
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
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      comps.push(area >= 6 ? { id: cur, area, x0, x1, y0, y1, bw, bh, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 } : null);
    }
    const list = comps.filter(Boolean);
    const rowOf = (y) => Math.min(n - 1, Math.max(0, Math.floor((y - grid.top) / p)));

    // tinta de cada trazo en cada fila
    const mass = new Map();
    for (const c of list) mass.set(c.id, new Float32Array(n));
    for (let y = 0; y < h; y++) {
      const ri = rowOf(y);
      for (let x = xa; x < xb; x++) {
        const k = lab[y * w + x];
        if (k && mass.has(k)) mass.get(k)[ri]++;
      }
    }

    for (const c of list) { c.d = digitness(c, p); c.strong = c.d >= 0.5; }

    // Los dígitos de un mismo número se escriben uno al lado del otro: se unen en un "grupo" los trazos
    // vecinos (poca separación, poco solapamiento horizontal, casi a la misma altura). Un número a mano
    // puede ser más alto que la fila o ir en bajada, pero sus dígitos siguen al lado uno del otro; en
    // cambio el número de la fila de abajo está a una fila de distancia.
    const strongs = list.filter((c) => c.strong);
    const parent = strongs.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < strongs.length; i++) for (let j = i + 1; j < strongs.length; j++) {
      const a = strongs[i], b = strongs[j];
      const gx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
      const ox = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
      if (gx <= 0.9 * p && ox <= 0.5 * Math.min(a.bw, b.bw) && Math.abs(a.cy - b.cy) <= 0.5 * p) parent[find(i)] = find(j);
    }
    const groups = new Map();
    strongs.forEach((c, i) => {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, { comps: [] });
      groups.get(r).comps.push(c);
    });
    const G = [...groups.values()];
    const bounds = (g) => {
      g.x0 = Math.min(...g.comps.map((c) => c.x0)); g.x1 = Math.max(...g.comps.map((c) => c.x1));
      g.y0 = Math.min(...g.comps.map((c) => c.y0)); g.y1 = Math.max(...g.comps.map((c) => c.y1));
    };
    G.forEach(bounds);
    // Trazos chicos (coma, punto, colita, cruz de un 5): viajan con el número más cercano y no cuentan solos
    const loose = [];
    for (const c of list) {
      if (c.strong) continue;
      let host = null, bestGap = 1e9;
      for (const g of G) {
        const gx = Math.max(0, g.x0 - c.x1, c.x0 - g.x1);
        const inBand = c.cy >= g.y0 - 0.15 * p && c.cy <= g.y1 + 0.55 * p;
        if (gx < 0.8 * p && inBand && gx < bestGap) { bestGap = gx; host = g; }
      }
      if (host) host.comps.push(c);
      else if (c.d >= 0.2) loose.push({ comps: [c] });
    }
    for (const g of loose) { bounds(g); G.push(g); }

    // Cada grupo es de UNA fila: la que tiene más tinta del grupo (ponderada al cuadrado)
    for (const g of G) {
      const m = new Float32Array(n);
      let tot = 0;
      for (const c of g.comps) { const mm = mass.get(c.id); for (let i = 0; i < n; i++) { m[i] += mm[i]; tot += mm[i]; } }
      const pi = Array.from(m, (v) => { const q = v / (tot || 1); return q * q; });
      const ps = pi.reduce((a, b) => a + b, 0) || 1;
      for (let i = 0; i < n; i++) pi[i] /= ps;
      let best = 0, second = -1;
      for (let i = 1; i < n; i++) if (pi[i] > pi[best]) best = i;
      for (let i = 0; i < n; i++) if (i !== best && (second < 0 || pi[i] > pi[second])) second = i;
      g.row = best; g.pi = pi[best]; g.alt = pi[second] > 0.3 ? second : -1;
      g.d = 1 - g.comps.reduce((q, c) => q * (1 - (c.strong || g.comps.length === 1 ? c.d : 0)), 1);
      for (const c of g.comps) { c.row = best; c.pi = g.pi; c.alt = g.alt; c.attached = !c.strong && g.comps.length > 1; }
    }

    // Probabilidad por fila: al menos un grupo de trazos con forma de número está en esa fila
    const rows = Array.from({ length: n }, () => ({ p: 0, ink: 0, nonEmpty: false, sure: false, ambiguous: false, alt: 0, bbox: null, labels: [], comps: 0 }));
    const miss = new Float64Array(n).fill(1);
    for (const g of G) {
      const r = rows[g.row];
      miss[g.row] *= 1 - g.d * g.pi; r.comps++;
      if (g.alt >= 0 && g.d >= 0.5) { r.ambiguous = true; r.alt = g.alt + 1; }
      for (const c of g.comps) {
        r.ink += c.area;
        r.labels.push(c.id);
        r.bbox = r.bbox
          ? { x0: Math.min(r.bbox.x0, c.x0), y0: Math.min(r.bbox.y0, c.y0), x1: Math.max(r.bbox.x1, c.x1), y1: Math.max(r.bbox.y1, c.y1) }
          : { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 };
      }
    }
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      r.p = r.comps ? 1 - miss[i] : 0;
      r.nonEmpty = r.p >= TH.send;
      r.sure = r.p >= TH.sure && !r.ambiguous;
      if (!r.nonEmpty) { r.bbox = null; r.labels = []; }
    }
    if (opts.debug) rows.dbg = list.filter((c) => c.d > 0.1 || c.attached).map((c) => ({ x0: c.x0, y0: c.y0, bw: c.bw, bh: c.bh, area: c.area, d: +c.d.toFixed(2), strong: c.strong, att: c.attached, row: c.row + 1, pi: +c.pi.toFixed(2), alt: c.alt + 1 }));
    rows.lab = lab; rows.w = w; rows.h = h; rows.xa = xa; rows.xb = xb; rows.pitch = p;
    return rows;
  }

  // Copia de los datos de la tira SIN los trazos de otras filas (así a Cloud Vision le llega solo el
  // número de esa fila, aunque el de al lado se meta un poco en ella). Devuelve {data,width,height}.
  function maskRow(img, rows, ri) {
    const w = img.width, h = img.height, lab = rows.lab, p = rows.pitch;
    const out = new Uint8ClampedArray(img.data);
    const row = rows[ri];
    if (!row || !row.bbox) return { data: out, width: w, height: h };
    const keep = new Set(row.labels);
    const padX = Math.round(p * 0.8), padY = Math.round(p * 0.5);
    const rx0 = Math.max(0, row.bbox.x0 - padX), rx1 = Math.min(w - 1, row.bbox.x1 + padX);
    const ry0 = Math.max(0, row.bbox.y0 - padY), ry1 = Math.min(h - 1, row.bbox.y1 + padY);
    const erase = new Uint8Array(w * h);
    for (let y = ry0; y <= ry1; y++) {
      for (let x = rx0; x <= rx1; x++) {
        const k = lab[y * w + x];
        if (x < rows.xa || x >= rows.xb) erase[y * w + x] = 1;       // bordes de la tira
        else if (k && !keep.has(k)) {
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= ry0 && yy <= ry1 && xx >= rx0 && xx <= rx1) erase[yy * w + xx] = 1;
          }
        }
      }
    }
    for (let y = ry0; y <= ry1; y++) for (let x = rx0; x <= rx1; x++) {
      const z = y * w + x;
      if (erase[z] && !keep.has(lab[z])) { out[z * 4] = out[z * 4 + 1] = out[z * 4 + 2] = 255; }
    }
    return { data: out, width: w, height: h };
  }

  const api = { fitGrid, rowBounds, removeRuling, rowInk, maskRow, digitness, TH, N_ROWS };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Rows = api;
})(typeof self !== "undefined" ? self : this);
