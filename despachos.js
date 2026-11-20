// despachos.js — Clientes, hojas del Excel de Despachos y extracción de las cantidades entregadas de un cliente en un período.
// Funciones puras (sin pantalla), pensadas para probarse con archivos de ejemplo.
(function (root) {
  "use strict";
  const O = (typeof require === "function" && typeof module === "object") ? require("./ocparse.js") : root.OcParse;

  // Hoja del Excel que identifica a cada cliente ("sheet"). Los números se leen de la hoja ANTERIOR a esa (la de la tabla por día).
  // kind "tabla": la hoja anterior tiene una fila por producto y una columna por día (Centro de Contención y Penal de Menores).
  // kind "pan": ese cliente lleva solamente PAN MIGNON BLANCO; la hoja anterior trae solo totales, así que se lee la lista diaria de la hoja del cliente.
  const CLIENTS = [
    { id: "cc", name: "Centro de Contención", sheet: "CC Malvinas", kind: "tabla", hints: [/CENTRO.*CONTENCI/, /\bCC\b/] },
    { id: "cs", name: "Penal de Menores", sheet: "CS Malvinas", kind: "tabla", hints: [/MENORES/, /\bCS\b/, /CENTRO.*SEGURIDAD/] },
    { id: "lp", name: "La Plata", sheet: "SAE La Plata", kind: "pan", hints: [/LA PLATA/] },
    { id: "up59", name: "UP 59", sheet: "Merlo", kind: "pan", hints: [/\bUP\s*N?[°º.]?\s*59\b/, /UNIDAD.*\b59\b/, /\b59\b/], title: /\bUP\s*N?[°º.]?\s*59\b|UNIDAD\s+PENITENCIARIA\s*N?[°º.]?\s*59\b/, mrow: 1 },
    { id: "up60", name: "UP 60", sheet: "Merlo", kind: "pan", hints: [/\bUP\s*N?[°º.]?\s*60\b/, /UNIDAD.*\b60\b/, /\b60\b/], title: /\bUP\s*N?[°º.]?\s*60\b|UNIDAD\s+PENITENCIARIA\s*N?[°º.]?\s*60\b/, mrow: 2 },
    { id: "alc", name: "Alcaidía", sheet: "Merlo", kind: "pan", hints: [/ALCAID/], title: /ALCAID/, mrow: 0 }
  ];
  const PAN = "PAN MIGNON BLANCO";
  const clientById = (id) => CLIENTS.find((c) => c.id === id) || null;

  const norm = (s) => String(s === null || s === undefined ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

  // A qué cliente corresponde una OC según el lugar de entrega que trae el PDF
  function suggestClient(oc, aliases) {
    aliases = aliases || {};
    const d = norm(oc.delivery), a = norm(oc.address);
    if (d && aliases[d] && clientById(aliases[d])) return { id: aliases[d], how: "recordado" };
    for (const text of [d, a]) {
      if (!text) continue;
      const hits = CLIENTS.filter((c) => c.hints.some((h) => h.test(text)));
      if (hits.length === 1) return { id: hits[0].id, how: "sugerido" };
      if (hits.length > 1) { const best = hits.find((c) => c.title && c.title.test(text)); if (best) return { id: best.id, how: "sugerido" }; }
    }
    return { id: null, how: "" };
  }

  // Período de la OC: por defecto, la quincena de la fecha de entrega
  function defaultPeriodMode(oc) {
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(oc.deliveryDate || "");
    if (!m) return { mode: "", month: null, year: null };
    return { mode: Number(m[1]) <= 15 ? "q1" : "q2", month: Number(m[2]), year: Number(m[3]) };
  }
  function periodRange(mode, custom) {
    if (mode === "q1") return { from: 1, to: 15 };
    if (mode === "q2") return { from: 16, to: 31 };
    if (mode === "mes") return { from: 1, to: 31 };
    if (mode === "custom" && custom && custom.from && custom.to) return { from: Number(custom.from), to: Number(custom.to) };
    return null;
  }

  function findSheet(wb, name) {
    const t = norm(name), vis = wb.sheets.filter((s) => !s.hidden);
    return vis.find((s) => norm(s.name) === t) || vis.find((s) => norm(s.name).includes(t) || t.includes(norm(s.name))) || null;
  }

  // Hoja de datos = la que está justo antes de la hoja que identifica al cliente
  function sheetsFor(wb, client) {
    const all = wb.sheets.filter((s) => !s.hidden);
    const idSheet = findSheet(wb, client.sheet);
    if (!idSheet) return { error: "No encontré la hoja “" + client.sheet + "” en el Excel (hojas: " + all.map((s) => s.name).join(", ") + ")." };
    const i = all.indexOf(idSheet);
    return { idSheet, dataSheet: i > 0 ? all[i - 1] : null };
  }

  // ---- lectura de la hoja ----
  const DATE_STR = /^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/;
  function dayOf(cell) {
    if (cell && typeof cell === "object" && cell.date) return { d: cell.d, m: cell.m };
    if (typeof cell === "string") { const m = DATE_STR.exec(cell.trim()); if (m && Number(m[1]) >= 1 && Number(m[1]) <= 31 && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { d: Number(m[1]), m: Number(m[2]) }; }
    return null;
  }
  const txt = (c) => (typeof c === "string" ? c.trim() : "");
  const num = (c) => { if (typeof c === "number") return c; if (typeof c === "string") { const v = O.parseNumber(c); return v === null || Number.isNaN(v) ? null : v; } return null; };

  // Hoja con una fila por producto y una columna por día. Los encabezados «total quincena» (col. Q y AG) separan las dos quincenas.
  function extractGrid(sheet, range, out) {
    const rows = sheet.rows; let hdr = -1, tcols = [];
    for (let r = 0; r < Math.min(rows.length, 80) && hdr < 0; r++) {
      const t = []; (rows[r] || []).forEach((c, k) => { if (/^TOTAL\s+QUINCENA/.test(norm(txt(c)))) t.push(k); });
      if (t.length >= 2) { hdr = r; tcols = t; }
    }
    if (hdr < 0) { out.error = "En la hoja " + sheet.name + " no encontré los encabezados «total quincena»."; return; }
    const cols = []; let segStart = 1;
    tcols.forEach((tc, si) => {
      for (let k = segStart; k < tc; k++) { const day = si * 15 + (k - segStart) + 1; if (day >= range.from && day <= range.to) cols.push(k); }
      segStart = tc + 1;
    });
    if (!cols.length) { out.error = "En la hoja " + sheet.name + " no hay columnas entre el día " + range.from + " y el " + range.to + "."; return; }
    for (let r = hdr + 1; r < rows.length; r++) {
      const row = rows[r] || [], name = txt(row[0]);
      if (!name) { if (out.rows.length) break; continue; }                                  // la tabla termina en la primera fila sin nombre
      if (/^(total|totales|subtotal|suma)\b/i.test(name)) continue;
      let sum = 0; const invalid = [];
      for (const k of cols) { const c = row[k]; if (c === null || c === undefined || c === "") continue; const v = num(c); if (v === null) { if (typeof c === "string") invalid.push(c); } else sum += v; }
      out.rows.push({ line: r + 1, name, key: O.keyOf(name), sum: O.round(sum, 3), invalid });
    }
    out.info = "Hoja “" + sheet.name + "”, días " + range.from + " al " + Math.min(range.to, tcols.length * 15) + " (" + cols.length + " columnas)";
    if (!out.rows.length) out.warnings.push("No encontré productos debajo del encabezado.");
  }

  // Lista diaria (Fecha de entrega | Comedor | Categoria | Ingrediente | Cant.) de la hoja del cliente
  function extractList(sheet, client, range, month, out) {
    const rows = sheet.rows; let hdr = -1, cD = -1, cC = -1, cI = -1, cQ = -1;
    for (let r = 0; r < Math.min(rows.length, 30) && hdr < 0; r++) {
      const n = (rows[r] || []).map((c) => norm(txt(c)));
      const fd = n.findIndex((s) => /^FECHA/.test(s)), ig = n.findIndex((s) => /^INGREDIENTE|^PRODUCTO|^DESCRIPCION/.test(s)), q = n.findIndex((s) => /^CANT/.test(s));
      if (fd >= 0 && ig >= 0 && q >= 0) { hdr = r; cD = fd; cI = ig; cQ = q; cC = n.findIndex((s) => /^COMEDOR/.test(s)); }
    }
    if (hdr < 0) { out.error = "En la hoja " + sheet.name + " no encontré las columnas Fecha de entrega / Ingrediente / Cant."; return; }
    const map = new Map(); let seen = 0, other = 0;
    for (let r = hdr + 1; r < rows.length; r++) {
      const row = rows[r] || [], dd = dayOf(row[cD]); if (!dd) continue;
      const q = num(row[cQ]), name = txt(row[cI]); if (q === null || !name) continue;
      if (client.title && cC >= 0) { if (!client.title.test(norm(txt(row[cC])))) { other++; continue; } }
      seen++;
      if (dd.d < range.from || dd.d > range.to || (month && dd.m && dd.m !== month)) continue;
      const e = map.get(name) || { line: r + 1, name, key: O.keyOf(name), sum: 0, invalid: [] };
      e.sum += q; map.set(name, e);
    }
    map.forEach((e) => { e.sum = O.round(e.sum, 3); out.rows.push(e); });
    if (!seen) { out.error = "En la hoja " + sheet.name + " no encontré entregas de " + client.name + "."; return; }
    out.info = "Hoja “" + sheet.name + "”, días " + range.from + " al " + Math.min(range.to, 31);
    const odd = out.rows.filter((e) => !/PAN MIGNON BLANCO/.test(norm(e.name)));
    if (odd.length) out.warnings.push("Ojo: " + client.name + " normalmente lleva solo " + PAN + ", pero ese período trae también: " + odd.map((e) => e.name).join(", ") + ".");
    if (!out.rows.length) out.warnings.push("No hay entregas de " + client.name + " entre el día " + range.from + " y el " + range.to + ".");
  }

  // Control cruzado con la hoja anterior (solo trae el total del mes de Alcaidía / UP 59 / UP 60 en la columna AG, filas 5, 6 y 7)
  function crossCheckMerlo(dataSheet, client, range, out) {
    if (!dataSheet || client.mrow === undefined || range.from > 1 || range.to < 30) return;
    const vals = [];
    (dataSheet.rows || []).forEach((row, r) => { const v = num((row || [])[32]); if (v !== null && v > 0) vals.push(v); });
    const mine = vals[client.mrow], total = out.rows.reduce((s, e) => s + e.sum, 0);
    if (mine !== undefined && Math.abs(mine - total) > 0.05) out.warnings.push("La hoja " + dataSheet.name + " indica " + O.fmtQty(mine) + " para el mes y la lista diaria suma " + O.fmtQty(O.round(total, 3)) + ": revisá.");
  }

  function extractTable(wb, client, range, month) {
    const out = { rows: [], warnings: [], info: "", error: "" };
    if (!range) { out.error = "Elegí el período (quincena, mes o días)."; return out; }
    const s = sheetsFor(wb, client);
    if (s.error) { out.error = s.error; return out; }
    if (client.kind === "tabla") {
      if (!s.dataSheet) { out.error = "No hay ninguna hoja antes de “" + s.idSheet.name + "”."; return out; }
      extractGrid(s.dataSheet, range, out);
    } else {
      extractList(s.idSheet, client, range, month, out);
      if (!out.error) crossCheckMerlo(s.dataSheet, client, range, out);
    }
    return out;
  }

  const api = { CLIENTS, clientById, suggestClient, defaultPeriodMode, periodRange, findSheet, sheetsFor, extractTable, norm };
  if (typeof module === "object" && module.exports) module.exports = api; else root.Despachos = api;
})(typeof self !== "undefined" ? self : this);
