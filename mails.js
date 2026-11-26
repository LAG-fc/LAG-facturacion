// mails.js — Sección "Enviar mails" (v9.0): progreso de cada OC y período, y envío de los mails de Cook Master.
//   · Portal: el mail lleva solo el PDF de los remitos (la factura va por el portal).
//   · Mail: el mail lleva el PDF de los remitos y la factura.
//   · Grupo L: no se manda nada por mail (la factura va por WhatsApp, desde Facturas).
// Después de enviar, en la planilla de Facturación se completan "REMITOS ENV" (si) y "FC (MAIL O PORTAL)".
(() => {
  "use strict";
  const A = window.App, P = window.Period, O = window.OcParse, F = window.Flujo, U = window.UnidadesStore, $ = (id) => document.getElementById(id);
  const esc = A.esc, ICON = (n) => '<svg class="i"><use href="#i-' + n + '"/></svg>';
  const table = $("mailTable"), selEl = $("mailSel"), sendBtn = $("mailSend");
  let filter = "todos", selected = new Set(), sending = false;
  const fmtDT = (ms) => new Date(ms).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  // Adjuntos de una unidad lista para mandar (null si falta algo)
  function mailOf(u) {
    if (u.cliente !== "cookmaster") return null;
    const e = u.estado || {}, pdfId = (e.pdf && e.pdf.id) || (u.pdfDrive && u.pdfDrive.id);
    if (!pdfId || !e.factura || !e.envio) return null;
    if (e.envio === "mail" && !e.factura.id) return null;
    const nro = e.factura.nro || "";
    const conFactura = e.envio === "mail";
    return {
      unit: u, canal: e.envio,
      asunto: conFactura ? P.invoiceSubject(u.oc.numero, u.periodo, nro) : P.emailSubject(u.oc.numero, u.periodo),
      cuerpo: conFactura ? P.invoiceBody(u.oc.numero, u.periodo, nro) : P.emailBody(u.oc.numero, u.periodo),
      adjuntos: conFactura ? [pdfId, e.factura.id] : [pdfId],
      nombres: [(e.pdf && e.pdf.nombre) || (u.pdfDrive && u.pdfDrive.name) || "remitos.pdf"].concat(conFactura ? [e.factura.nombre || "factura.pdf"] : [])
    };
  }
  const sent = (u) => !!(u.estado && u.estado.mail && u.estado.mail.enviado);

  function chip(cls, text) { return '<span class="chip ' + cls + '">' + esc(text) + "</span>"; }
  function render() {
    if (A.current() !== "mails") return;
    const all = window.Datos.units().filter((u) => u.started && !u.oc.missing && (filter === "todos" || u.cliente === filter));
    $("mailEmpty").hidden = all.length > 0;
    let h = '<thead><tr><th></th><th>OC</th><th>Período</th><th>Remitos</th><th>Tabla</th><th>Factura</th><th>Canal</th><th>Mail</th></tr></thead><tbody>';
    let lastMonth = "";
    for (const u of all) {
      const m = P.MESES[u.mes - 1] + " " + u.anio;
      if (m !== lastMonth) { h += '<tr class="month"><td colspan="8">' + esc(m) + "</td></tr>"; lastMonth = m; }
      const e = u.estado || {}, p = u.progreso.pasos, mail = mailOf(u), done = u.progreso.completa;
      const pdfUrl = (e.pdf && e.pdf.url) || "";
      const rem = p[0].estado === "hecho" ? (pdfUrl ? '<a class="chip ok" href="' + esc(pdfUrl) + '" target="_blank" rel="noopener">PDF en Drive</a>' : chip("ok", "PDF en Drive")) : p[0].estado === "listo" ? chip("warn", "Escaneados") : chip("", u.ended ? "Faltan" : "En curso");
      const tab = e.confirmacion === "coincide" ? chip("ok", "Coincide ✔") : e.confirmacion === "real" ? chip("warn", "Despachos reales") : e.confirmacion === "sin-excel" ? chip("info", "Sin Excel") : chip("", "—");
      const fac = e.factura ? chip("ok", (e.factura.nro || "") + " · $ " + O.fmtMoney(Math.abs(e.factura.total))) : chip(p[0].estado === "hecho" ? "warn" : "", "Falta");
      const canal = u.cliente === "grupol" ? chip("info", "WhatsApp") : e.envio === "mail" ? chip("wine", "Mail") : e.envio === "portal" ? chip("wine", "Portal") : chip("", e.factura ? "Elegir" : "—");
      let env;
      if (u.cliente === "grupol") env = e.wpp ? chip("ok", "No lleva · WhatsApp ✔") : chip("", "No lleva mail");
      else if (sent(u)) env = chip("ok", (e.mail.borrador ? "Borrador " : "Enviado ") + fmtDT(e.mail.enviado));
      else if (mail) env = chip("warn", "Listo para enviar");
      else env = chip("", e.factura && !e.envio ? "Elegí Portal o Mail" : "Falta");
      const can = !!mail && !sent(u) && !sending;
      if (!can) selected.delete(u.key);
      h += '<tr class="' + (done ? "done" : "") + '"><td class="sel">' + (u.cliente === "cookmaster" ? '<input type="checkbox" data-k="' + esc(u.key) + '"' + (selected.has(u.key) ? " checked" : "") + (can ? "" : " disabled") + ' aria-label="Elegir el mail de la OC ' + esc(u.oc.numero) + '">' : "") + "</td>" +
        '<td class="oc" data-l="OC"><span>OC ' + esc(u.oc.numero) + "<small>" + esc(u.cliente === "grupol" ? "Grupo L" : "Cook Master · " + F.sedeLabel(u.oc)) + "</small></span></td>" +
        '<td data-l="Período">' + esc(P.text(u.periodo) + "/" + u.periodo.month) + "</td>" +
        '<td data-l="Remitos">' + rem + '</td><td data-l="Tabla">' + tab + '</td><td data-l="Factura">' + fac + '</td><td data-l="Canal">' + canal + '</td><td data-l="Mail">' + env + "</td></tr>";
    }
    table.innerHTML = h + "</tbody>";
    refreshBar(all);
  }
  function refreshBar(all) {
    const ready = (all || window.Datos.units()).filter((u) => mailOf(u) && !sent(u)).length;
    const n = selected.size;
    selEl.textContent = n ? n + (n === 1 ? " mail elegido" : " mails elegidos") : ready ? ready + (ready === 1 ? " mail listo para enviar: elegilo en la tabla." : " mails listos para enviar: elegilos en la tabla.") : "No hay mails listos para enviar.";
    sendBtn.disabled = !n || sending;
    sendBtn.lastElementChild.textContent = A.settings().mailModo === "borrador" ? "Crear borradores" : "Enviar mails";
  }
  table.addEventListener("change", (e) => {
    const c = e.target; if (c.type !== "checkbox") return;
    if (c.checked) selected.add(c.dataset.k); else selected.delete(c.dataset.k);
    refreshBar();
  });
  $("mailFilter").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn"); if (!b) return;
    filter = b.dataset.f;
    $("mailFilter").querySelectorAll(".seg-btn").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    render();
  });

  // ---------------------------------------------------------------- envío
  const dlg = $("mailDialog"), list = $("mailList");
  let plan = [];
  sendBtn.addEventListener("click", () => {
    if (!A.bridgeReady()) { A.showMessage("Configurá el puente a Google en Ajustes para mandar los mails."); return; }
    const us = window.Datos.units().filter((u) => selected.has(u.key));
    plan = us.map(mailOf).filter(Boolean);
    if (!plan.length) return;
    const draft = A.settings().mailModo === "borrador";
    $("mailTitle").textContent = draft ? "Crear borradores en Gmail" : "Enviar mails";
    $("mailSub").textContent = (draft ? "Quedan en Borradores de Gmail para que los mandes vos." : "Se mandan desde tu Gmail a Cook Master.") + " Después se completa la planilla de Facturación.";
    $("mailGoLabel").textContent = draft ? "Crear " + plan.length + (plan.length === 1 ? " borrador" : " borradores") : "Enviar " + plan.length + (plan.length === 1 ? " mail" : " mails");
    $("mailErr").textContent = "";
    list.innerHTML = plan.map((m, i) => '<div class="mail-item" data-i="' + i + '"><strong>' + esc(m.asunto) + "</strong><small>" + esc((m.canal === "mail" ? "Mail (remitos + factura)" : "Portal (solo remitos)") + " · Adjuntos: " + m.nombres.join(", ")) + '</small><small class="st"></small></div>').join("");
    $("mailGo").disabled = false; $("mailCancel").disabled = false; $("mailCancel").textContent = "Cancelar";
    dlg.showModal();
  });
  $("mailCancel").addEventListener("click", () => { if (!sending) dlg.close(); });
  $("mailClose").addEventListener("click", () => { if (!sending) dlg.close(); });
  dlg.addEventListener("cancel", (e) => { if (sending) e.preventDefault(); });
  $("mailGo").addEventListener("click", async () => {
    if (sending) return;
    sending = true; $("mailGo").disabled = true; $("mailCancel").disabled = true;
    $("mailGo").classList.add("is-busy");
    const draft = A.settings().mailModo === "borrador";
    let ok = 0, bad = 0;
    for (let i = 0; i < plan.length; i++) {
      const m = plan[i], el = list.querySelector('[data-i="' + i + '"]'), st = el.querySelector(".st");
      st.textContent = draft ? "Creando el borrador…" : "Enviando…";
      try {
        const r = await window.Puente.call({ action: "enviarMail", asunto: m.asunto, cuerpo: m.cuerpo, adjuntos: m.adjuntos, borrador: draft }, 240000);
        await U.update(m.unit.key, { mail: { enviado: Date.now(), borrador: !!r.borrador, para: r.para, canal: m.canal } });
        let extra = "";
        const pl = m.unit.estado && m.unit.estado.planilla;
        if (pl && pl.fila) {
          try { await window.Puente.call({ action: "planillaMarcar", cliente: "cookmaster", numero: pl.numero, tipo: pl.tipo, total: pl.total, remitos: "si", fc: m.canal }); extra = " · planilla: REMITOS ENV = si, FC = " + m.canal; }
          catch (e) { extra = " · ⚠ no se pudo completar la planilla: " + (e.message || e); }
        } else extra = " · ⚠ la factura no está en la planilla (cargala desde Facturas)";
        el.className = "mail-item ok"; st.textContent = (r.borrador ? "✔ Borrador creado para " : "✔ Enviado a ") + r.para + extra;
        selected.delete(m.unit.key); ok++;
      } catch (e) {
        el.className = "mail-item bad"; st.textContent = "No se pudo: " + (e.message || e); bad++;
      }
    }
    sending = false; $("mailGo").classList.remove("is-busy"); $("mailCancel").disabled = false;
    $("mailCancel").textContent = "Cerrar";
    $("mailErr").textContent = bad ? bad + (bad === 1 ? " mail no se pudo mandar." : " mails no se pudieron mandar.") + " Podés reintentar." : "";
    A.toast(ok + (ok === 1 ? (draft ? " borrador creado ✔" : " mail enviado ✔") : (draft ? " borradores creados ✔" : " mails enviados ✔")));
    render();
  });

  A.on("view", (e) => { if (e.view === "mails") render(); });
  A.on("datos", () => { if (!sending) render(); });
  A.on("settings", () => refreshBar());
})();
