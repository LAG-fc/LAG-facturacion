// enhance.js — Filtros para que la foto parezca escaneada en una máquina de oficina, estilo CamScanner (v8.7).
// Trabaja sobre {data, width, height} (como ImageData) y lo modifica en el lugar. Sin librerías externas.
//
// Cadena de procesamiento (apply):
//   1) Iluminación pareja (flatten): se estima el "fondo" de la hoja (cuánta luz le llega a cada zona: sombra de la
//      mano, luz despareja, brillo) con un mapa por bloques que ignora la letra y las manchas, y se divide la foto por
//      ese mapa. El papel queda blanco parejo, sin sombras ni tinte amarillo, y la tinta conserva su color.
//   2) Reducción de ruido: suaviza el papel liso pero respeta los bordes de las letras (filtro que solo promedia
//      vecinos parecidos) y elimina el ruido de color (manchitas de colores de las fotos con poca luz).
//   3) Según el modo:
//      - "mejorado" (realce de color, como el "Magic Color"): curva de contraste (negros más negros, papel blanco
//        puro), tinta azul/roja más viva y nitidez (máscara de enfoque) para bordes de letra definidos.
//      - "gris": lo mismo en escala de grises.
//      - "documento": blanco y negro con umbral LOCAL (Sauvola): cada zona usa su propio umbral, así una parte más
//        oscura de la hoja no queda manchada. Bordes suavizados (sin serrucho) y sin puntitos sueltos.
//      - "color": la foto tal cual (solo recortada).
(function (root) {
  "use strict";

  const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  // Promedio en una ventana (2r+1)×(2r+1), separable y con suma corrida: el costo no depende de r.
  // Recibe cualquier arreglo de números y devuelve un Float32Array (los bordes repiten el último píxel).
  function boxBlur(src, w, h, r) {
    const n = w * h, inv = 1 / (2 * r + 1);
    const tmp = new Float32Array(n), out = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = src[row] * (r + 1);
      for (let x = 1; x <= r; x++) sum += src[row + (x < w ? x : w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum * inv;
        const xa = x + r + 1, xb = x - r;
        sum += src[row + (xa < w ? xa : w - 1)] - src[row + (xb > 0 ? xb : 0)];
      }
    }
    // vertical, recorriendo por filas (más rápido): una suma corrida por columna
    const acc = new Float64Array(w);
    for (let x = 0; x < w; x++) {
      let sum = tmp[x] * (r + 1);
      for (let k = 1; k <= r; k++) sum += tmp[(k < h ? k : h - 1) * w + x];
      acc[x] = sum;
    }
    for (let y = 0; y < h; y++) {
      const o = y * w, ya = (y + r + 1 < h ? y + r + 1 : h - 1) * w, yb = (y - r > 0 ? y - r : 0) * w;
      for (let x = 0; x < w; x++) {
        out[o + x] = acc[x] * inv;
        acc[x] += tmp[ya + x] - tmp[yb + x];
      }
    }
    return out;
  }

  // ---------- 1) Iluminación pareja ----------
  // Mapa del fondo (papel) por bloques, para cada canal R, G, B. En cada bloque se toma un percentil alto (lo más
  // claro: el papel, no la letra). Los bloques que son "contenido" (logo negro, tabla, sello, el fondo de la mesa)
  // se reconocen porque son mucho más oscuros que los bloques de alrededor, y se rellenan con los vecinos.
  function backgroundMaps(data, w, h) {
    const B = Math.max(8, Math.round(Math.min(w, h) / 48));
    const bw = Math.ceil(w / B), bh = Math.ceil(h / B), nb = bw * bh;
    const maps = [new Float32Array(nb), new Float32Array(nb), new Float32Array(nb)];
    const lum = new Float32Array(nb);
    const hist = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)];
    const pct = (hh, cnt, f) => { const t = cnt * f; let acc = 0; for (let k = 0; k < 64; k++) { acc += hh[k]; if (acc >= t) return k * 4 + 2; } return 254; };
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        for (const hh of hist) hh.fill(0);
        let count = 0;
        const y1 = Math.min(h, (by + 1) * B), x1 = Math.min(w, (bx + 1) * B);
        for (let y = by * B; y < y1; y++) {
          let i = (y * w + bx * B) * 4;
          for (let x = bx * B; x < x1; x++, i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            hist[0][r >> 2]++; hist[1][g >> 2]++; hist[2][b >> 2]++;
            hist[3][(r * 77 + g * 150 + b * 29) >> 10]++;
            count++;
          }
        }
        const k = by * bw + bx;
        for (let c = 0; c < 3; c++) maps[c][k] = pct(hist[c], count, 0.85);
        lum[k] = pct(hist[3], count, 0.85);
      }
    }
    // ¿qué bloques son papel? (claros respecto de su zona y de la hoja entera)
    const sorted = Float32Array.from(lum).sort();
    const paper = sorted[Math.floor(nb * 0.9)] || 200;
    const valid = new Uint8Array(nb);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let m = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = by + dy; if (yy < 0 || yy >= bh) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = bx + dx; if (xx < 0 || xx >= bw) continue;
            const v = lum[yy * bw + xx]; if (v > m) m = v;
          }
        }
        const v = lum[by * bw + bx];
        valid[by * bw + bx] = v >= 0.78 * m && v >= 0.5 * paper ? 1 : 0;
      }
    }
    // rellenar los bloques de contenido con el promedio de sus vecinos de papel (de afuera hacia adentro)
    let pending = 0;
    for (let k = 0; k < nb; k++) if (!valid[k]) pending++;
    if (pending === nb) { for (let c = 0; c < 3; c++) maps[c].fill(paper); pending = 0; }
    while (pending > 0) {
      const next = valid.slice();
      let filled = 0;
      for (let by = 0; by < bh; by++) {
        for (let bx = 0; bx < bw; bx++) {
          const k = by * bw + bx;
          if (valid[k]) continue;
          const s = [0, 0, 0];
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = by + dy; if (yy < 0 || yy >= bh) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = bx + dx; if (xx < 0 || xx >= bw) continue;
              const q = yy * bw + xx;
              if (!valid[q]) continue;
              s[0] += maps[0][q]; s[1] += maps[1][q]; s[2] += maps[2][q]; n++;
            }
          }
          if (!n) continue;
          for (let c = 0; c < 3; c++) maps[c][k] = s[c] / n;
          next[k] = 1; filled++;
        }
      }
      valid.set(next);
      pending -= filled;
      if (!filled) break;
    }
    // suavizado (la luz cambia de a poco)
    for (let c = 0; c < 3; c++) {
      let m = maps[c];
      for (let pass = 0; pass < 3; pass++) {
        const sm = new Float32Array(nb);
        for (let by = 0; by < bh; by++) {
          for (let bx = 0; bx < bw; bx++) {
            let s = 0, n = 0;
            for (let dy = -1; dy <= 1; dy++) {
              const yy = by + dy; if (yy < 0 || yy >= bh) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const xx = bx + dx; if (xx < 0 || xx >= bw) continue;
                s += m[yy * bw + xx]; n++;
              }
            }
            sm[by * bw + bx] = s / n;
          }
        }
        m = sm;
      }
      maps[c] = m;
    }
    return { maps, bw, bh, B, paper };
  }

  // Divide cada canal por su fondo: el papel queda en ~250 en toda la hoja y sin tinte.
  function flatten(img) {
    const { data, width: w, height: h } = img;
    const { maps, bw, bh, B } = backgroundMaps(data, w, h);
    const TARGET = 250;
    // ganancia de cada bloque (cuánto hay que aclarar), con un tope para zonas muy oscuras
    const gains = maps.map((m) => {
      const s = Float32Array.from(m).sort();
      const floor = Math.max(40, (s[Math.floor(s.length * 0.9)] || 200) * 0.35);
      return m.map((v) => TARGET / Math.max(v, floor));
    });
    // interpolación bilineal: por columna se calcula una vez qué bloques y con qué peso
    const cx0 = new Int32Array(w), cx1 = new Int32Array(w), ctx = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, x / B - 0.5)), x0 = Math.floor(fx);
      cx0[x] = x0; cx1[x] = Math.min(bw - 1, x0 + 1); ctx[x] = fx - x0;
    }
    const gr = new Float32Array(bw), gg = new Float32Array(bw), gb = new Float32Array(bw);
    const [G0, G1, G2] = gains;
    for (let y = 0; y < h; y++) {
      const fy = Math.min(bh - 1, Math.max(0, y / B - 0.5));
      const y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0, a0 = y0 * bw, a1 = y1 * bw;
      for (let bx = 0; bx < bw; bx++) {
        gr[bx] = G0[a0 + bx] * (1 - ty) + G0[a1 + bx] * ty;
        gg[bx] = G1[a0 + bx] * (1 - ty) + G1[a1 + bx] * ty;
        gb[bx] = G2[a0 + bx] * (1 - ty) + G2[a1 + bx] * ty;
      }
      let i = y * w * 4;
      for (let x = 0; x < w; x++, i += 4) {
        const x0 = cx0[x], x1 = cx1[x], tx = ctx[x], ux = 1 - tx;
        data[i] = data[i] * (gr[x0] * ux + gr[x1] * tx);
        data[i + 1] = data[i + 1] * (gg[x0] * ux + gg[x1] * tx);
        data[i + 2] = data[i + 2] * (gb[x0] * ux + gb[x1] * tx);
      }
    }
    return img;
  }

  // ---------- 2) Reducción de ruido ----------
  // Luminancia sin ruido: en zonas lisas (papel) se usa el promedio de los vecinos; en los bordes (letras) se deja
  // el píxel como está. El umbral sale del ruido medido en el papel.
  function denoiseLuma(Y, w, h) {
    const bl = boxBlur(Y, w, h, 1);
    const hist = new Uint32Array(64);
    let cnt = 0;
    for (let p = 0; p < Y.length; p += 7) { if (Y[p] < 200) continue; hist[Math.min(63, Math.abs(Y[p] - bl[p]))]++; cnt++; }
    let acc = 0, mad = 2;
    for (let k = 0; k < 64; k++) { acc += hist[k]; if (acc * 2 >= cnt) { mad = k; break; } }
    const T = Math.max(4, Math.min(20, 3 * 1.4826 * Math.max(1, mad)));
    for (let p = 0; p < Y.length; p++) {
      const d = bl[p] - Y[p];
      const a = 1 - Math.abs(d) / T;
      if (a > 0) Y[p] = Y[p] + a * d;
    }
    return Y;
  }

  // ---------- 3) Curva de contraste ----------
  // Punto negro = lo más oscuro de la tinta (percentil 0,5); punto blanco = un poco por debajo del papel (todo el
  // papel queda en blanco puro). gamma > 1 oscurece los grises: la letra fina y las líneas punteadas se ven más.
  function toneLUT(Y, gamma, white) {
    const hist = new Uint32Array(256);
    for (let p = 0; p < Y.length; p += 3) hist[Y[p] | 0]++;
    const n = Math.ceil(Y.length / 3);
    let acc = 0, bp = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.005) { bp = v; break; } }
    bp = Math.min(bp, 80);
    const wp = Math.max(bp + 60, white);
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      const t = Math.min(1, Math.max(0, (v - bp) / (wp - bp)));
      lut[v] = Math.round(255 * Math.pow(t, gamma));
    }
    return lut;
  }

  // Máscara de enfoque sobre la luminancia (bordes de letra más nítidos).
  function sharpen(Y, w, h, amount) {
    const r = Math.max(1, Math.round(Math.min(w, h) / 1400));
    const bl = boxBlur(boxBlur(Y, w, h, r), w, h, r);
    for (let p = 0; p < Y.length; p++) Y[p] = clamp255(Y[p] + amount * (Y[p] - bl[p]));
    return Y;
  }

  function lumaOf(data, n) {
    const Y = new Uint8ClampedArray(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) Y[p] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29 + 128) >> 8;
    return Y;
  }

  // "Color mejorado": papel blanco puro, tinta con color vivo y bordes nítidos.
  function magicColor(img) {
    const { data, width: w, height: h } = img;
    const n = w * h;
    const Y = lumaOf(data, n);
    // color = diferencia de cada canal con la luminancia (sin el ruido de color: se promedia en 5×5)
    let Cb = new Int16Array(n), Cr = new Int16Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) { Cb[p] = data[i + 2] - Y[p]; Cr[p] = data[i] - Y[p]; }
    Cb = boxBlur(Cb, w, h, 2); Cr = boxBlur(Cr, w, h, 2);
    denoiseLuma(Y, w, h);
    const lut = toneLUT(Y, 1.25, 228);
    for (let p = 0; p < n; p++) Y[p] = lut[Y[p]];
    sharpen(Y, w, h, 0.7);
    const SAT = 1.4;
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const y = Y[p];
      // sobre el papel (claro) no queda color: blanco puro, sin manchitas
      const k = y >= 245 ? 0 : y <= 190 ? SAT : SAT * (245 - y) / 55;
      const cb = Cb[p] * k, cr = Cr[p] * k;
      const r = y + cr, b = y + cb;
      data[i] = clamp255(r);
      data[i + 1] = clamp255((y - 0.299 * r - 0.114 * b) / 0.587);
      data[i + 2] = clamp255(b);
    }
    return img;
  }

  // "Escala de grises": igual que el realce, sin color.
  function grayscale(img) {
    const { data, width: w, height: h } = img;
    const n = w * h;
    const Y = lumaOf(data, n);
    denoiseLuma(Y, w, h);
    const lut = toneLUT(Y, 1.15, 230);
    for (let p = 0; p < n; p++) Y[p] = lut[Y[p]];
    sharpen(Y, w, h, 0.6);
    for (let p = 0, i = 0; p < n; p++, i += 4) data[i] = data[i + 1] = data[i + 2] = Y[p];
    return img;
  }

  // "Documento": blanco y negro con umbral local (Sauvola) sobre la hoja ya pareja.
  function blackWhite(img) {
    const { data, width: w, height: h } = img;
    const n = w * h;
    const Y = lumaOf(data, n);
    denoiseLuma(Y, w, h);
    const r = Math.max(7, Math.round(Math.min(w, h) / 60));
    const mean = boxBlur(Y, w, h, r);
    const Y2 = new Float32Array(n);
    for (let p = 0; p < n; p++) Y2[p] = Y[p] * Y[p];
    const mean2 = boxBlur(Y2, w, h, r);
    const K = 0.2, R = 128, D = 28;
    const out = new Uint8Array(n);
    const lut = toneLUT(Y, 1.3, 225);
    for (let p = 0; p < n; p++) {
      const m = mean[p];
      const sd = Math.sqrt(Math.max(0, mean2[p] - m * m));
      // umbral de la zona (lo que está por encima es papel: blanco puro). Por debajo, la tinta pasa a negro en una
      // rampa corta: la letra queda negra con el borde suave (sin serrucho ni trazo engordado) y una línea
      // punteada o un trazo de lápiz tenue no desaparecen. Lo muy oscuro (un logo o un sello macizo) es negro.
      const T = Math.max(96, Math.min(222, m * (1 + K * (sd / R - 1))));
      const y = Y[p];
      const bw = y >= T ? 255 : clamp255(255 * (1 - (T - y) / D));
      // nunca más claro que la versión en grises con contraste: un trazo tenue o una línea punteada fina que el
      // umbral dejaría en blanco queda en gris (no se pierde)
      out[p] = Math.min(bw, lut[y]);
    }
    // sin puntitos sueltos: un píxel oscuro sin vecinos oscuros es ruido
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (out[p] >= 128) continue;
        let nb = 0;
        if (out[p - 1] < 128) nb++; if (out[p + 1] < 128) nb++; if (out[p - w] < 128) nb++; if (out[p + w] < 128) nb++;
        if (out[p - w - 1] < 128) nb++; if (out[p - w + 1] < 128) nb++; if (out[p + w - 1] < 128) nb++; if (out[p + w + 1] < 128) nb++;
        if (nb <= 1) out[p] = 255;
      }
    }
    for (let p = 0, i = 0; p < n; p++, i += 4) data[i] = data[i + 1] = data[i + 2] = out[p];
    return img;
  }

  // Aplica el modo de imagen elegido: "mejorado", "gris", "documento" o "color" (sin cambios).
  function apply(img, mode) {
    if (mode === "color") return img;
    flatten(img);
    if (mode === "gris") return grayscale(img);
    if (mode === "documento") return blackWhite(img);
    return magicColor(img);
  }

  // Compatibilidad con versiones anteriores: enhance(img) = "Color mejorado".
  const enhance = (img) => apply(img, "mejorado");

  const api = { apply, enhance, flatten, MODES: ["mejorado", "documento", "gris", "color"] };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Enhance = api;
})(typeof self !== "undefined" ? self : this);
