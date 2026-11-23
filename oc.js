// oc.js — Sección "Facturación": buscar las OC y el Excel de Despachos del mes en Drive (o cargar una OC a mano),
// asignar el cliente, deducir el IVA, armar la tabla de facturación y controlar el porcentaje facturado con las facturas
// que hay en la carpeta de cada OC. No toca nada de la sección de remitos.
(() => {
  "use strict";
  const O = window.OcParse, D = window.Despachos, F = window.FactParse, $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const MESES = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];

  // ---------- Datos guardados en el navegador ----------
  let ocs = [], aliases = {}, clientAliases = {}, currentId = null;
  let facCache = {}, showDone = false, lastMes = "", editing = {};   // facCache: facturas ya leídas (por id de archivo de Drive)
  let excel = null;                                   // Excel de Despachos leído (solo en memoria): {name, wb, loadedAt}
  const jget = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v === null ? d : v; } catch (e) { return d; } };
  const load = () => { ocs = jget("ocData", []); if (!Array.isArray(ocs)) ocs = []; aliases = jget("ocAliases", {}) || {}; clientAliases = jget("ocClientAliases", {}) || {}; facCache = jget("facCache", {}) || {}; Object.keys(facCache).forEach((k) => { if (!facCache[k] || (!facCache[k].ok && !facCache[k].manual)) delete facCache[k]; }); showDone = !!jget("facShowDone", false); lastMes = jget("facLastMes", "") || ""; };
  const save = () => { try { localStorage.setItem("ocData", JSON.stringify(ocs)); localStorage.setItem("ocAliases", JSON.stringify(aliases)); localStorage.setItem("ocClientAliases", JSON.stringify(clientAliases)); localStorage.setItem("facCache", JSON.stringify(facCache)); localStorage.setItem("facShowDone", JSON.stringify(showDone)); localStorage.setItem("facLastMes", JSON.stringify(lastMes)); } catch (e) { /* nada */ } };
  const cur = () => ocs.find((x) => x.id === currentId) || null;

  // ---------- Pestañas ----------
  const views = { remitos: $("remitosView"), oc: $("ocView") };
  function showView(name) {
    const isOc = name === "oc";
    views.remitos.hidden = isOc; views.oc.hidden = !isOc;
    $("tabRemitos").setAttribute("aria-selected", String(!isOc));
    $("tabOc").setAttribute("aria-selected", String(isOc));
    if (window.RemitosApp) window.RemitosApp.setActive(!isOc);
    if (isOc) render();
  }
  $("tabs").addEventListener("click", (e) => { const b = e.target.closest(".tab"); if (b) showView(b.dataset.view); });

  // ---------- Facturado vs. a facturar ----------
  const money = (v) => "$ " + O.fmtMoney(v);
  const fmtPct = (p) => (Math.abs(p - Math.round(p)) < 0.05 ? String(Math.round(p)) : p.toFixed(1).replace(".", ",")) + "%";
  const factList = (rec) => ((rec.fact && rec.fact.ids) || []).map((id) => facCache[id]).filter(Boolean);
  const periodShort = (rec) => D.periodLabel(rec.pmode, rec.pcustom).split(" (")[0];
  function billing(rec) {
    const st = parsedPaste(rec), inv = st.inv, total = inv.total || 0, facs = factList(rec), used = facs.filter((f) => f.ok && f.sign !== 0);
    const fact = F.net(used), tol = 5 + total * 0.0001, hasTotal = inv.lines.length > 0 && total > 0;
    return { st, total, fact, hasTotal, tol, n: facs.length, unread: facs.filter((f) => !f.ok).length, pct: hasTotal ? fact / total * 100 : null, done: hasTotal && used.length > 0 && Math.abs(total - fact) <= tol };
  }

  // ---------- Lista de OC (barra lateral) ----------
  function renderList() {
    const list = $("ocList");
    list.innerHTML = "";
    const info = ocs.map((rec) => ({ rec, b: billing(rec) }));
    const visible = info.filter((x) => showDone || !x.b.done || x.rec.id === currentId);
    const doneN = info.filter((x) => x.b.done).length;
    visible.forEach(({ rec, b }) => {
      const cl = D.clientById(rec.client), el = document.createElement("div");
      el.className = "oc-chip" + (rec.id === currentId ? " on" : "") + (b.done ? " done" : "");
      const pct = b.pct === null ? "—" : fmtPct(b.pct);
      el.innerHTML = '<button type="button" class="oc-open"><span class="oc-line"><strong>OC ' + esc(rec.oc) + '</strong><span class="pct' + (b.done ? " ok" : "") + '">' + (b.done ? "✔ 100%" : pct) + '</span></span>' +
        '<small>' + (cl ? esc(cl.name) : '<span class="bad-txt">sin cliente</span>') + (rec.pmode ? " · " + esc(periodShort(rec)) : "") + '</small>' +
        '<span class="bar"><i style="width:' + (b.pct === null ? 0 : Math.max(0, Math.min(100, b.pct))) + '%"></i></span></button>' +
        '<button type="button" class="oc-del" title="Quitar esta OC de la lista" aria-label="Quitar OC ' + esc(rec.oc) + '"><svg class="i"><use href="#i-trash"/></svg></button>';
      el.querySelector(".oc-open").addEventListener("click", () => { currentId = rec.id; render(); });
      el.querySelector(".oc-del").addEventListener("click", async () => {
        if (!(await window.RemitosApp.askConfirm("¿Quitar la OC " + rec.oc + " de la lista? (se pierde lo que pegaste de entregas)", "Sí, quitar", "Cancelar"))) return;
        ocs = ocs.filter((x) => x.id !== rec.id); if (currentId === rec.id) currentId = null; save(); render();
      });
      list.appendChild(el);
    });
    const btn = $("ocShowDone");
    btn.hidden = doneN === 0;
    btn.textContent = showDone ? "Ocultar las completas (" + doneN + ")" : "Mostrar las completas (" + doneN + ")";
    // resumen del mes
    const withTotal = info.filter((x) => x.b.hasTotal), tot = withTotal.reduce((s, x) => s + x.b.total, 0), fac = withTotal.reduce((s, x) => s + x.b.fact, 0);
    const box = $("facMonth");
    box.hidden = !withTotal.length;
    if (withTotal.length) {
      const p = tot > 0 ? fac / tot * 100 : 0;
      box.innerHTML = '<div class="fm-top"><span>Total del mes</span><b>' + fmtPct(p) + '</b></div><div class="progress"><i style="width:' + Math.max(0, Math.min(100, p)) + '%"></i></div>' +
        '<small>Facturado ' + money(fac) + ' de ' + money(tot) + (info.length - doneN > 0 ? " · " + (info.length - doneN) + " pendiente" + (info.length - doneN === 1 ? "" : "s") : " · todo facturado ✔") + "</small>";
    }
    return { info, visible };
  }

  function renderListSafe() {
    const r = renderList();
    if (currentId !== null && !ocs.some((x) => x.id === currentId)) currentId = null;
    if (currentId === null) { const first = r.visible[0]; if (first) { currentId = first.rec.id; return renderList(); } }
    return r;
  }

  // ---------- Paso 1: productos e IVA ----------
  const RATES = [21, 10.5, 27, 0];
  function renderItems(rec) {
    $("ocTitle").textContent = rec.oc;
    $("ocMeta").textContent = [rec.emission ? "Emitida el " + rec.emission : "", rec.delivery ? "Entrega: " + rec.delivery : "", rec.pdfName ? "Archivo: " + rec.pdfName : ""].filter(Boolean).join(" · ");
    const body = $("ocItemsTable").querySelector("tbody");
    body.innerHTML = "";
    rec.items.forEach((it) => {
      const tr = document.createElement("tr");
      const rates = [...new Set([...(rec.totals.ivas || []).map((x) => x.rate), ...RATES])];
      tr.innerHTML = '<td class="desc">' + esc(it.desc) + '</td><td class="num">$ ' + O.fmtMoney(it.price) + '</td><td class="ctr"></td>';
      const sel = document.createElement("select");
      sel.className = "iva-sel" + (it.iva === null || it.iva === undefined ? " bad" : "");
      sel.innerHTML = '<option value="">?</option>' + rates.map((r) => '<option value="' + r + '"' + (it.iva === r ? " selected" : "") + ">" + O.fmtRate(r) + "</option>").join("");
      sel.addEventListener("change", () => {
        it.iva = sel.value === "" ? null : Number(sel.value); it.ivaSrc = "manual"; save();
        sel.classList.toggle("bad", it.iva === null); renderBadge(rec); renderInvoice(rec);
      });
      tr.lastElementChild.appendChild(sel);
      if (it.ivaSrc) tr.title = "IVA " + it.ivaSrc;
      body.appendChild(tr);
    });
    renderBadge(rec);
  }

  function renderBadge(rec) {
    const el = $("ocIvaBadge"), chk = O.checkIva(rec.items, rec.totals);
    $("ocIvaMini").textContent = chk.ok ? "✔ IVA verificado" : "⚠ revisar";
    $("ocIvaMini").className = "cnt " + (chk.ok ? "ok" : "bad-txt");
    if (!chk.ok) $("secIva").open = true;
    const parts = chk.rows.map((r) => "IVA " + O.fmtRate(r.rate) + ": $ " + O.fmtMoney(r.pdf));
    if (chk.ok) {
      el.className = "badge good";
      el.innerHTML = "✔ IVA verificado: con estos porcentajes los importes coinciden con los del PDF (" + esc(parts.join(" · ")) + ")." +
        (rec.solver && rec.solver.status === "ambiguous" ? " <b>Ojo:</b> había más de una combinación posible; revisá que sea la correcta." : "");
    } else {
      el.className = "badge warn";
      const diffs = chk.rows.filter((r) => !r.ok).map((r) => "IVA " + O.fmtRate(r.rate) + ": el PDF dice $ " + O.fmtMoney(r.pdf) + " y con tu selección da $ " + O.fmtMoney(r.expected));
      const unset = rec.items.some((it) => it.iva === null || it.iva === undefined);
      el.innerHTML = "⚠ " + esc((rec.solver && rec.solver.status !== "single" ? rec.solver.message + " " : "") + (unset ? "Hay productos sin IVA. " : "") + diffs.join(". "));
    }
  }

  // ---------- Paso 2: cliente, período y entregas ----------
  function monthOf(rec) { return rec.pmonth || null; }
  // Calcula (si se puede) la tabla de entregas desde el Excel de Despachos
  function recomputeAuto(rec) {
    const cl = D.clientById(rec.client), range = D.periodRange(rec.pmode, rec.pcustom);
    if (cl && cl.kind === "oc") {
      if (excel && rec.otherSheet) { const r = D.extractOther(excel.wb, rec.otherSheet, range, monthOf(rec)); rec.auto = { rows: r.rows, info: r.info, warnings: r.warnings, error: r.error, missing: !!r.missing, file: excel.name }; return; }
      rec.auto = { rows: [], info: "", warnings: [], error: "", missing: true, file: excel ? excel.name : "" }; return;
    }
    if (!excel) { if (!rec.auto) rec.auto = null; return; }                     // sin Excel cargado se conserva lo último leído
    if (!cl) { rec.auto = { rows: [], info: "", warnings: [], error: "Elegí el cliente de esta OC." }; return; }
    if (cl.kind === "oc") { rec.auto = { rows: [], info: "", warnings: [], error: "", missing: true, file: excel.name }; return; }
    const r = D.extractTable(excel.wb, cl, range, monthOf(rec));
    rec.auto = { rows: r.rows, info: r.info, warnings: r.warnings, error: r.error, missing: !!r.missing, file: excel.name };
  }

  function renderClientBox(rec) {
    const sel = $("ocClient");
    sel.innerHTML = '<option value="">— elegir —</option>' + D.CLIENTS.map((c) => '<option value="' + c.id + '"' + (rec.client === c.id ? " selected" : "") + ">" + esc(c.name) + "</option>").join("");
    sel.classList.toggle("bad", !rec.client);
    const ow = $("ocOtherWrap"), os = $("ocOtherSheet"), others = excel ? D.otherSheets(excel.wb) : [];
    ow.hidden = !(rec.client === "otro" && others.length);
    os.innerHTML = '<option value="">— usar lo pedido en la OC —</option>' + others.map((s) => '<option value="' + esc(s.name) + '"' + (rec.otherSheet === s.name ? " selected" : "") + ">" + esc(s.name) + "</option>").join("");
    $("ocPeriod").value = rec.pmode || "";
    $("ocPeriod").classList.toggle("bad", !rec.pmode);
    $("ocCustom").hidden = rec.pmode !== "custom";
    if (rec.pmode === "custom") { if (document.activeElement !== $("ocFrom")) $("ocFrom").value = (rec.pcustom && rec.pcustom.from) || ""; if (document.activeElement !== $("ocTo")) $("ocTo").value = (rec.pcustom && rec.pcustom.to) || ""; }
    const lines = [];
    const cl = D.clientById(rec.client);
    if (rec.clientHow === "sugerido" && cl) lines.push("Cliente y período sugeridos según la OC: confirmalos.");
    else if (rec.clientHow === "recordado" && cl) lines.push("Cliente recordado de una OC anterior con el mismo lugar de entrega.");
    else if (!rec.client && rec.delivery) lines.push("No pude reconocer el cliente por el lugar de entrega («" + rec.delivery + "»): elegilo.");
    const a = rec.auto;
    const sheetOther = cl && cl.kind === "oc" && rec.otherSheet && a && !a.missing;
    if (cl && cl.kind === "oc" && !sheetOther) { /* sin hoja en el Excel: se explica abajo */ }
    else if (cl && a) {
      if (a.error) lines.push("⚠ " + a.error);
      else lines.push("✔ Cantidades del Excel: " + a.info + ".");
      (a.warnings || []).forEach((w) => lines.push("⚠ " + w));
    } else if (cl && rec.pmode && !excel) lines.push("Para leer las entregas del Excel de Despachos tocá “Buscar OC del mes” (o pegá la tabla en “Entregas y coincidencias”).");
    if (parsedPaste(rec).source === "oc") lines.push(cl ? (cl.kind === "oc" ? "Sin hoja del Excel: se usan las cantidades pedidas en la OC (podés elegir una hoja del Excel arriba)." : "Este cliente no figura en el Excel: se usan las cantidades pedidas en la OC.") : "Sin cliente: se usan las cantidades pedidas en la OC. Elegí el cliente para tomar las entregas del Excel.");
    $("ocAutoInfo").innerHTML = lines.map((l) => esc(l)).join("<br>");
  }

  $("ocClient").addEventListener("change", () => {
    const rec = cur(); if (!rec) return;
    rec.client = $("ocClient").value || ""; rec.clientHow = "manual";
    if (rec.client && rec.delivery) clientAliases[D.norm(rec.delivery)] = rec.client;       // se acuerda para el mes que viene
    recomputeAuto(rec); save(); render();
  });
  $("ocOtherSheet").addEventListener("change", () => {
    const rec = cur(); if (!rec) return;
    rec.otherSheet = $("ocOtherSheet").value || ""; recomputeAuto(rec); save(); render();
  });
  $("ocPeriod").addEventListener("change", () => {
    const rec = cur(); if (!rec) return;
    rec.pmode = $("ocPeriod").value; rec.pmodeUser = true;
    recomputeAuto(rec); save(); render();
  });
  const dayInput = (id, key) => $(id).addEventListener("input", () => {
    const rec = cur(); if (!rec) return;
    const c = $(id).value.replace(/\D+/g, "").slice(0, 2); $(id).value = c;
    rec.pcustom = Object.assign({}, rec.pcustom, { [key]: c }); recomputeAuto(rec); save();
    renderClientBox(rec); const st = renderInvoice(rec); renderReview(rec, st);
  });
  dayInput("ocFrom", "from"); dayInput("ocTo", "to");

  function parsedPaste(rec) {
    if (rec.paste && rec.paste.trim()) {
      const p = O.parsePasted(rec.paste), matches = O.matchRows(p.rows, rec.items, aliases, rec.map || {});
      return { p, matches, inv: O.buildInvoice(rec.items, p.rows, matches), source: "manual" };
    }
    let rows = rec.auto && !rec.auto.error ? rec.auto.rows : [], source = rows.length ? "excel" : "none";
    // Sin cliente (o el cliente no figura en el Excel): se factura lo pedido en la OC
    if (!rows.length && (!rec.client || (rec.auto && rec.auto.missing))) {
      rows = rec.items.filter((it) => it.qty > 0).map((it) => ({ name: it.desc, key: O.keyOf(it.desc), sum: it.qty, invalid: [] }));
      if (rows.length) source = "oc";
    }
    const p = { rows, headerSkipped: false, warnings: [] }, matches = O.matchRows(rows, rec.items, aliases, rec.map || {});
    return { p, matches, inv: O.buildInvoice(rec.items, rows, matches), source };
  }

  function renderReview(rec, st) {
    const box = $("ocReviewBox"), body = $("ocReviewTable").querySelector("tbody");
    body.innerHTML = "";
    const { p, matches } = st;
    box.hidden = p.rows.length === 0;
    if (!p.rows.length) return;
    const pendingRows = p.rows.filter((r, k) => (matches[k].target === null) && r.sum > 0).length;
    $("ocReviewSummary").innerHTML = "Coincidencias con la OC · " + p.rows.length + " filas" + (st.source === "excel" ? " (del Excel)" : st.source === "oc" ? " (de la OC)" : " (pegadas)") + (pendingRows ? ' · <span class="bad-txt">' + pendingRows + " sin asignar</span>" : " ✔");
    if (pendingRows) { box.open = true; $("secDel").open = true; }
    p.rows.forEach((r, k) => {
      const m = matches[k], tr = document.createElement("tr");
      tr.className = m.target === null && r.sum > 0 ? "pending" : (r.sum === 0 ? "dim" : "");
      tr.innerHTML = '<td class="desc">' + esc(r.name) + (r.invalid && r.invalid.length ? '<br><small class="bad-txt">Celdas que no son número (se ignoraron): ' + esc(r.invalid.join(", ")) + "</small>" : "") +
        '</td><td class="num">' + O.fmtQty(r.sum) + "</td><td></td>";
      const sel = document.createElement("select");
      const order = [...new Set([...m.suggestions, ...rec.items.map((_, i) => i)])];
      sel.innerHTML = '<option value="">— elegir —</option>' + order.map((i) => '<option value="' + i + '">' + esc(rec.items[i].desc) + "</option>").join("") + '<option value="-1">(no facturar / ignorar)</option>';
      sel.value = m.target === null ? "" : String(m.target);
      sel.addEventListener("change", () => {
        rec.map = rec.map || {};
        if (sel.value === "") delete rec.map[r.key];
        else {
          rec.map[r.key] = Number(sel.value);
          if (Number(sel.value) >= 0) aliases[r.key] = O.keyOf(rec.items[Number(sel.value)].desc);   // se acuerda para próximas OC
        }
        save(); renderReview(rec, parsedPaste(rec)); renderInvoice(rec);
      });
      tr.lastElementChild.appendChild(sel);
      if (m.how && m.target !== null && r.sum > 0) { const s = document.createElement("small"); s.className = "how"; s.textContent = m.how === "exacto" ? "" : " (" + m.how + ")"; tr.lastElementChild.appendChild(s); }
      body.appendChild(tr);
    });
  }

  // ---------- Paso 3: tabla de facturación ----------
  let lastLines = [];
  function renderInvoice(rec) {
    const st = parsedPaste(rec), inv = st.inv;
    lastLines = inv.lines;
    const body = $("ocInvTable").querySelector("tbody");
    body.innerHTML = "";
    if (!inv.lines.length) {
      const tr = document.createElement("tr");
      const hasSrc = st.p.rows.length > 0;
      tr.innerHTML = '<td colspan="4" class="empty-row">' + (hasSrc ? "Ninguna fila tiene cantidades entregadas." : "Elegí el cliente y el período (o pegá las entregas) para ver la tabla de facturación.") + "</td>";
      body.appendChild(tr);
    }
    inv.lines.forEach((l) => {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td class="desc">' + esc(l.desc) + '</td><td class="num">' + O.fmtQty(l.qty) + '</td><td class="num">$ ' + O.fmtMoney(l.price) + '</td><td class="ctr' + (l.iva === null || l.iva === undefined ? " bad-txt" : "") + '">' + O.fmtRate(l.iva) + "</td>";
      body.appendChild(tr);
    });
    const warn = [];
    if (inv.pending) warn.push("⚠ " + inv.pending + (inv.pending === 1 ? " fila de las entregas tiene cantidades pero no está asignada" : " filas de las entregas tienen cantidades pero no están asignadas") + " a un producto de la OC, así que NO están en esta tabla. Revisá “Coincidencias con la OC”.");
    st.p.warnings.forEach((w) => warn.push("⚠ " + w));
    if (st.p.rows.length && st.p.rows.every((r) => r.sum === 0)) warn.push("⚠ Ninguna fila tiene cantidades: revisá el cliente, el período y las columnas.");
    if (inv.unknownBase > 0) warn.push("⚠ Hay productos con IVA sin definir; el total no los incluye.");
    $("ocWarn").innerHTML = warn.map((w) => '<p class="badge warn">' + esc(w) + "</p>").join("");
    $("ocInvTotals").innerHTML = inv.lines.length
      ? '<div><span>Subtotal (sin IVA)</span><b>$ ' + O.fmtMoney(inv.subtotal) + "</b></div>" + inv.ivas.map((x) => "<div><span>IVA " + O.fmtRate(x.rate) + "</span><b>$ " + O.fmtMoney(x.amount) + "</b></div>").join("") + '<div class="tot"><span>Total</span><b>$ ' + O.fmtMoney(inv.total) + "</b></div>"
      : "";
    $("ocOmitted").textContent = inv.omitted.length && st.p.rows.length ? inv.omitted.length + (inv.omitted.length === 1 ? " producto de la OC sin entregas (no se factura)." : " productos de la OC sin entregas (no se facturan).") : "";
    $("ocOmitted").title = inv.omitted.join("; ");
    $("ocCopyBtn").disabled = !inv.lines.length;
    $("ocDelMini").textContent = st.source === "excel" ? "del Excel" : st.source === "manual" ? "pegadas" : st.source === "oc" ? "de la OC" : "";
    $("ocPasteInfo").textContent = rec.paste && rec.paste.trim() ? st.p.rows.length + " filas leídas" + (st.p.headerSkipped ? " (se omitió la fila de encabezado)" : "") + " · se usa la tabla pegada en vez del Excel" : "";
    renderBill(rec); renderFacturas(rec);
    return st;
  }

  // Resumen: a facturar / facturado / falta
  function renderBill(rec) {
    const b = billing(rec), box = $("ocBill");
    if (!b.hasTotal) { box.innerHTML = '<p class="hint">Elegí el cliente y el período para calcular cuánto hay que facturar.</p>'; return; }
    const falta = O.round(b.total - b.fact, 2), over = -falta > b.tol;
    const msg = b.done ? '<p class="badge good">✔ Facturación completa: lo facturado coincide con lo entregado.</p>'
      : over ? '<p class="badge warn">⚠ Se facturó de más: ' + money(-falta) + ".</p>"
      : b.n === 0 ? "" : "";
    box.innerHTML = '<div class="stats"><div><span>A facturar</span><b>' + money(b.total) + '</b></div><div><span>Facturado</span><b>' + money(b.fact) + '</b></div><div><span>' + (over ? "Excedente" : "Falta facturar") + '</span><b' + (b.done ? ' class="ok"' : "") + ">" + money(Math.abs(b.done ? 0 : falta)) + '</b></div>' +
      '<div class="pct-big' + (b.done ? " ok" : "") + '">' + fmtPct(b.pct) + "</div></div>" +
      '<div class="progress"><i style="width:' + Math.max(0, Math.min(100, b.pct)) + '%"></i></div>' + msg +
      (b.st.inv.unknownBase > 0 ? '<p class="badge warn">⚠ Hay productos sin IVA definido: el total a facturar no los incluye.</p>' : "") +
      (b.unread ? '<p class="badge warn">⚠ ' + b.unread + (b.unread === 1 ? " factura no se pudo leer" : " facturas no se pudieron leer") + ": cargá el importe a mano en “Facturas”.</p>" : "");
  }

  // Facturas encontradas en la carpeta de la OC
  function renderFacturas(rec) {
    const box = $("facBody"), facs = factList(rec).slice().sort((a, b) => (a.name > b.name ? 1 : -1));
    $("facCount").textContent = rec.fact ? (facs.length ? facs.length + (facs.length === 1 ? " encontrada" : " encontradas") : "ninguna") : "";
    if (!rec.fact) { box.innerHTML = '<p class="hint">Todavía no se buscaron las facturas de esta OC. Tocá “Actualizar facturas”.</p>'; return; }
    if (rec.fact.error) { box.innerHTML = '<p class="badge warn">⚠ ' + esc(rec.fact.error) + "</p>"; return; }
    if (!rec.fact.carpeta) { box.innerHTML = '<p class="hint">No encontré la carpeta <b>OC-' + esc(rec.oc) + "</b> en tu Drive (se crea al guardar los remitos desde la sección Remitos).</p>"; return; }
    if (!facs.length) { box.innerHTML = '<p class="hint">La carpeta <b>OC-' + esc(rec.oc) + "</b> todavía no tiene facturas." + (rec.fact.otros ? " Hay " + rec.fact.otros + " archivo" + (rec.fact.otros === 1 ? "" : "s") + " más (remitos)." : "") + "</p>"; return; }
    box.innerHTML = "";
    facs.forEach((f) => {
      const row = document.createElement("div"); row.className = "fac-row" + (f.ok ? "" : " bad");
      const sign = f.sign < 0 ? "−" : f.sign > 0 ? "+" : "";
      const amount = f.ok ? '<span class="amt ' + (f.sign < 0 ? "neg" : "pos") + '">' + sign + " " + money(f.total) + "</span>" : "";
      row.innerHTML = '<div class="fac-name"><strong>' + esc(f.label) + "</strong><small>N.º " + esc(f.short) + (f.date ? " · " + esc(f.date) : "") + (f.manual ? " · importe cargado a mano" : "") + '</small></div><div class="fac-amt">' + amount + "</div>";
      const cell = row.querySelector(".fac-amt");
      if (!f.known) { cell.innerHTML = '<small class="bad-txt">Tipo desconocido: no se suma</small>'; }
      else if (!f.ok || editing[f.id]) {
        const inp = document.createElement("input"); inp.type = "text"; inp.inputMode = "decimal"; inp.className = "fac-input"; inp.placeholder = "Importe total";
        inp.setAttribute("aria-label", "Importe total de la factura " + f.short);
        if (f.ok) inp.value = O.fmtMoney(f.total);
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
        inp.addEventListener("change", () => {
          const v = O.parseNumber(inp.value);
          if (v === null || Number.isNaN(v) || v < 0) return;
          Object.assign(facCache[f.id], { total: O.round(v, 2), ok: true, manual: true }); delete editing[f.id]; save(); render();
        });
        cell.innerHTML = ""; if (!f.ok) { const t = document.createElement("small"); t.className = "bad-txt"; t.textContent = f.error || "No se pudo leer"; cell.appendChild(t); }
        cell.appendChild(inp);
      } else {
        const b = document.createElement("button"); b.type = "button"; b.className = "link-btn tiny"; b.textContent = "corregir";
        b.addEventListener("click", () => { editing[f.id] = true; renderFacturas(rec); });
        cell.appendChild(b);
      }
      box.appendChild(row);
    });
    if (rec.fact.at) { const p = document.createElement("p"); p.className = "hint small-note"; p.textContent = "Carpeta revisada " + new Date(rec.fact.at).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) + "."; box.appendChild(p); }
  }

  function render() {
    const { visible } = renderListSafe();
    const ex = $("ocExcelInfo");
    ex.textContent = excel ? "Excel de Despachos: " + excel.name : "Buscá las órdenes de compra del mes y controlá cuánto falta facturar de cada una.";
    const rec = cur();
    $("ocDetail").hidden = !rec;
    $("ocEmpty").hidden = !!rec;
    if (!rec) {
      $("ocEmptyText").textContent = !ocs.length ? "Todavía no cargaste ninguna OC." : visible.length ? "Elegí una OC de la lista." : "¡Todo facturado! No quedan OC pendientes.";
      $("ocEmptySub").textContent = !ocs.length ? "Tocá “Buscar OC del mes” o “Agregar OC”." : visible.length ? "Vas a ver cuánto falta facturar y las facturas de cada una." : "Las OC completas están ocultas: podés mostrarlas con el botón de la lista.";
      return;
    }
    renderItems(rec);
    renderClientBox(rec);
    if ($("ocPaste").value !== (rec.paste || "")) $("ocPaste").value = rec.paste || "";
    if (rec.paste && rec.paste.trim()) $("secDel").open = true;
    const st = renderInvoice(rec);
    renderReview(rec, st);
  }

  // ---------- Pegar entregas ----------
  let pasteTimer = null;
  $("ocPaste").addEventListener("input", () => {
    const rec = cur(); if (!rec) return;
    rec.paste = $("ocPaste").value;
    clearTimeout(pasteTimer);
    pasteTimer = setTimeout(() => { save(); const st = renderInvoice(rec); renderReview(rec, st); }, 200);
  });
  $("ocPasteClear").addEventListener("click", () => { const rec = cur(); if (!rec) return; rec.paste = ""; rec.map = {}; $("ocPaste").value = ""; save(); render(); });
  $("facClear").addEventListener("click", async () => {
    if (!(await window.RemitosApp.askConfirm("¿Borrar todos los datos guardados de Facturación (OC, facturas leídas y lo que pegaste)? Después volvés a tocar “Buscar OC del mes”.", "Sí, borrar todo", "Cancelar"))) return;
    ocs = []; facCache = {}; aliases = {}; clientAliases = {}; excel = null; currentId = null; editing = {};
    ["ocData", "facCache", "ocAliases", "ocClientAliases"].forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* nada */ } });
    setStatus("Datos de Facturación borrados."); save(); render();
  });
  $("ocShowDone").addEventListener("click", () => { showDone = !showDone; save(); render(); });

  $("ocCopyBtn").addEventListener("click", async () => {
    const txt = O.toTsv(lastLines), btn = $("ocCopyBtn"), old = btn.innerHTML;
    let ok = false;
    try { await navigator.clipboard.writeText(txt); ok = true; }
    catch (e) {
      const ta = document.createElement("textarea"); ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select();
      try { ok = document.execCommand("copy"); } catch (e2) { ok = false; } ta.remove();
    }
    btn.textContent = ok ? "Copiada ✔ (pegala en Excel)" : "No se pudo copiar";
    setTimeout(() => { btn.innerHTML = old; }, 2500);
  });

  // ---------- Armar el registro de una OC ----------
  function buildRecord(oc, number, fileName, prev) {
    const sol = O.solveIva(oc.items, oc.totals);
    oc.items.forEach((it, i) => { it.iva = sol.assign[i]; it.ivaSrc = sol.src[i]; });
    const sug = D.suggestClient(oc, clientAliases), dp = D.defaultPeriodMode(oc);
    const rec = {
      id: prev ? prev.id : "oc" + Date.now() + Math.floor(Math.random() * 1000), oc: number, pdfName: fileName, emission: oc.emission,
      delivery: oc.delivery, address: oc.address, deliveryDate: oc.deliveryDate,
      items: oc.items.map(({ desc, price, qty, importe, mark, iva, ivaSrc }) => ({ desc, price, qty, importe, mark, iva, ivaSrc })),
      totals: oc.totals, solver: { status: sol.status, count: sol.count, message: sol.message },
      paste: prev ? prev.paste : "", map: prev ? prev.map : {}, createdAt: prev ? prev.createdAt : Date.now(),
      client: prev && prev.client ? prev.client : (sug.id || ""), clientHow: prev && prev.client ? prev.clientHow : sug.how,
      pmode: prev && prev.pmode ? prev.pmode : dp.mode, pmodeUser: prev ? prev.pmodeUser : false, pcustom: prev ? prev.pcustom : null,
      pmonth: dp.month || (prev && prev.pmonth) || null, auto: prev ? prev.auto : null
    };
    return rec;
  }
  const upsert = (rec) => { ocs = ocs.filter((x) => x.id !== rec.id); ocs.unshift(rec); };

  // ---------- Buscar las OC del mes en Drive ----------
  const bridgeCfg = () => { const s = jget("settings", {}) || {}; return { url: String(s.bridgeUrl || "").trim(), key: String(s.bridgeKey || "").trim() }; };
  async function bridge(payload) {
    const cfg = bridgeCfg();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(cfg.url) || !cfg.key) throw new Error("Primero configurá el puente a Google en Ajustes (dirección y clave).");
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 180000);
    let res;
    try { res = await fetch(cfg.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(Object.assign({ key: cfg.key }, payload)), redirect: "follow", signal: ctl.signal }); }
    catch (e) { throw new Error(e.name === "AbortError" ? "Google tardó demasiado en responder." : "No hay conexión con Google (revisá internet y la dirección del puente)."); }
    finally { clearTimeout(timer); }
    let out; try { out = await res.json(); } catch (e) { throw new Error("El puente no respondió como se esperaba. Revisá que esté implementado con acceso “Cualquier persona”."); }
    if (!out.ok) {
      if (out.error === "Clave incorrecta") throw new Error("La clave del puente no coincide (revisá Ajustes).");
      if (/OC inválida|Nombre de archivo inválido|Fecha inválida/.test(out.error || "")) throw new Error("El puente es de una versión anterior. Actualizalo con el código nuevo (ver INSTRUCCIONES-PUENTE.txt, “Actualizar el puente a la versión 4”).");
      throw new Error(out.error || "El puente informó un error.");
    }
    return out;
  }
  const b64ToBuf = (b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };

  const mDlg = $("ocMonthDialog"), mInput = $("ocMonthInput"), mProg = $("ocMonthProgress"), mGo = $("ocMonthGo");
  let searching = false;
  const progress = (html) => { mProg.innerHTML = html; mProg.scrollTop = mProg.scrollHeight; };
  $("ocMonthBtn").addEventListener("click", () => {
    if (!mInput.value) mInput.value = MESES[new Date().getMonth()].charAt(0) + MESES[new Date().getMonth()].slice(1).toLowerCase();
    mProg.innerHTML = ""; mGo.disabled = false; searching = false; mDlg.showModal(); mInput.focus(); mInput.select();
  });
  $("ocMonthCancel").addEventListener("click", () => { if (!searching) mDlg.close(); });
  mDlg.addEventListener("cancel", (e) => { if (searching) e.preventDefault(); });
  $("ocMonthForm").addEventListener("submit", (e) => { e.preventDefault(); if (!searching) searchMonth(mInput.value.trim()); });

  async function searchMonth(mes) {
    if (!mes) { progress('<span class="bad-line">Escribí el mes (por ejemplo Noviembre).</span>'); return; }
    searching = true; mGo.disabled = true;
    const log = []; const say = (t, cls) => { log.push('<div class="' + (cls || "") + '">' + esc(t) + "</div>"); progress(log.join("")); };
    try {
      say("Buscando la carpeta en Drive…");
      const list = await bridge({ action: "list", mes });
      const pdfs = list.archivos.filter((f) => f.mime === "application/pdf"), xl = list.archivos.filter((f) => f.mime !== "application/pdf");
      say("Carpeta encontrada: " + list.ruta + " (" + pdfs.length + " PDF y " + xl.length + " Excel).", "ok-line");

      // Excel de Despachos
      let xlFile = null;
      if (xl.length) {
        const pref = xl.filter((f) => /despacho/i.test(f.name)).sort((a, b) => b.updated - a.updated);
        xlFile = pref[0] || xl.sort((a, b) => b.updated - a.updated)[0];
        if (!pref.length && xl.length > 1) say("No hay un Excel con “Despacho” en el nombre; uso el más reciente: " + xlFile.name, "bad-line");
        if (/\.xls$/i.test(xlFile.name) && xlFile.mime === "application/vnd.ms-excel") { say("“" + xlFile.name + "” es un .xls antiguo: guardalo como .xlsx para poder leerlo.", "bad-line"); xlFile = null; }
      } else say("No encontré ningún Excel en la carpeta.", "bad-line");
      if (xlFile) {
        say("Leyendo el Excel “" + xlFile.name + "”…");
        const r = await bridge({ action: "files", ids: [xlFile.id] });
        const f = r.archivos[0];
        if (f.error) say("No se pudo bajar el Excel: " + f.error, "bad-line");
        else {
          try { excel = { name: f.name, wb: await window.Xlsx.read(b64ToBuf(f.b64)), loadedAt: Date.now() }; say("Excel leído: hojas " + excel.wb.sheets.filter((s) => !s.hidden).map((s) => s.name).join(", ") + ".", "ok-line"); }
          catch (e) { say("No pude leer el Excel: " + e.message, "bad-line"); }
        }
      }

      // Órdenes de compra
      const found = [], problems = [];
      for (let i = 0; i < pdfs.length; i += 6) {
        const batch = pdfs.slice(i, i + 6);
        say("Leyendo órdenes de compra " + (i + 1) + " a " + (i + batch.length) + " de " + pdfs.length + "…");
        const r = await bridge({ action: "files", ids: batch.map((f) => f.id) });
        for (const f of r.archivos) {
          if (f.error) { problems.push(f.name + ": " + f.error); continue; }
          try {
            const ex = await window.PdfText.extract(b64ToBuf(f.b64));
            if (!ex.hasText) { problems.push(f.name + ": no trae texto (no es una OC del sistema)."); continue; }
            const oc = O.parseOc(ex.pages);
            if (!oc.items.length) { problems.push(f.name + ": no parece una orden de compra."); continue; }
            const num = oc.ocNumber || ((/(\d{4,})\D*\.pdf$/i.exec(f.name) || [])[1] || "");
            if (!num) { problems.push(f.name + ": no pude saber el número de OC."); continue; }
            found.push({ oc, num, name: f.name });
          } catch (e) { problems.push(f.name + ": " + e.message); }
        }
      }
      found.sort((a, b) => Number(a.num) - Number(b.num));
      const nums = new Set(found.map((x) => x.num));
      const keep = ocs.filter((x) => !nums.has(x.oc));
      const fresh = found.map((x) => buildRecord(x.oc, x.num, x.name, ocs.find((o) => o.oc === x.num)));
      ocs = fresh.concat(keep);
      if (excel) fresh.forEach(recomputeAuto);
      lastMes = mes; currentId = null;
      save(); render();
      try { await loadFacturas(fresh, (t) => say(t)); } catch (e) { say("Facturas: " + e.message, "bad-line"); }
      const noClient = fresh.filter((r) => !r.client).length;
      say("Listo: " + fresh.length + " OC cargadas." + (noClient ? " " + noClient + " sin cliente reconocido: elegilo en cada una." : " Todas con cliente sugerido: revisalos."), "ok-line");
      problems.forEach((p) => say(p, "bad-line"));
      searching = false; mGo.disabled = false;
      setStatus(fresh.length + " OC cargadas" + (noClient ? " (" + noClient + " sin cliente reconocido)" : "") + "." + (problems.length ? " No se pudieron leer: " + problems.map((p) => p.split(":")[0]).join(", ") + "." : ""), problems.length ? "bad-txt" : "");
      setTimeout(() => { if (mDlg.open && !searching) mDlg.close(); }, 700);
    } catch (err) {
      console.error(err);
      say(err.message || "No se pudo completar la búsqueda.", "bad-line");
    } finally { searching = false; mGo.disabled = false; }
  }


  // ---------- Facturas de cada OC (carpeta OC-<número> en Mi unidad) ----------
  let facBusy = false;
  const CACHE_V = "7.4";
  function setStatus(text, cls) { const el = $("facStatus"); el.hidden = !text; el.textContent = text || ""; el.className = "hint fac-status " + (cls || ""); }
  async function ingestFactura(f, meta) {
    const info = F.parseName(f.name || meta.name); if (!info) return;
    const prev = facCache[f.id] || {};
    const base = { v: CACHE_V, id: f.id, name: f.name || meta.name, updated: meta.updated, label: info.label, sign: info.sign, known: info.known, short: info.short, code: info.code, total: null, ok: false, manual: false, date: "", error: "" };
    if (f.error) { base.error = "No se pudo bajar: " + f.error; facCache[f.id] = base; return; }
    try {
      const ex = await window.PdfText.extract(b64ToBuf(f.b64));
      if (!ex.hasText) base.error = "El PDF no trae texto (parece una foto). Cargá el importe a mano.";
      else {
        const r = F.parseInvoice(ex.pages);
        if (r.ok) { base.total = r.total; base.ok = true; base.date = r.date; } else base.error = "No encontré el importe total. Cargalo a mano.";
      }
    } catch (e) { base.error = "No se pudo leer el PDF (" + e.message + "). Cargá el importe a mano. [lector " + ((window.PdfText && window.PdfText.version) || "viejo: falta subir pdftext.js") + "]"; }
    facCache[f.id] = base;
  }
  async function loadFacturas(list, say) {
    if (facBusy || !list.length) return;
    facBusy = true; $("facRefresh").disabled = true;
    const log = say || ((t) => setStatus(t));
    let nuevas = 0, errores = 0;
    try {
      for (let i = 0; i < list.length; i += 6) {
        const chunk = list.slice(i, i + 6);
        log("Buscando facturas (OC " + chunk.map((r) => r.oc).join(", ") + ")…");
        const out = await bridge({ action: "facturas", ocs: chunk.map((r) => r.oc), mes: lastMes || "" });
        const need = [];
        for (const rec of chunk) {
          const info = (out.resultados || {})[rec.oc] || { carpeta: false, archivos: [] };
          if (info.error) { rec.fact = { error: "Drive respondió: " + info.error, at: Date.now(), ids: [] }; errores++; continue; }
          rec.fact = { at: Date.now(), carpeta: !!info.carpeta, ruta: info.ruta || "", otros: info.otros || 0, ids: info.archivos.map((a) => a.id) };
          info.archivos.forEach((a) => { const c = facCache[a.id]; if (!c || c.updated !== a.updated || c.v !== CACHE_V || (!c.ok && !c.manual)) need.push(a); });   // los fallos nunca se guardan: se reintentan siempre
        }
        for (let k = 0; k < need.length; k += 6) {
          const part = need.slice(k, k + 6);
          log("Leyendo facturas " + (k + 1) + " a " + (k + part.length) + " de " + need.length + "…");
          const r = await bridge({ action: "files", ids: part.map((a) => a.id) });
          for (const f of r.archivos) { await ingestFactura(f, part.find((a) => a.id === f.id) || {}); nuevas++; }
        }
        save(); render();
      }
      const total = list.reduce((s, r) => s + ((r.fact && r.fact.ids) || []).length, 0);
      log(total + (total === 1 ? " factura encontrada" : " facturas encontradas") + " en " + list.length + (list.length === 1 ? " OC." : " OC.") + (errores ? " (" + errores + " con error)" : ""));
    } finally { facBusy = false; $("facRefresh").disabled = false; }
  }
  $("facRefresh").addEventListener("click", async () => {
    if (!ocs.length) { setStatus("Primero cargá las OC (Buscar OC del mes o Agregar OC)."); return; }
    try { await loadFacturas(ocs); } catch (e) { setStatus(e.message || "No se pudieron buscar las facturas.", "bad-txt"); }
  });

  // ---------- Agregar una OC a mano ----------
  const dlg = $("ocAddDialog"), numIn = $("ocAddNumber"), drop = $("ocDrop"), fileIn = $("ocFile"), addMsg = $("ocAddMsg");
  let busy = false;
  const cleanNum = (s) => String(s || "").replace(/\D+/g, "");
  function syncDrop() {
    const ok = cleanNum(numIn.value).length > 0 && !busy;
    drop.classList.toggle("disabled", !ok);
    fileIn.disabled = !ok;
    $("ocDropTitle").textContent = busy ? "Analizando el PDF…" : ok ? "Elegí el PDF de la OC" : "Escribí primero el número de OC";
    $("ocDropSub").textContent = busy ? "Un momento." : ok ? "Tocá acá o arrastrá el archivo hasta este cuadro." : "Después podés elegir el PDF o arrastrarlo hasta acá.";
  }
  $("ocAddBtn").addEventListener("click", () => { numIn.value = ""; addMsg.textContent = ""; busy = false; syncDrop(); dlg.showModal(); numIn.focus(); });
  $("ocAddCancel").addEventListener("click", () => { if (!busy) dlg.close(); });
  numIn.addEventListener("input", () => { const c = cleanNum(numIn.value); if (c !== numIn.value) numIn.value = c; addMsg.textContent = ""; syncDrop(); });
  numIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (!fileIn.disabled) fileIn.click(); } });
  drop.addEventListener("click", (e) => { if (fileIn.disabled) e.preventDefault(); });
  fileIn.addEventListener("change", () => { const f = fileIn.files[0]; fileIn.value = ""; if (f) importPdf(f); });

  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  // Con la sección de OC abierta se evita que el navegador abra el PDF si se suelta fuera del cuadro.
  window.addEventListener("dragover", (e) => { if (views.oc.hidden || !hasFiles(e)) return; e.preventDefault(); drop.classList.toggle("over", dlg.open && !fileIn.disabled); });
  window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) drop.classList.remove("over"); });
  window.addEventListener("drop", (e) => {
    if (views.oc.hidden || !hasFiles(e)) return;
    e.preventDefault(); drop.classList.remove("over");
    if (dlg.open && !fileIn.disabled && e.dataTransfer.files.length) importPdf(e.dataTransfer.files[0]);
  });

  async function importPdf(file) {
    if (busy) return;
    const num = cleanNum(numIn.value);
    if (!num) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") { addMsg.textContent = "Ese archivo no es un PDF."; return; }
    busy = true; addMsg.textContent = ""; syncDrop();
    try {
      const ex = await window.PdfText.extract(await file.arrayBuffer());
      if (!ex.hasText) throw new Error("Este PDF no trae texto (parece una foto o un escaneo). Por ahora solo se pueden leer PDF generados por el sistema del cliente.");
      const oc = O.parseOc(ex.pages);
      if (!oc.items.length) throw new Error("No encontré la tabla de productos en el PDF. ¿Es una orden de compra del mismo formato?");
      if (oc.ocNumber && oc.ocNumber !== num) {
        const useMine = await window.RemitosApp.askConfirm("El PDF dice que es la OC " + oc.ocNumber + " pero escribiste " + num + ".\n\n¿Querés seguir con la OC " + num + "?", "Sí, usar " + num, "No, volver");
        if (!useMine) { busy = false; syncDrop(); return; }
      }
      const dup = ocs.find((x) => x.oc === num);
      if (dup && !(await window.RemitosApp.askConfirm("Ya cargaste la OC " + num + ". ¿Reemplazarla? (se pierde lo que pegaste de entregas)", "Sí, reemplazar", "Cancelar"))) { busy = false; syncDrop(); return; }
      const rec = buildRecord(oc, num, file.name, dup ? Object.assign({}, dup, { paste: "", map: {}, client: "", pmode: "" }) : null);
      if (dup) rec.id = dup.id;
      if (excel) recomputeAuto(rec);
      upsert(rec); currentId = rec.id; save();
      busy = false; dlg.close(); render();
      $("ocDetail").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      console.error(err);
      addMsg.textContent = err.message || "No se pudo leer el PDF.";
      busy = false; syncDrop();
    }
  }

  load();
  currentId = null;
})();
