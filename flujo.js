// flujo.js — Lógica del flujo de facturación (sin pantalla, se prueba en Node).
//
// Una "unidad de facturación" es una OC + un período:
//   · Cook Master: cada OC del mes se factura por quincena (1 al 15 y 16 al fin de mes). Un remito por día.
//   · Grupo L: una OC por mes que se factura por semana (la semana de cada Excel de despachos, recortada al mes).
// Pasos de cada unidad: 1) remitos escaneados y guardados en Drive (con la tabla de recepciones confirmada contra el
// Excel de despachos), 2) factura de ARCA cargada (planilla de Facturación), 3) envío (Grupo L: WhatsApp; Cook Master:
// mail con los remitos —portal— o con remitos y factura —mail—).
(function (root) {
  "use strict";
  const req = (n, g) => ((typeof require === "function" && typeof module === "object") ? require(n) : root[g]);
  const O = req("./ocparse.js", "OcParse"), D = req("./despachos.js", "Despachos"), G = req("./grupol.js", "GrupoL"), P = req("./period.js", "Period");

  const CLIENTES = {
    cookmaster: { id: "cookmaster", nombre: "Cook Master", periodo: "quincenal", envio: "mail", hoja: 2 },
    grupol: { id: "grupol", nombre: "Grupo L", periodo: "semanal", envio: "whatsapp", hoja: 1 }
  };
  const clienteDe = (txt) => (/GRUPO\s*L\b/i.test(String(txt || "")) ? "grupol" : /COOK/i.test(String(txt || "")) ? "cookmaster" : null);
  const TOL = 0.005;                                                // diferencia admitida entre cantidades (kg o unidades)

  // ---------- Sede de Cook Master (comedor) ----------
  // Cómo se nombra la sede en la planilla de Facturación ("Cook Master OC 93032 (1 al 15/11) Penal")
  const SEDE_PLANILLA = { cc: "C.Contencion", cs: "Penal", lp: "La plata", up59: "UP 59", up60: "UP 60", alc: "Alcaida" };
  function sedeLabel(oc) {
    if (!oc) return "";
    if (SEDE_PLANILLA[oc.sede]) return SEDE_PLANILLA[oc.sede];
    const d = String(oc.delivery || "").replace(/\s+/g, " ").trim();
    return d.split(/\s+/).slice(0, 3).join(" ").replace(/\b([A-ZÁÉÍÓÚÑ])([A-ZÁÉÍÓÚÑ]+)\b/g, (m, a, b) => a + b.toLowerCase());
  }
  const sedeNombre = (oc) => { const c = oc && D.clientById(oc.sede); return c && c.id !== "otro" ? c.name : String((oc && oc.delivery) || "").trim(); };

  // ---------- Armar el registro de una OC leída del PDF ----------
  // parsed: lo que devuelve OcParse.parseAnyOc; ctx: {cliente, anio, mes, archivo, aliases (sedes recordadas)}
  function ocRecord(parsed, ctx) {
    const sol = O.solveIva(parsed.items, parsed.totals);
    const items = parsed.items.map((it, i) => {
      let iva = sol.assign[i], src = sol.src[i];
      if ((iva === null || iva === undefined) && parsed.format === "sap") { iva = 10.5; src = "el habitual del pan (10,5 %)"; }
      return { desc: it.desc, short: O.shortName(it.desc), price: it.price, qty: it.qty, importe: it.importe, iva: iva === undefined ? null : iva, ivaSrc: src || "", unit: it.unit || "" };
    });
    const rec = {
      id: ctx.cliente + "-" + parsed.ocNumber, cliente: ctx.cliente, numero: parsed.ocNumber, anio: ctx.anio, mes: ctx.mes,
      archivo: ctx.archivo || null, format: parsed.format || "", emission: parsed.emission, delivery: parsed.delivery, address: parsed.address,
      deliveryDate: parsed.deliveryDate, items, totals: parsed.totals, solver: { status: parsed.format === "sap" && sol.status === "none" ? "default" : sol.status, message: sol.message },
      warnings: parsed.warnings || [], sede: "", sedeHow: ""
    };
    if (ctx.cliente === "cookmaster") { const s = D.suggestClient(parsed, ctx.aliases || {}); rec.sede = s.id || "otro"; rec.sedeHow = s.id ? s.how : "sin reconocer"; }
    return rec;
  }

  // ---------- Períodos de cada OC ----------
  // weeklies: Excel semanales de Grupo L del mes (GrupoL.parseWeekly)
  function periodsFor(cliente, anio, mes, weeklies) {
    if (cliente === "cookmaster") return [P.quincena(anio, mes, 1), P.quincena(anio, mes, 2)];
    const out = [], seen = new Set(), last = P.lastDay(anio, mes);
    for (const w of weeklies || []) {
      if (!w || w.error || !w.desde || !w.hasta) continue;
      const a = Math.max(w.desde.y * 10000 + w.desde.m * 100 + w.desde.d, anio * 10000 + mes * 100 + 1);
      const b = Math.min(w.hasta.y * 10000 + w.hasta.m * 100 + w.hasta.d, anio * 10000 + mes * 100 + last);
      if (a > b) continue;
      const f = (k) => ({ y: Math.floor(k / 10000), m: Math.floor(k / 100) % 100, d: k % 100 });
      const p = P.range(f(a), f(b), "semanal", "semana del Excel");
      if (!seen.has(P.id(p))) { seen.add(P.id(p)); out.push(p); }
    }
    return out.sort((x, y) => P.id(x) < P.id(y) ? -1 : 1);
  }
  const ended = (p, today) => { const e = P.endOf(p), t = today || new Date(); return new Date(e.y, e.m - 1, e.d, 23, 59) < t; };
  const started = (p, today) => { const t = today || new Date(); return new Date(p.year, p.month - 1, p.from) <= t; };

  // ---------- Unidades de facturación ----------
  const unitKey = (cliente, oc, p) => cliente + "|" + P.cleanOc(oc) + "|" + P.id(p);
  const ESTADO_ORDEN = { enviado: 3, lista: 2, pendiente: 1 };
  // El lote (remitos escaneados) más avanzado de una OC y período
  function loteFor(lotes, oc, p) {
    const c = (lotes || []).filter((l) => l && l.tabla && P.cleanOc(l.tabla.oc) === P.cleanOc(oc) && l.periodo && P.same(l.periodo, p));
    c.sort((a, b) => ((ESTADO_ORDEN[b.estado] || 0) - (ESTADO_ORDEN[a.estado] || 0)) || ((b.creado || 0) - (a.creado || 0)));
    return c[0] || null;
  }
  // scan: {meses: [{anio, mes, clientes: {cookmaster: {ocs}, grupol: {ocs, semanas}}}]}; lotes: los lotes guardados;
  // estados: {clave de la unidad: estado guardado (tabla confirmada, PDF, factura, envío…)}
  function units(scan, lotes, estados, today) {
    estados = estados || {};
    const out = [], seen = new Set();
    for (const m of (scan && scan.meses) || []) {
      for (const cid of Object.keys(CLIENTES)) {
        const c = (m.clientes || {})[cid]; if (!c) continue;
        for (const oc of c.ocs || []) {
          for (const p of periodsFor(cid, m.anio, m.mes, c.semanas)) {
            const k = unitKey(cid, oc.numero, p); if (seen.has(k)) continue; seen.add(k);
            out.push({ key: k, cliente: cid, oc, periodo: p, lote: loteFor(lotes, oc.numero, p), estado: estados[k] || null, anio: m.anio, mes: m.mes, ended: ended(p, today), started: started(p, today) });
          }
        }
      }
    }
    // Remitos guardados (o estados) de OC o períodos que no aparecen en Drive: otros meses, períodos elegidos a mano
    const extra = (cidHint, ocNum, periodo) => {
      const known = out.find((u) => u.oc.numero === P.cleanOc(ocNum));
      const cid = cidHint || (known && known.cliente) || "cookmaster";
      const k = unitKey(cid, ocNum, periodo); if (seen.has(k)) return; seen.add(k);
      out.push({ key: k, cliente: cid, oc: known ? known.oc : { numero: P.cleanOc(ocNum), cliente: cid, items: [], missing: true }, periodo, lote: loteFor(lotes, ocNum, periodo), estado: estados[k] || null,
        anio: periodo.year, mes: periodo.month, ended: ended(periodo, today), started: true, extra: true });
    };
    for (const l of lotes || []) if (l && l.tabla && P.cleanOc(l.tabla.oc) && l.periodo) extra(l.tabla.cliente || "", l.tabla.oc, l.periodo);
    Object.keys(estados).forEach((k) => { const e = estados[k]; if (e && e.oc && e.periodo && e.cliente) extra(e.cliente, e.oc, e.periodo); });
    return out.sort((a, b) => (b.anio * 100 + b.mes) - (a.anio * 100 + a.mes) || (a.cliente < b.cliente ? -1 : a.cliente > b.cliente ? 1 : 0) ||
      String(a.oc.numero).localeCompare(String(b.oc.numero), undefined, { numeric: true }) || (P.id(a.periodo) < P.id(b.periodo) ? -1 : 1));
  }

  // ---------- Despachos (Excel) de una unidad ----------
  // ctx: {workbook(anio, mes) -> Xlsx de Cook Master | null, weeklies(anio, mes) -> [Excel semanales de Grupo L]}
  function despachos(unit, ctx) {
    const p = unit.periodo, oc = unit.oc;
    if (unit.cliente === "grupol") {
      const ws = (ctx.weeklies && ctx.weeklies(unit.anio, unit.mes)) || [];
      if (!ws.length) return { rows: [], error: "Todavía no hay Excel de despachos de Grupo L para este mes.", missing: true };
      const t = G.totals(ws, P.startOf(p), P.endOf(p));
      if (!t.dias) return { rows: [], error: "El Excel de despachos no tiene entregas del " + P.text(p) + ".", missing: true };
      return { rows: t.rows, info: "Excel semanal de Grupo L: " + t.dias + (t.dias === 1 ? " día" : " días") + " con entregas", warnings: [], dias: t.dias };
    }
    const wb = ctx.workbook && ctx.workbook(unit.anio, unit.mes);
    if (!wb) return { rows: [], error: "Todavía no está el Excel de despachos de Cook Master de este mes en Drive.", missing: true };
    const cl = D.clientById(oc.sede) || D.clientById("otro"), r = { from: p.from, to: p.to };
    let res;
    if (cl.kind === "oc") {
      const sheet = oc.otherSheet || D.findOtherSheet(wb, oc.delivery);
      res = sheet ? Object.assign(D.extractOther(wb, sheet, r, p.month), { sheet, auto: !oc.otherSheet })
        : { rows: [], error: "No encontré en el Excel la hoja de esta sede (" + sedeNombre(oc) + "): elegila a mano.", missing: true, needSheet: true };
    } else res = D.extractTable(wb, cl, r, p.month);
    return Object.assign({ warnings: [] }, res);
  }

  // ---------- Cantidades por producto de la OC ----------
  // rows: [{name, key, sum}] (Excel, tabla de recepciones…). Devuelve {qty: [por producto de la OC], pending: [filas sin asignar]}
  function qtyByItem(rows, items, aliases, overrides) {
    const qty = items.map(() => 0), pending = [];
    const matches = O.matchRows(rows, items, aliases || {}, overrides || {});
    rows.forEach((r, k) => {
      const t = matches[k].target;
      if (t === null || t === undefined) { if (r.sum > 0) pending.push({ name: r.name, sum: r.sum, suggestions: matches[k].suggestions }); return; }
      if (t >= 0) qty[t] = O.round(qty[t] + (r.sum || 0), 3);
    });
    return { qty, pending, matches };
  }
  // Filas de la tabla de recepciones de un lote (Lotes.recepcionOf o el lote mismo)
  function remitosRows(rec) {
    const filas = (rec && rec.filas) || [];
    return filas.filter((f) => f && String(f.nombre || "").trim() && typeof f.total === "number").map((f) => ({ name: f.nombre, key: O.keyOf(f.nombre), sum: f.total }));
  }

  // ---------- Comparación remitos vs despachos ----------
  function compare(items, rem, desp) {
    const lines = [];
    items.forEach((it, i) => {
      const a = rem.qty[i] || 0, b = desp.qty[i] || 0;
      if (!a && !b) return;
      lines.push({ i, desc: it.short || it.desc, remitos: a, despachos: b, diff: O.round(a - b, 3), ok: Math.abs(a - b) <= TOL });
    });
    const ok = lines.length > 0 && lines.every((l) => l.ok) && !rem.pending.length && !desp.pending.length;
    return { lines, ok, pendingRem: rem.pending, pendingDesp: desp.pending };
  }

  // ---------- Tabla de facturación ----------
  function billing(items, qty) {
    const rows = qty.map((q) => ({ sum: q || 0 })), matches = qty.map((_, i) => ({ target: i }));
    return O.buildInvoice(items, rows, matches);
  }
  // Cantidades a facturar de una unidad: la tabla confirmada (despachos reales si no coincidía) o la de los remitos; si
  // todavía no hay remitos, las del Excel de despachos. Devuelve {qty, source, pending}
  function quantities(unit, ctx, aliases) {
    const items = unit.oc.items || [], f = unit.estado || {};
    if (f.tablaReal && f.tablaReal.length) {
      const q = qtyByItem(f.tablaReal.map((r) => ({ name: r.nombre, key: O.keyOf(r.nombre), sum: r.total })), items, aliases);
      return { qty: q.qty, pending: q.pending, source: "real" };
    }
    if (f.remitos && f.remitos.length) {                            // totales de la tabla de recepciones confirmada
      const q = qtyByItem(f.remitos.map((r) => ({ name: r.nombre, key: O.keyOf(r.nombre), sum: r.total })), items, aliases);
      if (q.qty.some((v) => v > 0)) return { qty: q.qty, pending: q.pending, source: "remitos" };
    }
    if (unit.lote && unit.recepcion) {
      const q = qtyByItem(remitosRows(unit.recepcion), items, aliases);
      if (q.qty.some((v) => v > 0)) return { qty: q.qty, pending: q.pending, source: "remitos" };
    }
    const d = despachos(unit, ctx);
    if (!d.error && d.rows.length) { const q = qtyByItem(d.rows, items, aliases); return { qty: q.qty, pending: q.pending, source: "excel", info: d.info }; }
    return { qty: items.map(() => 0), pending: [], source: "none", error: d.error };
  }

  // ---------- Planilla de Facturación ----------
  const rangoCorto = (p) => (P.crosses(p) ? p.from + "/" + p.month + " al " + p.to + "/" + p.toMonth : p.from + " al " + p.to + "/" + p.month);
  function descripcion(unit) {
    if (unit.cliente === "grupol") return "Grupo L (sem " + rangoCorto(unit.periodo) + ")";
    return ("Cook Master OC " + unit.oc.numero + " (" + rangoCorto(unit.periodo) + ") " + sedeLabel(unit.oc)).trim();
  }
  // Control de la factura leída contra la tabla de facturación
  function checkInvoice(inv, bill, cliente) {
    const out = [];
    if (!inv || !inv.ok) return { ok: false, notes: ["No pude leer el importe total de la factura."] };
    const tol = Math.max(1, (bill.total || 0) * 0.0005);
    if (bill && bill.total > 0) {
      const d = O.round(inv.total - bill.total, 2);
      if (Math.abs(d) > tol) out.push("El total de la factura ($ " + O.fmtMoney(inv.total) + ") no coincide con la tabla de facturación ($ " + O.fmtMoney(bill.total) + "): diferencia $ " + O.fmtMoney(Math.abs(d)) + ".");
    }
    if (inv.receptor) {
      const okRec = cliente === "grupol" ? /TEYLEM|GRUPO\s*L|BLUE CATERING|EQUIS QUINCE|FORAIN|LOGISTICAL|ATLANTICO/i.test(inv.receptor) : /COOK\s*MASTER/i.test(inv.receptor);
      if (!okRec) out.push("La factura está a nombre de «" + inv.receptor + "», que no parece " + CLIENTES[cliente].nombre + ".");
    }
    if (inv.sign < 0) out.push("Es una nota de crédito: en la planilla se anota en negativo.");
    return { ok: out.length === 0, notes: out };
  }
  // Fila para la planilla (la columna FC y REMITOS ENV se completan al enviar)
  function filaPlanilla(unit, inv, descr) {
    const s = inv.sign < 0 ? -1 : 1, F = req("./factparse.js", "FactParse");
    return {
      fecha: inv.date, numero: String(Number(inv.numero || 0) || ""), tipo: F.planillaTipo(inv.code, inv.asociado) || inv.letter || "",
      descripcion: descr || descripcion(unit), subtotal: O.round(s * (inv.neto != null ? inv.neto : inv.total - (inv.iva || 0)), 2),
      iva: O.round(s * (inv.iva || 0), 2), total: O.round(s * inv.total, 2), estado: "DEBE"
    };
  }

  // ---------- Progreso de una unidad ----------
  // Devuelve {pasos: [{id, label, estado: "hecho"|"listo"|"falta"|"no", texto}], hechos, total, porcentaje, siguiente}
  function progress(unit) {
    const l = unit.lote, f = unit.estado || {}, gl = unit.cliente === "grupol";
    const pasos = [];
    const pdfOk = !!(f.pdf && f.pdf.id) || !!unit.pdfEnDrive;
    pasos.push({ id: "remitos", label: "Remitos", estado: pdfOk ? "hecho" : l ? "listo" : "falta",
      texto: pdfOk ? "PDF en Drive" + (f.confirmacion === "real" ? " (con despachos reales)" : f.confirmacion === "sin-excel" ? " (sin Excel para comparar)" : "") : l ? "Escaneados: falta confirmar la tabla" : unit.started ? "Faltan escanear" : "Período sin empezar" });
    const fac = f.factura;
    pasos.push({ id: "factura", label: "Factura", estado: fac ? "hecho" : pdfOk ? "listo" : "falta",
      texto: fac ? "N.º " + (fac.nro || fac.numero) + " · $ " + O.fmtMoney(fac.total) + (f.planilla && f.planilla.fila ? " · en la planilla" : "") : pdfOk ? "Lista para facturar" : "Falta" });
    let env;
    if (gl) env = { id: "envio", label: "WhatsApp", estado: f.wpp ? "hecho" : fac ? "listo" : "falta", texto: f.wpp ? "Factura enviada por WhatsApp" : fac ? "Falta mandar la factura" : "Falta" };
    else {
      const canal = f.envio === "mail" ? "Mail" : f.envio === "portal" ? "Portal" : "";
      const ready = pdfOk && fac && f.envio && (f.envio === "portal" || (f.factura && f.factura.id));
      env = { id: "envio", label: "Mail", estado: f.mail && f.mail.enviado ? "hecho" : ready ? "listo" : "falta",
        texto: f.mail && f.mail.enviado ? "Enviado (" + canal.toLowerCase() + ")" : ready ? "Listo para enviar (" + canal.toLowerCase() + ")" : fac && !f.envio ? "Elegí Portal o Mail" : "Falta" };
    }
    pasos.push(env);
    const hechos = pasos.filter((p) => p.estado === "hecho").length;
    const sig = pasos.find((p) => p.estado !== "hecho");
    return { pasos, hechos, total: pasos.length, porcentaje: Math.round(hechos / pasos.length * 100), completa: hechos === pasos.length, siguiente: sig ? sig.id : null };
  }

  const api = { CLIENTES, clienteDe, TOL, SEDE_PLANILLA, sedeLabel, sedeNombre, ocRecord, periodsFor, units, unitKey, loteFor, despachos, qtyByItem, remitosRows, compare, billing, quantities, descripcion, rangoCorto, checkInvoice, filaPlanilla, progress, ended };
  if (typeof module === "object" && module.exports) module.exports = api; else root.Flujo = api;
})(typeof self !== "undefined" ? self : this);
