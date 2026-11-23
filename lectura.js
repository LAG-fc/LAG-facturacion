// lectura.js — Lectura de las cantidades con el iPhone (v8.4; v8.5: solo la columna CANTIDAD del remito de LAG).
// Funciones puras (sin pantalla), probadas en Node con fotos reales de remitos.
//
// El iPhone reconoce muy bien la letra a mano ("Texto en vivo"), pero una página web no puede usar ese
// reconocimiento directamente. El camino es:
//   1) la página arma una "hoja de lectura": de cada remito toma los renglones de la tabla que tienen algo escrito,
//      los pone uno debajo del otro y les agrega una etiqueta impresa ("HOJA 1", "R03 =");
//   2) la comparte con el Atajo "LAG Cantidades" del iPhone, que usa "Extraer texto de la imagen" y copia el texto;
//   3) la página lee ese texto (parse), saca la cantidad y la descripción de cada renglón y busca el producto (match).
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- renglones de la tabla en la foto
  function otsu(g) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = -1, thr = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = g.length - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = i; }
    }
    return thr;
  }

  // Busca las líneas horizontales impresas de la tabla del remito y devuelve los renglones (en fracciones de la foto):
  // { x0, x1, rows: [{ y0, y1 }], vlines: [x...], thr } o null si no encuentra una tabla con renglones parejos.
  function findRows(g, w, h) {
    const thr = Math.max(90, Math.min(205, otsu(g) - 10));
    const minRun = 0.33 * w, gapOk = Math.max(2, Math.round(w * 0.004));
    // Las fotos nunca quedan perfectamente derechas: se "engrosa" la tinta unos píxeles hacia arriba y hacia abajo
    // para que una línea apenas inclinada siga viéndose continua.
    const band = Math.max(2, Math.round(h * 0.004));
    const dark = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) dark[i] = g[i] < thr ? 1 : 0;
    const flags = [];                                  // por cada y: {s, e} del tramo oscuro más largo (con huecos chicos)
    const acc = new Uint8Array(w);
    for (let y = 0; y < h; y++) {
      acc.fill(0);
      for (let yy = Math.max(0, y - band); yy <= Math.min(h - 1, y + band); yy++) { const o = yy * w; for (let x = 0; x < w; x++) if (dark[o + x]) acc[x] = 1; }
      let best = 0, bs = 0, be = 0, s = -1, last = -1;
      for (let x = 0; x < w; x++) {
        if (acc[x]) {
          if (s < 0 || x - last > gapOk) s = x;
          last = x;
          if (last - s > best) { best = last - s; bs = s; be = last; }
        }
      }
      flags.push(best >= minRun ? { s: bs, e: be } : null);
    }
    const lines = [];
    for (let y = 0; y < h; y++) {
      if (!flags[y]) continue;
      let y2 = y, s = flags[y].s, e = flags[y].e;
      while (y2 + 1 < h && flags[y2 + 1]) { y2++; s = Math.min(s, flags[y2].s); e = Math.max(e, flags[y2].e); }
      const c = (y + y2) / 2, t0 = Math.min(c, y + band), t1 = Math.max(c, y2 - band);   // sin el engrosado
      if (t1 - t0 < h * 0.02) lines.push({ y: c, t0, t1, s, e });                      // más gruesa que eso no es una línea
      y = y2;
    }
    if (lines.length < 3) return null;
    // la secuencia más larga de líneas con separación pareja (se tolera una línea que no se vio)
    const minGap = h * 0.012, maxGap = h * 0.12;
    let best = null;
    for (let i = 0; i < lines.length - 1; i++) {
      for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
        const base = lines[j].y - lines[i].y;
        if (base < minGap || base > maxGap) continue;
        const chain = [lines[i], lines[j]];
        let k = j, prev = lines[j];
        while (true) {
          let next = null, virt = false;
          for (let m = k + 1; m < lines.length; m++) {
            const d = lines[m].y - prev.y;
            if (d < base * 0.72) continue;
            if (d <= base * 1.3) { next = lines[m]; k = m; break; }
            if (d >= base * 1.7 && d <= base * 2.3) { next = lines[m]; k = m; virt = true; break; }
            break;
          }
          if (!next) break;
          if (virt) chain.push({ y: (prev.y + next.y) / 2, t0: (prev.y + next.y) / 2, t1: (prev.y + next.y) / 2, s: next.s, e: next.e, virtual: true });
          chain.push(next); prev = next;
        }
        if (chain.length >= 4 && (!best || chain.length > best.length)) best = chain;
      }
    }
    if (!best) return null;
    const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
    const real = best.filter((l) => !l.virtual);
    const x0 = Math.max(0, med(real.map((l) => l.s)) - w * 0.012), x1 = Math.min(w - 1, med(real.map((l) => l.e)) + w * 0.012);
    if (x1 - x0 < w * 0.3) return null;
    // líneas verticales de la tabla (separan columnas): se borran de la hoja de lectura para que no parezcan un "1"
    const yTop = Math.round(best[0].y), yBot = Math.round(best[best.length - 1].y), H = Math.max(1, yBot - yTop);
    const vlines = [];
    const hb = Math.max(2, Math.round(w * 0.003));
    for (let x = Math.max(0, Math.round(x0)); x <= Math.min(w - 1, Math.round(x1)); x++) {
      let n = 0;
      for (let y = yTop; y < yBot; y++) { const o = y * w; for (let xx = Math.max(0, x - hb); xx <= Math.min(w - 1, x + hb); xx++) if (dark[o + xx]) { n++; break; } }
      if (n / H >= 0.6) { if (vlines.length && x - vlines[vlines.length - 1].x1 <= 2) vlines[vlines.length - 1].x1 = x; else vlines.push({ x0: x, x1: x }); }
    }
    const rows = [];
    for (let i = 0; i < best.length - 1; i++) {
      const a = best[i], b = best[i + 1];
      rows.push({ y0: (a.t1 + 2) / h, y1: (b.t0 - 1) / h });
    }
    return { x0: x0 / w, x1: x1 / w, rows, vlines: vlines.map((v) => ({ x0: (v.x0 - 1) / w, x1: (v.x1 + 1) / w })), thr };
  }

  // ---------------------------------------------------------------- remito de LAG (formulario impreso)
  // El remito tiene una tabla con la columna CANTIDAD (a la izquierda, escrita a mano) y la columna DETALLE con los
  // 18 productos ya impresos, siempre en el mismo orden. La fila alcanza para saber el producto. Las anotaciones de
  // la derecha ("Unidad 60", "64 bolsas", "OC 93034") no se leen.
  const FILAS_REMITO = ["PAN MIGNON BLANCO", "PAN MIGNON DE SALVADO", "PAN FRANCES", "PAN MIGNON BLANCO SIN SAL",
    "PAN DE SALVADO SIN SAL", "FIGACITAS DE MANTECA", "LIBRITOS DE GRASA", "BIZCOCHUELO DE VAINILLA 50 X 80",
    "MEDIALUNAS DE MANTECA", "MEDIALUNAS PARA RELLENAR", "PAN DE HAMBURGUESA", "PEBETE", "SANDWICH DE MIGA TRIPLE",
    "PIONONO", "PREPIZZA", "PAN ARABE", "PAN DE MOLDE CON SEMILLA", "PAN CIABATTA"];

  // Línea vertical más larga (tolerando una leve inclinación) con x entre xa y xb. {x (en y = yc), m (dx/dy), y0, y1, len}
  function longestVertical(dark, w, h, xa, xb, ya, yb, yc) {
    const gap = Math.max(4, Math.round(h * 0.006));
    let best = null;
    for (let mi = -6; mi <= 6; mi++) {
      const m = mi * 0.004;                                 // hasta ±1,4°
      for (let xr = Math.round(xa); xr <= Math.round(xb); xr++) {
        let s = -1, last = -1, bl = 0, b0 = 0, b1 = 0;
        for (let y = ya; y < yb; y++) {
          const x = Math.round(xr + m * (y - yc));
          if (x < 1 || x >= w - 1) continue;
          const o = y * w;
          if (dark[o + x] || dark[o + x - 1] || dark[o + x + 1]) {
            if (s < 0 || y - last > gap) s = y;
            last = y;
            if (last - s > bl) { bl = last - s; b0 = s; b1 = last; }
          }
        }
        if (!best || bl > best.len) best = { x: xr, m, y0: b0, y1: b1, len: bl };
      }
    }
    return best;
  }

  // Busca la tabla del remito de LAG. Devuelve { angle, x0, xSep, rows: [19 × { y0, y1 }] } en fracciones de la foto
  // (rows[0] = PAN MIGNON BLANCO … rows[17] = PAN CIABATTA, rows[18] = el renglón vacío del final), o null.
  // El cuerpo de la tabla tiene siempre 19 renglones iguales: se cuentan desde el borde de abajo (que es firme) y cada
  // división se ajusta a la línea punteada más cercana. Así no importa si alguna punteada casi no se ve.
  const BODY_ROWS = 19;
  function findTable(g, w, h) {
    const ots = otsu(g), thr = Math.max(90, Math.min(215, ots - 6)), thr2 = Math.max(thr, Math.min(225, ots + 50));
    const dark = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) dark[i] = g[i] < thr ? 1 : 0;
    const yc = h / 2;
    // 1) la línea que separa CANTIDAD de DETALLE: vertical, larga (no toda la hoja) y en el tercio izquierdo
    const sep = longestVertical(dark, w, h, w * 0.1, w * 0.45, Math.round(h * 0.15), Math.round(h * 0.97), yc);
    if (!sep || sep.len < h * 0.2 || sep.len > h * 0.8) return null;
    const angle = Math.atan(sep.m);
    const xs = sep.x + sep.m * (sep.y0 + sep.y1 - 2 * yc) / 2;           // x de la separación a media altura
    // 2) borde izquierdo de la tabla: otra vertical, con la misma inclinación, a la izquierda
    let x0 = null;
    for (let xr = Math.round(sep.x - w * 0.04); xr >= 2; xr--) {
      let n = 0, tot = 0;
      for (let y = sep.y0; y <= sep.y1; y++) {
        const x = Math.round(xr + sep.m * (y - yc)); if (x < 1 || x >= w - 1) continue;
        tot++; const o = y * w; if (dark[o + x] || dark[o + x - 1] || dark[o + x + 1]) n++;
      }
      if (tot && n / tot >= 0.7) { x0 = xr + sep.m * (sep.y0 + sep.y1 - 2 * yc) / 2; break; }
    }
    const xL = x0 !== null ? x0 : Math.max(0, xs - w * 0.18), xR = Math.min(w - 2, xs + (w - xs) * 0.92);
    // 3) perfil de líneas horizontales (con la inclinación de la hoja): punteadas (umbral claro) y firmes (umbral oscuro)
    const NB = 32;
    let hs = -sep.m;
    const binHit = (y, xa, xb, t) => {
      for (let x = xa; x < xb; x++) { const yy = Math.round(y + hs * (x - xs)); for (let d = -1; d <= 1; d++) { const q = yy + d; if (q >= 0 && q < h && g[q * w + x] < t) return 1; } }
      return 0;
    };
    const cover = (y, t) => {
      let c = 0, cl = 0;
      for (let b = 0; b < NB; b++) c += binHit(y, Math.round(xs + 3 + (xR - xs - 3) * b / NB), Math.round(xs + 3 + (xR - xs - 3) * (b + 1) / NB), t);
      for (let b = 0; b < 6; b++) cl += binHit(y, Math.round(xL + 3 + (xs - xL - 6) * b / 6), Math.round(xL + 3 + (xs - xL - 6) * (b + 1) / 6), t);
      return cl >= 3 ? c : 0;
    };
    const u0 = (sep.y1 - sep.y0) / (BODY_ROWS + 1);
    const ya = Math.max(1, Math.round(sep.y0 - 2 * u0)), yb = Math.min(h - 2, Math.round(sep.y1 + u0));
    // la inclinación de las horizontales se mide aparte (la hoja escaneada puede estar apenas deformada): se elige
    // la que deja las líneas más "afiladas" en el perfil
    {
      let bestS = -1, bestH = hs;
      for (let k = -10; k <= 10; k++) {
        const cand = k * 0.002; hs = cand;
        let sc = 0;
        for (let y = ya; y <= yb; y += 1) {
          let c = 0;
          for (let b = 0; b < NB; b += 2) c += binHit(y, Math.round(xs + 3 + (xR - xs - 3) * b / NB), Math.round(xs + 3 + (xR - xs - 3) * (b + 1) / NB), thr2);
          sc += c * c * c;
        }
        if (sc > bestS) { bestS = sc; bestH = cand; }
      }
      hs = bestH;
    }
    const prof = [];
    for (let y = ya; y <= yb; y++) prof.push(cover(y, thr2));
    const peaks = [];
    const win = Math.max(2, Math.round(u0 * 0.35));
    for (let i = 0; i < prof.length; i++) {
      if (prof[i] < NB * 0.4) continue;
      let isMax = true, lo1 = prof[i], lo2 = prof[i];
      for (let j = Math.max(0, i - win); j <= Math.min(prof.length - 1, i + win); j++) {
        if (prof[j] > prof[i] || (prof[j] === prof[i] && j < i)) { isMax = false; break; }
        if (j < i) lo1 = Math.min(lo1, prof[j]); else lo2 = Math.min(lo2, prof[j]);
      }
      // tiene que sobresalir de lo que la rodea (el texto impreso da una meseta, no un pico)
      if (isMax && prof[i] - Math.max(lo1, lo2) >= NB * 0.18) peaks.push(ya + i);
    }
    // 4) borde de abajo: la línea firme más marcada cerca del final de la separación
    let B = sep.y1, bestC = -1;
    for (let y = Math.round(sep.y1 - u0 * 0.6); y <= Math.round(sep.y1 + u0 * 0.6); y++) { if (y < 1 || y >= h - 1) continue; const c = cover(y, thr); if (c > bestC) { bestC = c; B = y; } }
    // 5) alto de renglón: la periodicidad del perfil de líneas dentro del cuerpo (autocorrelación, usa todas las
    //    punteadas a la vez, aunque algunas casi no se vean) y después el ajuste fino con los picos.
    const segA = Math.max(ya, Math.round(B - (BODY_ROWS + 0.5) * u0)), segB = Math.min(yb, Math.round(B - 0.4 * u0));
    const seg = []; for (let y = segA; y <= segB; y++) seg.push(prof[y - ya]);
    const mean = seg.reduce((p, q) => p + q, 0) / Math.max(1, seg.length);
    const z = seg.map((v) => v - mean);
    const ac = (lag) => { let sm = 0, n = 0; for (let i = 0; i + lag < z.length; i++) { sm += z[i] * z[i + lag]; n++; } return n ? sm / n : 0; };
    let uAc = u0, bestAc = -Infinity;
    for (let lag = Math.floor(u0 * 0.82); lag <= Math.ceil(u0 * 1.15); lag++) {
      const v = ac(lag) + 0.7 * ac(2 * lag) + 0.5 * ac(3 * lag);
      if (v > bestAc) { bestAc = v; uAc = lag; }
    }
    { const f = (l) => ac(l) + 0.7 * ac(2 * l) + 0.5 * ac(3 * l), c = f(uAc), lft = f(uAc - 1), rgt = f(uAc + 1), den = lft - 2 * c + rgt;
      if (den < 0) uAc += Math.max(-0.5, Math.min(0.5, 0.5 * (lft - rgt) / den)); }
    const sig = (u) => 0.12 * u;
    let best = { u: uAc, score: -1, lineScore: 0 };
    for (let u = uAc * 0.97; u <= uAc * 1.03; u += uAc * 0.001) {
      let sc = 0;
      peaks.forEach((p) => { const k = Math.round((B - p) / u); if (k < 1 || k > BODY_ROWS) return; const d = p - (B - k * u); sc += Math.exp(-(d * d) / (2 * sig(u) * sig(u))); });
      if (sc > best.score) best = { u, score: sc, lineScore: sc };
    }
    const u = best.u;
    if (best.lineScore < 4) return null;                                     // no parece el remito de LAG
    if (sep.y0 > B - (BODY_ROWS - 3) * u) return null;                       // la separación es demasiado corta
    const bnd = [];
    let snapped = 0;
    for (let k = 0; k <= BODY_ROWS; k++) {
      const e = B - k * u;
      let snap = e, dmin = u * 0.25;
      peaks.forEach((p) => { if (Math.abs(p - e) < dmin) { dmin = Math.abs(p - e); snap = p; } });
      if (k > 0 && snap !== e) snapped++;
      bnd.push(k === 0 ? B : snap);
    }
    // ¿es de verdad el remito de LAG? la mayoría de las líneas del cuerpo tienen que caer sobre la grilla de 19
    // renglones, y casi ninguna fuera de ella (otro formulario tendría renglones de otro alto)
    const inBody = peaks.filter((p) => p > B - BODY_ROWS * u + u * 0.3 && p < B - u * 0.3);
    const offGrid = inBody.filter((p) => { const k = Math.round((B - p) / u); return Math.abs(p - (B - k * u)) > u * 0.22; }).length;
    if (snapped < 9 || offGrid > Math.max(1, inBody.length * 0.25)) return null;
    const rows = [], dy = hs * ((xL + xs) / 2 - xs);                         // las y se miden en la separación: se pasan
    for (let i = 0; i < BODY_ROWS; i++) {                                     // al centro de la columna CANTIDAD
      const top = bnd[BODY_ROWS - i] + dy, bot = bnd[BODY_ROWS - i - 1] + dy;
      rows.push({ y0: (top + 2) / h, y1: (bot - 2) / h });
    }
    return { angle, slope: hs, thr, x0: xL / w, xSep: xs / w, rows, unit: u / h, score: best.score, lineScore: best.lineScore, snapped, offGrid, lines: bnd.map((y) => (y + dy) / h) };
  }

  // Proporción de tinta dentro de un rectángulo (en píxeles), sin contar las líneas verticales.
  function inkRatio(g, w, h, r, vlines, thr) {
    const x0 = Math.max(0, Math.round(r.x0)), x1 = Math.min(w - 1, Math.round(r.x1));
    const y0 = Math.max(0, Math.round(r.y0)), y1 = Math.min(h - 1, Math.round(r.y1));
    const skip = new Uint8Array(w);
    (vlines || []).forEach((v) => { for (let x = Math.max(0, Math.floor(v.x0 * w) - 2); x <= Math.min(w - 1, Math.ceil(v.x1 * w) + 2); x++) skip[x] = 1; });
    let n = 0, tot = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { if (skip[x]) continue; tot++; if (g[y * w + x] < thr) n++; }
    return tot ? n / tot : 0;
  }

  // ---------------------------------------------------------------- texto que devuelve el iPhone
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
  const FIX = { O: "0", o: "0", D: "0", I: "1", l: "1", "|": "1", i: "1", S: "5", s: "5", B: "8", Z: "2", z: "2", g: "9", q: "9" };
  // Un "número" que el reconocedor pudo confundir con letras parecidas (l2O → 120). Tiene que tener algún dígito real.
  const digitish = (t) => /\d/.test(t) && t.length <= 9 && /^[0-9OoDIil|SsBZzgq.,]+$/.test(t);

  // Número con formato argentino: 12 · 12,5 · 12.5 · 1.250 (= mil doscientos cincuenta) · 1.250,5
  function parseNumber(s) {
    s = String(s).replace(/\s+/g, "");
    if (!s || !/^[0-9.,]+$/.test(s)) return null;
    s = s.replace(/^[.,]+|[.,]+$/g, "");
    const hasC = s.includes(","), hasD = s.includes(".");
    if (hasC && hasD) {
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
      else s = s.replace(/,/g, "");
    } else if (hasC) {
      s = (s.match(/,/g) || []).length > 1 ? s.replace(/,/g, "") : s.replace(",", ".");
    } else if (hasD) {
      const parts = s.split(".");
      if (parts.length > 2 || (parts[1].length === 3 && parts[0] !== "" && parts[0] !== "0")) s = parts.join("");
    }
    const v = Number(s);
    return isFinite(v) && v >= 0 ? v : null;
  }
  const fmt = (v) => String(Math.round(v * 1000) / 1000).replace(".", ",");
  const UNITS = /^(KG|KGS|KILO|KILOS|K|U|UN|UNI|UNID|UNIDS|UNIDADES|DOC|DOCENA|DOCENAS|BOLSA|BOLSAS|CAJA|CAJAS|PAQ|BULTO|BULTOS)$/;

  // Separa cantidad y descripción de un renglón ("120 Pan mignon blanco", "l2O kg medialunas").
  function splitRow(text) {
    const toks = String(text || "").trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      let t = toks[i].replace(/^[^0-9A-Za-z|]+|[^0-9A-Za-z|.,]+$/g, "");
      if (!t) continue;
      if (/^O\.?C\.?$/i.test(t)) return { oc: true, qty: null, desc: toks.join(" ") };       // "OC 93035": no es una cantidad
      if (digitish(t)) {
        const fixed = t.replace(/[OoDIil|SsBZzgq]/g, (c) => FIX[c]);
        const v = parseNumber(fixed);
        if (v !== null) {
          let desc = toks.slice(i + 1).filter((x, k) => !(k === 0 && UNITS.test(norm(x)))).join(" ");
          desc = desc.replace(/\bO\.?\s*C\.?\s*[:#Nº°.]*\s*\d{3,}/gi, " ").replace(/\s+/g, " ").trim();
          const before = toks.slice(0, i).join(" ");
          return { qty: v, qtyText: fmt(v), desc: desc || before };
        }
      }
    }
    return { qty: null, desc: toks.join(" ") };
  }

  // Etiquetas de la hoja de lectura: "F01 =" (fila del remito de LAG: solo la cantidad) o "R01 =" (renglón completo).
  const LABEL = /^\s*([FRPE])\s*([0-9OoIl]{1,2})\s*[=:\-–—]?\s*(.*)$/;
  const HEAD = /^\s*H\s*[O0]\s*J\s*A\s*([0-9OoIl]{1,3})\b(.*)$/i;
  // En una celda de CANTIDAD: "509, 28" o "509 28" es 509,28 (el reconocedor a veces separa la coma)
  const joinDecimals = (t) => t.replace(/(\d)\s*([.,])\s+(\d)/g, "$1$2$3").replace(/^(\D*\d{1,4})\s+(\d{2})(?!\d)/, "$1,$2");
  const num = (s) => Number(String(s).replace(/[Oo]/g, "0").replace(/[Il]/g, "1"));

  // Interpreta el texto copiado por el Atajo. Devuelve [{hoja, renglon, qty, qtyText, desc, oc}]
  function parse(text) {
    const out = [];
    let hoja = 1, full = false, pending = null;
    String(text || "").split(/\r?\n/).forEach((raw) => {
      const line = raw.replace(/\s+/g, " ").trim();
      if (!line) return;
      const h = HEAD.exec(line);
      if (h) { hoja = num(h[1]); full = /COMPLETA/i.test(h[2]); pending = null; return; }
      const m = LABEL.exec(line);
      if (m) {
        const fila = m[1].toUpperCase() !== "R";
        const rest = (fila ? joinDecimals(m[3]) : m[3]).trim(), r = { hoja, renglon: num(m[2]), fila, raw: rest };
        Object.assign(r, splitRow(rest));
        out.push(r);
        pending = r.qty === null && !r.oc ? r : null;
        return;
      }
      if (pending) {                                   // el iPhone separó la etiqueta y el contenido en dos líneas
        const sp = splitRow(pending.fila ? joinDecimals(line) : line);
        if (sp.qty !== null || sp.oc) { Object.assign(pending, sp, { desc: [pending.desc, sp.desc].filter(Boolean).join(" "), raw: (pending.raw + " " + line).trim() }); pending = null; }
        else pending.desc = [pending.desc, line].filter(Boolean).join(" ");
        return;
      }
      if (full) {                                       // hoja sin tabla reconocida: se toma cada línea con un número
        const sp = splitRow(line);
        if (sp.qty !== null || sp.oc) out.push(Object.assign({ hoja, renglon: null, raw: line }, sp));
        return;
      }
      // texto suelto: se suma a la descripción del renglón anterior
      const prev = out[out.length - 1];
      if (prev && prev.hoja === hoja && !/^[FR]\s*\d/.test(line)) prev.desc = [prev.desc, line].filter(Boolean).join(" ");
    });
    return out.filter((r) => r.qty !== null || r.oc || r.desc);
  }

  // ---------------------------------------------------------------- producto según la descripción
  const STOP = new Set(["DE", "DEL", "LA", "EL", "LOS", "LAS", "X", "Y", "CON", "KG", "KGS", "KILO", "KILOS", "K", "U", "UN", "UNI", "UNID", "UNIDADES", "DOC", "DOCENA", "DOCENAS", "BOLSA", "BOLSAS", "CAJA", "CAJAS", "PAQ", "BULTO", "BULTOS"]);
  const toks = (s) => norm(s).split(" ").filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t));
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let lo = i;
      for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); lo = Math.min(lo, cur[j]); }
      if (lo > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  function sim(a, b) {
    if (a === b) return 1;
    if (a.length >= 3 && b.length >= 3 && (b.startsWith(a) || a.startsWith(b))) return 0.85;
    if (Math.min(a.length, b.length) >= 4 && lev(a, b, 1) <= 1) return 0.8;
    if (Math.min(a.length, b.length) >= 7 && lev(a, b, 2) <= 2) return 0.6;
    return 0;
  }
  // Devuelve { name, score, alts } ; name es null si no hay un producto claro.
  function match(desc, catalog, aliases) {
    const key = norm(desc);
    if (!key) return { name: null, score: 0, alts: [] };
    if (aliases && aliases[key] && catalog.includes(aliases[key])) return { name: aliases[key], score: 1, alts: [], alias: true };
    const dt = toks(desc);
    if (!dt.length) return { name: null, score: 0, alts: [] };
    const scored = catalog.map((name) => {
      const ct = toks(name);
      if (!ct.length) return { name, score: 0 };
      const rec = ct.reduce((s, c) => s + Math.max(...dt.map((d) => sim(d, c))), 0) / ct.length;
      const prec = dt.filter((d) => ct.some((c) => sim(d, c) >= 0.6)).length / dt.length;
      return { name, score: 0.6 * rec + 0.4 * prec };
    }).sort((a, b) => b.score - a.score);
    const [a, b] = scored;
    const alts = scored.filter((x) => x.score >= 0.45).slice(0, 4).map((x) => x.name);
    if (a && a.score >= 0.6 && (!b || a.score - b.score >= 0.08)) return { name: a.name, score: a.score, alts };
    return { name: null, score: a ? a.score : 0, alts };
  }

  const api = { findTable, findRows, inkRatio, otsu, parse, splitRow, match, norm, parseNumber, FILAS_REMITO };
  if (typeof module === "object" && module.exports) module.exports = api; else root.Lectura = api;
})(typeof self !== "undefined" ? self : this);
