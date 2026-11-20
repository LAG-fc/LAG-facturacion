// period.js — Período del lote de remitos y nombre del PDF.
//   Semanal:   semanas del mes en bloques de 7 días (1–7, 8–14, 15–21, 22–28 y 29–fin de mes); se usa la semana actual.
//   Quincenal: del 16 en adelante se escanea la 1.ª quincena del mes (1 al 15);
//              del 1 al 15 se escanea la 2.ª quincena del mes anterior (16 al último día de ese mes).
// El nombre queda REMITOS_<OC>_<desde>_al_<hasta> (sin el mes).
(function (root) {
  "use strict";

  function forDate(mode, d) {
    d = d || new Date();
    const y = d.getFullYear(), m = d.getMonth(), day = d.getDate();
    if (mode === "quincenal") {
      if (day > 15) return { mode, from: 1, to: 15, year: y, month: m + 1, previousMonth: false, label: "1ª quincena" };
      const last = new Date(y, m, 0).getDate();               // días del mes anterior
      const pm = new Date(y, m - 1, 1);                       // el mes anterior (maneja enero -> diciembre)
      return { mode, from: 16, to: last, year: pm.getFullYear(), month: pm.getMonth() + 1, previousMonth: true, label: "2ª quincena del mes anterior" };
    }
    const lastDay = new Date(y, m + 1, 0).getDate();
    const wk = Math.floor((day - 1) / 7);                     // 0..4
    const from = wk * 7 + 1;
    const to = wk >= 4 ? lastDay : from + 6;
    return { mode: "semanal", from, to, year: y, month: m + 1, previousMonth: false, label: "semana " + (wk + 1) + " del mes" };
  }

  const cleanOc = (s) => String(s || "").replace(/\D+/g, "");
  const fileName = (oc, p) => "REMITOS_" + cleanOc(oc) + "_" + p.from + "_al_" + p.to;
  const text = (p) => p.from + " al " + p.to;

  // ---- Drive / Gmail ----
  const MESES = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];
  const two = (n) => String(n).padStart(2, "0");
  const monthName = (p) => MESES[p.month - 1];
  // Carpeta en Drive: OC-<año> / <MES> / OC-<número>
  const folderPath = (oc, p) => "OC-" + p.year + "/" + monthName(p) + "/OC-" + cleanOc(oc);
  // "15/11 al 21/11"
  const dateRange = (p) => two(p.from) + "/" + two(p.month) + " al " + two(p.to) + "/" + two(p.month);
  const greeting = (d) => { const h = (d || new Date()).getHours(); return h < 12 ? "Buenos días" : h < 20 ? "Buenas tardes" : "Buenas noches"; };
  const emailSubject = (oc, p) => "Remitos OC " + cleanOc(oc) + " \u2013 per\u00edodo " + text(p);
  const emailBody = (oc, p, d) => greeting(d) + ",\nadjunto remitos correspondientes a la OC " + cleanOc(oc) + " (periodo " + dateRange(p) + ").\nSaludos.";

  const api = { forDate, fileName, cleanOc, text, monthName, folderPath, dateRange, greeting, emailSubject, emailBody };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Period = api;
})(typeof self !== "undefined" ? self : this);
