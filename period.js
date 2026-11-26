// period.js — Período de un lote de remitos, nombre del PDF y carpeta de Drive.
//   Cook Master (quincenal): 1.ª quincena (1 al 15) o 2.ª quincena (16 al último día del mes).
//     Del 16 en adelante se escanea la 1.ª quincena del mes; del 1 al 15, la 2.ª quincena del mes anterior.
//   Grupo L (semanal): la semana del Excel de despachos ("SEMANA DEL 16.11 AL 21.11"), recortada al mes de la OC.
//     Sin Excel se usan bloques de 7 días del mes (1–7, 8–14, 15–21, 22–28 y 29–fin de mes).
// Un período es {mode, from, to, year, month, label} (+ toMonth/toYear si termina en otro mes).
// El PDF se llama REMITOS_<OC>_<desde>_al_<hasta> (con el mes si el período cruza de mes).
(function (root) {
  "use strict";
  const lastDay = (y, m) => new Date(y, m, 0).getDate();          // m: 1-12

  function quincena(y, m, half) {
    return half === 1
      ? { mode: "quincenal", from: 1, to: 15, year: y, month: m, label: "1ª quincena" }
      : { mode: "quincenal", from: 16, to: lastDay(y, m), year: y, month: m, label: "2ª quincena" };
  }

  function forDate(mode, d) {
    d = d || new Date();
    const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
    if (mode === "quincenal") {
      if (day > 15) return Object.assign(quincena(y, m + 1, 1), { previousMonth: false });
      const pm = new Date(y, m - 1, 1);                       // el mes anterior (maneja enero -> diciembre)
      return Object.assign(quincena(pm.getFullYear(), pm.getMonth() + 1, 2), { previousMonth: true, label: "2ª quincena del mes anterior" });
    }
    const wk = Math.floor((day - 1) / 7);                     // 0..4
    const from = wk * 7 + 1;
    const to = wk >= 4 ? lastDay(y, m + 1) : from + 6;
    return { mode: "semanal", from, to, year: y, month: m + 1, previousMonth: false, label: "semana " + (wk + 1) + " del mes" };
  }

  // Período entre dos fechas {y, m, d} (por ejemplo, la semana de Grupo L)
  function range(desde, hasta, mode, label) {
    const p = { mode: mode || "semanal", from: desde.d, to: hasta.d, year: desde.y, month: desde.m, label: label || "semana" };
    if (hasta.m !== desde.m || hasta.y !== desde.y) { p.toMonth = hasta.m; p.toYear = hasta.y; }
    return p;
  }
  const startOf = (p) => ({ y: p.year, m: p.month, d: p.from });
  const endOf = (p) => ({ y: p.toYear || p.year, m: p.toMonth || p.month, d: p.to });
  const crosses = (p) => !!(p.toMonth && (p.toMonth !== p.month || (p.toYear || p.year) !== p.year));
  // Cantidad de días del período (en Cook Master hay un remito por día: 15 o 16 por quincena)
  function days(p) {
    const a = Date.UTC(p.year, p.month - 1, p.from), e = endOf(p), b = Date.UTC(e.y, e.m - 1, e.d);
    return Math.round((b - a) / 864e5) + 1;
  }
  // Identificador estable del período ("2026-11-01_2026-11-15")
  const two = (n) => String(n).padStart(2, "0");
  const iso = (f) => f.y + "-" + two(f.m) + "-" + two(f.d);
  const id = (p) => iso(startOf(p)) + "_" + iso(endOf(p));
  const same = (a, b) => !!(a && b) && id(a) === id(b);

  const cleanOc = (s) => String(s || "").replace(/\D+/g, "");
  const fileName = (oc, p) => "REMITOS_" + cleanOc(oc) + "_" + (crosses(p) ? p.from + "-" + p.month + "_al_" + p.to + "-" + p.toMonth : p.from + "_al_" + p.to);
  // "1 al 15" · "29/6 al 3/7"
  const text = (p) => (crosses(p) ? p.from + "/" + p.month + " al " + p.to + "/" + p.toMonth : p.from + " al " + p.to);

  // ---- Drive / Gmail ----
  const MESES = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];
  const monthName = (p) => MESES[p.month - 1];
  const CLIENT_FOLDER = { cookmaster: "Cook Master", grupol: "Grupo L" };
  // Carpeta en Drive (Mi unidad): OC-<año> / <Cliente> / OC-<número>
  const folderPath = (oc, p, cliente) => "OC-" + p.year + "/" + (CLIENT_FOLDER[cliente] || "Cliente") + "/OC-" + cleanOc(oc);
  // "15/11 al 21/11"
  const dateRange = (p) => two(p.from) + "/" + two(p.month) + " al " + two(p.to) + "/" + two(p.toMonth || p.month);
  const greeting = (d) => { const h = (d || new Date()).getHours(); return h < 12 ? "Buenos días" : h < 20 ? "Buenas tardes" : "Buenas noches"; };
  const emailSubject = (oc, p) => "Remitos OC " + cleanOc(oc) + " – período " + text(p);
  const emailBody = (oc, p, d) => greeting(d) + ",\nadjunto remitos correspondientes a la OC " + cleanOc(oc) + " (periodo " + dateRange(p) + ").\nSaludos.";
  const invoiceSubject = (oc, p, nro) => "Factura " + nro + " y remitos OC " + cleanOc(oc) + " – período " + text(p);
  const invoiceBody = (oc, p, nro, d) => greeting(d) + ",\nadjunto la factura " + nro + " y los remitos correspondientes a la OC " + cleanOc(oc) + " (periodo " + dateRange(p) + ").\nSaludos.";

  const api = { forDate, quincena, range, startOf, endOf, crosses, days, id, same, lastDay, fileName, cleanOc, text, monthName, MESES, CLIENT_FOLDER, folderPath, dateRange, greeting, emailSubject, emailBody, invoiceSubject, invoiceBody };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Period = api;
})(typeof self !== "undefined" ? self : this);
