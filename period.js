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
      if (day > 15) return { mode, from: 1, to: 15, previousMonth: false, label: "1ª quincena" };
      const last = new Date(y, m, 0).getDate();               // días del mes anterior
      return { mode, from: 16, to: last, previousMonth: true, label: "2ª quincena del mes anterior" };
    }
    const lastDay = new Date(y, m + 1, 0).getDate();
    const wk = Math.floor((day - 1) / 7);                     // 0..4
    const from = wk * 7 + 1;
    const to = wk >= 4 ? lastDay : from + 6;
    return { mode: "semanal", from, to, previousMonth: false, label: "semana " + (wk + 1) + " del mes" };
  }

  const cleanOc = (s) => String(s || "").replace(/\D+/g, "");
  const fileName = (oc, p) => "REMITOS_" + cleanOc(oc) + "_" + p.from + "_al_" + p.to;
  const text = (p) => p.from + " al " + p.to;

  const api = { forDate, fileName, cleanOc, text };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Period = api;
})(typeof self !== "undefined" ? self : this);
