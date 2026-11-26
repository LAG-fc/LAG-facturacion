// factparse.js — Comprobantes fiscales de ARCA (facturas, FCE y notas de crédito/débito): reconoce el tipo por el nombre
// del archivo (CUIT_tipo_puntoDeVenta_número.pdf) y lee del PDF (sin OCR) número, fecha, emisor, receptor, neto, IVA y total.
// Facturas y notas de débito suman; notas de crédito restan.
(function (root) {
  "use strict";
  const O = (typeof require === "function" && typeof module === "object") ? require("./ocparse.js") : root.OcParse;
  const NAME_RE = /(\d{11})_(\d{3})_(\d{5})_(\d{8})/;
  // planilla: cómo se anota el tipo en la columna "TIPO FACT" de la planilla de Facturación
  const KINDS = {
    "001": { label: "Factura A", sign: 1, planilla: "A" },
    "002": { label: "Nota de Débito A", sign: 1, planilla: "ND A" },
    "003": { label: "Nota de Crédito A", sign: -1, planilla: "NC FC" },
    "006": { label: "Factura B", sign: 1, planilla: "B" },
    "008": { label: "Nota de Crédito B", sign: -1, planilla: "NC B" },
    "011": { label: "Factura C", sign: 1, planilla: "C" },
    "013": { label: "Nota de Crédito C", sign: -1, planilla: "NC C" },
    "201": { label: "Factura de Crédito Electrónica A", sign: 1, planilla: "eA" },
    "202": { label: "Nota de Débito Electrónica A", sign: 1, planilla: "ND eA" },
    "203": { label: "Nota de Crédito Electrónica A", sign: -1, planilla: "NC eA" }
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
  const first = (lines, re) => { for (const l of lines) { const m = re.exec(clean(l)); if (m) return { m, line: l }; } return null; };

  // pages: [{items:[{x,y,str}]}] (lo que devuelve PdfText.extract). Las facturas de ARCA traen ORIGINAL, DUPLICADO y
  // TRIPLICADO: se usa la primera copia para los datos y la moda de los totales por si alguna copia viene distinta.
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
    const out = { ok: total !== null, total, date, source: primary.length ? "Importe Total" : secondary.length ? "Total" : "", hasText: lines.length > 0 };

    // --- datos del comprobante (primera copia) ---
    let h;
    if ((h = first(lines, /PUNTO DE VENTA\s*:?\s*(\d{1,5})\s+COMP\.?\s*NRO\.?\s*:?\s*(\d{1,8})/))) { out.pv = h.m[1].padStart(5, "0"); out.numero = h.m[2].padStart(8, "0"); }
    if ((h = first(lines, /\bCOD\.?\s*(\d{2,3})\b/))) out.code = h.m[1].padStart(3, "0");
    if ((h = first(lines, /^([ABCEM])$/))) out.letter = h.m[1];
    if ((h = first(lines, /^RAZON SOCIAL\s*:\s*(.+?)(?:\s+FECHA DE EMISION.*)?$/))) out.emisor = h.line.replace(/^.*?:\s*/, "").replace(/\s+Fecha de Emisi.*$/i, "").trim();
    if ((h = first(lines, /^CUIT\s*:\s*(\d{11})$/))) out.emisorCuit = h.m[1];
    if ((h = first(lines, /^CUIT\s*:\s*(\d{11})\s+APELLIDO Y NOMBRE\s*\/\s*RAZON SOCIAL\s*:\s*(.+)$/))) { out.receptorCuit = h.m[1]; out.receptor = h.line.replace(/^.*Raz[oó]n Social:\s*/i, "").trim(); }
    if ((h = first(lines, /IMPORTE NETO GRAVADO\s*:?\s*\$?\s*([\d.]+,\d{2})/))) out.neto = O.parseNumber(h.m[1]);
    if ((h = first(lines, /IMPORTE OTROS TRIBUTOS\s*:?\s*\$?\s*([\d.]+,\d{2})/))) out.otros = O.parseNumber(h.m[1]);
    if ((h = first(lines, /\bFAC[A-Z.]*\s*[A-Z]?\s*:\s*(\d{4,5})-(\d{8})/))) out.asociado = h.m[1].padStart(5, "0") + "-" + h.m[2];
    if ((h = first(lines, /CAE N\S*\s*:?\s*(\d{10,})/))) out.cae = h.m[1];
    const ivas = [], seen = new Set();
    for (const l of lines) {
      const m = /^IVA\s*(\d+(?:[.,]\d+)?)\s*%\s*:?\s*\$?\s*([\d.]+,\d{2})$/.exec(clean(l));
      if (!m) continue;
      const rate = Number(m[1].replace(",", "."));
      if (seen.has(rate)) break;                                       // empieza la copia DUPLICADO
      seen.add(rate);
      const amount = O.parseNumber(m[2]); if (amount > 0) ivas.push({ rate, amount });
    }
    out.ivas = ivas;
    out.iva = O.round(ivas.reduce((t, x) => t + x.amount, 0), 2);
    const k = KINDS[out.code || ""];
    out.kind = k ? k.label : "";
    out.sign = k ? k.sign : 1;
    return out;
  }

  // Tipo como se anota en la planilla de Facturación: A, eA, "NC FC13" (nota de crédito de la factura 13)…
  function planillaTipo(code, asociado) {
    const k = KINDS[code || ""];
    if (!k) return "";
    if (k.sign < 0 && /^NC (FC|eA)$/.test(k.planilla)) return k.planilla + (asociado ? String(Number(String(asociado).split("-").pop())) : "");
    return k.planilla;
  }

  // lista: [{ sign, total }] -> neto facturado
  function net(list) { return O.round(list.reduce((s, f) => s + (f.sign || 0) * (typeof f.total === "number" ? f.total : 0), 0), 2); }

  const api = { parseName, parseInvoice, planillaTipo, net, KINDS };
  if (typeof module === "object" && module.exports) module.exports = api; else root.FactParse = api;
})(typeof self !== "undefined" ? self : this);
