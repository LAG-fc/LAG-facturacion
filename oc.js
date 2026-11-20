// oc.js — Sección "Órdenes de compra": cargar la OC (PDF), deducir el IVA, pegar las entregas desde Excel
// y obtener la tabla de facturación. No toca nada de la sección de remitos (solo se alternan entre sí).
(() => {
  "use strict";
  const O = window.OcParse, $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- Datos guardados en el navegador ----------
  let ocs = [], aliases = {}, currentId = null;
  const load = () => {
    try { ocs = JSON.parse(localStorage.getItem("ocData") || "[]"); if (!Array.isArray(ocs)) ocs = []; } catch (e) { ocs = []; }
    try { aliases = JSON.parse(localStorage.getItem("ocAliases") || "{}") || {}; } catch (e) { aliases = {}; }
  };
  const save = () => { try { localStorage.setItem("ocData", JSON.stringify(ocs)); localStorage.setItem("ocAliases", JSON.stringify(aliases)); } catch (e) { /* nada */ } };
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
      const b = document.createElement("div");
      b.className = "oc-chip" + (rec.id === currentId ? " on" : "");
      b.innerHTML = '<button type="button" class="oc-open"><strong>OC ' + esc(rec.oc) + '</strong><small>' + rec.items.length + ' productos</small></button>' +
        '<button type="button" class="oc-del" title="Eliminar esta OC" aria-label="Eliminar OC ' + esc(rec.oc) + '"><svg class="i"><use href="#i-trash"/></svg></button>';
      b.querySelector(".oc-open").addEventListener("click", () => { currentId = rec.id; render(); });
      b.querySelector(".oc-del").addEventListener("click", async () => {
        if (!(await window.RemitosApp.askConfirm("¿Eliminar la OC " + rec.oc + " y lo que pegaste de entregas?", "Sí, eliminar", "Cancelar"))) return;
        ocs = ocs.filter((x) => x.id !== rec.id); if (currentId === rec.id) currentId = ocs.length ? ocs[0].id : null; save(); render();
      });
      list.appendChild(b);
    });
  }

  // ---------- Detalle ----------
  const RATES = [21, 10.5, 27, 0];
  function renderItems(rec) {
    $("ocTitle").textContent = "· OC " + rec.oc;
    $("ocMeta").textContent = [rec.emission ? "Emitida el " + rec.emission : "", rec.pdfName ? "Archivo: " + rec.pdfName : ""].filter(Boolean).join(" · ");
    const body = $("ocItemsTable").querySelector("tbody");
    body.innerHTML = "";
    rec.items.forEach((it, i) => {
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

  function parsedPaste(rec) {
    const p = O.parsePasted(rec.paste || "");
    const matches = O.matchRows(p.rows, rec.items, aliases, rec.map || {});
    return { p, matches, inv: O.buildInvoice(rec.items, p.rows, matches) };
  }

  function renderReview(rec, st) {
    const box = $("ocReviewBox"), body = $("ocReviewTable").querySelector("tbody");
    body.innerHTML = "";
    const { p, matches, inv } = st;
    box.hidden = p.rows.length === 0;
    if (!p.rows.length) return;
    const pendingRows = p.rows.filter((r, k) => (matches[k].target === null) && r.sum > 0).length;
    $("ocReviewSummary").innerHTML = "Coincidencias con la OC · " + p.rows.length + " filas" + (pendingRows ? ' · <span class="bad-txt">' + pendingRows + " sin asignar</span>" : " ✔");
    if (pendingRows) box.open = true;
    p.rows.forEach((r, k) => {
      const m = matches[k], tr = document.createElement("tr");
      tr.className = m.target === null && r.sum > 0 ? "pending" : (r.sum === 0 ? "dim" : "");
      tr.innerHTML = '<td class="desc">' + esc(r.name) + (r.invalid.length ? '<br><small class="bad-txt">Celdas que no son número (se ignoraron): ' + esc(r.invalid.join(", ")) + "</small>" : "") +
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

  let lastLines = [];
  function renderInvoice(rec) {
    const st = parsedPaste(rec), inv = st.inv;
    lastLines = inv.lines;
    const body = $("ocInvTable").querySelector("tbody");
    body.innerHTML = "";
    if (!inv.lines.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td colspan="4" class="empty-row">' + (rec.paste && rec.paste.trim() ? "Ninguna fila tiene cantidades entregadas." : "Pegá las entregas del período (paso 2) para ver la tabla de facturación.") + "</td>";
      body.appendChild(tr);
    }
    inv.lines.forEach((l) => {
      const tr = document.createElement("tr");
      tr.innerHTML = '<td class="desc">' + esc(l.desc) + '</td><td class="num">' + O.fmtQty(l.qty) + '</td><td class="num">$ ' + O.fmtMoney(l.price) + '</td><td class="ctr' + (l.iva === null || l.iva === undefined ? " bad-txt" : "") + '">' + O.fmtRate(l.iva) + "</td>";
      body.appendChild(tr);
    });
    const warn = [];
    if (inv.pending) warn.push("⚠ " + inv.pending + (inv.pending === 1 ? " fila de tu tabla tiene cantidades pero no está asignada" : " filas de tu tabla tienen cantidades pero no están asignadas") + " a un producto de la OC, así que NO están en esta tabla. Revisá “Coincidencias con la OC”.");
    st.p.warnings.forEach((w) => warn.push("⚠ " + w));
    if (rec.paste && rec.paste.trim() && st.p.rows.length && st.p.rows.every((r) => r.sum === 0)) warn.push("⚠ Ninguna fila tiene cantidades: revisá que hayas copiado también las columnas de los días.");
    if (inv.unknownBase > 0) warn.push("⚠ Hay productos con IVA sin definir; el total no los incluye.");
    $("ocWarn").innerHTML = warn.map((w) => '<p class="badge warn">' + esc(w) + "</p>").join("");
    $("ocInvTotals").innerHTML = inv.lines.length
      ? '<div><span>Subtotal (sin IVA)</span><b>$ ' + O.fmtMoney(inv.subtotal) + "</b></div>" + inv.ivas.map((x) => "<div><span>IVA " + O.fmtRate(x.rate) + "</span><b>$ " + O.fmtMoney(x.amount) + "</b></div>").join("") + '<div class="tot"><span>Total</span><b>$ ' + O.fmtMoney(inv.total) + "</b></div>"
      : "";
    $("ocOmitted").textContent = inv.omitted.length && rec.paste && rec.paste.trim() ? "Productos de la OC sin entregas (no se facturan): " + inv.omitted.join("; ") : "";
    $("ocCopyBtn").disabled = !inv.lines.length;
    $("ocPasteInfo").textContent = st.p.rows.length ? st.p.rows.length + " filas leídas" + (st.p.headerSkipped ? " (se omitió la fila de encabezado)" : "") : "";
    return st;
  }

  function render() {
    if (currentId === null && ocs.length) currentId = ocs[0].id;
    renderList();
    const rec = cur();
    $("ocDetail").hidden = !rec;
    if (!rec) return;
    renderItems(rec);
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
  $("ocPasteClear").addEventListener("click", () => { const rec = cur(); if (!rec) return; rec.paste = ""; rec.map = {}; $("ocPaste").value = ""; save(); const st = renderInvoice(rec); renderReview(rec, st); });

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

  // ---------- Agregar OC ----------
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
      let number = num;
      if (oc.ocNumber && oc.ocNumber !== num) {
        const useMine = await window.RemitosApp.askConfirm("El PDF dice que es la OC " + oc.ocNumber + " pero escribiste " + num + ".\n\n¿Querés seguir con la OC " + num + "?", "Sí, usar " + num, "No, volver");
        if (!useMine) { busy = false; syncDrop(); return; }
      }
      const dup = ocs.find((x) => x.oc === number);
      if (dup && !(await window.RemitosApp.askConfirm("Ya cargaste la OC " + number + ". ¿Reemplazarla? (se pierde lo que pegaste de entregas)", "Sí, reemplazar", "Cancelar"))) { busy = false; syncDrop(); return; }
      const sol = O.solveIva(oc.items, oc.totals);
      oc.items.forEach((it, i) => { it.iva = sol.assign[i]; it.ivaSrc = sol.src[i]; });
      const rec = { id: dup ? dup.id : "oc" + Date.now(), oc: number, pdfName: file.name, emission: oc.emission, items: oc.items.map(({ desc, price, qty, importe, mark, iva, ivaSrc }) => ({ desc, price, qty, importe, mark, iva, ivaSrc })), totals: oc.totals, solver: { status: sol.status, count: sol.count, message: sol.message }, paste: "", map: {}, createdAt: Date.now() };
      ocs = ocs.filter((x) => x.id !== rec.id); ocs.unshift(rec); currentId = rec.id; save();
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
