// factparse.js — Facturas fiscales: reconoce el tipo por el nombre del archivo y lee el importe total del PDF (sin OCR).
// Facturas y notas de débito suman; notas de crédito restan.
(function (root) {
  "use strict";
  const O = (typeof require === "function" && typeof module === "object") ? require("./ocparse.js") : root.OcParse;
  const NAME_RE = /(\d{11})_(\d{3})_(\d{5})_(\d{8})/;
  const KINDS = {
    "001": { label: "Factura A", sign: 1 },
    "002": { label: "Nota de Débito A", sign: 1 },
    "003": { label: "Nota de Crédito A", sign: -1 },
    "201": { label: "Factura de Crédito Electrónica A", sign: 1 },
    "202": { label: "Nota de Débito Electrónica A", sign: 1 },
    "203": { label: "Nota de Crédito Electrónica A", sign: -1 }
  };
  function parseName(name) {
    const m = NAME_RE.exec(String(name || "")); if (!m) return null;
    const k = KINDS[m[2]];
    return { cuit: m[1], code: m[2], pv: m[3], number: m[4], short: String(Number(m[3])).padStart(5, "0") + "-" + m[4], label: k ? k.label : "Tipo " + m[2] + " (desconocido)", sign: k ? k.sign : 0, known: !!k };
  }

  const MONEY = /(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}(?!\d)/g;
  const clean = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  function rowsOf(items) {
    const rows = [], sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
    for (const it of sorted) { const r = rows.find((q) => Math.abs(q.y - it.y) <= 2); if (r) r.cells.push(it); else rows.push({ y: it.y, cells: [it] }); }
    rows.forEach((r) => r.cells.sort((a, b) => a.x - b.x));
    return rows.sort((a, b) => b.y - a.y).map((r) => r.cells.map((c) => c.str).join(" ").replace(/\s+/g, " ").trim());
  }
  const moneyIn = (s) => (String(s).match(MONEY) || []).map((x) => O.parseNumber(x)).filter((v) => typeof v === "number" && !Number.isNaN(v));
  function mode(vals) {
    const c = new Map(); vals.forEach((v) => { const k = v.toFixed(2); c.set(k, (c.get(k) || 0) + 1); });
    let best = null, n = 0; c.forEach((cnt, k) => { if (cnt > n) { n = cnt; best = Number(k); } }); return best;
  }

  // pages: [{items:[{x,y,str}]}] (lo que devuelve PdfText.extract)
  function parseInvoice(pages) {
    const lines = []; (pages || []).forEach((p) => rowsOf(p.items || []).forEach((l) => lines.push(l)));
    const primary = [], secondary = []; let date = "";
    lines.forEach((l, i) => {
      const u = clean(l);
      if (!date) { const m = /FECHA DE EMISION\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/.exec(u); if (m) date = m[1]; }
      if (/IMPORTE\s+TOTAL/.test(u)) {
        const after = l.slice(clean(l).search(/IMPORTE\s+TOTAL/));
        let v = moneyIn(after); if (!v.length) v = moneyIn(lines[i + 1] || "");
        if (v.length) primary.push(v[v.length - 1]);
      } else if (/(^|[^A-Z])TOTAL\s*:?\s*\$?\s*[\d.]+,\d{2}\s*$/.test(u) && !/SUBTOTAL|NETO|IVA/.test(u)) {
        const v = moneyIn(l); if (v.length) secondary.push(v[v.length - 1]);
      }
    });
    const total = primary.length ? mode(primary) : secondary.length ? mode(secondary) : null;
    return { ok: total !== null, total, date, source: primary.length ? "Importe Total" : secondary.length ? "Total" : "", hasText: lines.length > 0 };
  }

  // lista: [{ sign, total }] -> neto facturado
  function net(list) { return O.round(list.reduce((s, f) => s + (f.sign || 0) * (typeof f.total === "number" ? f.total : 0), 0), 2); }

  const api = { parseName, parseInvoice, net, KINDS };
  if (typeof module === "object" && module.exports) module.exports = api; else root.FactParse = api;
})(typeof self !== "undefined" ? self : this);
