// ocr.js — Lectura de texto con Google Cloud Vision + armado de filas (producto / cantidad)
// + cálculo de totales. La parte de "armado de filas" no depende del navegador.
(function (root) {
  "use strict";

  const VISION_URL = "https://vision.googleapis.com/v1/images:annotate";

  // ---------- Llamada a la API ----------
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
      fr.onerror = () => reject(new Error("No se pudo leer la imagen"));
      fr.readAsDataURL(blob);
    });
  }

  async function recognize(blob, apiKey) {
    const content = await blobToBase64(blob);
    const res = await fetch(VISION_URL + "?key=" + encodeURIComponent(apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          image: { content },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          imageContext: { languageHints: ["es"] }
        }]
      })
    });
    let json = {};
    try { json = await res.json(); } catch (e) { /* sin cuerpo */ }
    if (!res.ok) throw new Error((json.error && json.error.message) || ("Error HTTP " + res.status));
    const r = json.responses && json.responses[0];
    if (r && r.error) throw new Error(r.error.message || "Error de la API");
    return r || {};
  }

  // ---------- Palabras con posición y confianza ----------
  // Los vértices que devuelve Vision siguen la orientación del TEXTO (arriba-izq, arriba-der,
  // abajo-der, abajo-izq del renglón). Con eso se sabe si la foto está girada (0/90/180/270)
  // sin hacer otra consulta: se gira el texto "en papel" y se avisa cuánto girar la imagen.
  function detectRotation(raw) {
    const votes = [0, 0, 0, 0];
    for (const w of raw) {
      const v = w.v;
      if (v.length < 2) continue;
      const dx = v[1].x - v[0].x, dy = v[1].y - v[0].y;
      if (Math.hypot(dx, dy) < 4) continue;
      let ang = Math.atan2(dy, dx) * 180 / Math.PI;   // 0 = texto normal; 90 = el texto baja
      if (ang < 0) ang += 360;
      const k = Math.round(ang / 90) % 4;
      votes[k] += Math.min(12, w.text.length);          // las palabras largas pesan más
    }
    const total = votes.reduce((x, y) => x + y, 0);
    let best = 0;
    for (let k = 1; k < 4; k++) if (votes[k] > votes[best]) best = k;
    if (total < 30 || votes[best] < total * 0.5) return 0;
    return best * 90;
  }

  // Lleva un punto de la imagen girada a la imagen derecha (W,H = tamaño de la imagen original).
  function rotPoint(p, rot, W, H) {
    if (rot === 90) return { x: p.y, y: W - p.x };         // se gira 90° a la izquierda
    if (rot === 180) return { x: W - p.x, y: H - p.y };
    if (rot === 270) return { x: H - p.y, y: p.x };        // se gira 90° a la derecha
    return p;
  }

  function extractWords(resp, opts) {
    opts = opts || {};
    const page = resp && resp.fullTextAnnotation && resp.fullTextAnnotation.pages && resp.fullTextAnnotation.pages[0];
    if (!page) return { words: [], width: 0, height: 0, rotation: 0 };
    const raw = [];
    for (const b of page.blocks || []) {
      for (const p of b.paragraphs || []) {
        for (const wd of p.words || []) {
          const text = (wd.symbols || []).map((s) => s.text || "").join("");
          if (!text.trim()) continue;
          const v = ((wd.boundingBox && wd.boundingBox.vertices) || []).map((q) => ({ x: q.x || 0, y: q.y || 0 }));
          if (!v.length) continue;
          raw.push({ text, v, conf: typeof wd.confidence === "number" ? wd.confidence : 0.5 });
        }
      }
    }
    let W = page.width || 0, H = page.height || 0;
    if (!W || !H) {
      for (const w of raw) for (const q of w.v) { W = Math.max(W, q.x); H = Math.max(H, q.y); }
    }
    const rotation = opts.autoRotate === false ? 0 : detectRotation(raw);
    const words = [];
    for (const w of raw) {
      const v = rotation ? w.v.map((q) => rotPoint(q, rotation, W, H)) : w.v;
      const xs = v.map((q) => q.x), ys = v.map((q) => q.y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      words.push({
        text: w.text, x0, x1, y0, y1,
        cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, h: Math.max(1, y1 - y0), conf: w.conf
      });
    }
    const swap = rotation === 90 || rotation === 270;
    return { words, width: swap ? H : W, height: swap ? W : H, rotation };
  }

  // ---------- Utilidades de texto / números ----------
  const NUM_RE = /^(\d{1,4}(?:[.,]\d{1,3})?)(?:(kg|kgs|gr|grs|g|k|un|u|unid|unids|uds|ud|doc|docena)\.?)?$/i;

  function cleanTok(t) {
    return t.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "");
  }

  function parseQtyString(s) {
    s = String(s).trim();
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    else if (/^\d{1,3}\.\d{3}$/.test(s)) s = s.replace(".", "");   // 1.250 = mil doscientos cincuenta
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  // Cantidad escrita a mano por el usuario: "12", "2,5", "2.5"
  function parseManualQty(text) {
    const s = String(text || "").trim();
    if (!/^\d+([.,]\d+)?$/.test(s)) return null;
    const n = parseFloat(s.replace(",", "."));
    return isFinite(n) && n > 0 ? n : null;
  }

  function numericInfo(text) {
    const m = NUM_RE.exec(cleanTok(text));
    if (!m) return null;
    const value = parseQtyString(m[1]);
    return value === null ? null : { value, unit: m[2] || "" };
  }

  const isWord = (text) => /\p{L}{2,}/u.test(text) && !numericInfo(text);

  function normalizeName(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  }

  function formatQty(n) {
    if (n === null || n === undefined) return "";
    const r = Math.round(n * 1000) / 1000;
    return Number.isInteger(r) ? String(r) : String(r).replace(".", ",");
  }

  function minConfFor(sens) {
    return sens === "estricta" ? 0.9 : sens === "flexible" ? 0.65 : 0.8;
  }

  // ---------- Productos impresos del remito (se pueden editar en Ajustes) ----------
  const DEFAULT_CATALOG = [
    "PAN MIGNON BLANCO", "PAN MIGNON DE SALVADO", "PAN FRANCES", "PAN MIGNON BLANCO SIN SAL",
    "PAN DE SALVADO SIN SAL", "FIGACITAS DE MANTECA", "LIBRITOS DE GRASA", "BIZCOCHUELO DE VAINILLA 50 X 80",
    "MEDIALUNAS DE MANTECA", "MEDIALUNAS PARA RELLENAR", "PAN DE HAMBURGUESA", "PEBETE",
    "SANDWICH DE MIGA TRIPLE", "PIONONO", "PREPIZZA", "PAN ARABE", "PAN DE MOLDE CON SEMILLA", "PAN CIABATTA"
  ];
  const TABLE_ROWS = 19;   // la tabla del remito tiene 19 filas (la última no trae producto impreso)

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  const similarity = (a, b) => (a.length || b.length) ? 1 - levenshtein(a, b) / Math.max(a.length, b.length) : 1;
  const compact = (s) => normalizeName(s).replace(/ /g, "");

  // Une las primeras palabras de una fila (de izquierda a derecha) con el producto del catálogo
  // que mejor coincide. Lo que sigue a la derecha (anotaciones a mano) se descarta.
  function matchProduct(words, catalog) {
    const ws = [...words].sort((a, b) => a.x0 - b.x0);
    let best = null;
    for (let k = 1; k <= Math.min(ws.length, 9); k++) {
      const text = compact(ws.slice(0, k).map((w) => w.text).join(""));
      if (!text) continue;
      for (const c of catalog) {
        const sim = similarity(text, c.key);
        const score = sim + 0.03 * k;
        if (!best || score > best.score) best = { score, sim, k, c };
      }
    }
    if (!best || best.sim < 0.78) return null;
    const used = ws.slice(0, best.k);
    return {
      name: best.c.name, sim: best.sim,
      conf: Math.min(best.sim, mean(used.map((w) => w.conf))),
      cy: mean(used.map((w) => w.cy))
    };
  }

  // Cantidad escrita a mano en la columna izquierda. Acepta "489,12", "489, 12", "489.12", "489 12".
  const CONFUSABLE = { O: "0", o: "0", Q: "0", D: "0", l: "1", I: "1", "|": "1", S: "5", s: "5", B: "8", Z: "2", z: "2", q: "9", g: "9", G: "6", T: "7" };
  function parseQtyCell(words) {
    let t = words.map((w) => w.text).join(" ").trim();
    if (!t) return null;
    let low = false;
    t = t.replace(/\s*([.,])\s*/g, "$1");
    const digits = (t.match(/\d/g) || []).length;
    if (digits < 2 && !/^\d{1,2}$/.test(t)) return null;
    // letras que suelen confundirse con números, solo si el resto es claramente un número
    if (/[A-Za-z|]/.test(t)) {
      const fixed = t.replace(/[A-Za-z|]/g, (ch) => CONFUSABLE[ch] || "?");
      if (/^\d{1,4}([.,]\d{1,3})?$/.test(fixed)) { t = fixed; low = true; } else return null;
    }
    t = t.replace(/[.,]+$/, "");
    if (/^\d{1,4}\s\d{1,3}$/.test(t)) { t = t.replace(/\s/, ","); low = true; }   // "489 12"
    if (!/^\d{1,4}([.,]\d{1,3})?$/.test(t)) return null;
    if (/^\d{1,3}\.\d{3}$/.test(t)) low = true;                                       // 1.250: ambiguo
    const value = parseQtyString(t);
    if (value === null) return null;
    return { value, low, text: t, conf: Math.min(...words.map((w) => w.conf)) };
  }

  // Remito con columnas:  CANTIDAD (a mano) | DETALLE (productos impresos) | anotaciones a mano
  function buildRowsColumns(lines, headerIdx, qx, dx, o) {
    const boundary = (qx + dx) / 2;
    const headerCy = lines[headerIdx].cy;
    let endIdx = lines.length;
    for (let i = headerIdx + 1; i < lines.length; i++) {
      if (STOP_RE.test(lines[i].text)) { endIdx = i; break; }
    }
    const region = lines.slice(headerIdx + 1, endIdx);
    const regionWords = region.flatMap((l) => l.words);
    const catalog = (o.catalog || []).map((n) => ({ name: n.trim(), key: compact(n) })).filter((c) => c.key);

    // Filas de productos (texto impreso en la columna del medio)
    const productLines = [];
    for (const line of region) {
      const detail = line.words.filter((w) => w.cx >= boundary);
      if (!detail.length) continue;
      if (catalog.length) {
        const m = matchProduct(detail, catalog);
        if (m) productLines.push(m);
      } else {
        const ws = [...detail].sort((a, b) => a.x0 - b.x0);
        const grp = [ws[0]];
        for (let i = 1; i < ws.length && ws[i].x0 - ws[i - 1].x1 <= o.medH * 1.6; i++) grp.push(ws[i]);
        const name = grp.map((w) => w.text).join(" ").trim();
        if (/\p{L}{3,}/u.test(name)) productLines.push({ name, sim: 1, conf: mean(grp.map((w) => w.conf)), cy: mean(grp.map((w) => w.cy)) });
      }
    }
    productLines.sort((a, b) => a.cy - b.cy);
    const gaps = [];
    for (let i = 1; i < productLines.length; i++) gaps.push(productLines[i].cy - productLines[i - 1].cy);
    gaps.sort((a, b) => a - b);
    const pitch = gaps.length ? gaps[gaps.length >> 1] : o.medH * 2.2;

    // Cantidades escritas a mano en la columna de la izquierda
    const leftWords = regionWords.filter((w) => w.cx < boundary);
    const cells = [];
    if (leftWords.length) {
      for (const l of groupLines(leftWords).lines || []) {
        const q = parseQtyCell(l.words);
        if (q) cells.push({ ...q, cy: l.cy, text: q.text });
      }
    }

    // Cada cantidad va con la fila de producto más cercana en altura
    const byLine = new Map();
    const rows = [];
    for (const c of cells) {
      let best = -1, bd = Infinity;
      productLines.forEach((p, i) => { const d = Math.abs(p.cy - c.cy); if (d < bd) { bd = d; best = i; } });
      if (best >= 0 && bd <= pitch * 0.75) {
        if (!byLine.has(best)) byLine.set(best, []);
        byLine.get(best).push(c);
      } else {
        rows.push({ cy: c.cy, row: makeRow("", c.value, c.text, 0, c.text, o.minConf) });   // sin producto claro
      }
    }
    for (const [i, list] of byLine) {
      const p = productLines[i];
      list.sort((a, b) => b.conf - a.conf);
      const c = list[0];
      const conf = Math.min(c.conf, p.conf);
      const row = makeRow(p.name, c.value, c.text, conf, c.text + "  " + p.name, o.minConf);
      if (c.low || list.length > 1) row.low = true;     // corregida por letras/espacios, o dudosa por duplicado
      rows.push({ cy: c.cy, row });
    }
    rows.sort((a, b) => a.cy - b.cy);
    return { rows: rows.map((r) => r.row), headerFound: true, layout: "columnas" };
  }

  // ---------- Lectura de la columna de cantidades (recuadro recortado) ----------
  // La imagen que se manda a Vision es SOLO la columna de cantidades, de la primera a la última fila de
  // la tabla. Cada cantidad se asigna al producto por el número de fila (de arriba hacia abajo).
  // words: salida de extractWords(resp, {autoRotate:false}); o.height: alto de la imagen leída.
  function buildRowsStrip(words, o) {
    o = o || {};
    const products = (o.products || []).map((p) => String(p).trim()).filter(Boolean);
    const N = Math.max(o.rowCount || TABLE_ROWS, products.length);
    const height = o.height || Math.max(1, ...words.map((w) => w.y1));
    const minConf = o.minConf === undefined ? 0.8 : o.minConf;
    const rowH = height / N;

    // Palabras pegadas (por ejemplo "489," y "12") forman una sola cantidad
    const ws = words.filter((w) => /[\p{N}]/u.test(w.text) || /^[A-Za-z|]{1,4}$/.test(w.text) || /[.,]/.test(w.text))
      .map((w) => ({ ...w })).sort((a, b) => a.x0 - b.x0);
    const hs = ws.map((w) => w.h).sort((a, b) => a - b);
    const medH = hs[hs.length >> 1] || rowH * 0.5;
    const groups = [];
    for (const w of ws) {
      let g = null;
      for (const c of groups) {
        const overlap = Math.min(w.y1, c.y1) - Math.max(w.y0, c.y0);
        if (overlap >= 0.3 * Math.min(w.h, c.y1 - c.y0) && w.x0 - c.x1 <= medH * 2.2 && w.x1 >= c.x0 - medH) { g = c; break; }
      }
      if (g) { g.words.push(w); g.x1 = Math.max(g.x1, w.x1); g.y0 = Math.min(g.y0, w.y0); g.y1 = Math.max(g.y1, w.y1); }
      else groups.push({ words: [w], x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1 });
    }

    const byRow = new Map();
    for (const g of groups) {
      const longest = g.words.reduce((a, b) => (b.text.length > a.text.length ? b : a));
      const cy = longest.cy;
      const idx = Math.min(N - 1, Math.max(0, Math.floor(cy / rowH)));
      const top = idx * rowH, bottom = top + rowH;
      const gh = Math.max(1, g.y1 - g.y0);
      const spill = Math.max(0, bottom - g.y1 < 0 ? g.y1 - bottom : 0, g.y0 < top ? top - g.y0 : 0) / gh;
      g.spill = spill;
      g.tall = gh > rowH * 1.35;
      if (!byRow.has(idx)) byRow.set(idx, []);
      byRow.get(idx).push(g);
    }

    const rows = [];
    for (const [idx, list] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
      const name = products[idx] || "";
      const allWords = list.flatMap((g) => g.words).sort((a, b) => a.x0 - b.x0);
      const text = allWords.map((w) => w.text).join(" ");
      const hasDigit = /\d/.test(text);
      const q = parseQtyCell(allWords);
      const uncertain = list.length > 1 || list.some((g) => g.spill > 0.35 || g.tall) || o.layoutOk === false;
      if (q) {
        const row = makeRow(name, q.value, q.text, q.conf, "fila " + (idx + 1) + ": " + q.text, minConf);
        if (q.low || uncertain) row.low = true;
        row.index = idx + 1;
        rows.push(row);
      } else if (hasDigit) {
        const row = makeRow(name, null, text, 0, "fila " + (idx + 1) + ": " + text, minConf);   // se vio algo, pero no se entiende
        row.low = true; row.index = idx + 1;
        rows.push(row);
      }
    }
    return { rows, layout: "columna", rowCount: N };
  }

  // ---------- Lectura de la zona central (no depende de encabezados) ----------
  // Los productos impresos están siempre en el centro y las cantidades a mano siempre en la columna
  // izquierda. Se buscan los renglones de productos conocidos (catálogo) y, a partir de ellos:
  //   - la columna de cantidades es todo lo que queda a la izquierda del texto impreso,
  //   - se ignora todo lo que está a la derecha (firmas, notas, números sueltos) y fuera de la tabla.
  // Una palabra del renglón se prueba como inicio del nombre, así las notas a los costados no molestan.
  function matchProductInLine(words, catalog) {
    const ws = [...words].sort((a, b) => a.x0 - b.x0);
    let best = null;
    for (let s = 0; s < ws.length; s++) {
      if (!/\p{L}{2,}/u.test(ws[s].text)) continue;
      for (let k = 1; k <= Math.min(ws.length - s, 9); k++) {
        const used = ws.slice(s, s + k);
        const text = compact(used.map((w) => w.text).join(""));
        if (!text) continue;
        for (const c of catalog) {
          const sim = similarity(text, c.key);
          const score = sim + 0.03 * k;
          if (!best || score > best.score) best = { score, sim, c, used };
        }
      }
    }
    if (!best || best.sim < 0.78) return null;
    return {
      name: best.c.name, sim: best.sim,
      conf: Math.min(best.sim, mean(best.used.map((w) => w.conf))),
      cy: mean(best.used.map((w) => w.cy)),
      x0: Math.min(...best.used.map((w) => w.x0)), x1: Math.max(...best.used.map((w) => w.x1))
    };
  }

  function buildRowsCentral(words, o) {
    const catalog = (o.catalog || []).map((n) => ({ name: n.trim(), key: compact(n) })).filter((c) => c.key);
    if (!catalog.length) return null;
    const g = groupLines(words);
    const lines = g.lines || [];
    const medH = g.medH || 10;
    const products = [];
    for (const l of lines) {
      const m = matchProductInLine(l.words, catalog);
      if (m) products.push(m);
    }
    if (products.length < 2) return null;
    products.sort((a, b) => a.cy - b.cy);
    const gaps = [];
    for (let i = 1; i < products.length; i++) gaps.push(products[i].cy - products[i - 1].cy);
    gaps.sort((a, b) => a - b);
    const pitch = Math.max(medH * 1.2, gaps[gaps.length >> 1] || medH * 2.2);
    const left = Math.min(...products.map((p) => p.x0));
    const top = products[0].cy - pitch * 0.75, bottom = products[products.length - 1].cy + pitch * 0.75;

    // Columna de cantidades: a la izquierda de todo el texto impreso, dentro del alto de la tabla
    const colWords = words.filter((w) => w.x1 <= left + medH * 0.3 && w.cy >= top && w.cy <= bottom);
    const cells = [];
    const cg = colWords.length ? groupLines(colWords) : { lines: [] };
    for (const l of cg.lines || []) {
      const q = parseQtyCell(l.words);
      if (q) cells.push({ ...q, cy: l.cy });
    }

    const byLine = new Map();
    const rows = [];
    for (const c of cells) {
      let best = -1, bd = Infinity;
      products.forEach((p, i) => { const d = Math.abs(p.cy - c.cy); if (d < bd) { bd = d; best = i; } });
      if (best >= 0 && bd <= pitch * 0.75) {
        if (!byLine.has(best)) byLine.set(best, []);
        byLine.get(best).push(c);
      } else {
        rows.push({ cy: c.cy, row: makeRow("", c.value, c.text, 0, c.text, o.minConf) });   // cantidad sin producto claro
      }
    }
    for (const [i, list] of byLine) {
      const p = products[i];
      list.sort((a, b) => b.conf - a.conf);
      const c = list[0];
      const row = makeRow(p.name, c.value, c.text, Math.min(c.conf, p.conf), c.text + "  " + p.name, o.minConf);
      if (c.low || list.length > 1) row.low = true;
      rows.push({ cy: c.cy, row });
    }
    rows.sort((a, b) => a.cy - b.cy);
    return { rows: rows.map((r) => r.row), headerFound: false, layout: "central" };
  }

  // ---------- Armado de filas ----------
  function groupLines(words) {
    if (!words.length) return [];
    const sorted = [...words].sort((a, b) => a.cy - b.cy);
    const hs = words.map((w) => w.h).sort((a, b) => a - b);
    const medH = hs[hs.length >> 1] || 10;
    const lines = [];
    for (const w of sorted) {
      let line = null;
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
        if (Math.abs(lines[i].cy - w.cy) <= medH * 0.6) { line = lines[i]; break; }
      }
      if (line) {
        line.words.push(w);
        line.cy = line.words.reduce((s, x) => s + x.cy, 0) / line.words.length;
      } else {
        lines.push({ cy: w.cy, words: [w] });
      }
    }
    lines.sort((a, b) => a.cy - b.cy);
    for (const l of lines) {
      l.words.sort((a, b) => a.cx - b.cx);
      l.text = l.words.map((w) => w.text).join(" ");
    }
    return { lines, medH };
  }

  const STOP_RE = /(sub\s*total|\btotal|observaci|firma|recib[ií]|aclaraci|transporte|son\s+pesos|\bc\.?a\.?e\b)/i;
  const SKIP_RE = /\b(cuit|fecha|remito|cliente|domicilio|direcci[oó]n|tel|iva|punto\s+de\s+venta|ing\.?\s*brutos|inicio\s+de\s+act|raz[oó]n|condici[oó]n|localidad|c[oó]d|descripci[oó]n|cantidad|producto|art[ií]culo|precio|importe|unitario|original|duplicado)\b/i;

  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

  function makeRow(name, qty, qtyText, conf, lineText, minConf) {
    const low = !(conf >= minConf) || !name || qty === null || qty <= 0 || qty > 9999;
    return { name, qty, qtyText, conf, lineText, low };
  }

  function parseLine(line, ctx, minConf) {
    const toks = line.words;
    const cand = [];
    toks.forEach((t, i) => { const n = numericInfo(t.text); if (n) cand.push({ i, n }); });

    let qtyIdx = -1;
    if (ctx.header) {
      if (cand.length && ctx.qx !== null) {
        let best = null;
        for (const c of cand) {
          const d = Math.abs(toks[c.i].cx - ctx.qx);
          if (!best || d < best.d) best = { c, d };
        }
        if (best && best.d <= ctx.tol) qtyIdx = best.c.i;
      }
    } else {
      const fa = toks.findIndex((t) => isWord(t.text));
      if (fa < 0) return { kind: "skip" };
      const after = cand.filter((c) => c.i > fa);
      const pure = after.filter((c) => !c.n.unit);
      const pool = pure.length ? pure : after;
      if (pool.length) qtyIdx = (ctx.mode === "ultimo" ? pool[pool.length - 1] : pool[0]).i;
    }

    if (qtyIdx < 0) {
      return toks.some((t) => isWord(t.text)) ? { kind: "text" } : { kind: "skip" };
    }

    const q = toks[qtyIdx];
    const info = numericInfo(q.text);
    const firstAlpha = toks.findIndex((t) => isWord(t.text));
    let prod;
    if (firstAlpha >= 0 && firstAlpha < qtyIdx) {
      prod = toks.slice(firstAlpha, qtyIdx);
    } else {
      prod = toks.slice(qtyIdx + 1);
      while (prod.length && numericInfo(prod[prod.length - 1].text)) prod.pop();
    }
    const name = prod.map((t) => t.text).join(" ").replace(/\s+/g, " ").trim();
    const pConf = prod.length ? mean(prod.map((t) => t.conf)) : 0;
    const conf = prod.length ? Math.min(q.conf, pConf) : 0;
    return { kind: "row", row: makeRow(name, info.value, q.text, conf, line.text, minConf) };
  }

  // words: salida de extractWords. opts: {width, qtyMode: "primero"|"ultimo", minConf}
  function buildRows(words, opts) {
    opts = opts || {};
    const minConf = opts.minConf === undefined ? 0.8 : opts.minConf;
    const g = groupLines(words);
    const lines = g.lines || [];
    const medH = g.medH || 10;
    const width = opts.width || Math.max(0, ...words.map((w) => w.x1));

    const central = buildRowsCentral(words, { minConf, catalog: opts.catalog });
    if (central) return central;
    // Con catálogo y sin poder ubicar los productos impresos no se inventa nada: queda en ⚠ para cargar a mano.
    if ((opts.catalog || []).some((n) => String(n).trim())) return { rows: [], headerFound: false, layout: "sin-tabla" };

    let headerIdx = -1, qx = null;
    for (let i = 0; i < lines.length; i++) {
      const hw = lines[i].words.find((w) => /^cant/i.test(cleanTok(w.text)));
      if (hw) { headerIdx = i; qx = hw.cx; break; }
    }
    const ctx = { header: headerIdx >= 0, qx, tol: width * 0.12, mode: opts.qtyMode || "primero" };

    // ¿Remito con la columna CANTIDAD a la izquierda de DETALLE? (el formato de la panadería)
    if (headerIdx >= 0) {
      const dw = lines[headerIdx].words.find((w) => /^(detalle|descripci[oó]n|producto|art[ií]culo)s?$/i.test(cleanTok(w.text)));
      if (dw && dw.cx - qx > width * 0.15) {
        return buildRowsColumns(lines, headerIdx, qx, dw.cx, { medH, minConf, catalog: opts.catalog });
      }
    }

    const rows = [];
    let prevLine = null;
    for (let i = headerIdx >= 0 ? headerIdx + 1 : 0; i < lines.length; i++) {
      const line = lines[i];
      if (STOP_RE.test(line.text)) { if (ctx.header) break; else continue; }
      if (!ctx.header && SKIP_RE.test(line.text)) continue;

      const r = parseLine(line, ctx, minConf);
      if (r.kind === "row") {
        rows.push(r.row);
        prevLine = line;
      } else if (r.kind === "text" && ctx.header) {
        const textConf = mean(line.words.filter((t) => isWord(t.text)).map((t) => t.conf));
        const last = rows[rows.length - 1];
        if (last && prevLine && line.cy - prevLine.cy <= medH * 2.4) {
          // Renglón sin cantidad pegado al anterior: continuación del nombre del producto.
          last.name = (last.name + " " + line.text).replace(/\s+/g, " ").trim();
          last.lineText += " " + line.text;
          last.conf = Math.min(last.conf, textConf);
          last.low = last.low || !(last.conf >= minConf);
        } else {
          rows.push(makeRow(line.text, null, "", 0, line.text, minConf));
        }
        prevLine = line;
      }
    }
    return { rows, headerFound: ctx.header };
  }

  // ---------- Totales ----------
  function aggregate(rowLists) {
    const map = new Map();
    for (const rows of rowLists) {
      for (const r of rows) {
        if (!r.name || r.qty === null || r.qty === undefined || !(r.qty > 0)) continue;
        const key = normalizeName(r.name);
        if (!key) continue;
        const cur = map.get(key);
        if (cur) cur.qty += r.qty;
        else map.set(key, { name: r.name.trim(), qty: r.qty });
      }
    }
    const out = [...map.entries()].map(([k, v]) => ({ key: k, name: v.name, qty: Math.round(v.qty * 1000) / 1000 }));
    out.sort((a, b) => a.key.localeCompare(b.key, "es"));
    return out;
  }

  const api = {
    recognize, extractWords, buildRows, buildRowsStrip, aggregate, TABLE_ROWS,
    normalizeName, formatQty, parseManualQty, minConfFor, DEFAULT_CATALOG
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OCR = api;
})(typeof self !== "undefined" ? self : this);
