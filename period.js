// period.js — Período de un lote de remitos, nombre del PDF y carpeta de Drive.
//   Cook Master (quincenal): 1.ª quincena (1 al 15) o 2.ª quincena (16 al último día del mes).
//     Del 16 en adelante se escanea la 1.ª quincena del mes; del 1 al 15, la 2.ª quincena del mes anterior.
//   Grupo L (semanal): la semana del Excel de despachos ("SEMANA DEL 16.11 AL 21.11"), recortada al mes de la OC.
//     Sin Excel se usan bloques de 7 días del mes (1–7, 8–14, 15–21, 22–28 y 29–fin de mes).
// Un período es {mode, from, to, year, month, label} (+ toMonth/toYear si termina en otro mes).
// El PDF se llama REMITOS_<OC>_<desde>_al_<hasta> (con el mes si el período cruza de mes).
// Período a facturar HOY (v9.1, periodoActual):
//   Cook Master se factura el 15 (1.ª quincena) y el último día del mes (2.ª quincena). Entre esas fechas sigue a la
//   vista la última quincena facturada (para terminar lo que falte): del 15 al 29 → 1.ª quincena del mes; del 30 (o el
//   último día) al 14 del mes siguiente → 2.ª quincena.
//   Grupo L se factura por semana: la semana de lunes a sábado en la que está el día de hoy (el domingo cuenta la que
//   terminó el sábado).
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

  // Quincena de Cook Master que corresponde facturar hoy
  function quincenaActual(d) {
    d = d || new Date();
    const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    if (day < 15) { const pm = new Date(y, m - 2, 1); return quincena(pm.getFullYear(), pm.getMonth() + 1, 2); }
    if (day >= Math.min(30, lastDay(y, m))) return quincena(y, m, 2);
    return quincena(y, m, 1);
  }
  // Semana de Grupo L (lunes a sábado) en la que está el día de hoy: {desde, hasta}
  function semanaActual(d) {
    d = d || new Date();
    const dow = d.getDay(), back = dow === 0 ? 6 : dow - 1;
    const lun = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back), sab = new Date(lun.getFullYear(), lun.getMonth(), lun.getDate() + 5);
    const f = (x) => ({ y: x.getFullYear(), m: x.getMonth() + 1, d: x.getDate() });
    return { desde: f(lun), hasta: f(sab) };
  }
  // ¿Se superponen dos rangos de fechas {desde, hasta}?
  const k = (f) => f.y * 10000 + f.m * 100 + f.d;
  const overlaps = (a, b) => k(a.desde) <= k(b.hasta) && k(b.desde) <= k(a.hasta);
  // Un rango de fechas partido por mes (cada OC de Grupo L es de un mes)
  function splitByMonth(desde, hasta, mode, label) {
    const out = [];
    let a = desde;
    while (k(a) <= k(hasta)) {
      const ld = lastDay(a.y, a.m), endK = Math.min(k(hasta), a.y * 10000 + a.m * 100 + ld);
      const b = { y: Math.floor(endK / 10000), m: Math.floor(endK / 100) % 100, d: endK % 100 };
      out.push(range(a, b, mode, label));
      const nx = new Date(b.y, b.m - 1, b.d + 1); a = { y: nx.getFullYear(), m: nx.getMonth() + 1, d: nx.getDate() };
    }
    return out;
  }

  const cleanOc = (s) => String(s || "").replace(/\D+/g, "");
  const fileName = (oc, p) => "REMITOS_" + cleanOc(oc) + "_" + (crosses(p) ? p.from + "-" + p.month + "_al_" + p.to + "-" + p.toMonth : p.from + "_al_" + p.to);
  // "1 al 15" · "29/6 al 3/7"
  const text = (p) => (crosses(p) ? p.from + "/" + p.month + " al " + p.to + "/" + p.toMonth : p.from + " al " + p.to);

  // ---- Drive / Gmail ----
  const MESES = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];
  const monthName = (p) => MESES[p.month - 1];
  const CLIENT_FOLDER = { cookmaster: "Cook Master", grupol: "Grupo L" };
  // Carpeta del período de facturación: "1ª quincena (1 al 15)" (Cook Master) o "Semana 16 al 21" (Grupo L)
  function periodFolder(cliente, p) {
    const t = crosses(p) ? p.from + "-" + p.month + " al " + p.to + "-" + p.toMonth : p.from + " al " + p.to;
    if (cliente === "grupol") return "Semana " + t;
    if (p.from === 1 && p.to === 15) return "1ª quincena (" + t + ")";
    if (p.from === 16 && p.to === lastDay(p.year, p.month)) return "2ª quincena (" + t + ")";
    return "Período " + t;
  }
  // Carpeta en Drive (Mi unidad): OC-<año> / <Cliente> / <MES> / <período de facturación>
  const folderPath = (cliente, p) => "OC-" + p.year + "/" + (CLIENT_FOLDER[cliente] || "Cliente") + "/" + monthName(p) + "/" + periodFolder(cliente, p);
  // "15/11 al 21/11"
  const dateRange = (p) => two(p.from) + "/" + two(p.month) + " al " + two(p.to) + "/" + two(p.toMonth || p.month);
  const greeting = (d) => { const h = (d || new Date()).getHours(); return h < 12 ? "Buenos días" : h < 20 ? "Buenas tardes" : "Buenas noches"; };
  const emailSubject = (oc, p) => "Remitos OC " + cleanOc(oc) + " – período " + text(p);
  const emailBody = (oc, p, d) => greeting(d) + ",\nadjunto remitos correspondientes a la OC " + cleanOc(oc) + " (periodo " + dateRange(p) + ").\nSaludos.";
  const invoiceSubject = (oc, p, nro) => "Factura " + nro + " y remitos OC " + cleanOc(oc) + " – período " + text(p);
  const invoiceBody = (oc, p, nro, d) => greeting(d) + ",\nadjunto la factura " + nro + " y los remitos correspondientes a la OC " + cleanOc(oc) + " (periodo " + dateRange(p) + ").\nSaludos.";

  const api = { forDate, quincena, quincenaActual, semanaActual, overlaps, splitByMonth, periodFolder, range, startOf, endOf, crosses, days, id, same, lastDay, fileName, cleanOc, text, monthName, MESES, CLIENT_FOLDER, folderPath, dateRange, greeting, emailSubject, emailBody, invoiceSubject, invoiceBody };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Period = api;
})(typeof self !== "undefined" ? self : this);
