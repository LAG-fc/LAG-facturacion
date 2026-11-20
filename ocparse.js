// ocparse.js — Interpreta una orden de compra (OC) ya leída con pdftext.js, deduce el IVA de cada producto a partir de
// los totales, cruza las entregas pegadas desde Excel y arma la tabla de facturación. Todo en funciones puras.
(function (root) {
  "use strict";

  // ---------- números ----------
  const round = (v, d) => { const f = Math.pow(10, d); return Math.round((v + Number.EPSILON) * f) / f; };
  // Formato del PDF (inglés): $ 1,234.50
  function parseUS(s) {
    const t = String(s).replace(/[$\s]/g, "").replace(/,/g, "");
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
  }
  // Formato de Excel argentino: 12 · 12,5 · 12.5 · 1.250 (=1250) · 1.250,5
  function parseNumber(s) {
    s = String(s).replace(/\s+/g, "");
    if (!s) return null;
    if (!/^[0-9.,]+$/.test(s)) return NaN;
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
    return isFinite(v) && v >= 0 ? v : NaN;
  }
  // Para mostrar: 56.000,00 (miles con punto, coma decimal)
  function fmt(v, minD, maxD) {
    if (v === null || v === undefined || Number.isNaN(v)) return "";
    let s = round(v, maxD).toFixed(maxD);
    if (maxD > minD) { let [i, d] = s.split("."); while (d.length > minD && d.endsWith("0")) d = d.slice(0, -1); s = d.length ? i + "." + d : i; }
    const [ip, dp] = s.split(".");
    const withDots = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return dp ? withDots + "," + dp : withDots;
  }
  const fmtMoney = (v) => fmt(v, 2, 3);
  const fmtQty = (v) => fmt(v, 0, 3);
  const fmtRate = (r) => (r === null || r === undefined ? "?" : String(r).replace(".", ",") + "%");
  const plain = (v, minD, maxD) => fmt(v, minD, maxD).replace(/\./g, "");      // para pegar en Excel: sin separador de miles

  // ---------- 1) Leer la OC ----------
  function groupRows(items) {
    const rows = [];
    const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
    for (const it of sorted) {
      const r = rows.find((q) => Math.abs(q.y - it.y) <= 1.6);
      if (r) r.cells.push(it); else rows.push({ y: it.y, cells: [it] });
    }
    rows.forEach((r) => r.cells.sort((a, b) => a.x - b.x));
    return rows.sort((a, b) => b.y - a.y);
  }
  const MONEY = /^\$\s*-?[\d,]+\.\d+$/;
  const QTY = /^\d+(\.\d+)?$/;

  function cleanDescription(raw) {
    let rate = null;
    const desc = raw.replace(/\(\s*(?:IVA\s*)?(\d+(?:[.,]\d+)?)\s*%\s*\)/gi, (m, r) => { rate = Number(r.replace(",", ".")); return ""; })
      .replace(/\s+/g, " ").trim();
    return { desc, rate };
  }

  function parseOc(pages) {
    const out = { ocNumber: "", emission: "", items: [], totals: { subtotal: null, discount: 0, total: null, ivas: [] }, warnings: [] };
    pages.forEach((pg, pageIdx) => {
      const rows = groupRows(pg.items);
      let cur = null, descX = null, lastY = null;       // cur = último producto leído (para unir líneas partidas)
      for (const r of rows) {
        const cells = r.cells, texts = cells.map((c) => c.str), joined = texts.join(" ");
        let m;
        if (!out.ocNumber && (m = /Orden de compra\D*?(\d+)\s*$/i.exec(joined))) out.ocNumber = m[1];
        if (!out.emission && (m = /Emisi[oó]n:\s*([\d/-]+)/i.exec(joined))) out.emission = m[1];

        // Fila de producto: cantidad · presentación · descripción · … · precio · importe
        const n = texts.length;
        if (n >= 4 && QTY.test(texts[0]) && MONEY.test(texts[n - 1]) && MONEY.test(texts[n - 2])) {
          const qty = Number(texts[0]), price = parseUS(texts[n - 2]), importe = parseUS(texts[n - 1]);
          const raw = texts[2] || "";
          cur = { raw, qty, price, importe };
          descX = cells[2] ? cells[2].x : null; lastY = r.y;
          out.items.push(cur);
          continue;
        }
        // Línea que continúa la descripción del producto anterior
        if (cur && cells.length === 1 && descX !== null && Math.abs(cells[0].x - descX) <= 1.5 && lastY - r.y <= 16 && !MONEY.test(texts[0])) {
          cur.raw += " " + texts[0]; lastY = r.y;
          continue;
        }
        cur = null;
        // Totales
        const money = texts.find((t) => MONEY.test(t));
        if (money !== undefined && n >= 2) {
          const label = (texts.find((t) => !MONEY.test(t)) || "").trim();
          const v = parseUS(money);
          if ((m = /^IVA\s*([\d.,]+)\s*%$/i.exec(label))) out.totals.ivas.push({ rate: Number(m[1].replace(",", ".")), amount: v });
          else if (/^SUBTOTAL$/i.test(label)) out.totals.subtotal = v;
          else if (/^TOTAL$/i.test(label)) out.totals.total = v;
          else if (/^Descuentos?$/i.test(label)) out.totals.discount = v;
        }
      }
    });
    out.items = out.items.map((it) => {
      const d = cleanDescription(it.raw);
      if (Math.abs(round(it.qty * it.price, 2) - it.importe) > 0.05) out.warnings.push("En “" + d.desc + "” cantidad × precio no coincide con el importe del PDF.");
      return { desc: d.desc, price: it.price, qty: it.qty, importe: it.importe, mark: d.rate, iva: null, ivaSrc: "" };
    });
    return out;
  }

  // ---------- 2) Deducir el IVA de cada producto ----------
  // Subconjuntos de "values" (centavos) cuya suma esté en [lo, hi]. Devuelve máscaras (bit j = values[j]).
  function subsetsInRange(values, lo, hi, cap) {
    const n = values.length, h = n >> 1;
    const sums = (arr) => { const s = [0]; for (const v of arr) { const L = s.length; for (let i = 0; i < L; i++) s.push(s[i] + v); } return s; };
    const A = sums(values.slice(0, h)), B = sums(values.slice(h));
    const order = Array.from(B.keys()).sort((i, j) => B[i] - B[j]);
    const out = [];
    for (let a = 0; a < A.length && out.length < cap; a++) {
      const from = lo - A[a], to = hi - A[a];
      let l = 0, r = order.length;
      while (l < r) { const mid = (l + r) >> 1; if (B[order[mid]] < from) l = mid + 1; else r = mid; }
      for (let k = l; k < order.length && B[order[k]] <= to && out.length < cap; k++) out.push(a + order[k] * Math.pow(2, h));
    }
    return out;
  }
  // Reparte "pool" (índices con importe en centavos) entre los grupos; cada grupo tiene un rango de suma.
  function partition(pool, cents, groups, cap) {
    if (groups.length === 1) {
      const s = pool.reduce((t, i) => t + cents[i], 0);
      return s >= groups[0].lo && s <= groups[0].hi ? [[pool.slice()]] : [];
    }
    const g = groups[0], vals = pool.map((i) => cents[i]), n = vals.length, h = n >> 1, results = [];
    for (const mask of subsetsInRange(vals, g.lo, g.hi, cap)) {
      const lowMask = mask % Math.pow(2, h), highMask = Math.floor(mask / Math.pow(2, h));
      const pick = [], rest = [];
      pool.forEach((idx, j) => { const inSet = j < h ? (lowMask >> j) & 1 : (highMask >> (j - h)) & 1; (inSet ? pick : rest).push(idx); });
      for (const sol of partition(rest, cents, groups.slice(1), cap)) { results.push([pick].concat(sol)); if (results.length >= cap) return results; }
    }
    return results;
  }

  function solveIva(items, totals) {
    const rates = (totals.ivas || []).filter((x) => x.amount > 0).map((x) => ({ rate: x.rate, amount: x.amount }));
    const res = { assign: items.map(() => null), src: items.map(() => ""), status: "none", count: 0, message: "" };
    if (!items.length) { res.message = "La OC no tiene productos."; return res; }
    if (!rates.length) { res.message = "La OC no informa importes de IVA; elegí el IVA de cada producto."; return res; }
    if (rates.length === 1) {
      items.forEach((it, i) => { res.assign[i] = rates[0].rate; res.src[i] = "deducido"; });
      res.status = "single"; res.count = 1; res.message = "Todos los productos llevan " + fmtRate(rates[0].rate) + " (es el único IVA de la OC)."; return res;
    }
    if (items.length > 36) { res.message = "Son demasiados productos para deducir el IVA automáticamente."; return res; }
    const cents = items.map((it) => Math.round(it.importe * 100));
    const validMark = (it) => it.mark !== null && rates.some((r) => r.rate === it.mark);
    for (const useMarks of [true, false]) {
      for (const extra of [0, items.length]) {
        // los que traen el IVA escrito en la descripción quedan fijos
        const forced = items.map((it) => (useMarks && validMark(it) ? it.mark : null));
        const free = []; items.forEach((it, i) => { if (forced[i] === null) free.push(i); });
        const groups = rates.map((r) => {
          const f = items.reduce((t, it, i) => t + (forced[i] === r.rate ? cents[i] : 0), 0);
          const lo = Math.ceil((r.amount - 0.005) / (r.rate / 100) * 100 - 1e-6) - extra - f;
          const hi = Math.floor((r.amount + 0.005) / (r.rate / 100) * 100 + 1e-6) + extra - f;
          return { lo, hi };
        });
        if (groups.some((g) => g.hi < 0)) continue;
        groups.forEach((g) => { g.lo = Math.max(0, g.lo); });
        const sols = partition(free, cents, groups, 200);
        if (!sols.length) continue;
        const best = sols[0];
        items.forEach((it, i) => { if (forced[i] !== null) { res.assign[i] = forced[i]; res.src[i] = "marcado"; } });
        best.forEach((set, gi) => set.forEach((i) => { res.assign[i] = rates[gi].rate; res.src[i] = "deducido"; }));
        res.count = sols.length;
        res.status = sols.length === 1 ? "single" : "ambiguous";
        res.message = sols.length === 1
          ? "IVA deducido de los totales de la OC: la combinación es única y cuadra."
          : "Hay " + (sols.length >= 200 ? "muchas" : sols.length) + " combinaciones posibles de IVA; revisá la columna IVA.";
        if (!useMarks) res.message += " (No coincide con los IVA escritos en las descripciones.)";
        return res;
      }
    }
    res.message = "No pude deducir el IVA con los totales de la OC (¿tiene descuentos?). Elegí el IVA de cada producto.";
    items.forEach((it, i) => { if (validMark(it)) { res.assign[i] = it.mark; res.src[i] = "marcado"; } });
    return res;
  }

  // Compara, con el IVA actual de cada producto, contra los importes de IVA del PDF
  function checkIva(items, totals) {
    const rows = [];
    let allOk = items.length > 0 && items.every((it) => it.iva !== null && it.iva !== undefined);
    for (const t of totals.ivas || []) {
      const base = items.reduce((s, it) => s + (it.iva === t.rate ? it.importe : 0), 0);
      const exp = round(base * t.rate / 100, 2);
      const ok = Math.abs(exp - t.amount) <= Math.max(0.05, items.length * 0.005 / (t.rate / 100) * (t.rate / 100));
      rows.push({ rate: t.rate, expected: exp, pdf: t.amount, ok });
      if (!ok) allOk = false;
    }
    const known = new Set((totals.ivas || []).filter((t) => t.amount > 0).map((t) => t.rate));
    if (items.some((it) => it.iva !== null && it.iva !== undefined && it.iva !== 0 && !known.has(it.iva))) allOk = false;
    return { rows, ok: allOk };
  }

  // ---------- 3) Tabla pegada desde Excel ----------
  const STOP = new Set(["DE", "DEL", "LA", "EL", "Y", "X", "UN", "UNA", "UNIDAD", "UNIDADES", "KILOGRAMO", "KILOGRAMOS", "KILO", "KILOS", "KG", "KGS", "GR", "GRS", "G", "CM", "1"]);
  function tokens(name) {
    let s = String(name).toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    s = s.replace(/\([^)]*\)/g, " ").replace(/(\d)([A-Z])/g, "$1 $2").replace(/([A-Z])(\d)/g, "$1 $2");
    return s.split(/[^A-Z0-9]+/).filter((t) => t && !STOP.has(t)).map((t) => (t.length > 3 && t.endsWith("S") ? t.slice(0, -1) : t));
  }
  const keyOf = (name) => tokens(name).join(" ");

  function parsePasted(text) {
    const out = { rows: [], headerSkipped: false, warnings: [] };
    const lines = String(text || "").split(/\r?\n/);
    let first = true;
    lines.forEach((line, ln) => {
      if (!line.replace(/[\t\s]/g, "")) return;
      const cells = line.split("\t").map((c) => c.trim());
      const name = cells[0] || "";
      const rest = cells.slice(1);
      const nums = [], invalid = [];
      for (const c of rest) {
        if (c === "" || c === "-" || c === "–" || c === "—") continue;
        const v = parseNumber(c);
        if (v === null) continue;
        if (Number.isNaN(v)) invalid.push(c); else nums.push(v);
      }
      if (first) {
        first = false;
        // encabezado: sin ningún número, o con la primera celda vacía
        if ((!nums.length && (rest.some((c) => c !== "") || !name)) || (!name && !nums.length)) { out.headerSkipped = true; return; }
      }
      if (!name) { if (nums.length) out.warnings.push("Fila " + (ln + 1) + ": tiene cantidades pero no tiene descripción; se ignoró."); return; }
      if (/^(total(es)?|suma|subtotal)\b/i.test(name)) return;
      out.rows.push({ line: ln + 1, name, key: keyOf(name), sum: round(nums.reduce((a, b) => a + b, 0), 3), invalid });
    });
    return out;
  }

  function sameSet(a, b) { return a.length === b.length && a.every((t) => b.includes(t)); }
  // Para cada fila pegada, a qué producto de la OC corresponde. aliases: {claveFila: claveOC}; overrides: {claveFila: índice | -1}
  function matchRows(rows, items, aliases, overrides) {
    aliases = aliases || {}; overrides = overrides || {};
    const itemTok = items.map((it) => tokens(it.desc)), itemKey = itemTok.map((t) => t.join(" "));
    return rows.map((r) => {
      const t = tokens(r.name), sug = items.map((_, i) => i).map((i) => {
        const inter = t.filter((x) => itemTok[i].includes(x)).length, uni = new Set([...t, ...itemTok[i]]).size;
        return { i, score: uni ? inter / uni : 0 };
      }).sort((a, b) => b.score - a.score).filter((x) => x.score > 0).map((x) => x.i);
      if (Object.prototype.hasOwnProperty.call(overrides, r.key)) { const o = overrides[r.key]; if (o === -1 || (o >= 0 && o < items.length)) return { target: o, how: "manual", suggestions: sug }; }
      if (aliases[r.key] !== undefined) { const i = itemKey.indexOf(aliases[r.key]); if (i >= 0) return { target: i, how: "alias", suggestions: sug }; }
      if (!t.length) return { target: null, how: "none", suggestions: sug };
      let i = itemTok.findIndex((it) => sameSet(it, t));
      if (i >= 0) return { target: i, how: "exacto", suggestions: sug };
      const cands = [];
      itemTok.forEach((it, k) => {
        const inter = t.filter((x) => it.includes(x)).length;
        if (inter === Math.min(t.length, it.length)) cands.push({ k, j: inter / new Set([...t, ...it]).size });
      });
      if (cands.length) {
        cands.sort((a, b) => b.j - a.j);
        if (cands.length === 1 || cands[0].j > cands[1].j) return { target: cands[0].k, how: "automático", suggestions: sug };
        return { target: null, how: "ambiguo", suggestions: sug };
      }
      return { target: null, how: "none", suggestions: sug };
    });
  }

  // ---------- 4) Tabla de facturación ----------
  function buildInvoice(items, rows, matches) {
    const qty = items.map(() => 0);
    let pending = 0;
    rows.forEach((r, k) => {
      const m = matches[k];
      if (m.target === null || m.target === undefined) { if (r.sum > 0) pending++; return; }
      if (m.target >= 0) qty[m.target] = round(qty[m.target] + r.sum, 3);
    });
    const lines = [], omitted = [];
    items.forEach((it, i) => {
      if (qty[i] > 0) lines.push({ idx: i, desc: it.desc, qty: qty[i], price: it.price, iva: it.iva, importe: round(qty[i] * it.price, 2) });
      else omitted.push(it.desc);
    });
    const subtotal = round(lines.reduce((s, l) => s + l.importe, 0), 2);
    const byRate = new Map();
    lines.forEach((l) => { const k = l.iva === null || l.iva === undefined ? "?" : l.iva; byRate.set(k, round((byRate.get(k) || 0) + l.importe, 2)); });
    const ivas = [...byRate.entries()].filter(([k]) => k !== "?").sort((a, b) => b[0] - a[0]).map(([rate, base]) => ({ rate, base, amount: round(base * rate / 100, 2) }));
    const unknownBase = byRate.get("?") || 0;
    const total = round(subtotal + ivas.reduce((s, x) => s + x.amount, 0), 2);
    return { lines, omitted, subtotal, ivas, unknownBase, total, pending };
  }

  function toTsv(lines) {
    const head = ["DESCRIPCION", "CANTIDAD", "PRECIO", "IVA"].join("\t");
    return [head].concat(lines.map((l) => [l.desc, plain(l.qty, 0, 3), plain(l.price, 2, 3), l.iva === null || l.iva === undefined ? "" : fmtRate(l.iva)].join("\t"))).join("\n");
  }

  const api = { parseOc, solveIva, checkIva, parsePasted, matchRows, buildInvoice, toTsv, keyOf, tokens, parseNumber, parseUS, fmtMoney, fmtQty, fmtRate, round };
  if (typeof module === "object" && module.exports) module.exports = api; else root.OcParse = api;
})(typeof self !== "undefined" ? self : this);
