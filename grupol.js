// grupol.js — Excel semanal de despachos de Grupo L ("PEDIDO SEMANAL - SEMANA DEL 16.11 AL 21.11.xlsx").
// La hoja de datos tiene un renglón por sucursal y día: Fecha | Sucursal | <producto 1> | <producto 2> | … | PROV,
// con un renglón "Total dd/mm/aaaa" por día y "Total general" al final. Funciones puras (sin pantalla).
(function (root) {
  "use strict";
  const O = (typeof require === "function" && typeof module === "object") ? require("./ocparse.js") : root.OcParse;
  const norm = (s) => String(s === null || s === undefined ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();
  const NOT_PRODUCT = /^(PROV|PROVEEDOR|TOTAL|OBS|OBSERVACION|ZONA|DIRECCION|CLIENTE)/;

  // Fecha de una celda: fecha de Excel ({date, y, m, d}) o texto "17/11/2026"
  function dateOf(c, yearHint) {
    if (c && typeof c === "object" && c.date) return { y: c.y, m: c.m, d: c.d };
    const m = /^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?$/.exec(String(c == null ? "" : c).trim());
    if (!m) return null;
    let y = m[3] ? Number(m[3]) : yearHint || null; if (y && y < 100) y += 2000;
    const d = Number(m[1]), mo = Number(m[2]);
    return d >= 1 && d <= 31 && mo >= 1 && mo <= 12 ? { y, m: mo, d } : null;
  }
  const num = (c) => { if (typeof c === "number") return c; if (typeof c === "string" && c.trim()) { const v = O.parseNumber(c.trim()); return v === null || Number.isNaN(v) ? null : v; } return null; };
  const key = (f) => f.y * 10000 + f.m * 100 + f.d;

  // Semana del nombre del archivo: "SEMANA DEL 16.11 AL 21.11"
  function weekFromName(name, year) {
    const m = /DEL\s+(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?\s+AL\s+(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?/i.exec(String(name || ""));
    if (!m) return null;
    const y1 = m[3] ? Number(m[3]) : year, y2 = m[6] ? Number(m[6]) : y1;
    return { desde: { y: y1, m: Number(m[2]), d: Number(m[1]) }, hasta: { y: y2, m: Number(m[5]), d: Number(m[4]) } };
  }

  // wb: lo que devuelve Xlsx.read. Devuelve {desde, hasta, productos:[nombres], filas:[{y,m,d,sucursal,cant:[]}], totalGeneral, hoja} o {error}
  function parseWeekly(wb, fileName) {
    let best = null;
    for (const sh of wb.sheets.filter((s) => !s.hidden)) {
      const rows = sh.rows || [];
      for (let r = 0; r < Math.min(rows.length, 25); r++) {
        const n = (rows[r] || []).map(norm), cF = n.findIndex((x) => /^FECHA$/.test(x)), cS = n.findIndex((x) => /^SUCURSAL|^ESCUELA|^DESTINO|^ESTABLECIMIENTO/.test(x));
        if (cF >= 0 && cS >= 0) {
          const prods = [];
          n.forEach((x, k) => { if (k > cS && x && !NOT_PRODUCT.test(x)) prods.push(k); });
          if (prods.length && (!best || prods.length > best.prods.length)) best = { sh, hdr: r, cF, cS, prods };
          break;
        }
      }
    }
    if (!best) return { error: "No encontré la tabla de despachos (columnas Fecha / Sucursal / productos) en " + (fileName || "el Excel") + "." };
    const { sh, hdr, cF, cS, prods } = best, rows = sh.rows;
    // Período: renglón "FECHA: DEL 16/11/2026 AL 21/11/2026" (en cualquier hoja) o el nombre del archivo
    let wk = null;
    for (const s of wb.sheets) for (const row of (s.rows || []).slice(0, 6)) {
      const t = (row || []).map((c) => (c && c.date ? c.d + "/" + c.m + "/" + c.y : String(c == null ? "" : c))).join(" ");
      const m = /DEL\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+AL\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(t);
      if (m && !wk) wk = { desde: dateOf(m[1]), hasta: dateOf(m[2]) };
    }
    const out = { hoja: sh.name, productos: prods.map((k) => String(rows[hdr][k]).trim()), filas: [], totalGeneral: null, desde: null, hasta: null };
    const yearHint = wk && wk.desde ? wk.desde.y : null;
    for (let r = hdr + 1; r < rows.length; r++) {
      const row = rows[r] || [], first = norm(row[cF]);
      if (/^TOTAL GENERAL/.test(first)) { out.totalGeneral = prods.map((k) => num(row[k]) || 0); continue; }
      if (/^TOTAL/.test(first)) continue;
      const f = dateOf(row[cF], yearHint); if (!f) continue;
      const cant = prods.map((k) => num(row[k]));
      if (cant.every((v) => v === null)) continue;
      out.filas.push({ y: f.y, m: f.m, d: f.d, sucursal: String(row[cS] == null ? "" : row[cS]).trim(), cant });
    }
    if (!wk) wk = weekFromName(fileName, yearHint || (out.filas[0] && out.filas[0].y));
    if (!wk && out.filas.length) { const ks = out.filas.slice().sort((a, b) => key(a) - key(b)); wk = { desde: ks[0], hasta: ks[ks.length - 1] }; }
    if (wk) { out.desde = { y: wk.desde.y, m: wk.desde.m, d: wk.desde.d }; out.hasta = { y: wk.hasta.y, m: wk.hasta.m, d: wk.hasta.d }; }
    return out;
  }

  // Suma por producto de las entregas entre "desde" y "hasta" (inclusive), juntando varias semanas. Si dos archivos traen
  // la misma sucursal y día (una copia bajada dos veces), cuenta una sola vez: la del primero de la lista (el más nuevo).
  function totals(weeklies, desde, hasta) {
    const lo = key(desde), hi = key(hasta), seen = new Set(), sums = new Map(), names = [];
    let dias = new Set();
    for (const w of weeklies) {
      if (!w || w.error) continue;
      w.productos.forEach((p) => { if (!sums.has(norm(p))) { sums.set(norm(p), 0); names.push(p); } });
      for (const f of w.filas) {
        const k = key(f); if (k < lo || k > hi) continue;
        const id = k + "|" + norm(f.sucursal); if (seen.has(id)) continue; seen.add(id);
        dias.add(k);
        f.cant.forEach((v, i) => { if (v !== null) { const p = norm(w.productos[i]); sums.set(p, O.round(sums.get(p) + v, 3)); } });
      }
    }
    return { rows: names.map((n) => ({ name: n, key: O.keyOf(n), sum: sums.get(norm(n)), invalid: [] })), dias: dias.size };
  }

  const api = { parseWeekly, totals, weekFromName, dateOf };
  if (typeof module === "object" && module.exports) module.exports = api; else root.GrupoL = api;
})(typeof self !== "undefined" ? self : this);
