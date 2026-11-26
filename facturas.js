// facturas.js — Sección "Facturas" (v9.0).
// Para cada OC y período: la tabla de facturación (cantidades de la tabla de recepciones confirmada —o de los
// despachos reales—, precios e IVA de la OC) y la carga de la factura hecha en ARCA:
//   1) se lee el PDF (número, tipo, fecha, neto, IVA, total) y se controla contra la tabla de facturación;
//   2) se guarda en la carpeta de la OC en Drive (Mi unidad / OC-año / Cliente / OC-número);
//   3) se agrega una fila nueva en la planilla de Facturación (Grupo L: 1.ª hoja; Cook Master: 2.ª hoja);
//   4) Grupo L: se manda por WhatsApp. Cook Master: se elige «Portal» o «Mail» (lo usa «Enviar mails»).
(() => {
  "use strict";
  const A = window.App, P = window.Period, O = window.OcParse, F = window.Flujo, FP = window.FactParse, U = window.UnidadesStore, $ = (id) => document.getElementById(id);
  const esc = A.esc, ICON = (n) => '<svg class="i"><use href="#i-' + n + '"/></svg>';
  const money = (v) => "$ " + O.fmtMoney(v);
  const RATES = [10.5, 21, 27, 0];
  const listEl = $("factList"), mainEl = $("factMain");
  let filter = "pendientes", selKey = "", pending = null, busy = false;   // pending: factura leída que todavía no se guardó
  const blobs = new Map();                                                 // clave de la unidad -> PDF de la factura (para WhatsApp)
  const Dt = () => window.Datos;

  const cliTag = (c) => (c === "grupol" ? '<span class="cli gl">GL</span>' : '<span class="cli cm">CM</span>');
  const unitName = (u) => "OC " + u.oc.numero + " · " + (u.cliente === "grupol" ? "Grupo L" : F.sedeLabel(u.oc) || "Cook Master");
  const perName = (u) => P.text(u.periodo) + "/" + u.periodo.month + (u.cliente === "cookmaster" ? " · " + u.periodo.label : " · semana");
  const dots = (u) => '<span class="dots">' + u.progreso.pasos.map((p) => '<i class="' + p.estado + '" title="' + esc(p.label + ": " + p.texto) + '"></i>').join("") + "</span>";

  // ---------------------------------------------------------------- lista
  function units() {
    return Dt().units().filter((u) => u.started && !u.oc.missing);
  }
  function renderList(list) {
    const show = list.filter((u) => filter === "todas" || u.progreso.pasos[1].estado !== "hecho" || u.key === selKey);
    if (!show.length) { listEl.innerHTML = '<p class="hint" style="padding:6px 6px 10px">' + (list.length ? "No quedan facturas pendientes ✔" : "Todavía no hay OC leídas de Drive.") + "</p>"; return; }
    let h = "", last = "";
    show.forEach((u) => {
      const g = P.MESES[u.mes - 1] + " " + u.anio + " · " + F.CLIENTES[u.cliente].nombre;
      if (g !== last) { h += "<h4>" + esc(g.charAt(0) + g.slice(1).toLowerCase()) + "</h4>"; last = g; }
      h += '<button type="button" class="ui-item' + (u.key === selKey ? " on" : "") + '" data-k="' + esc(u.key) + '">' + cliTag(u.cliente) +
        '<span class="ui-txt"><strong>' + esc(unitName(u)) + "</strong><small>" + esc(perName(u) + " · " + u.progreso.pasos[1].texto) + "</small></span>" + dots(u) + "</button>";
    });
    listEl.innerHTML = h;
  }
  listEl.addEventListener("click", (e) => { const b = e.target.closest(".ui-item"); if (!b) return; select(b.dataset.k); if (window.matchMedia("(max-width: 900px)").matches) mainEl.scrollIntoView({ behavior: "smooth", block: "start" }); });
  $("factFilter").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn"); if (!b) return;
    filter = b.dataset.f;
    $("factFilter").querySelectorAll(".seg-btn").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    render();
  });
  function select(k) { if (k !== selKey) pending = null; selKey = k; try { localStorage.setItem("factSel", k); } catch (e) { /* nada */ } render(); }

  // ---------------------------------------------------------------- detalle
  function render() {
    if (A.current() !== "facturas") return;
    const list = units();
    if (!selKey || !list.some((u) => u.key === selKey)) {
      const saved = (() => { try { return localStorage.getItem("factSel") || ""; } catch (e) { return ""; } })();
      const pick = list.find((u) => u.key === saved) || list.find((u) => u.progreso.pasos[1].estado === "listo") || list.find((u) => u.progreso.pasos[1].estado !== "hecho") || list[0];
      selKey = pick ? pick.key : "";
    }
    renderList(list);
    const u = list.find((x) => x.key === selKey);
    if (!u) {
      mainEl.innerHTML = '<section class="card empty"><svg class="i big"><use href="#i-receipt"/></svg><p>No hay OC para facturar.</p><small>' +
        (A.bridgeReady() ? "Cuando estén las OC en Drive (Facturacion / mes / cliente) aparecen acá." : "Configurá el puente a Google en Ajustes para leer las OC de Drive.") + "</small></section>";
      return;
    }
    renderUnit(u);
  }

  function renderUnit(u) {
    const e = u.estado || {}, oc = u.oc, items = oc.items || [];
    const q = F.quantities(u, Dt().ctx, Dt().aliases()), bill = F.billing(items, q.qty);
    const srcTxt = { real: "Cantidades de la tabla de despachos reales (la de los remitos no coincidía con el Excel).", remitos: e.confirmacion === "coincide" ? "Cantidades de la tabla de recepciones confirmada: coincide con el Excel de despachos ✔" : "Cantidades de la tabla de recepciones de los remitos.", excel: "Todavía no se confirmaron los remitos: cantidades tomadas del Excel de despachos (" + (q.info || "") + ").", none: q.error || "Todavía no hay cantidades para este período." }[q.source];
    let h = "";
    // encabezado
    h += '<section class="card fm-head"><h2>' + esc(F.CLIENTES[u.cliente].nombre) + " · <b>OC " + esc(oc.numero) + "</b>" + '<br><small class="hint">' + esc((u.cliente === "cookmaster" ? F.sedeNombre(oc) + " · " : "") + "Período " + P.dateRange(u.periodo) + " (" + (u.periodo.label || "") + ")") + "</small></h2>" +
      '<div class="steps">' + u.progreso.pasos.map((p) => '<span class="step ' + p.estado + '">' + esc(p.label + ": " + p.texto) + "</span>").join("") + "</div></section>";
    // tabla de facturación
    h += '<section class="card bill-card"><div class="bill-tools"><h3>' + ICON("receipt") + "Tabla de facturación</h3>" +
      '<button type="button" class="btn soft small" id="billCopy"' + (bill.lines.length ? "" : " disabled") + ">" + ICON("copy") + "Copiar tabla</button></div>" +
      '<p class="badge ' + (q.source === "excel" || q.source === "none" ? "warn" : "good") + '">' + esc(srcTxt) + "</p>";
    if (u.cliente === "cookmaster") h += sedeBox(u, q);
    h += '<div class="table-wrap"><table class="bill-table"><thead><tr><th>Descripción</th><th class="num">Cantidad</th><th class="num">Precio unit.</th><th class="ctr">IVA</th><th class="num">Importe</th></tr></thead><tbody>' +
      (bill.lines.length ? bill.lines.map((l) => '<tr><td class="desc">' + esc(items[l.idx].short || l.desc) + '</td><td class="num" data-l="Cantidad">' + O.fmtQty(l.qty) + (items[l.idx].unit ? " " + esc(items[l.idx].unit.toLowerCase()) : "") + '</td><td class="num" data-l="Precio unit.">' + money(l.price) + '</td><td class="ctr" data-l="IVA">' + ivaSelect(l.idx, l.iva) + '</td><td class="num imp" data-l="Importe">' + money(l.importe) + "</td></tr>").join("")
        : '<tr><td colspan="5" class="hint" style="text-align:center;padding:22px">' + esc(q.error || "Ningún producto tiene cantidades en este período.") + "</td></tr>") +
      "</tbody></table></div>";
    if (bill.lines.length) h += '<div class="bill-totals"><div><span>Subtotal (neto)</span><b>' + money(bill.subtotal) + "</b></div>" + bill.ivas.map((x) => "<div><span>IVA " + O.fmtRate(x.rate) + "</span><b>" + money(x.amount) + "</b></div>").join("") + '<div class="tot"><span>Total</span><b>' + money(bill.total) + "</b></div></div>";
    if (bill.unknownBase > 0) h += '<p class="badge warn">Hay productos sin IVA: elegilo en la columna IVA.</p>';
    if (q.pending.length) h += pendingBox(u, q.pending);
    if (oc.solver && oc.solver.status === "default") h += '<p class="hint">IVA: la OC de Grupo L no informa el IVA; se usa el 10,5 % (el habitual del pan). Si alguno lleva otro, cambialo en la columna IVA.</p>';
    h += "</section>";
    // factura
    h += '<section class="card inv-card" id="invCard">' + invoiceHtml(u, bill) + "</section>";
    mainEl.innerHTML = h;
    wire(u, bill);
  }

  function ivaSelect(i, iva) {
    const rates = [...new Set([...RATES, iva].filter((x) => x !== null && x !== undefined))];
    return '<select class="iva-sel' + (iva === null || iva === undefined ? " bad" : "") + '" data-i="' + i + '" aria-label="IVA">' + (iva === null || iva === undefined ? '<option value="">?</option>' : "") +
      rates.map((r) => '<option value="' + r + '"' + (iva === r ? " selected" : "") + ">" + O.fmtRate(r) + "</option>").join("") + "</select>";
  }
  function sedeBox(u, q) {
    const oc = u.oc, D = window.Despachos, wb = Dt().workbook(u.anio, u.mes);
    const opts = D.CLIENTS.map((c) => '<option value="' + c.id + '"' + (oc.sede === c.id ? " selected" : "") + ">" + esc(c.id === "otro" ? "Otra sede (elegir la hoja del Excel)" : c.name) + "</option>").join("");
    let h = '<div class="row-inline" style="flex-wrap:wrap"><label class="field-inline">Sede de la OC (hoja del Excel)<select id="sedeSel">' + opts + "</select></label>";
    if (oc.sede === "otro" && wb) {
      const sheets = D.otherSheets(wb), auto = D.findOtherSheet(wb, oc.delivery);
      h += '<label class="field-inline">Hoja<select id="sheetSel"><option value="">' + esc(auto ? "Automática: " + auto : "— elegir —") + "</option>" + sheets.map((s) => '<option value="' + esc(s.name) + '"' + (oc.otherSheet === s.name ? " selected" : "") + ">" + esc(s.name) + "</option>").join("") + "</select></label>";
    }
    h += '<span class="hint">' + esc(oc.sedeHow === "sin reconocer" ? "No reconocí la sede por el lugar de entrega («" + (oc.delivery || "") + "»): elegila." : "Lugar de entrega: " + (oc.delivery || "")) + "</span></div>";
    return h;
  }
  function pendingBox(u, list) {
    const items = u.oc.items;
    return '<div class="badge warn" style="margin-top:12px"><b>Productos del Excel o de la tabla sin producto de la OC</b> (no se facturan hasta asignarlos; la página lo recuerda):' +
      '<div class="table-wrap"><table class="oc-table assign-table"><tbody>' + list.map((p, k) => '<tr><td>' + esc(p.name) + '</td><td class="num">' + O.fmtQty(p.sum) + '</td><td><select data-p="' + k + '"><option value="">— elegir —</option>' +
        [...new Set([...(p.suggestions || []), ...items.map((_, i) => i)])].map((i) => '<option value="' + i + '">' + esc(items[i].short || items[i].desc) + "</option>").join("") + "</select></td></tr>").join("") + "</tbody></table></div></div>";
  }

  // ---------------------------------------------------------------- factura de ARCA
  function invoiceHtml(u, bill) {
    const e = u.estado || {}, f = e.factura, gl = u.cliente === "grupol";
    const enCarpeta = Dt().facturasEnCarpeta(u);
    let h = "<h3>" + ICON("file") + "Factura de ARCA</h3>";
    if (f && !pending) {
      h += invGrid(f) + '<div class="files-list">' +
        (f.url ? '<a href="' + esc(f.url) + '" target="_blank" rel="noopener">' + ICON("folder") + "Ver la factura en Drive (" + esc(f.nombre || "") + ")</a>" : "") +
        (e.planilla && e.planilla.fila ? '<a href="' + esc(e.planilla.url || "#") + '" target="_blank" rel="noopener">' + ICON("sheet") + "Planilla de Facturación: hoja " + esc(e.planilla.hoja) + ", fila " + esc(e.planilla.fila) + (e.planilla.duplicada ? " (ya estaba cargada)" : "") + "</a>" : '<span class="warn-txt">' + ICON("alert") + "Falta la fila en la planilla de Facturación.</span>") + "</div>";
      if (!(e.planilla && e.planilla.fila)) h += '<div class="row-btns"><button type="button" class="btn soft" id="invRowRetry">' + ICON("sheet") + "Agregar la fila a la planilla</button></div>";
      if (gl) {
        h += '<p class="badge ' + (e.wpp ? "good" : "warn") + '">' + (e.wpp ? "✔ Factura enviada por WhatsApp el " + new Date(e.wpp).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) + "." : "Falta mandar la factura por WhatsApp.") + "</p>" +
          '<div class="row-btns"><button type="button" class="btn wpp big" id="wppBtn">' + ICON("chat") + (e.wpp ? "Mandar otra vez por WhatsApp" : "Enviar por WhatsApp") + "</button>" +
          (e.wpp ? "" : '<button type="button" class="btn ghost" id="wppMark">Ya la mandé</button>') + "</div>";
      } else {
        const locked = !!(e.mail && e.mail.enviado);
        h += '<p class="hint" style="margin-top:12px"><b>¿Cómo se presenta esta factura?</b>' + (locked ? " (el mail ya se envió)" : "") + "</p>" + canalChoice(e.envio, locked);
        if (e.envio) h += '<div class="row-btns"><button type="button" class="btn primary" data-go="mails">' + ICON("mail") + "Ir a Enviar mails</button></div>";
      }
      h += '<div class="row-btns"><button type="button" class="link-btn" id="invReplace">Cargar otra factura para este período (nota de crédito o reemplazo)</button></div>';
      return h;
    }
    if (pending) {
      const inv = pending.inv, chk = F.checkInvoice(inv, bill, u.cliente);
      h += invGrid(Object.assign({ nro: inv.pv && inv.numero ? inv.pv + "-" + inv.numero : "?", tipo: FP.planillaTipo(inv.code, inv.asociado) }, inv)) +
        (chk.ok ? '<p class="badge good">✔ El total coincide con la tabla de facturación.</p>' : chk.notes.map((n) => '<p class="badge warn">⚠ ' + esc(n) + "</p>").join("")) +
        '<label class="field">Descripción para la planilla<input type="text" class="desc-input" id="invDesc" maxlength="160" value="' + esc(pending.desc) + '"></label>';
      if (!gl) h += '<p class="hint" style="margin-top:12px"><b>¿Cómo se presenta esta factura?</b> (elegí una)</p>' + canalChoice(pending.envio, false);
      else h += '<p class="hint" style="margin-top:12px">Al guardar: se sube a la carpeta de la OC, se agrega en la planilla (hoja de Grupo L) y después la mandás por WhatsApp.</p>';
      h += '<ol class="steps-run" id="invSteps" hidden></ol><p class="err" id="invErr" role="alert"></p>' +
        '<div class="row-btns"><button type="button" class="btn primary big" id="invSave">' + ICON("check") + "Guardar factura</button>" +
        '<button type="button" class="btn secondary" id="invOther">Elegir otro archivo</button></div>';
      return h;
    }
    h += '<label class="dropzone" id="invDrop"><svg class="i big"><use href="#i-upload"/></svg><strong>Cargá la factura (PDF de ARCA)</strong><small>Tocá acá o arrastrá el archivo. Se lee el número, la fecha y los importes.</small><input type="file" id="invFile" accept="application/pdf,.pdf" hidden></label><p class="err" id="invErr" role="alert"></p>';
    if (enCarpeta.length) h += '<p class="hint">En la carpeta de la OC ya hay: ' + esc(enCarpeta.map((x) => x.label + " " + x.short).join(" · ")) + ".</p>";
    return h;
  }
  function invGrid(f) {
    const nro = f.nro || (f.pv && f.numero ? f.pv + "-" + f.numero : "?");
    return '<div class="inv-grid"><div><span>Comprobante</span><b>' + esc((f.kind || f.label || "") + (f.tipo ? " (" + f.tipo + ")" : "")) + "</b></div><div><span>Número</span><b>" + esc(nro) + "</b></div><div><span>Fecha</span><b>" + esc(f.date || f.fecha || "") + "</b></div>" +
      '<div class="amt"><span>Neto</span><b>' + money(Math.abs(f.neto != null ? f.neto : f.subtotal || 0)) + '</b></div><div class="amt"><span>IVA</span><b>' + money(Math.abs(f.iva || 0)) + '</b></div><div class="big"><span>Total</span><b>' + (f.sign < 0 ? "− " : "") + money(Math.abs(f.total)) + "</b></div>" +
      (f.receptor ? '<div style="grid-column:1/-1"><span>A nombre de</span><b>' + esc(f.receptor) + "</b></div>" : "") + "</div>";
  }
  function canalChoice(val, locked) {
    return '<div class="choice" role="radiogroup" aria-label="Portal o Mail">' +
      '<label><input type="radio" name="canal" value="portal"' + (val === "portal" ? " checked" : "") + (locked ? " disabled" : "") + '><span><strong>Portal</strong><small>La factura se sube al portal de Cook Master. Por mail van solo los remitos.</small></span></label>' +
      '<label><input type="radio" name="canal" value="mail"' + (val === "mail" ? " checked" : "") + (locked ? " disabled" : "") + '><span><strong>Mail</strong><small>Hubo un problema con el portal: por mail van los remitos y la factura.</small></span></label></div>';
  }

  // ---------------------------------------------------------------- eventos del detalle
  function wire(u, bill) {
    const items = u.oc.items;
    const copy = $("billCopy");
    if (copy) copy.addEventListener("click", async () => {
      const tsv = O.toTsv(bill.lines.map((l) => Object.assign({}, l, { desc: items[l.idx].short || l.desc })));
      let ok = false; try { await navigator.clipboard.writeText(tsv); ok = true; } catch (e) { ok = false; }
      A.toast(ok ? "Tabla copiada ✔ (pegala en Excel o usala para ARCA)" : "No se pudo copiar en este navegador.");
    });
    mainEl.querySelectorAll(".iva-sel").forEach((s) => s.addEventListener("change", () => { if (s.value === "") return; Dt().setAjuste(u.oc.id, { iva: { [s.dataset.i]: Number(s.value) } }); }));
    const sedeSel = $("sedeSel"); if (sedeSel) sedeSel.addEventListener("change", () => Dt().setAjuste(u.oc.id, { sede: sedeSel.value }));
    const sheetSel = $("sheetSel"); if (sheetSel) sheetSel.addEventListener("change", () => Dt().setAjuste(u.oc.id, { otherSheet: sheetSel.value }));
    mainEl.querySelectorAll(".assign-table select").forEach((s) => s.addEventListener("change", () => {
      const q = F.quantities(u, Dt().ctx, Dt().aliases()), p = q.pending[Number(s.dataset.p)];
      if (p && s.value !== "") Dt().setAlias(O.keyOf(p.name), items[Number(s.value)].desc);
    }));
    const file = $("invFile"), drop = $("invDrop");
    if (file) {
      file.addEventListener("change", () => { const f = file.files[0]; file.value = ""; if (f) readInvoice(u, f, bill); });
      drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
      drop.addEventListener("dragleave", () => drop.classList.remove("over"));
      drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer.files[0]; if (f) readInvoice(u, f, bill); });
    }
    mainEl.querySelectorAll('input[name="canal"]').forEach((r) => r.addEventListener("change", async () => {
      if (pending) { pending.envio = r.value; return; }
      await U.update(u.key, { envio: r.value });
      A.toast(r.value === "portal" ? "Portal: por mail van solo los remitos." : "Mail: van los remitos y la factura.");
    }));
    const save = $("invSave"); if (save) save.addEventListener("click", () => saveInvoice(u, bill));
    const other = $("invOther"); if (other) other.addEventListener("click", () => { pending = null; render(); setTimeout(() => { const f = $("invFile"); if (f) f.click(); }, 50); });
    const rep = $("invReplace"); if (rep) rep.addEventListener("click", async () => {
      if (!(await A.askConfirm("¿Cargar otra factura para este período? La fila anterior de la planilla y el archivo en Drive NO se borran; esta queda como la factura del período.", "Cargar otra", "Cancelar"))) return;
      pending = null; mainEl.querySelector("#invCard").innerHTML = invoiceHtml(Object.assign({}, u, { estado: Object.assign({}, u.estado, { factura: null }) }), bill); wire(Object.assign({}, u, { estado: Object.assign({}, u.estado, { factura: null }) }), bill);
    });
    const retry = $("invRowRetry"); if (retry) retry.addEventListener("click", () => addRow(u, u.estado.factura));
    const wpp = $("wppBtn"); if (wpp) wpp.addEventListener("click", () => sendWhatsApp(u));
    const mark = $("wppMark"); if (mark) mark.addEventListener("click", () => markWpp(u));
  }

  async function readInvoice(u, file, bill) {
    const err = $("invErr");
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { err.textContent = "Ese archivo no es un PDF."; return; }
    try {
      const ex = await window.PdfText.extract(await file.arrayBuffer());
      if (!ex.hasText) throw new Error("El PDF no trae texto (parece una foto o un escaneo). Bajá la factura desde ARCA en PDF.");
      const inv = FP.parseInvoice(ex.pages), byName = FP.parseName(file.name);
      if (!inv.code && byName) inv.code = byName.code;
      if (!inv.pv && byName) { inv.pv = byName.pv; inv.numero = byName.number; }
      if (!inv.kind && inv.code && FP.KINDS[inv.code]) { inv.kind = FP.KINDS[inv.code].label; inv.sign = FP.KINDS[inv.code].sign; }
      if (!inv.ok) throw new Error("No encontré el importe total en el PDF. ¿Es una factura de ARCA?");
      if (!inv.numero) throw new Error("No encontré el número de comprobante en el PDF.");
      const desc = F.descripcion(u) + (inv.sign < 0 && inv.asociado ? " (NC de la " + Number(inv.asociado.split("-")[1]) + ")" : "");
      pending = { inv, file, desc, envio: (u.estado && u.estado.envio) || "" };
      blobs.set(u.key, file);
      render();
    } catch (e) { console.error(e); err.textContent = e.message || String(e); }
  }

  function stepsUi() {
    const ol = $("invSteps"); ol.hidden = false; ol.innerHTML = "";
    return (text) => { const li = document.createElement("li"); li.className = "run"; li.textContent = text; ol.appendChild(li); return { ok: (t) => { li.className = "ok"; if (t) li.textContent = t; }, bad: (t) => { li.className = "bad"; if (t) li.textContent = t; } }; };
  }
  // Nombre del archivo en Drive: el de ARCA (CUIT_tipo_pv_número) con la OC al final, para identificarlo
  function invoiceFileName(u, inv, file) {
    const byName = FP.parseName(file.name);
    const base = byName ? (/(\d{11}_\d{3}_\d{5}_\d{8})/.exec(file.name) || [])[1] : (inv.emisorCuit || "factura") + "_" + (inv.code || "000") + "_" + (inv.pv || "00000") + "_" + (inv.numero || "00000000");
    return base + "_OC" + u.oc.numero;
  }

  async function saveInvoice(u, bill) {
    if (busy || !pending) return;
    const inv = pending.inv, gl = u.cliente === "grupol", err = $("invErr");
    err.textContent = "";
    if (!gl && !pending.envio) { err.textContent = "Elegí «Portal» o «Mail»."; return; }
    if (!A.bridgeReady()) { err.textContent = "Configurá el puente a Google en Ajustes para guardar la factura en Drive y en la planilla."; return; }
    const desc = ($("invDesc").value || "").trim() || F.descripcion(u);
    const chk = F.checkInvoice(inv, bill, u.cliente);
    if (!chk.ok && !(await A.askConfirm("Ojo:\n• " + chk.notes.join("\n• ") + "\n\n¿Guardar la factura igual?", "Guardar igual", "Revisar"))) return;
    busy = true; $("invSave").disabled = true; $("invOther").disabled = true;
    const step = stepsUi();
    const fact = { nro: inv.pv + "-" + inv.numero, numero: inv.numero, pv: inv.pv, code: inv.code || "", tipo: FP.planillaTipo(inv.code, inv.asociado) || inv.letter || "", kind: inv.kind || "", fecha: inv.date, date: inv.date,
      neto: inv.neto != null ? inv.neto : null, iva: inv.iva || 0, ivas: inv.ivas || [], total: inv.total, sign: inv.sign, asociado: inv.asociado || "", receptor: inv.receptor || "", emisor: inv.emisor || "", descripcion: desc, at: Date.now() };
    try {
      let s = step("Guardando la factura en la carpeta de la OC en Drive…");
      const up = await window.Puente.call({ action: "subir", tipo: "factura", oc: u.oc.numero, cliente: u.cliente, anio: u.periodo.year, nombre: invoiceFileName(u, inv, pending.file), pdf: await A.blobToBase64(pending.file) }, 240000);
      Object.assign(fact, { id: up.id, nombre: up.nombre, url: up.url, ruta: up.ruta });
      s.ok("Factura en Drive: " + up.ruta + "/" + up.nombre + (up.existente ? " (ya estaba)" : ""));
      await U.update(u.key, { cliente: u.cliente, oc: u.oc.numero, periodo: u.periodo, factura: fact, envio: gl ? "whatsapp" : pending.envio, planilla: { fila: 0 } });
      const file = pending.file;
      pending = null;
      await addRow(u, fact, step);
      blobs.set(u.key, file);
      A.toast("Factura guardada ✔" + (gl ? " Ahora mandala por WhatsApp." : ""));
    } catch (e) {
      console.error(e);
      err.textContent = "No se pudo completar: " + (e.message || e);
      const last = $("invSteps").lastElementChild; if (last && last.className === "run") last.className = "bad";
    } finally { busy = false; render(); }
  }
  // Fila nueva en la planilla de Facturación
  async function addRow(u, fact, step) {
    step = step || ((t) => { A.toast(t); return { ok: (x) => A.toast(x || "Listo ✔"), bad: (x) => A.toast(x || "Error") }; });
    const s = step("Agregando la fila en la planilla de Facturación (" + (u.cliente === "grupol" ? "hoja de Grupo L" : "hoja de Cook Master") + ")…");
    const inv = Object.assign({}, fact, { numero: fact.numero, date: fact.fecha });
    const fila = F.filaPlanilla(u, inv, fact.descripcion);
    try {
      const r = await window.Puente.call({ action: "planillaAgregar", cliente: u.cliente, bloque: { anio: u.periodo.year, mes: u.periodo.month }, fila });
      await U.update(u.key, { planilla: { hoja: r.hoja, fila: r.fila, url: r.url, duplicada: !!r.duplicada, numero: fila.numero, tipo: fila.tipo, total: fila.total } });
      s.ok("Planilla: hoja " + r.hoja + ", fila " + r.fila + (r.duplicada ? " (ya estaba cargada: no se duplicó)" : ""));
    } catch (e) { s.bad("No se pudo agregar la fila en la planilla: " + (e.message || e)); throw e; }
  }

  // ---------------------------------------------------------------- WhatsApp (Grupo L)
  async function invoiceBlob(u) {
    if (blobs.has(u.key)) return blobs.get(u.key);
    const f = u.estado && u.estado.factura; if (!f || !f.id) return null;
    const r = await window.Puente.call({ action: "files", ids: [f.id] });
    const a = (r.archivos || [])[0]; if (!a || a.error) throw new Error((a && a.error) || "No se pudo bajar la factura de Drive.");
    const blob = new File([A.b64ToBytes(a.b64)], f.nombre || "factura.pdf", { type: "application/pdf" });
    blobs.set(u.key, blob);
    return blob;
  }
  async function sendWhatsApp(u) {
    const f = u.estado.factura, num = (A.settings().wppNumero || "").replace(/\D+/g, "");
    const text = "Factura " + (f.nro || "") + " · " + (f.descripcion || F.descripcion(u)) + " · Total $ " + O.fmtMoney(Math.abs(f.total));
    let blob;
    if (!blobs.has(u.key)) {                    // hay que bajarla de Drive: después se toca de nuevo (el celular pide un toque para compartir)
      try { A.toast("Bajando la factura de Drive…"); await invoiceBlob(u); A.toast("Lista: tocá de nuevo «Enviar por WhatsApp»."); } catch (e) { A.showMessage(e.message || String(e)); }
      return;
    }
    blob = blobs.get(u.key);
    const file = blob instanceof File ? blob : new File([blob], f.nombre || "factura.pdf", { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Factura " + (f.nro || ""), text });
        if (await A.askConfirm("¿Se mandó la factura por WhatsApp?", "Sí, se mandó", "No")) await markWpp(u);
      } catch (e) { if (e && e.name !== "AbortError") A.showMessage("No se pudo compartir: " + (e.message || e)); }
      return;
    }
    // Computadora: se abre el chat y se descarga el PDF para adjuntarlo
    A.downloadBlob(file, file.name);
    window.open((num ? "https://wa.me/" + num : "https://wa.me/") + "?text=" + encodeURIComponent(text), "_blank", "noopener");
    if (await A.askConfirm("Se abrió WhatsApp y se descargó el PDF de la factura: adjuntalo en el chat (clip › Documento).\n\n¿Ya la mandaste?", "Sí, se mandó", "Todavía no")) await markWpp(u);
  }
  async function markWpp(u) {
    await U.update(u.key, { wpp: Date.now() });
    const p = u.estado && u.estado.planilla;
    if (p && p.fila && A.bridgeReady()) {
      try { await window.Puente.call({ action: "planillaMarcar", cliente: u.cliente, numero: p.numero, tipo: p.tipo, total: p.total, fc: "wpp" }); }
      catch (e) { A.toast("No se pudo anotar «wpp» en la planilla: " + (e.message || e)); }
    }
    A.toast("Factura marcada como enviada por WhatsApp ✔");
  }

  // ---------------------------------------------------------------- inicio
  A.on("view", (e) => { if (e.view !== "facturas") return; if (e.params && e.params.unit) { pending = null; selKey = e.params.unit; } render(); });
  A.on("datos", () => { if (!busy) render(); });
  A.on("lotes", () => { if (!busy) render(); });
})();
