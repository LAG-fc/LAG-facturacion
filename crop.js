// crop.js — Detección automática del papel y recorte con corrección de perspectiva.
// No usa librerías externas. Trabaja con objetos {data, width, height} (como ImageData).
(function (root) {
  "use strict";

  function toGray(img) {
    const d = img.data, n = img.width * img.height;
    const g = new Uint8Array(n);
    for (let i = 0, p = 0; p < n; i += 4, p++) {
      g[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
    }
    return g;
  }

  // Umbral automático (Otsu): separa "papel claro" de "fondo oscuro".
  function otsu(gray) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    const total = gray.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = i; }
    }
    return thr;
  }

  // Erosión 4-vecinos: elimina puntitos y bordes finos pegados al papel.
  function erode(mask, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!mask[p]) continue;
        if ((x > 0 && !mask[p - 1]) || (x < w - 1 && !mask[p + 1]) ||
            (y > 0 && !mask[p - w]) || (y < h - 1 && !mask[p + w])) continue;
        out[p] = 1;
      }
    }
    return out;
  }

  // Dilatación 4-vecinos (agranda la máscara 1 píxel).
  function dilate(mask, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (mask[p] || (x > 0 && mask[p - 1]) || (x < w - 1 && mask[p + 1]) ||
            (y > 0 && mask[p - w]) || (y < h - 1 && mask[p + w])) out[p] = 1;
      }
    }
    return out;
  }

  function largestComponent(mask, w, h) {
    const n = w * h;
    const lab = new Int32Array(n);
    const stack = new Int32Array(n);
    let cur = 0, best = 0, bestCount = 0;
    for (let s = 0; s < n; s++) {
      if (!mask[s] || lab[s]) continue;
      cur++;
      let sp = 0, count = 0;
      stack[sp++] = s; lab[s] = cur;
      while (sp) {
        const p = stack[--sp];
        count++;
        const x = p % w;
        if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; stack[sp++] = p + 1; }
        if (p >= w && mask[p - w] && !lab[p - w]) { lab[p - w] = cur; stack[sp++] = p - w; }
        if (p < n - w && mask[p + w] && !lab[p + w]) { lab[p + w] = cur; stack[sp++] = p + w; }
      }
      if (count > bestCount) { bestCount = count; best = cur; }
    }
    return { lab, best, count: bestCount };
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function polyArea(q) {
    let a = 0;
    for (let i = 0; i < q.length; i++) {
      const p = q[i], r = q[(i + 1) % q.length];
      a += p.x * r.y - r.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (cr === 0) return false;
      const s = cr > 0 ? 1 : -1;
      if (sign && s !== sign) return false;
      sign = s;
    }
    return true;
  }

  // ---------- Detección de la hoja completa ----------
  // 1) Se separa "papel claro" del fondo (Otsu).
  // 2) Se pinta el fondo desde los bordes de la foto: todo lo que el fondo NO alcanza es la
  //    silueta de la hoja, incluida la tabla negra del remito y la letra (así no se recorta
  //    solo el interior de la tabla).
  // 3) A esa silueta se le ajusta un cuadrilátero (esquinas extremas) y un rectángulo de
  //    mínima área; se elige el que mejor cubre la silueta. Siempre sale una figura de 4 lados.
  function floodBackground(mask, w, h) {
    const bg = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let sp = 0;
    const push = (p) => { if (!mask[p] && !bg[p]) { bg[p] = 1; stack[sp++] = p; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) {
      const p = stack[--sp], x = p % w;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (p >= w) push(p - w);
      if (p < w * h - w) push(p + w);
    }
    return bg;
  }

  function convexHull(pts) {
    pts.sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lo = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    const up = [];
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    lo.pop(); up.pop();
    return lo.concat(up);
  }

  // Rectángulo de mínima área que contiene al casco convexo, ordenado [TL,TR,BR,BL].
  function minAreaRect(hull) {
    let best = null;
    for (let deg = 0; deg < 90; deg += 0.5) {
      const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const p of hull) {
        const u = p.x * c + p.y * s, v = -p.x * s + p.y * c;
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      const area = (u1 - u0) * (v1 - v0);
      if (!best || area < best.area) best = { area, c, s, u0, u1, v0, v1 };
    }
    const back = (u, v) => ({ x: u * best.c - v * best.s, y: u * best.s + v * best.c });
    return orderQuad([back(best.u0, best.v0), back(best.u1, best.v0), back(best.u1, best.v1), back(best.u0, best.v1)]);
  }

  // Ordena 4 puntos como [TL,TR,BR,BL] (TL = arriba a la izquierda).
  function orderQuad(q) {
    const cx = q.reduce((s, p) => s + p.x, 0) / 4, cy = q.reduce((s, p) => s + p.y, 0) / 4;
    const sorted = q.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    // ángulos crecientes en pantalla = sentido horario: empezar por el punto con menor x+y
    let k = 0, m = Infinity;
    sorted.forEach((p, i) => { if (p.x + p.y < m) { m = p.x + p.y; k = i; } });
    return [0, 1, 2, 3].map((i) => sorted[(k + i) % 4]);
  }

  function quadCoverage(quad, sil, w, h) {
    // IoU entre el cuadrilátero y la silueta
    let x0 = w, x1 = 0, y0 = h, y1 = 0;
    for (const p of quad) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(w - 1, Math.ceil(x1)); y1 = Math.min(h - 1, Math.ceil(y1));
    const orient = (quad[1].x - quad[0].x) * (quad[2].y - quad[1].y) - (quad[1].y - quad[0].y) * (quad[2].x - quad[1].x) > 0;
    let inter = 0, qArea = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let inside = true;
        for (let i = 0; i < 4; i++) {
          const a = quad[i], b = quad[(i + 1) % 4];
          const cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
          if (orient ? cr < 0 : cr > 0) { inside = false; break; }
        }
        if (inside) { qArea++; if (sil[y * w + x]) inter++; }
      }
    }
    let silArea = 0;
    for (let i = 0; i < sil.length; i++) silArea += sil[i];
    return { iou: inter / Math.max(1, qArea + silArea - inter), qArea, silArea };
  }

  // Ajusta un cuadrilátero a la silueta que sale de un umbral dado. Devuelve {quad, iou} o null.
  function fitAtThreshold(gray, w, h, thr) {
    const mask = new Uint8Array(w * h);
    for (let p = 0; p < mask.length; p++) mask[p] = gray[p] > thr ? 1 : 0;

    // Silueta = todo lo que el fondo no alcanza desde los bordes de la foto.
    const bg = floodBackground(mask, w, h);
    let sil = new Uint8Array(w * h);
    for (let p = 0; p < sil.length; p++) sil[p] = bg[p] ? 0 : 1;
    const ERODE = 3;
    for (let i = 0; i < ERODE; i++) sil = erode(sil, w, h);
    const cc = largestComponent(sil, w, h);
    if (!cc.best || cc.count < w * h * 0.08) return null;
    sil = new Uint8Array(w * h);
    for (let p = 0; p < sil.length; p++) sil[p] = cc.lab[p] === cc.best ? 1 : 0;
    for (let i = 0; i < ERODE; i++) sil = dilate(sil, w, h);

    // Puntos de borde de la silueta -> casco convexo
    const edge = [];
    let tl = null, br = null, tr = null, bl = null, minS = Infinity, maxS = -Infinity, maxD = -Infinity, minD = Infinity;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!sil[p]) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !sil[p - 1] || !sil[p + 1] || !sil[p - w] || !sil[p + w]) {
          if ((x + y) % 2 === 0 || x === 0 || y === 0) edge.push({ x, y });
        }
        const s = x + y, d = x - y;
        if (s < minS) { minS = s; tl = { x, y }; }
        if (s > maxS) { maxS = s; br = { x, y }; }
        if (d > maxD) { maxD = d; tr = { x, y }; }
        if (d < minD) { minD = d; bl = { x, y }; }
      }
    }
    if (edge.length < 20) return null;
    const hull = convexHull(edge);
    const candidates = [];
    if (tl && tr && br && bl) candidates.push(orderQuad([tl, tr, br, bl]));
    candidates.push(minAreaRect(hull));
    let quad = null, bestIou = 0;
    for (const c of candidates) {
      if (!isConvex(c)) continue;
      const cov = quadCoverage(c, sil, w, h);
      if (cov.iou > bestIou) { bestIou = cov.iou; quad = c; }
    }
    if (!quad) return null;
    quad = quad.map((p) => ({ x: Math.min(w - 1, Math.max(0, p.x)), y: Math.min(h - 1, Math.max(0, p.y)) }));
    return { quad, iou: bestIou };
  }

  // Devuelve {quad:[TL,TR,BR,BL], areaRatio} en coordenadas de la imagen recibida, o null.
  function detectPaper(img) {
    const w = img.width, h = img.height;
    const gray = toGray(img);
    const t0 = otsu(gray);
    // Se prueban varios umbrales (el papel suele tener un lado más oscuro por la sombra)
    // y se queda el que mejor forma un rectángulo.
    let fit = null;
    for (const k of [1, 0.85, 0.7, 1.15]) {
      const f = fitAtThreshold(gray, w, h, Math.round(t0 * k));
      if (f && (!fit || f.iou > fit.iou + 0.005)) fit = f;
      if (fit && fit.iou > 0.97) break;
    }
    if (!fit || fit.iou < 0.85) return null;
    const quad = fit.quad, bestIou = fit.iou;

    const area = polyArea(quad);
    const ratio = area / (w * h);
    if (ratio < 0.15 || ratio > 0.97) { if (globalThis.__dbg) console.log('ratio', ratio); return null; }       // muy chico, o ya ocupa todo el cuadro
    // El interior debe ser claramente más claro que lo que queda afuera. Si no, es una
    // imagen ya recortada (o papel blanco sobre fondo blanco) y es mejor no recortar nada.
    let inSum = 0, inN = 0, outSum = 0, outN = 0;
    const orient = (quad[1].x - quad[0].x) * (quad[2].y - quad[1].y) - (quad[1].y - quad[0].y) * (quad[2].x - quad[1].x) > 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let inside = true;
        for (let i = 0; i < 4; i++) {
          const a = quad[i], b = quad[(i + 1) % 4];
          const cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
          if (orient ? cr < 0 : cr > 0) { inside = false; break; }
        }
        if (inside) { inSum += gray[y * w + x]; inN++; } else { outSum += gray[y * w + x]; outN++; }
      }
    }
    if (outN > w * h * 0.02 && inSum / Math.max(1, inN) - outSum / outN < 35) { if (globalThis.__dbg) console.log('contrast', inSum/inN, outSum/outN); return null; }
    const minSide = 0.12 * Math.min(w, h);
    for (let i = 0; i < 4; i++) if (dist(quad[i], quad[(i + 1) % 4]) < minSide) return null;
    return { quad, areaRatio: ratio, coverage: bestIou };
  }

  // Resuelve el sistema lineal A·x = b (eliminación gaussiana con pivoteo).
  function solve(A, b) {
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let piv = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
      [A[i], A[piv]] = [A[piv], A[i]];
      [b[i], b[piv]] = [b[piv], b[i]];
      const d = A[i][i] || 1e-12;
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / d;
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / (A[i][i] || 1e-12);
    }
    return x;
  }

  // Homografía que lleva (u,v) del rectángulo de salida a (x,y) del cuadrilátero de origen.
  function homography(dst, src) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const u = dst[i].x, v = dst[i].y, x = src[i].x, y = src[i].y;
      A.push([u, v, 1, 0, 0, 0, -x * u, -x * v]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -y * u, -y * v]); b.push(y);
    }
    return solve(A, b);
  }

  // Endereza el cuadrilátero quad=[TL,TR,BR,BL] (coordenadas de img) a un rectángulo.
  // Proporción real de la hoja del remito (ancho / alto): 0,83.
  const PAGE_RATIO = 0.83;
  function warp(img, quad, maxSide) {
    const [TL, TR, BR, BL] = quad;
    let outW = Math.round(Math.max(dist(TL, TR), dist(BL, BR)));
    let outH = Math.round(Math.max(dist(TL, BL), dist(TR, BR)));
    // La hoja siempre es un rectángulo con la proporción del remito: se conserva el lado más
    // largo medido y el otro se calcula (así la perspectiva o un dedo en una esquina no deforman).
    if (outH >= outW) outW = Math.round(outH * PAGE_RATIO);
    else outH = Math.round(outW * PAGE_RATIO);
    const s = Math.min(1, (maxSide || 2200) / Math.max(outW, outH));
    outW = Math.max(2, Math.round(outW * s));
    outH = Math.max(2, Math.round(outH * s));

    const H = homography(
      [{ x: 0, y: 0 }, { x: outW - 1, y: 0 }, { x: outW - 1, y: outH - 1 }, { x: 0, y: outH - 1 }],
      quad
    );
    const sw = img.width, sh = img.height, sd = img.data;
    const out = new Uint8ClampedArray(outW * outH * 4);
    for (let v = 0; v < outH; v++) {
      for (let u = 0; u < outW; u++) {
        const den = H[6] * u + H[7] * v + 1;
        let sx = (H[0] * u + H[1] * v + H[2]) / den;
        let sy = (H[3] * u + H[4] * v + H[5]) / den;
        sx = Math.min(sw - 1.001, Math.max(0, sx));
        sy = Math.min(sh - 1.001, Math.max(0, sy));
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        const o = (v * outW + u) * 4;
        for (let c = 0; c < 3; c++) {
          const top = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
          const bot = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
          out[o + c] = top * (1 - fy) + bot * fy;
        }
        out[o + 3] = 255;
      }
    }
    return { data: out, width: outW, height: outH };
  }

  const api = { detectPaper, warp, PAGE_RATIO };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Crop = api;
})(typeof self !== "undefined" ? self : this);
