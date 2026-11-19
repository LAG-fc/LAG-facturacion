// enhance.js — "Color mejorado" (parecido al modo de CamScanner).
// Mantiene los colores originales (por ejemplo la tinta azul), pero:
//   1) aplana sombras y manchas de luz para que el papel quede parejo y blanco,
//   2) pone el blanco más blanco y los negros más oscuros,
//   3) agrega una nitidez leve.
// Trabaja sobre {data, width, height} (como ImageData) y lo modifica en el lugar.
(function (root) {
  "use strict";

  const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  function boxBlur(src, w, h, r) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    const d = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = (sum / d) | 0;
        sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = (sum / d) | 0;
        sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  // Mapa de "cuánta luz hay" en cada zona del papel (percentil 70 de cada bloque).
  function illuminationMap(lum, w, h, B) {
    const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
    let map = new Float32Array(bw * bh);
    const hist = new Uint32Array(64);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        hist.fill(0);
        let count = 0;
        const y1 = Math.min(h, (by + 1) * B), x1 = Math.min(w, (bx + 1) * B);
        for (let y = by * B; y < y1; y++) {
          for (let x = bx * B; x < x1; x++) { hist[lum[y * w + x] >> 2]++; count++; }
        }
        const target = count * 0.7;
        let acc = 0, bin = 63;
        for (let k = 0; k < 64; k++) { acc += hist[k]; if (acc >= target) { bin = k; break; } }
        map[by * bw + bx] = bin * 4 + 2;
      }
    }
    // Dilatación 3x3 (para no oscurecer sellos o manchas de tinta) y suavizado.
    const dil = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let m = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = by + dy, xx = bx + dx;
          if (yy < 0 || yy >= bh || xx < 0 || xx >= bw) continue;
          const v = map[yy * bw + xx];
          if (v > m) m = v;
        }
        dil[by * bw + bx] = m;
      }
    }
    map = dil;
    for (let pass = 0; pass < 2; pass++) {
      const sm = new Float32Array(bw * bh);
      for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
          let s = 0, c = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const yy = by + dy, xx = bx + dx;
            if (yy < 0 || yy >= bh || xx < 0 || xx >= bw) continue;
            s += map[yy * bw + xx]; c++;
          }
          sm[by * bw + bx] = s / c;
        }
      }
      map = sm;
    }
    return { map, bw, bh };
  }

  function enhance(img, opts) {
    opts = Object.assign({ sharpen: 0.7, gamma: 1.2, paperTarget: 247 }, opts || {});
    const { data, width: w, height: h } = img;
    const n = w * h;

    // 1) Aplanar la iluminación y neutralizar el tinte, canal por canal (R, G, B)
    const B = Math.max(12, Math.round(Math.min(w, h) / 40));
    const maps = [], floors = [];
    let bw = 0, bh = 0;
    for (let c = 0; c < 3; c++) {
      const ch = new Uint8Array(n);
      for (let i = c, p = 0; p < n; i += 4, p++) ch[p] = data[i];
      const m = illuminationMap(ch, w, h, B);
      bw = m.bw; bh = m.bh;
      maps.push(m.map);
      const sorted = Array.from(m.map).sort((a, b) => a - b);
      const globalPaper = sorted[Math.floor(sorted.length * 0.75)] || 200;
      floors.push(Math.max(60, globalPaper * 0.55));
    }

    for (let y = 0; y < h; y++) {
      const fy = Math.min(bh - 1, Math.max(0, y / B - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(bw - 1, Math.max(0, x / B - 0.5));
        const x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const map = maps[c];
          const L = (map[y0 * bw + x0] * (1 - tx) + map[y0 * bw + x1] * tx) * (1 - ty) +
                    (map[y1 * bw + x0] * (1 - tx) + map[y1 * bw + x1] * tx) * ty;
          const gain = Math.min(3, opts.paperTarget / Math.max(L, floors[c]));
          data[i + c] = clamp255(data[i + c] * gain);
        }
      }
    }

    // 2) Blancos más blancos, negros más oscuros (curva común a los 3 canales)
    const hist = new Uint32Array(256);
    for (let i = 0; i < data.length; i += 4) hist[(data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8]++;
    let acc = 0, bp = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.006) { bp = v; break; } }
    bp = Math.min(bp, 90);
    const wp = 232;
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      const t = Math.min(1, Math.max(0, (v - bp) / (wp - bp)));
      lut[v] = Math.round(255 * Math.pow(t, opts.gamma));
    }
    for (let i = 0; i < data.length; i += 4) {
      data[i] = lut[data[i]]; data[i + 1] = lut[data[i + 1]]; data[i + 2] = lut[data[i + 2]];
    }

    // 3) Nitidez leve (máscara de enfoque)
    if (opts.sharpen > 0) {
      const r = Math.max(1, Math.round(Math.min(w, h) / 1000));
      for (let c = 0; c < 3; c++) {
        const ch = new Uint8Array(n);
        for (let i = c, p = 0; p < n; i += 4, p++) ch[p] = data[i];
        const bl = boxBlur(boxBlur(ch, w, h, r), w, h, r);
        for (let i = c, p = 0; p < n; i += 4, p++) data[i] = clamp255(ch[p] + opts.sharpen * (ch[p] - bl[p]));
      }
    }
    return img;
  }

  const api = { enhance };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Enhance = api;
})(typeof self !== "undefined" ? self : this);
