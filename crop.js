// crop.js — Recorte automático de la hoja con corrección de perspectiva, estilo CamScanner (v8.7).
// No usa librerías externas. Trabaja con objetos {data, width, height} (como ImageData).
//
// Cómo se encuentra la hoja (detectPaper, sobre una imagen chica de ~480 px):
//   1) Bordes: gradiente de Sobel sobre la foto en gris suavizada, afinado (solo el máximo de cada borde).
//   2) Rectas: transformada de Hough con "polaridad": cada recta recuerda de qué lado está lo claro. Así el borde de
//      la hoja (papel claro adentro, fondo más oscuro afuera) no se confunde con las líneas impresas de la tabla.
//   3) Cuadriláteros: se combinan 2 pares de rectas casi paralelas (arriba/abajo, izquierda/derecha). El recuadro
//      SIEMPRE sale de cortar 4 rectas: tiene 4 lados rectos y forma de rectángulo visto en perspectiva. Se descarta
//      todo lo que no tenga forma de hoja (ángulos lejos de 90°, lados opuestos muy distintos, muy chico).
//   4) Puntaje: a lo largo de cada lado tiene que haber un escalón claro-adentro / oscuro-afuera. Gana el cuadrilátero
//      más grande con los 4 lados bien apoyados. Un dedo o una sombra que tapa una esquina no importa: la esquina
//      sale del cruce de las rectas, no de los píxeles de la esquina.
//
// Con la foto en alta resolución (process):
//   5) refineQuad: cada lado se vuelve a medir en la foto grande (perfiles perpendiculares al borde, con precisión
//      de fracción de píxel) y se ajusta una recta o, si la hoja está curvada, una curva suave (ajuste robusto: los
//      puntos raros —un dedo, un reflejo— no cuentan). Las esquinas son los cruces de esos bordes.
//   6) warp: homografía del cuadrilátero a un rectángulo con la proporción real de la hoja (se estima con la
//      perspectiva y se ajusta a remito/A4/oficio si está cerca). Si los bordes estaban curvados, se "aplana" la hoja
//      (las líneas de texto quedan derechas). La salida es SIEMPRE un rectángulo, sin restos del fondo.
(function (root) {
  "use strict";

  // Proporción real de la hoja del remito de LAG (ancho / alto) y otras hojas comunes, con cuánto se tolera
  // (en logaritmo) para tomarla como exacta: remito ±9 %, A4 y oficio ±4 %.
  const PAGE_RATIO = 0.83;
  const KNOWN_RATIOS = [[PAGE_RATIO, 0.09], [0.7071, 0.04], [0.6067, 0.04]];

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function toGray(img) {
    const d = img.data, n = img.width * img.height;
    const g = new Float32Array(n);
    for (let i = 0, p = 0; p < n; i += 4, p++) g[p] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) / 256;
    return g;
  }

  // Suavizado binomial 1-2-1 (parecido a un gaussiano chico), separable, "passes" veces.
  function smooth(src, w, h, passes) {
    let a = Float32Array.from(src);
    const b = new Float32Array(w * h);
    for (let k = 0; k < passes; k++) {
      for (let y = 0; y < h; y++) {
        const o = y * w;
        for (let x = 0; x < w; x++) {
          const l = a[o + (x > 0 ? x - 1 : 0)], r = a[o + (x < w - 1 ? x + 1 : x)];
          b[o + x] = (l + 2 * a[o + x] + r) * 0.25;
        }
      }
      for (let y = 0; y < h; y++) {
        const up = (y > 0 ? y - 1 : 0) * w, dn = (y < h - 1 ? y + 1 : y) * w, o = y * w;
        for (let x = 0; x < w; x++) a[o + x] = (b[up + x] + 2 * b[o + x] + b[dn + x]) * 0.25;
      }
    }
    return a;
  }

  // ---------- 1) Bordes (Sobel + afinado) ----------
  // Devuelve los píxeles de borde: posición y dirección del gradiente (apunta hacia lo claro).
  function edgePixels(gs, w, h) {
    const n = w * h;
    const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        const a = gs[p - w - 1], b = gs[p - w], c = gs[p - w + 1], d = gs[p - 1], f = gs[p + 1], g = gs[p + w - 1], hh = gs[p + w], i = gs[p + w + 1];
        const sx = (c + 2 * f + i - a - 2 * d - g) * 0.125, sy = (g + 2 * hh + i - a - 2 * b - c) * 0.125;
        gx[p] = sx; gy[p] = sy;
        mag[p] = Math.sqrt(sx * sx + sy * sy);
      }
    }
    // Umbral: por encima del ruido, bajo como para ver una hoja blanca sobre una mesa clara.
    let thr = 3.2;
    let xs = [], ys = [], th = [];
    for (let pass = 0; pass < 3; pass++) {
      xs = []; ys = []; th = [];
      for (let y = 2; y < h - 2; y++) {
        for (let x = 2; x < w - 2; x++) {
          const p = y * w + x, m = mag[p];
          if (m < thr) continue;
          const dx = Math.round(gx[p] / m), dy = Math.round(gy[p] / m);
          const q = dy * w + dx;
          if (m < mag[p + q] || m <= mag[p - q]) continue;           // no es el máximo del borde
          xs.push(x); ys.push(y); th.push(Math.atan2(gy[p], gx[p]));
        }
      }
      if (xs.length <= 0.12 * n) break;                              // demasiado ruido: se sube el umbral
      thr *= 1.8;
    }
    return { xs: Float32Array.from(xs), ys: Float32Array.from(ys), th: Float32Array.from(th), count: xs.length };
  }

  // ---------- 2) Rectas (Hough con polaridad) ----------
  // Una recta es {nx, ny, rho}: los puntos p con nx·x + ny·y = rho. (nx, ny) apunta hacia el lado claro.
  const NTH = 360;
  const COS = new Float32Array(NTH), SIN = new Float32Array(NTH);
  for (let t = 0; t < NTH; t++) { COS[t] = Math.cos(t * Math.PI / 180); SIN[t] = Math.sin(t * Math.PI / 180); }

  function houghLines(E, w, h) {
    const D = Math.ceil(Math.hypot(w, h)), NR = 2 * D + 1;
    const acc = new Uint16Array(NTH * NR);
    const SPREAD = 3;
    for (let k = 0; k < E.count; k++) {
      const x = E.xs[k], y = E.ys[k];
      let t0 = Math.round(E.th[k] * 180 / Math.PI);
      for (let dt = -SPREAD; dt <= SPREAD; dt++) {
        const t = (t0 + dt + 720) % NTH;
        const r = Math.round(x * COS[t] + y * SIN[t]) + D;
        const i = t * NR + r;
        if (acc[i] < 65535) acc[i]++;
      }
    }
    const minVotes = Math.max(18, Math.round(0.08 * Math.min(w, h)));
    const cand = [];
    for (let i = 0; i < acc.length; i++) if (acc[i] >= minVotes) cand.push(i);
    cand.sort((a, b) => acc[b] - acc[a]);
    const peaks = [];
    for (const i of cand) {
      const t = Math.floor(i / NR), r = i % NR - D;
      let near = false;
      for (const pk of peaks) {
        let dt = Math.abs(pk.t - t); if (dt > NTH / 2) dt = NTH - dt;
        if (dt <= 4 && Math.abs(pk.r - r) <= 8) { near = true; break; }
      }
      if (near) continue;
      peaks.push({ t, r, votes: acc[i] });
      if (peaks.length >= 30) break;
    }
    // Ajuste fino de cada recta con los píxeles de borde que la forman (mínimos cuadrados totales).
    const lines = [];
    for (const pk of peaks) {
      const c = COS[pk.t], s = SIN[pk.t];
      let n = 0, mx = 0, my = 0;
      const sel = [];
      for (let k = 0; k < E.count; k++) {
        const x = E.xs[k], y = E.ys[k];
        if (Math.abs(x * c + y * s - pk.r) > 2.5) continue;
        let da = Math.abs(E.th[k] - pk.t * Math.PI / 180) % (2 * Math.PI); if (da > Math.PI) da = 2 * Math.PI - da;
        if (da > 0.15) continue;
        sel.push(k); mx += x; my += y; n++;
      }
      if (n < 8) continue;
      mx /= n; my /= n;
      let sxx = 0, syy = 0, sxy = 0;
      for (const k of sel) { const dx = E.xs[k] - mx, dy = E.ys[k] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
      // dirección principal de los puntos = dirección de la recta
      const phi = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      let nx = -Math.sin(phi), ny = Math.cos(phi);
      if (nx * c + ny * s < 0) { nx = -nx; ny = -ny; }
      lines.push({ nx, ny, rho: nx * mx + ny * my, votes: n, border: false });
    }
    // sin repetidas
    lines.sort((a, b) => b.votes - a.votes);
    const out = [];
    for (const l of lines) {
      if (out.some((o) => o.nx * l.nx + o.ny * l.ny > 0.9994 && Math.abs(o.rho - l.rho) < 3)) continue;
      out.push(l);
      if (out.length >= 24) break;
    }
    return out;
  }

  function intersect(a, b) {
    const det = a.nx * b.ny - a.ny * b.nx;
    if (Math.abs(det) < 1e-9) return null;
    return { x: (a.rho * b.ny - a.ny * b.rho) / det, y: (a.nx * b.rho - a.rho * b.nx) / det };
  }

  // Ordena 4 puntos como [TL,TR,BR,BL] (TL = arriba a la izquierda), en sentido horario en pantalla.
  function orderQuad(q) {
    const cx = q.reduce((s, p) => s + p.x, 0) / 4, cy = q.reduce((s, p) => s + p.y, 0) / 4;
    const sorted = q.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    let k = 0, m = Infinity;
    sorted.forEach((p, i) => { if (p.x + p.y < m) { m = p.x + p.y; k = i; } });
    return [0, 1, 2, 3].map((i) => sorted[(k + i) % 4]);
  }

  function polyArea(q) {
    let a = 0;
    for (let i = 0; i < q.length; i++) { const p = q[i], r = q[(i + 1) % q.length]; a += p.x * r.y - r.x * p.y; }
    return Math.abs(a) / 2;
  }

  // ¿Tiene forma de hoja? (rectángulo visto en perspectiva). Devuelve un factor 0..1 (0 = se descarta).
  function rectShape(q, w, h) {
    let sign = 0, pen = 1;
    for (let i = 0; i < 4; i++) {
      const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
      const ux = a.x - b.x, uy = a.y - b.y, vx = c.x - b.x, vy = c.y - b.y;
      const cr = ux * vy - uy * vx;
      if (!cr) return 0;
      const s = cr > 0 ? 1 : -1;
      if (sign && s !== sign) return 0;                                  // no es convexo
      sign = s;
      const ang = Math.acos(clamp((ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1), -1, 1)) * 180 / Math.PI;
      if (ang < 60 || ang > 120) return 0;                               // esquina muy lejos de 90°
      const dev = (ang - 90) / 45;
      pen *= 1 - 0.5 * dev * dev;
    }
    const s = [0, 1, 2, 3].map((i) => dist(q[i], q[(i + 1) % 4]));
    if (Math.min(s[0], s[2]) / Math.max(s[0], s[2]) < 0.55) return 0;    // lados opuestos muy distintos
    if (Math.min(s[1], s[3]) / Math.max(s[1], s[3]) < 0.55) return 0;
    if (Math.min(...s) < 0.15 * Math.min(w, h)) return 0;
    return pen;
  }

  // ---------- 4) Puntaje de un lado: escalón "claro adentro, oscuro afuera" ----------
  // Devuelve la fracción del lado con escalón (0..1) y, aparte, si una franja de afuera es en general más oscura
  // que la de adentro (así una raya impresa de la tabla, que tiene papel a los dos lados, no cuenta como borde).
  function sideSupport(gs, w, h, A, B, nx, ny, border, paper) {
    const K = 36;
    let hit = 0;
    const at = (x, y) => {
      const xi = Math.round(x), yi = Math.round(y);
      return xi < 0 || yi < 0 || xi >= w || yi >= h ? -1 : gs[yi * w + xi];
    };
    const hin = new Uint16Array(64), hout = new Uint16Array(64);
    let nin = 0, nout = 0;
    for (let k = 0; k < K; k++) {
      const t = 0.05 + 0.9 * k / (K - 1);
      const px = A.x + (B.x - A.x) * t, py = A.y + (B.y - A.y) * t;
      if (border) {                                                    // lado pegado al borde de la foto: hay papel ahí
        const v = at(px + nx * 3, py + ny * 3);
        if (v >= paper * 0.72) hit++;
        continue;
      }
      let best = -1;
      for (let o = -3; o <= 3; o++) {
        const inn = at(px + nx * (o + 2), py + ny * (o + 2));
        const o1 = at(px + nx * (o - 2), py + ny * (o - 2));
        if (inn < 0 || o1 < 0) continue;
        const o2v = at(px + nx * (o - 5), py + ny * (o - 5));
        const s = Math.min(inn - o1, o2v < 0 ? inn - o1 : inn - o2v);   // afuera tiene que ser oscuro (no una raya fina)
        if (s > best) best = s;
      }
      if (best >= 5) hit++;
      else if (k - hit > K * 0.6) return { s: hit / K, band: 0 };      // ya no llega: no hace falta seguir
      for (let o = 4; o <= 16; o += 3) {
        const vo = at(px - nx * o, py - ny * o);
        if (vo >= 0) { hout[vo >> 2]++; nout++; }
        if (o > 10) continue;
        const vi = at(px + nx * o, py + ny * o);
        if (vi >= 0) { hin[vi >> 2]++; nin++; }
      }
    }
    // Franja de afuera: hasta su parte más clara (percentil 70) tiene que ser más oscura que el papel de adentro
    // (también su parte clara: así la letra o una raya impresa cerca del borde no cuentan).
    let band = 255;
    if (!border && nout >= K) {
      const pct = (hist, cnt, f) => { let acc = 0; for (let i = 0; i < 64; i++) { acc += hist[i]; if (acc >= cnt * f) return i * 4 + 2; } return 255; };
      band = pct(hin, nin, 0.7) - pct(hout, nout, 0.7);
    }
    return { s: hit / K, band };
  }

  // Brillo típico del papel dentro de un cuadrilátero (percentil 80 de una grilla de muestras).
  function paperLevel(gs, w, h, q) {
    const v = [];
    for (let i = 1; i < 12; i++) {
      for (let j = 1; j < 12; j++) {
        const s = i / 12, t = j / 12;
        const x = (q[0].x * (1 - s) + q[1].x * s) * (1 - t) + (q[3].x * (1 - s) + q[2].x * s) * t;
        const y = (q[0].y * (1 - s) + q[1].y * s) * (1 - t) + (q[3].y * (1 - s) + q[2].y * s) * t;
        const xi = Math.round(x), yi = Math.round(y);
        if (xi >= 0 && yi >= 0 && xi < w && yi < h) v.push(gs[yi * w + xi]);
      }
    }
    v.sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length * 0.8)] : 0;
  }

  // Devuelve {quad:[TL,TR,BR,BL], areaRatio, coverage, sides} en coordenadas de la imagen recibida, o null.
  // El cuadrilátero siempre tiene forma de rectángulo (en perspectiva); si no se encuentra uno así, devuelve null.
  function detectPaper(img) {
    const w = img.width, h = img.height;
    if (w < 40 || h < 40) return null;
    const gs = smooth(toGray(img), w, h, 2);
    const E = edgePixels(gs, w, h);
    const lines = houghLines(E, w, h);
    // los bordes de la foto también sirven de lado (hoja más grande que el cuadro)
    lines.push({ nx: 0, ny: 1, rho: 0.5, border: true }, { nx: 0, ny: -1, rho: -(h - 1.5), border: true },
               { nx: 1, ny: 0, rho: 0.5, border: true }, { nx: -1, ny: 0, rho: -(w - 1.5), border: true });
    const minDim = Math.min(w, h);
    // pares de rectas opuestas: casi paralelas, con lo claro mirando hacia adentro, bien separadas
    const foot = (l) => { const c = l.nx * w / 2 + l.ny * h / 2 - l.rho; return { x: w / 2 - c * l.nx, y: h / 2 - c * l.ny }; };
    const pairs = [];
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        const a = lines[i], b = lines[j];
        if (a.nx * b.nx + a.ny * b.ny > -0.82) continue;
        const fa = foot(a), fb = foot(b);
        if (b.nx * fa.x + b.ny * fa.y - b.rho < 0.15 * minDim) continue;
        if (a.nx * fb.x + a.ny * fb.y - a.rho < 0.15 * minDim) continue;
        pairs.push([a, b]);
      }
    }
    const found = [];
    // una esquina puede quedar un poco afuera del cuadro (la hoja no entró entera): se recorta igual, alineado con
    // la hoja, y lo que falta queda en blanco
    const margin = 0.1 * Math.max(w, h);
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const [a1, a2] = pairs[i], [b1, b2] = pairs[j];
        if (a1 === b1 || a1 === b2 || a2 === b1 || a2 === b2) continue;
        if ((a1.border ? 1 : 0) + (a2.border ? 1 : 0) + (b1.border ? 1 : 0) + (b2.border ? 1 : 0) > 2) continue;
        let perp = true;
        for (const a of pairs[i]) for (const b of pairs[j]) if (Math.abs(a.nx * b.nx + a.ny * b.ny) > 0.7) perp = false;
        if (!perp) continue;
        const pts = [intersect(a1, b1), intersect(a1, b2), intersect(a2, b2), intersect(a2, b1)];
        if (pts.some((p) => !p || p.x < -margin || p.y < -margin || p.x > w - 1 + margin || p.y > h - 1 + margin)) continue;
        const q = orderQuad(pts);
        const shape = rectShape(q, w, h);
        if (!shape) continue;
        const area = polyArea(q) / (w * h);
        if (area < 0.12) continue;
        // a qué recta corresponde cada lado del cuadrilátero ordenado
        const ls = [a1, a2, b1, b2];
        const sideLine = (A, B) => {
          const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
          let bl = null, bd = Infinity;
          for (const l of ls) { const d = Math.abs(l.nx * mx + l.ny * my - l.rho); if (d < bd) { bd = d; bl = l; } }
          return bl;
        };
        const pl = ls.some((l) => l.border) ? paperLevel(gs, w, h, q) : 0;
        const S = [];
        let ok = true;
        for (let k = 0; k < 4; k++) {
          const A = q[k], B = q[(k + 1) % 4], l = sideLine(A, B);
          const r = sideSupport(gs, w, h, A, B, l.nx, l.ny, l.border, pl);
          const s = r.s * (l.border ? 0.85 : 1);
          if (s < 0.4 || r.band < 10) { ok = false; break; }            // sin borde claro, o afuera también hay papel
          S.push(s);
        }
        if (!ok) continue;
        const mean = (S[0] + S[1] + S[2] + S[3]) / 4, min = Math.min(...S);
        if (mean < 0.6) continue;
        const score = mean * mean * min * Math.pow(area, 0.3) * shape;
        found.push({ score, q, S, area, borders: ls.filter((l) => l.border).length });
      }
    }
    // Gana el de mejor puntaje. Cada lado ya comprobó que afuera hay fondo más oscuro y no más papel (así una foto
    // ya recortada, o una mesa sin hoja, no se recortan).
    let best = null;
    for (const f of found) if (!best || f.score > best.score) best = f;
    if (!best) return null;
    if (best.area > 0.97) return null;                                  // ya es una foto recortada
    const quad = best.q.map((p) => ({ x: p.x, y: p.y }));
    return { quad, areaRatio: best.area, coverage: best.score, sides: best.S.map((s) => Math.round(s * 100) / 100), borders: best.borders };
  }

  // ---------- 5) Ajuste fino en la foto grande ----------
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

  // Ajuste robusto y = a + b·u + c·u² (u en [-1, 1]) con pesos de Tukey. curve=false: recta (c = 0).
  function robustFit(pts, curve) {
    const m = curve ? 3 : 2;
    let wts = pts.map((p) => p.w0);
    let coef = [0, 0, 0], sigma = 1;
    for (let it = 0; it < 8; it++) {
      const A = Array.from({ length: m }, () => new Array(m).fill(0)), b = new Array(m).fill(0);
      let sw = 0;
      for (let i = 0; i < pts.length; i++) {
        const wi = wts[i]; if (!wi) continue;
        const u = pts[i].u, f = [1, u, u * u];
        for (let r = 0; r < m; r++) { b[r] += wi * f[r] * pts[i].y; for (let c = 0; c < m; c++) A[r][c] += wi * f[r] * f[c]; }
        sw += wi;
      }
      if (sw < m + 2) return null;
      const x = solve(A, b);
      coef = [x[0], x[1], curve ? x[2] : 0];
      const res = pts.map((p) => Math.abs(p.y - (coef[0] + coef[1] * p.u + coef[2] * p.u * p.u)));
      const sorted = res.filter((r, i) => wts[i] > 0 || it === 0).sort((a, b) => a - b);
      sigma = Math.max(0.6, 1.4826 * (sorted[Math.floor(sorted.length / 2)] || 0));
      const cT = 4 * sigma;
      wts = res.map((r, i) => (r >= cT ? 0 : pts[i].w0 * Math.pow(1 - (r / cT) * (r / cT), 2)));
    }
    const res = pts.map((p) => Math.abs(p.y - (coef[0] + coef[1] * p.u + coef[2] * p.u * p.u)));
    const inl = res.filter((r) => r < 2.5 * sigma).length;
    return { a: coef[0], b: coef[1], c: coef[2], sigma, inliers: inl / pts.length };
  }

  // Luminancia con interpolación bilineal en la foto grande (-1 si cae afuera).
  function lumSampler(img) {
    const w = img.width, h = img.height, d = img.data;
    return (x, y) => {
      if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return -1;
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const i = (y0 * w + x0) * 4, j = i + w * 4;
      const l00 = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      const l10 = d[i + 4] * 0.299 + d[i + 5] * 0.587 + d[i + 6] * 0.114;
      const l01 = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
      const l11 = d[j + 4] * 0.299 + d[j + 5] * 0.587 + d[j + 6] * 0.114;
      return (l00 * (1 - fx) + l10 * fx) * (1 - fy) + (l01 * (1 - fx) + l11 * fx) * fy;
    };
  }

  // Entre varios candidatos por perfil, elige los que forman una curva suave y continua (y = a + b·u + c·u²).
  // Devuelve un punto por perfil (el más cercano a esa curva), listo para el ajuste fino.
  function ransacEdge(pts, K) {
    if (pts.length < 3) return [];
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const TOL = 3;
    let best = null, bestScore = 0;
    const evalModel = (m) => {
      const byK = new Map();
      for (const p of pts) {
        const r = Math.abs(p.y - (m[0] + m[1] * p.u + m[2] * p.u * p.u));
        if (r > TOL) continue;
        const o = byK.get(p.k);
        if (!o || r < o.r) byK.set(p.k, { r, p });
      }
      let sc = 0;
      byK.forEach((v) => { sc += 0.3 + v.p.w0; });
      return sc;
    };
    for (let it = 0; it < 260; it++) {
      const p1 = pts[(rnd() * pts.length) | 0], p2 = pts[(rnd() * pts.length) | 0], p3 = pts[(rnd() * pts.length) | 0];
      let m = null;
      if (it % 3 === 0) {                                     // recta por 2 puntos
        if (Math.abs(p1.u - p2.u) < 0.2) continue;
        const b = (p2.y - p1.y) / (p2.u - p1.u);
        m = [p1.y - b * p1.u, b, 0];
      } else {                                                // parábola por 3 puntos
        const u = [p1.u, p2.u, p3.u];
        if (Math.abs(u[0] - u[1]) < 0.15 || Math.abs(u[1] - u[2]) < 0.15 || Math.abs(u[0] - u[2]) < 0.15) continue;
        const x = solve([[1, u[0], u[0] * u[0]], [1, u[1], u[1] * u[1]], [1, u[2], u[2] * u[2]]], [p1.y, p2.y, p3.y]);
        m = x;
      }
      const sc = evalModel(m);
      if (sc > bestScore) { bestScore = sc; best = m; }
    }
    if (!best) return [];
    const byK = new Map();
    for (const p of pts) {
      const r = Math.abs(p.y - (best[0] + best[1] * p.u + best[2] * p.u * p.u));
      if (r > TOL * 2.5) continue;
      const o = byK.get(p.k);
      if (!o || r < o.r) byK.set(p.k, { r, p });
    }
    return [...byK.values()].map((v) => v.p).sort((a, b) => a.u - b.u);
  }

  // Mide un lado (de A a B) en la foto grande: busca el borde de la hoja en perfiles perpendiculares dentro de
  // ±band píxeles y le ajusta una recta o una curva. Devuelve {ox, oy, dx, dy, nx, ny, hl, a, b, c, ok}
  // (punto = O + d·x + n·y(x), con y(x) = a + b·(x/hl) + c·(x/hl)², n hacia adentro de la hoja).
  function measureSide(L, A, B, cx, cy, band) {
    const len = dist(A, B), hl = len / 2;
    const dx = (B.x - A.x) / len, dy = (B.y - A.y) / len;
    let nx = -dy, ny = dx;
    const ox = (A.x + B.x) / 2, oy = (A.y + B.y) / 2;
    if ((cx - ox) * nx + (cy - oy) * ny < 0) { nx = -nx; ny = -ny; }
    const side = { ox, oy, dx, dy, nx, ny, hl, a: 0, b: 0, c: 0, ok: false };
    const K = Math.round(clamp(len / 14, 40, 160));
    const pts = [];
    const P0 = -band - 8, NP = 2 * band + 17;
    const prof = new Float32Array(NP);
    for (let k = 0; k < K; k++) {
      const t = 0.02 + 0.96 * k / (K - 1);
      const x = (t - 0.5) * len;
      const bx = ox + dx * x, by = oy + dy * x;
      for (let s = 0; s < NP; s++) {
        const off = P0 + s;
        let acc = 0, cnt = 0;
        for (let j = -2; j <= 2; j += 2) {
          const v = L(bx + nx * off + dx * j, by + ny * off + dy * j);
          if (v >= 0) { acc += v; cnt++; }
        }
        prof[s] = cnt ? acc / cnt : -1;
      }
      // candidatos a borde de la hoja: claro adentro y oscuro afuera, también bastante más afuera (así no cuentan
      // las rayas impresas ni el borde de una letra). Se guardan los 4 mejores de cada perfil.
      const cands = [];
      for (let s = 13; s < NP - 3; s++) {
        const inn = prof[s + 2], o1 = prof[s - 2];
        if (inn < 0 || o1 < 0) continue;
        const o2 = prof[s - 6], o3 = prof[s - 12];
        let sc = inn - o1;
        if (o2 >= 0) sc = Math.min(sc, inn - o2);
        if (o3 >= 0) sc = Math.min(sc, inn - o3);
        if (sc < 6) continue;
        const l = cands[cands.length - 1];
        if (l && s - l.s <= 2) { if (sc > l.sc) { l.s = s; l.sc = sc; } continue; }
        cands.push({ s, sc });
      }
      cands.sort((p, q) => q.sc - p.sc);
      for (const cd of cands.slice(0, 4)) {
        // posición del borde con fracción de píxel: máximo de la derivada (parábola)
        let ms = cd.s, mv = -Infinity;
        for (let s = cd.s - 3; s <= cd.s + 3; s++) {
          if (s < 1 || s >= NP - 1 || prof[s - 1] < 0 || prof[s + 1] < 0) continue;
          const dv = prof[s + 1] - prof[s - 1];
          if (dv > mv) { mv = dv; ms = s; }
        }
        let sub = 0;
        if (ms > 1 && ms < NP - 2 && prof[ms - 2] >= 0 && prof[ms + 2] >= 0) {
          const dm = prof[ms] - prof[ms - 2], dp = prof[ms + 2] - prof[ms], den = dm - 2 * mv + dp;
          if (den < 0) sub = clamp(0.5 * (dm - dp) / den, -0.5, 0.5);
        }
        pts.push({ k, u: x / hl, y: P0 + ms + sub, w0: Math.min(1, cd.sc / 30) });
      }
    }
    // El borde de la hoja es el que sigue de punta a punta del lado (una curva suave): se busca con RANSAC entre
    // todos los candidatos y después se ajusta fino, con un solo punto por perfil.
    const sel = ransacEdge(pts, K);
    if (sel.length < Math.max(12, K * 0.35)) return side;
    const line = robustFit(sel, false);
    const curve = robustFit(sel, true);
    let fit = line;
    // se usa la curva solo si la hoja está curvada de verdad (flecha clara y ajuste mucho mejor que la recta)
    if (curve && (!line || (Math.abs(curve.c) > Math.max(2, 0.004 * len) && Math.abs(curve.c) < 0.06 * len &&
        curve.sigma < line.sigma * 0.8 && curve.inliers >= 0.6))) fit = curve;
    if (fit && fit.inliers >= 0.5 && Math.abs(fit.a) <= band + 2) {
      side.a = fit.a; side.b = fit.b; side.c = fit.c; side.ok = true;
    }
    return side;
  }

  // Punto del borde s a la distancia x (a lo largo del lado) y distancia con signo de p al borde s.
  const sidePoint = (s, x) => { const u = x / s.hl, y = s.a + s.b * u + s.c * u * u; return { x: s.ox + s.dx * x + s.nx * y, y: s.oy + s.dy * x + s.ny * y }; };
  const sideDist = (s, p) => {
    const rx = p.x - s.ox, ry = p.y - s.oy, u = (rx * s.dx + ry * s.dy) / s.hl;
    return rx * s.nx + ry * s.ny - (s.a + s.b * u + s.c * u * u);
  };
  // Esquinas = cruce de cada borde con el siguiente (rectas o curvas), por Newton.
  function sideCorners(sides) {
    const corners = [];
    for (let i = 0; i < 4; i++) {
      const s1 = sides[(i + 3) % 4], s2 = sides[i];           // la esquina i es el final del lado i-1 y el comienzo del lado i
      let x = s1.hl;
      for (let it = 0; it < 25; it++) {
        const f = sideDist(s2, sidePoint(s1, x)), f2 = sideDist(s2, sidePoint(s1, x + 0.5));
        const der = (f2 - f) / 0.5;
        if (!der) break;
        const step = clamp(f / der, -s1.hl * 0.2, s1.hl * 0.2);
        x -= step;
        if (Math.abs(step) < 0.01) break;
      }
      corners.push(sidePoint(s1, x));
    }
    return corners;
  }

  // Mide de nuevo los 4 lados del cuadrilátero aproximado en la foto grande (2 pasadas: la segunda parte de las
  // esquinas ya corregidas, así una hoja curvada queda bien medida hasta las puntas). Devuelve
  // {quad, sides, refined, P}: P(side, x) da los puntos de cada borde (para aplanar la hoja en warp).
  function refineQuad(img, quad, opts) {
    opts = opts || {};
    const w = img.width, h = img.height;
    const L = lumSampler(img);
    const diag = Math.max(dist(quad[0], quad[2]), dist(quad[1], quad[3]));
    const band1 = Math.round(clamp(opts.band || diag * 0.02, 6, 70));
    const inset = opts.inset != null ? opts.inset : clamp(diag * 0.0022, 1.5, 9);
    const cx = quad.reduce((s, p) => s + p.x, 0) / 4, cy = quad.reduce((s, p) => s + p.y, 0) / 4;
    let cur = quad, sides = null, maxBow = 0, ok = false;
    for (let pass = 0; pass < 2; pass++) {
      const band = pass === 0 ? band1 : Math.round(clamp(Math.max(diag * 0.012, maxBow * 1.3 + 8), 6, 90));
      const ss = [0, 1, 2, 3].map((i) => {
        const A = cur[i], B = cur[(i + 1) % 4];
        const s = measureSide(L, A, B, cx, cy, band);
        // lado pegado al borde de la foto (la hoja sigue afuera del cuadro): queda donde está
        const e = Math.max(4, 0.012 * Math.max(w, h));
        if ((A.x < e && B.x < e) || (A.y < e && B.y < e) || (A.x > w - 1 - e && B.x > w - 1 - e) || (A.y > h - 1 - e && B.y > h - 1 - e)) {
          s.a = s.b = s.c = 0; s.ok = true;
        }
        return s;
      });
      const good = ss.filter((s) => s.ok).length;
      if (good < 3) break;                                     // no se ve bien el borde: queda lo anterior
      const corners = sideCorners(ss);
      if (corners.some((p) => !isFinite(p.x) || !isFinite(p.y))) break;
      sides = ss; ok = true;
      maxBow = Math.max(...ss.map((s) => Math.abs(s.c)));
      const moved = Math.max(...corners.map((p, i) => dist(p, cur[i])));
      cur = corners;
      if (!maxBow && moved < band * 0.35) break;               // recto y ya en su lugar: no hace falta otra pasada
    }
    // seguridad: si algo salió raro, se queda el cuadrilátero aproximado (corrido apenas hacia adentro)
    // (una esquina tapada por un dedo puede corregirse bastante: se tolera hasta 8 % de la diagonal)
    const tol = Math.max(band1 * 1.6, 0.08 * diag, maxBow * 2.5);
    let final = null;
    if (ok) {
      sides.forEach((s) => { s.a += inset; });               // un pelito hacia adentro: que no quede ni una raya del fondo
      final = sideCorners(sides);
      const ar = polyArea(final) / Math.max(1, polyArea(quad));
      if (final.some((p, i) => !isFinite(p.x) || !isFinite(p.y) || dist(p, quad[i]) > tol) || ar < 0.8 || ar > 1.25 ||
          !rectShape(final, w * 0.3, h * 0.3)) final = null;
    }
    if (!final) {
      const q = quad.map((p) => { const d = Math.max(1, dist(p, { x: cx, y: cy })); return { x: p.x + (cx - p.x) * inset / d, y: p.y + (cy - p.y) * inset / d }; });
      return { quad: q, sides: null, refined: false };
    }
    return { quad: final, sides, refined: true, P: sidePoint };
  }

  // ---------- 6) Enderezado ----------
  // Homografía que lleva (u,v) del primer cuadrilátero a (x,y) del segundo.
  function homography(dst, src) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const u = dst[i].x, v = dst[i].y, x = src[i].x, y = src[i].y;
      A.push([u, v, 1, 0, 0, 0, -x * u, -x * v]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -y * u, -y * v]); b.push(y);
    }
    return solve(A, b);
  }
  const applyH = (H, u, v) => { const d = H[6] * u + H[7] * v + 1; return { x: (H[0] * u + H[1] * v + H[2]) / d, y: (H[3] * u + H[4] * v + H[5]) / d }; };

  // Proporción real (ancho/alto) de la hoja a partir de la perspectiva (método de Zhang y He), suponiendo la
  // distancia focal típica de un celular. Si queda cerca de remito / A4 / oficio, se usa esa medida exacta.
  function aspectRatio(quad, w, h) {
    const [TL, TR, BR, BL] = quad;
    const simple = (dist(TL, TR) + dist(BL, BR)) / (dist(TL, BL) + dist(TR, BR));
    let r = simple;
    const f = 0.75 * Math.max(w, h), u0 = w / 2, v0 = h / 2;
    const m = (p) => [p.x - u0, p.y - v0, 1];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const m1 = m(TL), m2 = m(TR), m3 = m(BL), m4 = m(BR);
    const c14 = cross(m1, m4);
    const k2 = dot(c14, m3) / dot(cross(m2, m4), m3), k3 = dot(c14, m2) / dot(cross(m3, m4), m2);
    const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
    const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
    const num = (n2[0] * n2[0] + n2[1] * n2[1]) / (f * f) + n2[2] * n2[2];
    const den = (n3[0] * n3[0] + n3[1] * n3[1]) / (f * f) + n3[2] * n3[2];
    if (isFinite(num) && isFinite(den) && den > 0) {
      const est = Math.sqrt(num / den);
      if (isFinite(est) && est > 0.3 && est < 3.3 && Math.abs(Math.log(est / simple)) < 0.35) r = est;
    }
    // se ajusta a una medida conocida si está cerca (en vertical o en apaisado)
    const land = r > 1, rp = land ? 1 / r : r;
    let out = clamp(rp, 0.45, 1);
    for (const [k, tol] of KNOWN_RATIOS) if (Math.abs(Math.log(rp / k)) < tol) { out = k; break; }
    return land ? 1 / out : out;
  }

  // Desplazamiento de un borde curvo, medido en la hoja ya enderezada: e(t) = k·4t(1-t). Devuelve k.
  function bowAmount(Hinv, side, P, xa, xb, axis, target, span) {
    if (!side || !side.c) return 0;
    let num = 0, den = 0;
    for (let i = 1; i < 16; i++) {
      const x = xa + (xb - xa) * i / 16;
      const p = P(side, x), q = applyH(Hinv, p.x, p.y);
      const t = clamp((axis === "v" ? q.x : q.y) / span, 0, 1), g = 4 * t * (1 - t);   // posición a lo largo del lado
      num += g * ((axis === "v" ? q.y : q.x) - target); den += g * g;
    }
    return den ? num / den : 0;
  }

  // Endereza el cuadrilátero quad=[TL,TR,BR,BL] (coordenadas de img) a un rectángulo.
  // opts.ratio: proporción ancho/alto (si no, se estima). opts.refined: resultado de refineQuad (aplana bordes curvos).
  function warp(img, quad, maxSide, opts) {
    opts = opts || {};
    const [TL, TR, BR, BL] = quad;
    const ratio = opts.ratio || aspectRatio(quad, img.width, img.height);
    const mw = Math.max(dist(TL, TR), dist(BL, BR)), mh = Math.max(dist(TL, BL), dist(TR, BR));
    let outW, outH;
    if (ratio <= 1) { outH = Math.max(mh, mw / ratio); outW = outH * ratio; }
    else { outW = Math.max(mw, mh * ratio); outH = outW / ratio; }
    const s = Math.min(1, (maxSide || 2200) / Math.max(outW, outH));
    outW = Math.max(2, Math.round(outW * s));
    outH = Math.max(2, Math.round(outH * s));
    const Wm = outW - 1, Hm = outH - 1;
    const rect = [{ x: 0, y: 0 }, { x: Wm, y: 0 }, { x: Wm, y: Hm }, { x: 0, y: Hm }];
    const H = homography(rect, quad);

    // bordes curvos: cuánto se arquea cada lado, medido en la hoja enderezada
    let kT = 0, kB = 0, kL = 0, kR = 0;
    const rf = opts.refined;
    if (rf && rf.sides && rf.P) {
      const Hinv = homography(quad, rect);
      const xOf = (sd, p) => (p.x - sd.ox) * sd.dx + (p.y - sd.oy) * sd.dy;
      const S = rf.sides;
      kT = bowAmount(Hinv, S[0], rf.P, xOf(S[0], TL), xOf(S[0], TR), "v", 0, Wm);
      kR = bowAmount(Hinv, S[1], rf.P, xOf(S[1], TR), xOf(S[1], BR), "u", Wm, Hm);
      kB = bowAmount(Hinv, S[2], rf.P, xOf(S[2], BR), xOf(S[2], BL), "v", Hm, Wm);
      kL = bowAmount(Hinv, S[3], rf.P, xOf(S[3], BL), xOf(S[3], TL), "u", 0, Hm);
      const capV = 0.05 * outH, capU = 0.05 * outW;
      kT = clamp(kT, -capV, capV); kB = clamp(kB, -capV, capV); kL = clamp(kL, -capU, capU); kR = clamp(kR, -capU, capU);
    }
    const bowed = kT || kB || kL || kR;
    // el lado derecho e inferior se recorren al revés (de BR a BL, de BL a TL): t va de 1 a 0
    const eT = new Float32Array(outW), eB = new Float32Array(outW), eL = new Float32Array(outH), eR = new Float32Array(outH);
    if (bowed) {
      for (let u = 0; u < outW; u++) { const t = u / Wm, g = 4 * t * (1 - t); eT[u] = kT * g; eB[u] = kB * g; }
      for (let v = 0; v < outH; v++) { const t = v / Hm, g = 4 * t * (1 - t); eL[v] = kL * g; eR[v] = kR * g; }
    }

    const sw = img.width, sh = img.height, sd = img.data;
    const out = new Uint8ClampedArray(outW * outH * 4);
    for (let v = 0; v < outH; v++) {
      const fv = v / Hm;
      for (let u = 0; u < outW; u++) {
        let uu = u, vv = v;
        if (bowed) {
          const fu = u / Wm;
          vv = v + (1 - fv) * eT[u] + fv * eB[u];
          uu = u + (1 - fu) * eL[v] + fu * eR[v];
        }
        const den = H[6] * uu + H[7] * vv + 1;
        let sx = (H[0] * uu + H[1] * vv + H[2]) / den;
        let sy = (H[3] * uu + H[4] * vv + H[5]) / den;
        const o = (v * outW + u) * 4;
        if (sx < -1.5 || sy < -1.5 || sx > sw + 0.5 || sy > sh + 0.5) {   // fuera de la foto: papel en blanco
          out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 255;
          continue;
        }
        sx = sx < 0 ? 0 : sx > sw - 1.001 ? sw - 1.001 : sx;
        sy = sy < 0 ? 0 : sy > sh - 1.001 ? sh - 1.001 : sy;
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        out[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
        out[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
        out[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
        out[o + 3] = 255;
      }
    }
    return { data: out, width: outW, height: outH, bow: { top: kT, right: kR, bottom: kB, left: kL }, ratio };
  }

  // Todo junto, sobre la foto grande: ajuste fino de los bordes + enderezado (+ aplanado si la hoja está curvada).
  // quad: esquinas aproximadas en coordenadas de img (por ejemplo, las de detectPaper escaladas).
  function process(img, quad, maxSide) {
    const rf = refineQuad(img, quad);
    const ratio = aspectRatio(rf.quad, img.width, img.height);
    const out = warp(img, rf.quad, maxSide, { ratio, refined: rf });
    return { img: out, quad: rf.quad, info: { refined: rf.refined, ratio: Math.round(ratio * 1000) / 1000, bow: out.bow } };
  }

  const api = { detectPaper, refineQuad, warp, process, aspectRatio, PAGE_RATIO };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Crop = api;
})(typeof self !== "undefined" ? self : this);
