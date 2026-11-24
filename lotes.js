// lotes.js — "PDF guardados" (v8.3; v8.8: tabla de recepciones tipo planilla de Excel).
// Cada vez que se toca "Guardar remitos" en el escáner, las fotos quedan como un lote en la lista lateral (en la cuenta
// del usuario: se ve desde el celular y desde la computadora), con la OC que se eligió antes de escanear.
// Al abrir un lote se ven las fotos de los remitos junto a la tabla de recepciones: una planilla como la de Excel, con
// un renglón por producto, una columna por remito y el total de cada producto. Lo que se escribe se guarda solo.
// "Guardar PDF" arma el PDF (remitos + tabla), lo sube a Drive y deja el borrador en Gmail (puente de Google).
// La tabla queda asociada a la OC del lote (Lotes.recepciones y el evento "lag:recepcion", para Facturación).
// El almacenamiento está en lotes-store.js.
(() => {
  "use strict";
  const A = window.RemitosApp, S = window.LotesStore, P = window.Period, $ = (id) => document.getElementById(id);
  if (!A || !S || !P) { console.warn("PDF guardados: faltan archivos (scanner.js, lotes-store.js o period.js)."); return; }
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ICON = (n) => '<svg class="i"><use href="#i-' + n + '"/></svg>';
  const pad = (n) => String(n).padStart(2, "0");
  const fmtDay = (ms) => { const d = new Date(ms); return pad(d.getDate()) + "/" + pad(d.getMonth() + 1); };
  const fmtTime = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  const fmtMB = (b) => { const m = (b || 0) / 1048576; return (m >= 100 ? Math.round(m) : m.toFixed(1)).toString().replace(".", ",") + " MB"; };
  const hojas = (n) => n + (n === 1 ? " remito" : " remitos");
  const finePointer = () => !!(window.matchMedia && matchMedia("(pointer: fine)").matches);

  // ---------------------------------------------------------------- cantidades
  // Un número: acepta 12 · 12,5 · 12.5 · 1.250 (mil doscientos cincuenta) · 1.250,5
  function parseNumber(s) {
    s = String(s).replace(/\s+/g, "");
    if (!s) return null;
    if (!/^[0-9.,]+$/.test(s)) return NaN;
    const hasC = s.includes(","), hasD = s.includes(".");
    if (hasC && hasD) {
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
      else s = s.replace(/,/g, "");
    } else if (hasC) {
      s = (s.match(/,/g) || []).length > 1 ? s.replace(/,/g, "") : s.replace(",", ".");
    } else if (hasD) {
      const parts = s.split(".");
      if (parts.length > 2 || (parts[1].length === 3 && parts[0] !== "" && parts[0] !== "0")) s = parts.join("");
    }
    const v = Number(s);
    return isFinite(v) && v >= 0 ? v : NaN;
  }
  // Una cantidad o una suma de cantidades ("120+35,5")
  function parseQty(text) {
    const t = String(text == null ? "" : text).trim();
    if (!t) return { empty: true };
    let sum = 0;
    const parts = t.split("+");
    for (const p of parts) {
      const v = parseNumber(p);
      if (v === null || Number.isNaN(v)) return { ok: false };
      sum += v;
    }
    return { ok: true, value: Math.round(sum * 1000) / 1000, isSum: parts.length > 1 };
  }
  const formatQty = (v) => String(Math.round(v * 1000) / 1000).replace(".", ",");

  // ---------------------------------------------------------------- estado de cada lote
  const isSent = (it) => it.estado === "enviado";
  const ocOf = (it) => P.cleanOc((it.tabla && it.tabla.oc) || "");
  function stateOf(it) {
    const up = S.uploadingInfo(it.id);
    if (up) return { k: "subiendo", cls: "info", text: up.total ? "Subiendo " + up.done + " de " + up.total + "…" : "Subiendo…" };
    if (it.where === "local" && it.pendiente) return { k: "sin-subir", cls: "warn", text: "Sin subir · está solo en este dispositivo" };
    if (it.where === "cloud" && !it.subido) return { k: "incompleto", cls: "warn", text: "Subida sin terminar (desde otro dispositivo)" };
    if (it.estado === "lista") return { k: "lista", cls: "ok", text: "Tabla completa · falta «Guardar PDF»" };
    if (it.estado === "enviado") return { k: "enviado", cls: "", text: "PDF enviado el " + fmtDay(it.enviado) + " " + fmtTime(it.enviado) };
    return { k: "pendiente", cls: "warn", text: ocOf(it) ? "Falta la tabla de recepciones" : "Falta la OC y la tabla de recepciones" };
  }
  const periodOf = (it, mode) => P.forDate(mode || (it.periodo && it.periodo.mode === "quincenal" ? "quincenal" : "semanal"), new Date(it.creado));
  const titleOf = (it) => { const oc = it.tabla && it.tabla.oc; return (oc ? "OC " + oc + " · " : "Remitos del ") + P.dateRange(it.periodo || periodOf(it)); };
  const fileOf = (oc, per) => (oc ? P.fileName(oc, per) : "REMITOS_" + per.from + "_al_" + per.to);

  // ---------------------------------------------------------------- lista lateral
  const listEl = $("lotesList"), sentEl = $("lotesSentList"), whereEl = $("lotesWhere"), refreshBtn = $("lotesRefresh");
  let items = [], listError = null, loading = false, again = false, lastLoad = 0;

  async function refresh() {
    if (loading) { again = true; return; }
    loading = true; refreshBtn.classList.add("spin");
    try { const r = await S.list(); items = r.items; listError = r.error; }
    catch (e) { console.error(e); listError = e.message || String(e); }
    finally { loading = false; lastLoad = Date.now(); refreshBtn.classList.remove("spin"); }
    render();
    if (again) { again = false; await refresh(); }
  }

  function render() {
    const cloudMode = S.mode() === "cloud";
    const used = items.filter((it) => it.where === "cloud").reduce((s, it) => s + (it.tamano || 0), 0);
    whereEl.className = "lotes-where" + (listError ? " warn" : "");
    whereEl.innerHTML = listError
      ? ICON("cloud-off") + "<span>" + esc(listError) + (cloudMode ? " Se muestran los guardados en este dispositivo." : "") + "</span>"
      : cloudMode
        ? ICON("cloud") + "<span>En tu cuenta: los ves desde cualquier dispositivo donde inicies sesión." + (used ? " Espacio usado: " + fmtMB(used) + " de 1 GB." : "") + "</span>"
        : ICON("cloud-off") + "<span>Sin cuenta: quedan guardados solo en este dispositivo.</span>";
    const active = items.filter((it) => !isSent(it)), sent = items.filter(isSent);
    $("lotesCount").textContent = active.length;
    listEl.replaceChildren(...active.map(card));
    sentEl.replaceChildren(...sent.map(card));
    $("lotesEmpty").hidden = active.length > 0;
    $("lotesSent").hidden = sent.length === 0;
    $("lotesSentN").textContent = "(" + sent.length + ")";
    fillOcSuggest();
    if (cur) { const fresh = items.find((x) => x.id === cur.id); if (fresh && fresh !== cur && !dirty() && !saving) { cur = fresh; fillHead(); } }
  }

  // Sugerencias para el número de OC (escáner y tabla): las de los PDF guardados y las cargadas en Facturación.
  function fillOcSuggest() {
    const dl = $("ocSuggest");
    if (!dl) return;
    const seen = new Set(), list = [];
    const add = (oc, label) => { oc = P.cleanOc(oc); if (!oc || seen.has(oc)) return; seen.add(oc); list.push('<option value="' + esc(oc) + '">' + esc(label) + "</option>"); };
    items.forEach((it) => add(ocOf(it), "Remitos del " + P.dateRange(it.periodo || periodOf(it))));
    try { const o = JSON.parse(localStorage.getItem("ocData") || "[]"); if (Array.isArray(o)) o.forEach((r) => r && add(r.oc, "OC de Facturación")); } catch (e) { /* nada */ }
    dl.innerHTML = list.slice(0, 60).join("");
  }

  function card(it) {
    const st = stateOf(it), el = document.createElement("div");
    el.className = "lote" + (st.k === "lista" ? " ready" : "") + (isSent(it) ? " sent" : "");
    el.innerHTML =
      '<button type="button" class="lote-open" title="Abrir: ver los remitos y cargar la tabla de recepciones">' +
        (it.miniatura ? '<img class="lote-thumb" alt="" src="' + esc(it.miniatura) + '">' : '<span class="lote-thumb">' + ICON("image") + "</span>") +
        '<span class="lote-info"><strong>' + esc(titleOf(it)) + "</strong>" +
        "<small>" + esc(hojas(it.paginas || 0) + " · guardado " + fmtDay(it.creado) + " " + fmtTime(it.creado)) + "</small>" +
        '<span class="chip ' + st.cls + '">' + esc(st.text) + "</span></span>" +
      "</button>";
    el.querySelector(".lote-open").addEventListener("click", () => openLote(it));
    if (st.k === "lista") el.appendChild(actBtn("primary", "send", "Guardar PDF", "Guardar el PDF y mandarlo al borrador de Gmail", () => openLote(it, { send: true })));
    if (st.k === "pendiente") el.appendChild(actBtn("soft", "list", "Tabla", "Cargar la tabla de recepciones", () => openLote(it)));
    if (st.k === "sin-subir" && S.mode() === "cloud") el.appendChild(actBtn("soft", "upload", "Subir", "Subir a tu cuenta", () => uploadNow(it)));
    return el;
  }
  function actBtn(kind, icon, label, title, fn) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn " + kind + " small lote-act"; b.title = title;
    b.innerHTML = ICON(icon) + "<span>" + esc(label) + "</span>";
    b.addEventListener("click", fn);
    return b;
  }
  async function uploadNow(it) {
    try { await S.upload(it.id); A.setStatus("Subido a tu cuenta ✔", 4000); }
    catch (e) { await A.showMessage("No se pudo subir: " + S.describe(e)); }
    refresh();
  }

  refreshBtn.addEventListener("click", () => { S.retryUploads(); refresh(); });
  S.onChange(() => { if (!loading) render(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { if (cur) flushSave(); return; }
    if (unlocked && Date.now() - lastLoad > 15000 && !dlg.open) refresh();
  });
  window.addEventListener("online", () => setTimeout(refresh, 1500));

  // ---------------------------------------------------------------- un lote: fotos + tabla de recepciones
  const dlg = $("lotDialog"), grid = $("lotGrid"), gridWrap = $("lotGridWrap"), errEl = $("lotErr"), ocEl = $("lotOc"), savedEl = $("lotSaved");
  const stage = $("lvStage"), img = $("lvImg"), lvMsg = $("lvMsg"), strip = $("lvStrip");
  let cur = null, work = null, orig = "", mode = "semanal", busy = false;
  let shots = null, urls = [], idx = 0, loadSeq = 0;
  const cache = new Map();                          // id -> fotos ya bajadas (los últimos 2 lotes abiertos)

  // La tabla en memoria: work = {oc, n (remitos = columnas), rows: [{nombre, cat (está en la lista de productos), cant: [texto por remito]}]}
  // Se guarda en el lote como tabla = {oc, remitos, filas: [{nombre, cant}], valores: [{nombre, texto (total)}], extras: []}.
  // "valores" lleva el total de cada producto (así lo leían las versiones anteriores).
  const blank = (n) => Array.from({ length: n }, () => "");
  function toWork(it) {
    const t = it.tabla || {};
    const n = Math.max(1, Math.min(300, (it.paginas | 0) || (t.remitos | 0) || 1));
    const rows = A.catalog().map((nombre) => ({ nombre, cat: true, cant: blank(n) }));
    const byName = new Map(rows.map((r) => [r.nombre, r]));
    const put = (nombre, cant) => {
      nombre = String(nombre == null ? "" : nombre).trim();
      let r = nombre ? byName.get(nombre) : null;
      if (!r) { r = { nombre, cat: false, cant: blank(n) }; rows.push(r); if (nombre) byName.set(nombre, r); }
      cant.forEach((v, i) => { v = String(v == null ? "" : v).trim(); if (v && i < n) r.cant[i] = r.cant[i] ? r.cant[i] + "+" + v : v; });
    };
    if (Array.isArray(t.filas)) t.filas.forEach((f) => { if (f) put(f.nombre, Array.isArray(f.cant) ? f.cant : []); });
    else {                                           // lotes anteriores a la v8.8: un total por producto (va al remito 1)
      (Array.isArray(t.valores) ? t.valores : []).forEach((v) => { if (v && v.nombre) put(v.nombre, [v.texto]); });
      (Array.isArray(t.extras) ? t.extras : []).forEach((x) => { if (x && (x.nombre || x.texto)) put(x.nombre, [x.texto]); });
    }
    return { oc: P.cleanOc(t.oc || ""), n, rows };
  }
  const rowUsed = (r) => r.cant.some((v) => String(v).trim() !== "");
  function rowTotal(r) {
    let sum = 0, has = false;
    const bad = [];
    r.cant.forEach((v, i) => { const q = parseQty(v); if (q.empty) return; if (!q.ok) { bad.push(i); return; } has = true; sum += q.value; });
    return { has, bad, value: Math.round(sum * 1000) / 1000 };
  }
  function fromWork() {
    const filas = [], valores = [];
    work.rows.forEach((r) => {
      const nombre = String(r.nombre || "").trim();
      if (!rowUsed(r) && (r.cat || !nombre)) return;
      filas.push({ nombre, cant: r.cant.map((v) => String(v).trim()) });
      const t = rowTotal(r);
      if (nombre && t.has && !t.bad.length) valores.push({ nombre, texto: formatQty(t.value) });
    });
    return { oc: work.oc, remitos: work.n, filas, valores, extras: [] };
  }
  function issues() {
    let bad = 0, noName = 0, any = 0;
    work.rows.forEach((r) => { const t = rowTotal(r); bad += t.bad.length; if (t.has) { any++; if (!String(r.nombre).trim()) noName++; } });
    return { bad, noName, any };
  }
  const newEstado = () => { const q = issues(); return work.oc && q.any && !q.bad && !q.noName ? "lista" : "pendiente"; };
  const snapshot = () => JSON.stringify({ t: fromWork(), m: mode });
  const dirty = () => !!(cur && work && snapshot() !== orig);

  function fillHead() {
    const st = stateOf(cur);
    $("lotTitle").textContent = titleOf(Object.assign({}, cur, { tabla: { oc: work.oc }, periodo: periodOf(cur, mode) }));
    $("lotSub").textContent = hojas(cur.paginas || 0) + " · guardado el " + fmtDay(cur.creado) + " a las " + fmtTime(cur.creado) +
      (cur.where === "local" ? " · en este dispositivo" : " · en tu cuenta") + (isSent(cur) && cur.carpeta ? " · Drive: " + cur.carpeta : "");
    const chip = $("lotState");
    chip.className = "lot-state chip " + st.cls; chip.textContent = st.text;
    $("lotSend").lastChild.textContent = isSent(cur) ? "Guardar PDF otra vez" : "Guardar PDF";
    renderSaved();
  }

  // ---------------------------------------------------------------- guardado automático de la tabla
  let saveTimer = 0, saving = null, saveErr = "";
  function renderSaved() {
    if (!cur) return;
    const pend = !!saveTimer || dirty();
    savedEl.className = "xl-saved" + (saveErr ? " bad" : saving ? " busy" : pend ? " busy" : " ok");
    savedEl.textContent = saveErr ? "No se pudo guardar (" + saveErr + "). Se vuelve a intentar con el próximo cambio."
      : saving ? "Guardando…" : pend ? "Cambios sin guardar…"
      : cur.where === "local" ? "✓ Guardado en este dispositivo" : "✓ Guardado en tu cuenta";
  }
  function scheduleSave(ms) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = 0; flushSave(); }, ms == null ? 1200 : ms);
    renderSaved();
  }
  // Guarda la tabla y el período si hay cambios. Devuelve true si quedó todo guardado.
  async function flushSave() {
    clearTimeout(saveTimer); saveTimer = 0;
    while (saving) await saving;
    if (!cur || !work) return true;
    if (!dirty()) { renderSaved(); return true; }
    const it = cur, snap = snapshot(), tabla = fromWork(), periodo = periodOf(it, mode), estado = newEstado();
    saving = S.update(it, { tabla, periodo, estado }).then(
      () => { if (cur === it) orig = snap; saveErr = ""; return true; },
      (e) => { console.error(e); saveErr = (e && e.message) || String(e); return false; });
    renderSaved();
    const ok = await saving;
    saving = null;
    render();
    if (cur === it) { fillHead(); if (ok && dirty()) scheduleSave(); }
    return ok;
  }
  window.addEventListener("beforeunload", (e) => {
    if (cur && (saveTimer || saving || dirty())) { flushSave(); e.preventDefault(); e.returnValue = ""; }
  });
  function changed() { errEl.textContent = ""; errEl.className = "err"; fillHead(); scheduleSave(); }
  function note(text, ok) { errEl.className = ok ? "note" : "err"; errEl.textContent = text; }

  function refreshPeriodInfo() {
    const per = periodOf(cur, mode);
    $("lotPeriodSeg").querySelectorAll(".seg-btn").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
    $("lotPeriodText").textContent = "día " + P.text(per);
    $("lotPeriodSub").textContent = "(" + per.label + ")";
    $("lotFile").textContent = fileOf(work.oc, per);
    $("lotDest").textContent = A.bridgeReady()
      ? "«Guardar PDF» arma el PDF (remitos + tabla), lo sube a Drive (" + P.folderPath(work.oc || "número", per) + ") y deja el borrador en Gmail."
      : "El puente a Drive y Gmail no está configurado en este dispositivo (Ajustes): «Guardar PDF» solo puede descargarlo.";
    fillHead();
  }
  $("lotPeriodSeg").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn");
    if (!b || !cur) return;
    mode = b.dataset.mode === "quincenal" ? "quincenal" : "semanal";
    refreshPeriodInfo(); changed();
  });
  ocEl.addEventListener("input", () => {
    const c = P.cleanOc(ocEl.value);
    if (c !== ocEl.value) ocEl.value = c;
    ocEl.classList.remove("bad");
    work.oc = c; refreshPeriodInfo(); changed();
  });
  ocEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); focusCell(0, Math.min(idx, work.n - 1)); } });

  // ---------------------------------------------------------------- la planilla
  function buildGrid() {
    const n = work.n;
    let h = '<colgroup><col class="c-n"><col class="c-p">' + '<col class="c-r">'.repeat(n) + '<col class="c-t"></colgroup>';
    h += '<thead><tr><th class="xn" scope="col">N°</th><th class="xp" scope="col">Producto</th>';
    for (let c = 0; c < n; c++) h += '<th class="xc" scope="col" data-c="' + c + '"><button type="button" class="xh" data-c="' + c + '" title="Ver la foto del remito ' + (c + 1) + '"><small>Remito</small>' + (c + 1) + "</button></th>";
    h += '<th class="xt" scope="col">Total</th></tr></thead><tbody>';
    work.rows.forEach((r, i) => {
      h += "<tr" + (r.cat ? "" : ' class="extra"') + ">";
      h += r.cat
        ? '<td class="xn">' + (i + 1) + '</td><th class="xp" scope="row"><span>' + esc(r.nombre) + "</span></th>"
        : '<td class="xn"><button type="button" class="xrm" data-r="' + i + '" title="Quitar este producto" aria-label="Quitar este producto">' + ICON("x") + "</button></td>" +
          '<th class="xp" scope="row"><input type="text" class="xname" data-r="' + i + '" value="' + esc(r.nombre) + '" placeholder="Nombre del producto" autocomplete="off" spellcheck="false" maxlength="80"></th>';
      for (let c = 0; c < n; c++) {
        h += '<td class="xc"><input type="text" class="xq" data-r="' + i + '" data-c="' + c + '" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="40" aria-label="' +
          esc((r.nombre || "Producto") + ", remito " + (c + 1)) + '" value="' + esc(r.cant[c]) + '"></td>';
      }
      h += '<td class="xt"></td></tr>';
    });
    h += "</tbody>";
    grid.innerHTML = h;
    work.rows.forEach((r, i) => paintRow(i, true));
    markCol(idx);
  }
  const cellAt = (r, c) => grid.querySelector('input.xq[data-r="' + r + '"][data-c="' + c + '"]');
  // Total del renglón y celdas mal escritas (en rojo, salvo la que se está escribiendo)
  function paintRow(i, all) {
    const tr = grid.tBodies[0] && grid.tBodies[0].rows[i];
    if (!tr) return;
    const r = work.rows[i], t = rowTotal(r);
    tr.classList.toggle("has", t.has || t.bad.length > 0);
    const tot = tr.cells[tr.cells.length - 1];
    tot.textContent = t.bad.length ? "?" : t.has ? formatQty(t.value) : "";
    tot.classList.toggle("bad", t.bad.length > 0);
    tr.querySelectorAll("input.xq").forEach((inp) => { if (all || document.activeElement !== inp) inp.classList.toggle("bad", t.bad.includes(+inp.dataset.c)); });
    const nm = tr.querySelector("input.xname");
    if (nm) nm.classList.toggle("bad", t.has && !String(r.nombre).trim());
  }
  function markCol(c) {
    grid.querySelectorAll(".on-col").forEach((e) => e.classList.remove("on-col"));
    const th = grid.querySelector('th.xc[data-c="' + c + '"]');
    if (th) th.classList.add("on-col");
    grid.querySelectorAll('input.xq[data-c="' + c + '"]').forEach((e) => e.parentElement.classList.add("on-col"));
  }
  function focusCell(r, c) {
    const el = cellAt(r, c);
    if (!el) return;
    el.focus({ preventScroll: true }); el.select();
    try { el.parentElement.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) { /* nada */ }
  }

  grid.addEventListener("input", (e) => {
    const t = e.target;
    if (t.classList.contains("xq")) { const r = +t.dataset.r; work.rows[r].cant[+t.dataset.c] = t.value; t.classList.remove("bad"); paintRow(r); changed(); }
    else if (t.classList.contains("xname")) { work.rows[+t.dataset.r].nombre = t.value; paintRow(+t.dataset.r); changed(); }
  });
  grid.addEventListener("focusin", (e) => {
    const t = e.target;
    if (!t.classList.contains("xq")) return;
    t.dataset.orig = t.value;
    const c = +t.dataset.c;
    if (c !== idx) show(c);
    grid.querySelectorAll("tr.on-row").forEach((x) => x.classList.remove("on-row"));
    t.closest("tr").classList.add("on-row");
    if (finePointer()) { t.select(); t.dataset.sel = "1"; }       // como en Excel: lo que se escribe reemplaza la celda
  });
  grid.addEventListener("mouseup", (e) => { const t = e.target; if (t.dataset && t.dataset.sel) { delete t.dataset.sel; if (t.selectionStart === t.selectionEnd) t.select(); } });
  grid.addEventListener("focusout", (e) => {
    const t = e.target;
    if (!t.classList || !t.classList.contains("xq")) return;
    delete t.dataset.sel;
    t.classList.toggle("bad", parseQty(t.value).ok === false);
    const tr = t.closest("tr"); if (tr) tr.classList.remove("on-row");
  });
  grid.addEventListener("click", (e) => {
    const h = e.target.closest(".xh");
    if (h) { show(+h.dataset.c); return; }
    const rm = e.target.closest(".xrm");
    if (rm) { work.rows.splice(+rm.dataset.r, 1); buildGrid(); changed(); }
  });
  // Teclado como en Excel: Enter baja (al final de la columna pasa al remito siguiente), flechas, Tab, F2 y Esc.
  grid.addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (t.classList.contains("xname")) {
      const r = +t.dataset.r;
      if (e.key === "Enter" || (e.key === "ArrowRight" && t.selectionStart === t.value.length)) { e.preventDefault(); focusCell(r, 0); }
      return;
    }
    if (!t.classList.contains("xq")) return;
    const r = +t.dataset.r, c = +t.dataset.c, R = work.rows.length, C = work.n;
    const len = t.value.length, s0 = t.selectionStart, s1 = t.selectionEnd, all = s0 === 0 && s1 === len;
    let go = null;
    switch (e.key) {
      case "Enter":
        if (e.shiftKey) go = [r - 1, c];
        else go = r + 1 < R ? [r + 1, c] : c + 1 < C ? [0, c + 1] : [r, c];
        break;
      case "ArrowDown": go = [r + 1, c]; break;
      case "ArrowUp": go = [r - 1, c]; break;
      case "ArrowLeft": if (all || (s0 === 0 && s1 === 0)) go = [r, c - 1]; break;
      case "ArrowRight": if (all || (s0 === len && s1 === len)) go = [r, c + 1]; break;
      case "F2": e.preventDefault(); t.setSelectionRange(len, len); return;
      case "Escape":
        if (t.value !== (t.dataset.orig || "")) {
          e.preventDefault(); e.stopPropagation();
          t.value = t.dataset.orig || ""; t.dispatchEvent(new Event("input", { bubbles: true })); t.select();
        }
        return;
      default: return;
    }
    if (!go) return;
    e.preventDefault();
    if (go[1] < 0) { const nm = grid.tBodies[0].rows[r].querySelector("input.xname"); if (nm) nm.focus(); return; }
    if (go[0] < 0 || go[0] >= R || go[1] >= C) return;
    focusCell(go[0], go[1]);
  });
  // Pegar celdas copiadas de Excel (varias filas y columnas): se llenan desde la celda elegida.
  grid.addEventListener("paste", (e) => {
    const t = e.target;
    if (!t.classList.contains("xq")) return;
    const text = e.clipboardData && e.clipboardData.getData("text/plain");
    if (!text) return;
    const clean = text.replace(/\r/g, "").replace(/\n+$/, "");
    if (!/[\t\n]/.test(clean)) return;                               // un solo valor: se pega normal
    e.preventDefault();
    const lines = clean.split("\n").map((l) => l.split("\t"));
    const r0 = +t.dataset.r, c0 = +t.dataset.c, R = work.rows.length, C = work.n;
    let out = 0;
    lines.forEach((cells, i) => cells.forEach((v, j) => {
      const r = r0 + i, c = c0 + j;
      if (r < R && c < C) work.rows[r].cant[c] = v.trim(); else if (v.trim()) out++;
    }));
    buildGrid(); changed();
    focusCell(r0, c0);
    if (out) note("Se pegó lo que entra en la tabla; " + out + (out === 1 ? " celda quedó afuera" : " celdas quedaron afuera") + " (más renglones o remitos de los que hay).");
  });

  $("lotAddExtra").addEventListener("click", () => {
    work.rows.push({ nombre: "", cat: false, cant: blank(work.n) });
    buildGrid();
    const names = grid.querySelectorAll("input.xname");
    const last = names[names.length - 1];
    if (last) { last.focus(); try { last.scrollIntoView({ block: "nearest" }); } catch (e) { /* nada */ } }
  });

  // Copia la tabla (Producto + una columna por remito, sin el total) para pegarla en Excel o en Facturación > Entregas.
  $("lotCopy").addEventListener("click", async () => {
    const used = work.rows.filter(rowUsed);
    if (!used.length) { note("La tabla está vacía: no hay nada para copiar."); return; }
    const cell = (v) => { const q = parseQty(v); return q.empty ? "" : q.ok ? formatQty(q.value) : String(v).trim(); };
    const head = ["Producto"].concat(Array.from({ length: work.n }, (_, c) => "Remito " + (c + 1)));
    const tsv = [head.join("\t")].concat(used.map((r) => [String(r.nombre).trim() || "(sin nombre)"].concat(r.cant.map(cell)).join("\t"))).join("\n");
    let ok = false;
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(tsv); ok = true; } } catch (e) { ok = false; }
    if (!ok) {
      const ta = document.createElement("textarea"); ta.value = tsv; ta.style.position = "fixed"; ta.style.opacity = "0";
      dlg.appendChild(ta); ta.select();
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      ta.remove();
    }
    note(ok ? "✓ Tabla copiada: pegala en Excel (Ctrl+V)." : "No se pudo copiar la tabla en este navegador.", ok);
  });

  // Filas para el PDF. Devuelve null (y marca en rojo) si hay datos inválidos.
  function collect() {
    const rows = [];
    let bad = 0, noName = 0;
    work.rows.forEach((r, i) => {
      paintRow(i, true);
      const t = rowTotal(r), nombre = String(r.nombre).trim();
      if (t.bad.length) { bad += t.bad.length; return; }
      if (!t.has) return;
      if (!nombre) { noName++; return; }
      rows.push({ name: nombre, qtyText: formatQty(t.value), cells: r.cant.map((v) => { const q = parseQty(v); return q.ok ? formatQty(q.value) : ""; }) });
    });
    if (bad || noName) {
      note(bad ? "Revisá las celdas marcadas en rojo: tienen que ser números (por ejemplo 12 o 2,5) o sumas (120+35)." : "Falta el nombre de un producto agregado.");
      const first = grid.querySelector("input.xq.bad, input.xname.bad");
      if (first) first.focus();
      return null;
    }
    errEl.textContent = "";
    return rows;
  }

  // ---------------------------------------------------------------- visor de fotos
  function releaseUrls() { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; }
  function viewerMsg(html) { lvMsg.hidden = !html; lvMsg.innerHTML = html || ""; img.hidden = !!html; }
  // Muestra la foto del remito i y resalta su columna en la tabla
  function show(i) {
    const total = urls.length || (work ? work.n : 0);
    if (!total) return;
    idx = Math.max(0, Math.min(total - 1, i));
    markCol(idx);
    if (!urls.length) return;
    img.src = urls[idx];
    $("lvPos").textContent = "Remito " + (idx + 1) + " de " + urls.length;
    $("lvPrev").disabled = idx === 0; $("lvNext").disabled = idx === urls.length - 1;
    strip.querySelectorAll("button").forEach((b, k) => b.classList.toggle("on", k === idx));
    const on = strip.children[idx]; if (on && on.scrollIntoView) on.scrollIntoView({ block: "nearest", inline: "nearest" });
    stage.scrollTop = 0; stage.scrollLeft = 0;
  }
  async function loadShots(it) {
    const seq = ++loadSeq;
    releaseUrls(); shots = null; strip.innerHTML = "";
    $("lvPos").textContent = "—"; $("lvPrev").disabled = $("lvNext").disabled = true;
    viewerMsg('<div class="spinner"></div><span>Cargando las fotos…</span>');
    try {
      const f = cache.get(it.id) || await S.fotos(it);
      if (seq !== loadSeq) return null;
      if (!f.length) throw new Error("Este PDF no tiene fotos.");
      cache.set(it.id, f); while (cache.size > 2) cache.delete(cache.keys().next().value);
      shots = f;
      urls = f.map((x) => URL.createObjectURL(new Blob([x.bytes], { type: "image/jpeg" })));
      strip.replaceChildren(...urls.map((u, k) => {
        const b = document.createElement("button"); b.type = "button"; b.title = "Remito " + (k + 1);
        b.innerHTML = '<img alt="" loading="lazy" src="' + u + '"><span>' + (k + 1) + "</span>";
        b.addEventListener("click", () => show(k)); return b;
      }));
      viewerMsg("");
      show(idx);
      return f;
    } catch (e) {
      if (seq !== loadSeq) return null;
      console.error(e);
      viewerMsg(ICON("alert") + "<span>No se pudieron cargar las fotos: " + esc(e.message || e) + '</span><button type="button" class="btn soft small" id="lvRetry">Reintentar</button>');
      const r = $("lvRetry"); if (r) r.addEventListener("click", () => loadShots(it));
      return null;
    }
  }
  $("lvPrev").addEventListener("click", () => show(idx - 1));
  $("lvNext").addEventListener("click", () => show(idx + 1));
  function toggleZoom() { const z = !stage.classList.contains("zoom"); stage.classList.toggle("zoom", z); $("lvZoom").setAttribute("aria-pressed", String(z)); }
  $("lvZoom").addEventListener("click", toggleZoom);
  img.addEventListener("click", toggleZoom);
  dlg.addEventListener("keydown", (e) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); show(idx - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); show(idx + 1); }
  });

  // ---------------------------------------------------------------- abrir / cerrar
  async function openLote(it, opts = {}) {
    if (dlg.open) { if (!(await closeLote())) return; }
    cur = it; work = toWork(it); idx = 0; saveErr = "";
    mode = it.periodo && it.periodo.mode === "quincenal" ? "quincenal" : "semanal";
    orig = snapshot();
    ocEl.value = work.oc; ocEl.classList.remove("bad"); errEl.textContent = "";
    stage.classList.remove("zoom"); $("lvZoom").setAttribute("aria-pressed", "false");
    buildGrid(); refreshPeriodInfo(); setBusy(false);
    dlg.showModal();
    gridWrap.scrollTop = 0; gridWrap.scrollLeft = 0; $("lotForm").scrollTop = 0;
    const p = loadShots(it);
    if (opts.send) { await p; if (cur === it && dlg.open) sendCurrent(); }
    else if (finePointer()) { if (work.oc) focusCell(0, 0); else ocEl.focus(); }
  }
  // Devuelve false si el usuario decide quedarse.
  async function closeLote() {
    if (busy) return false;
    if (cur && !(await flushSave())) {
      if (!(await A.askConfirm("No se pudieron guardar los últimos cambios de la tabla de recepciones:\n" + saveErr + "\n\n¿Cerrar igual? Esos cambios se pierden.", "Cerrar igual", "Volver"))) return false;
    }
    loadSeq++; releaseUrls(); img.removeAttribute("src");
    if (dlg.open) dlg.close();
    cur = null; work = null; saveErr = ""; grid.innerHTML = "";
    return true;
  }
  $("lotClose").addEventListener("click", () => closeLote());
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeLote(); });

  function setBusy(on, text) {
    busy = on;
    ["lotSend", "lotDownload", "lotDelete", "lotClose", "lotCopy", "lotAddExtra"].forEach((id) => { $(id).disabled = on; });
    $("lotForm").inert = !!on;
    $("lotSend").classList.toggle("is-busy", !!on && text !== undefined && /Enviando|Preparando|Guardando/.test(text));
    if (on && text) $("lotDest").textContent = text; else if (!on && cur) refreshPeriodInfo();
  }

  async function buildPdfOf(rows) {
    const f = shots || await loadShots(cur);
    if (!f) throw new Error("No se pudieron cargar las fotos.");
    const per = periodOf(cur, mode), name = fileOf(work.oc, per);
    return { pdf: A.makePdf(f, name, work.oc, per, rows, work.n), name, per };
  }

  // La tabla de un lote, lista para Facturación: {id, oc, periodo, estado, enviado, remitos, filas: [{nombre, cant: [número|null por remito], total}]}
  function recepcionOf(it) {
    const w = toWork(it);
    return {
      id: it.id, oc: w.oc, periodo: it.periodo || periodOf(it), estado: it.estado, enviado: it.enviado || null, archivo: it.archivo || "", remitos: w.n,
      filas: w.rows.filter(rowUsed).map((r) => ({ nombre: String(r.nombre).trim(), cant: r.cant.map((v) => { const q = parseQty(v); return q.ok ? q.value : null; }), total: rowTotal(r).value }))
    };
  }

  // "Guardar PDF": guarda la tabla, arma el PDF (remitos + tabla) y lo manda a Drive y al borrador de Gmail.
  async function sendCurrent() {
    if (busy || !cur) return;
    if (!work.oc) { ocEl.classList.add("bad"); ocEl.focus(); note("Escribí el número de la orden de compra (OC): con él se nombra el PDF y la carpeta de Drive."); return; }
    const rows = collect();
    if (rows === null) return;
    if (!rows.length && !(await A.askConfirm("La tabla de recepciones está vacía: el PDF va a salir solo con los remitos.\n\n¿Guardarlo igual?", "Guardar igual", "Volver"))) return;
    setBusy(true, "Guardando la tabla…");
    const saved = await flushSave();
    setBusy(false);
    if (!saved) { note("No se pudo guardar la tabla: " + saveErr); return; }
    if (!A.bridgeReady()) {
      if (await A.askConfirm("Este dispositivo no tiene configurado el puente a Google Drive y Gmail (Ajustes), así que no se puede mandar al borrador.\n\n¿Querés descargar el PDF?", "Descargar PDF", "Cancelar")) downloadCurrent(rows);
      return;
    }
    const it = cur;
    let built = null;
    setBusy(true, "Preparando el PDF…");
    try {
      built = await buildPdfOf(rows);
      setBusy(true, "Enviando a Google Drive y Gmail…");
      const sent = await A.sendToBridge(built.pdf, built.name, work.oc, built.per);
      await S.update(it, { estado: "enviado", enviado: Date.now(), carpeta: String(sent.carpeta || ""), archivo: built.name }).catch((e) => console.warn(e));
      setBusy(false);
      orig = snapshot();
      try { document.dispatchEvent(new CustomEvent("lag:recepcion", { detail: recepcionOf(it) })); } catch (e) { console.warn(e); }
      await closeLote();
      refresh();
      A.setStatus("PDF guardado ✔ " + built.name + ".pdf", 8000);
      await A.showMessage("PDF guardado en Drive:\n" + (sent.carpeta || P.folderPath(it.tabla.oc, built.per)) +
        (sent.reemplazado ? "\n(reemplazó un PDF con el mismo nombre; el anterior está en la papelera de Drive)" : "") +
        "\n\nBorrador creado en Gmail con los remitos y la tabla de recepciones, para revisar y enviar.");
    } catch (e) {
      console.error(e);
      setBusy(false);
      const msg = "No se pudo enviar: " + (e.message || e);
      if (built && await A.askConfirm(msg + "\n\n¿Querés descargar el PDF en este dispositivo?", "Descargar", "No")) A.downloadBlob(built.pdf, built.name + ".pdf");
      else if (!built) await A.showMessage(msg);
    }
  }
  $("lotSend").addEventListener("click", sendCurrent);

  async function downloadCurrent(rows) {
    if (busy || !cur) return;
    rows = rows || collect();
    if (rows === null) return;
    setBusy(true, "Preparando el PDF…");
    try {
      const b = await buildPdfOf(rows);
      A.downloadBlob(b.pdf, b.name + ".pdf");
      note("✓ PDF «" + b.name + ".pdf» descargado.", true);
    } catch (e) { note("No se pudo generar el PDF: " + (e.message || e)); }
    finally { setBusy(false); }
  }
  $("lotDownload").addEventListener("click", () => downloadCurrent());

  $("lotDelete").addEventListener("click", async () => {
    if (busy || !cur) return;
    const it = cur;
    const warn = isSent(it) ? "" : "\n\nTodavía no se guardó el PDF en Drive ni en el borrador de Gmail.";
    if (!(await A.askConfirm("¿Borrar estos remitos guardados (" + hojas(it.paginas || 0) + ") y su tabla? No se puede deshacer." + warn, "Borrar", "Cancelar"))) return;
    clearTimeout(saveTimer); saveTimer = 0;
    while (saving) await saving;
    setBusy(true, "Borrando…");
    try {
      await S.remove(it);
      cache.delete(it.id);
      setBusy(false); orig = snapshot();
      await closeLote();
      A.setStatus("Remitos borrados.", 4000);
      refresh();
    } catch (e) { setBusy(false); note("No se pudo borrar: " + (e.message || e)); }
  });

  // ---------------------------------------------------------------- inicio
  let unlocked = false;
  A.onSettings = async () => {
    render();
    if (cur && dlg.open) { await flushSave(); if (!cur) return; work = toWork(cur); orig = snapshot(); buildGrid(); refreshPeriodInfo(); }
  };
  const start = () => { unlocked = true; refresh(); S.retryUploads(); };
  if (window.LAGAuth) window.LAGAuth.onUnlock(start); else start();

  window.Lotes = {
    // Guarda las fotos recién escaneadas como un lote nuevo. extra = {oc}
    async saveBatch(list, periodo, onProgress, extra) {
      const r = await S.save(list, periodo, onProgress, extra);
      if (r.fotos) { cache.set(r.id, r.fotos); while (cache.size > 2) cache.delete(cache.keys().next().value); delete r.fotos; }
      await refresh();
      return r;
    },
    refresh,
    // Tablas de recepciones guardadas (todas, o las de una OC), para la sección Facturación.
    async recepciones(oc) {
      await refresh();
      const want = oc ? P.cleanOc(oc) : "";
      return items.filter((it) => it.tabla && (!want || ocOf(it) === want)).map(recepcionOf);
    }
  };
})();
