// oc.js — Sección "Órdenes de compra": buscar las OC y el Excel de Despachos del mes en Drive (o cargar una OC a mano),
// asignar el cliente, deducir el IVA y armar la tabla de facturación. No toca nada de la sección de remitos.
(() => {
  "use strict";
  const O = window.OcParse, D = window.Despachos, $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const MESES = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];

  // ---------- Datos guardados en el navegador ----------
  let ocs = [], aliases = {}, clientAliases = {}, currentId = null;
  let excel = null;                                   // Excel de Despachos leído (solo en memoria): {name, wb, loadedAt}
  const jget = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v === null ? d : v; } catch (e) { return d; } };
  const load = () => { ocs = jget("ocData", []); if (!Array.isArray(ocs)) ocs = []; aliases = jget("ocAliases", {}) || {}; clientAliases = jget("ocClientAliases", {}) || {}; };
  const save = () => { try { localStorage.setItem("ocData", JSON.stringify(ocs)); localStorage.setItem("ocAliases", JSON.stringify(aliases)); localStorage.setItem("ocClientAliases", JSON.stringify(clientAliases)); } catch (e) { /* nada */ } };
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

  // ---------- Lista de OC ----------
  function renderList() {
    const list = $("ocList");
    list.innerHTML = "";
    $("ocEmpty").hidden = ocs.length > 0;
    ocs.forEach((rec) => {
      const cl = D.clientById(rec.client), b = document.createElement("div");
      b.className = "oc-chip" + (rec.id === currentId ? " on" : "");
      b.innerHTML = '<button type="button" class="oc-open"><strong>OC ' + esc(rec.oc) + '</strong><small>' + (cl ? esc(cl.name) : '<span class="bad-txt">sin cliente</span>') + '</small></button>' +
        '<button type="button" class="oc-del" title="Eliminar esta OC" aria-label="Eliminar OC ' + esc(rec.oc) + '"><svg class="i"><use href="#i-trash"/></svg></button>';
      b.querySelector(".oc-open").addEventListener("click", () => { currentId = rec.id; render(); });
      b.querySelector(".oc-del").addEventListener("click", async () => {
        if (!(await window.RemitosApp.askConfirm("¿Eliminar la OC " + rec.oc + " y lo que pegaste de entregas?", "Sí, eliminar", "Cancelar"))) return;
        ocs = ocs.filter((x) => x.id !== rec.id); if (currentId === rec.id) currentId = ocs.length ? ocs[0].id : null; save(); render();
      });
      list.appendChild(b);
    });
  }

  // ---------- Paso 1: productos e IVA ----------
  const RATES = [21, 10.5, 27, 0];
  function renderItems(rec) {
    $("ocTitle").textContent = "· OC " + rec.oc;
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
    if (!excel) { if (!rec.auto) rec.auto = null; return; }                     // sin Excel cargado se conserva lo último leído
    if (!cl) { rec.auto = { rows: [], info: "", warnings: [], error: "Elegí el cliente de esta OC." }; return; }
    const r = D.extractTable(excel.wb, cl, range, monthOf(rec));
    rec.auto = { rows: r.rows, info: r.info, warnings: r.warnings, error: r.error, file: excel.name };
  }

  function renderClientBox(rec) {
    const sel = $("ocClient");
    sel.innerHTML = '<option value="">— elegir —</option>' + D.CLIENTS.map((c) => '<option value="' + c.id + '"' + (rec.client === c.id ? " selected" : "") + ">" + esc(c.name) + "</option>").join("");
    sel.classList.toggle("bad", !rec.client);
    $("ocPeriod").value = rec.pmode || "";
    $("ocPeriod").classList.toggle("bad", !rec.pmode);
    $("ocCustom").hidden = rec.pmode !== "custom";
    if (rec.pmode === "custom") { if (document.activeElement !== $("ocFrom")) $("ocFrom").value = (rec.pcustom && rec.pcustom.from) || ""; if (document.activeElement !== $("ocTo")) $("ocTo").value = (rec.pcustom && rec.pcustom.to) || ""; }
    const lines = [];
    const cl = D.clientById(rec.client);
    if (rec.clientHow === "sugerido" && cl) lines.push("Cliente sugerido por el lugar de entrega («" + rec.delivery + "»): confirmalo.");
    else if (rec.clientHow === "recordado" && cl) lines.push("Cliente recordado de una OC anterior con el mismo lugar de entrega.");
    else if (!rec.client && rec.delivery) lines.push("No pude reconocer el cliente por el lugar de entrega («" + rec.delivery + "»): elegilo.");
    if (rec.pmode && !rec.pmodeUser && rec.deliveryDate) lines.push("Período propuesto según la fecha de entrega de la OC (" + rec.deliveryDate.replace(/-/g, "/") + ").");
    const a = rec.auto;
    if (cl && a) {
      if (a.error) lines.push("⚠ " + a.error);
      else lines.push("✔ Cantidades leídas del Excel" + (a.file ? " «" + a.file + "»" : "") + ": " + a.info + ".");
      (a.warnings || []).forEach((w) => lines.push("⚠ " + w));
    } else if (cl && rec.pmode && !excel) lines.push("Para leer las entregas del Excel de Despachos tocá “Buscar OC del mes” (o pegá la tabla abajo).");
    $("ocAutoInfo").innerHTML = lines.map((l) => esc(l)).join("<br>");
  }

  $("ocClient").addEventListener("change", () => {
    const rec = cur(); if (!rec) return;
    rec.client = $("ocClient").value || ""; rec.clientHow = "manual";
    if (rec.client && rec.delivery) clientAliases[D.norm(rec.delivery)] = rec.client;       // se acuerda para el mes que viene
    recomputeAuto(rec); save(); render();
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
    const rows = rec.auto && !rec.auto.error ? rec.auto.rows : [];
    const p = { rows, headerSkipped: false, warnings: [] }, matches = O.matchRows(rows, rec.items, aliases, rec.map || {});
    return { p, matches, inv: O.buildInvoice(rec.items, rows, matches), source: rows.length ? "excel" : "none" };
  }

  function renderReview(rec, st) {
    const box = $("ocReviewBox"), body = $("ocReviewTable").querySelector("tbody");
    body.innerHTML = "";
    const { p, matches } = st;
    box.hidden = p.rows.length === 0;
    if (!p.rows.length) return;
    const pendingRows = p.rows.filter((r, k) => (matches[k].target === null) && r.sum > 0).length;
    $("ocReviewSummary").innerHTML = "Coincidencias con la OC · " + p.rows.length + " filas" + (st.source === "excel" ? " (del Excel)" : " (pegadas)") + (pendingRows ? ' · <span class="bad-txt">' + pendingRows + " sin asignar</span>" : " ✔");
    if (pendingRows) box.open = true;
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
    $("ocOmitted").textContent = inv.omitted.length && st.p.rows.length ? "Productos de la OC sin entregas (no se facturan): " + inv.omitted.join("; ") : "";
    $("ocCopyBtn").disabled = !inv.lines.length;
    $("ocPasteInfo").textContent = rec.paste && rec.paste.trim() ? st.p.rows.length + " filas leídas" + (st.p.headerSkipped ? " (se omitió la fila de encabezado)" : "") + " · se usa la tabla pegada en vez del Excel" : "";
    return st;
  }

  function render() {
    if (currentId === null && ocs.length) currentId = ocs[0].id;
    renderList();
    const ex = $("ocExcelInfo");
    ex.hidden = !excel;
    if (excel) ex.textContent = "Excel de Despachos cargado: " + excel.name + " · hojas: " + excel.wb.sheets.filter((s) => !s.hidden).map((s) => s.name).join(", ");
    const rec = cur();
    $("ocDetail").hidden = !rec;
    if (!rec) return;
    renderItems(rec);
    renderClientBox(rec);
    if ($("ocPaste").value !== (rec.paste || "")) $("ocPaste").value = rec.paste || "";
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
      if (/OC inválida|Nombre de archivo inválido|Fecha inválida/.test(out.error || "")) throw new Error("El puente es de una versión anterior. Actualizalo con el código nuevo (ver INSTRUCCIONES-PUENTE.txt, “Actualizar el puente a la versión 2”).");
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
      currentId = fresh.length ? fresh[0].id : currentId;
      save(); render();
      const noClient = fresh.filter((r) => !r.client).length;
      say("Listo: " + fresh.length + " OC cargadas." + (noClient ? " " + noClient + " sin cliente reconocido: elegilo en cada una." : " Todas con cliente sugerido: revisalos."), "ok-line");
      problems.forEach((p) => say(p, "bad-line"));
    } catch (err) {
      console.error(err);
      say(err.message || "No se pudo completar la búsqueda.", "bad-line");
    } finally { searching = false; mGo.disabled = false; }
  }

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
  if (ocs.length) currentId = ocs[0].id;
})();
