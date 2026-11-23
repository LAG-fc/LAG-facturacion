// lotes.js — "PDF guardados" (v8.3).
// Cada vez que se toca "Guardar PDF", las fotos escaneadas quedan como un lote en la lista lateral (en la cuenta del
// usuario: se ve desde el celular y desde la computadora). Al abrir un lote se ven las fotos de los remitos junto a la
// tabla de recepciones; cuando la tabla está completa (OC y cantidades), aparece la opción de enviarlo al borrador
// de Gmail (puente de Google). El almacenamiento está en lotes-store.js.
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
  const hojas = (n) => n + (n === 1 ? " hoja" : " hojas");

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
    const t = String(text || "").trim();
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
  function stateOf(it) {
    const up = S.uploadingInfo(it.id);
    if (up) return { k: "subiendo", cls: "info", text: up.total ? "Subiendo " + up.done + " de " + up.total + "…" : "Subiendo…" };
    if (it.where === "local" && it.pendiente) return { k: "sin-subir", cls: "warn", text: "Sin subir · está solo en este dispositivo" };
    if (it.where === "cloud" && !it.subido) return { k: "incompleto", cls: "warn", text: "Subida sin terminar (desde otro dispositivo)" };
    if (it.estado === "lista") return { k: "lista", cls: "ok", text: "Lista para enviar" };
    if (it.estado === "enviado") return { k: "enviado", cls: "", text: "Enviado el " + fmtDay(it.enviado) + " " + fmtTime(it.enviado) };
    return { k: "pendiente", cls: "warn", text: "Falta la tabla de recepciones" };
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
    if (again) { again = false; refresh(); }
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
    if (cur) { const fresh = items.find((x) => x.id === cur.id); if (fresh && fresh !== cur && !dirty()) { cur = fresh; fillHead(); } }
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
    if (st.k === "lista") el.appendChild(actBtn("primary", "send", "Enviar", "Enviar al borrador de Gmail", () => openLote(it, { send: true })));
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
  document.addEventListener("visibilitychange", () => { if (!document.hidden && unlocked && Date.now() - lastLoad > 15000 && !dlg.open) refresh(); });
  window.addEventListener("online", () => setTimeout(refresh, 1500));

  // ---------------------------------------------------------------- un lote: fotos + tabla de recepciones
  const dlg = $("lotDialog"), rowsEl = $("lotRows"), errEl = $("lotErr"), ocEl = $("lotOc");
  const stage = $("lvStage"), img = $("lvImg"), lvMsg = $("lvMsg"), strip = $("lvStrip");
  let cur = null, work = null, orig = "", mode = "semanal", busy = false;
  let shots = null, urls = [], idx = 0, loadSeq = 0;
  const cache = new Map();                          // id -> fotos ya bajadas (los últimos 2 lotes abiertos)

  // Copia editable de la tabla del lote. Lo que no esté en la lista de productos de este dispositivo pasa a "otros".
  function toWork(it) {
    const t = it.tabla || {}, cat = new Set(A.catalog());
    const values = {}, extras = [];
    (Array.isArray(t.valores) ? t.valores : []).forEach((v) => {
      if (!v || !v.nombre) return;
      if (cat.has(v.nombre)) values[v.nombre] = String(v.texto || "");
      else extras.push({ nombre: String(v.nombre), texto: String(v.texto || "") });
    });
    (Array.isArray(t.extras) ? t.extras : []).forEach((x) => { if (x) extras.push({ nombre: String(x.nombre || ""), texto: String(x.texto || "") }); });
    return { oc: P.cleanOc(t.oc || ""), values, extras };
  }
  function fromWork() {
    const valores = A.catalog().filter((n) => String(work.values[n] || "").trim()).map((n) => ({ nombre: n, texto: String(work.values[n]).trim() }));
    const extras = work.extras.filter((x) => String(x.nombre || "").trim() || String(x.texto || "").trim()).map((x) => ({ nombre: String(x.nombre || "").trim(), texto: String(x.texto || "").trim() }));
    return { oc: work.oc, valores, extras };
  }
  const snapshot = () => JSON.stringify({ t: fromWork(), m: mode });
  const dirty = () => !!(cur && work && snapshot() !== orig);

  function fillHead() {
    const st = stateOf(cur);
    $("lotTitle").textContent = titleOf(Object.assign({}, cur, { tabla: { oc: work.oc }, periodo: periodOf(cur, mode) }));
    $("lotSub").textContent = hojas(cur.paginas || 0) + " · guardado el " + fmtDay(cur.creado) + " a las " + fmtTime(cur.creado) +
      (cur.where === "local" ? " · en este dispositivo" : " · en tu cuenta") + (isSent(cur) && cur.carpeta ? " · Drive: " + cur.carpeta : "");
    const chip = $("lotState"), unsaved = dirty();
    chip.className = "lot-state chip " + (unsaved ? "info" : st.cls); chip.textContent = unsaved ? "Cambios sin guardar" : st.text;
    $("lotSend").lastChild.textContent = isSent(cur) ? "Volver a enviar" : "Enviar al borrador de Gmail";
  }

  function refreshPeriodInfo() {
    const per = periodOf(cur, mode);
    $("lotPeriodSeg").querySelectorAll(".seg-btn").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
    $("lotPeriodText").textContent = "día " + P.text(per);
    $("lotPeriodSub").textContent = "(" + per.label + ")";
    $("lotFile").textContent = fileOf(work.oc, per);
    $("lotDest").textContent = A.bridgeReady()
      ? "Al enviar, el PDF se sube a Drive (" + P.folderPath(work.oc || "número", per) + ") y queda un borrador en Gmail."
      : "El puente a Drive/Gmail no está configurado en este dispositivo (Ajustes). Mientras tanto podés descargar el PDF.";
    fillHead();
  }
  $("lotPeriodSeg").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn");
    if (!b || !cur) return;
    mode = b.dataset.mode === "quincenal" ? "quincenal" : "semanal";
    refreshPeriodInfo();
  });
  ocEl.addEventListener("input", () => {
    const c = P.cleanOc(ocEl.value);
    if (c !== ocEl.value) ocEl.value = c;
    ocEl.classList.remove("bad"); errEl.textContent = "";
    work.oc = c; refreshPeriodInfo();
  });

  function calcLabel(row, input) {
    const q = parseQty(input.value);
    let lab = row.querySelector(".calc");
    if (q.ok && q.isSum) {
      if (!lab) { lab = document.createElement("div"); lab.className = "calc"; row.appendChild(lab); }
      lab.textContent = "= " + formatQty(q.value);
    } else if (lab) lab.remove();
  }
  function qtyInput(get, set) {
    const inp = document.createElement("input");
    inp.type = "text"; inp.className = "q"; inp.inputMode = "decimal"; inp.autocomplete = "off"; inp.placeholder = "—";
    inp.value = get();
    inp.addEventListener("input", () => { set(inp.value); inp.classList.remove("bad"); errEl.textContent = ""; calcLabel(inp.parentElement, inp); });
    inp.addEventListener("blur", () => { inp.classList.toggle("bad", parseQty(inp.value).ok === false); });
    return inp;
  }
  function buildRows() {
    rowsEl.innerHTML = "";
    A.catalog().forEach((name, i) => {
      const row = document.createElement("div"); row.className = "tt-row";
      const n = document.createElement("div"); n.className = "n"; n.textContent = i + 1;
      const nm = document.createElement("div"); nm.className = "name"; nm.textContent = name;
      const inp = qtyInput(() => work.values[name] || "", (v) => { work.values[name] = v; });
      row.append(n, nm, inp); calcLabel(row, inp); rowsEl.appendChild(row);
    });
    work.extras.forEach((x, i) => {
      const row = document.createElement("div"); row.className = "tt-row extra";
      const rm = document.createElement("button"); rm.type = "button"; rm.className = "rm"; rm.title = "Quitar"; rm.innerHTML = ICON("x");
      rm.addEventListener("click", () => { work.extras.splice(i, 1); buildRows(); });
      const nm = document.createElement("input"); nm.type = "text"; nm.className = "name-in"; nm.placeholder = "Nombre del producto"; nm.value = x.nombre || "";
      nm.addEventListener("input", () => { x.nombre = nm.value; errEl.textContent = ""; });
      const inp = qtyInput(() => x.texto || "", (v) => { x.texto = v; });
      row.append(rm, nm, inp); calcLabel(row, inp); rowsEl.appendChild(row);
    });
  }
  $("lotAddExtra").addEventListener("click", () => {
    work.extras.push({ nombre: "", texto: "" }); buildRows();
    const names = rowsEl.querySelectorAll("input.name-in");
    if (names.length) { names[names.length - 1].focus(); rowsEl.scrollTop = rowsEl.scrollHeight; }
  });
  // Enter pasa al casillero siguiente
  $("lotForm").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.target.tagName !== "INPUT") return;
    e.preventDefault();
    const inputs = [...$("lotForm").querySelectorAll("input")];
    const k = inputs.indexOf(e.target);
    if (k >= 0 && k < inputs.length - 1) { inputs[k + 1].focus(); if (inputs[k + 1].select) inputs[k + 1].select(); }
    else $("lotSave").focus();
  });
  $("lotForm").addEventListener("submit", (e) => e.preventDefault());
  $("lotForm").addEventListener("input", () => { if (cur) fillHead(); });

  // Filas para el PDF. Devuelve null (y marca en rojo) si hay datos inválidos.
  function collect() {
    const rows = [], cat = A.catalog(), inputs = [...rowsEl.querySelectorAll(".tt-row")];
    let bad = 0, noName = 0;
    const mark = (i, isBad) => { const q = inputs[i] && inputs[i].querySelector("input.q"); if (q) q.classList.toggle("bad", isBad); };
    cat.forEach((name, i) => {
      const q = parseQty(work.values[name]);
      if (q.empty) { mark(i, false); return; }
      if (!q.ok) { bad++; mark(i, true); return; }
      mark(i, false); rows.push({ name, qtyText: formatQty(q.value) });
    });
    work.extras.forEach((x, k) => {
      const q = parseQty(x.texto), nm = String(x.nombre || "").trim(), i = cat.length + k;
      if (q.empty && !nm) return;
      if (!q.ok || q.empty) { bad++; mark(i, true); return; }
      if (!nm) { noName++; return; }
      mark(i, false); rows.push({ name: nm, qtyText: formatQty(q.value) });
    });
    if (bad || noName) {
      errEl.textContent = bad ? "Revisá las cantidades marcadas en rojo (por ejemplo 12 o 2,5)." : "Falta el nombre de un producto agregado.";
      const first = rowsEl.querySelector("input.q.bad"); if (first) first.focus();
      return null;
    }
    errEl.textContent = "";
    return rows;
  }

  // ---------------------------------------------------------------- visor de fotos
  function releaseUrls() { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; }
  function viewerMsg(html) { lvMsg.hidden = !html; lvMsg.innerHTML = html || ""; img.hidden = !!html; }
  function show(i) {
    if (!urls.length) return;
    idx = Math.max(0, Math.min(urls.length - 1, i));
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
      show(0);
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
    cur = it; work = toWork(it);
    mode = it.periodo && it.periodo.mode === "quincenal" ? "quincenal" : "semanal";
    orig = snapshot();
    ocEl.value = work.oc; ocEl.classList.remove("bad"); errEl.textContent = "";
    stage.classList.remove("zoom"); $("lvZoom").setAttribute("aria-pressed", "false");
    buildRows(); refreshPeriodInfo(); setBusy(false);
    dlg.showModal();
    rowsEl.scrollTop = 0;
    const p = loadShots(it);
    if (opts.send) { await p; if (cur === it && dlg.open) sendCurrent(); }
    else if (window.matchMedia && matchMedia("(pointer: fine)").matches) { const f = work.oc ? rowsEl.querySelector("input.q") : ocEl; if (f) f.focus(); }
  }
  // Devuelve false si el usuario decide quedarse (o si no se pudo guardar).
  async function closeLote() {
    if (busy) return false;
    if (dirty()) {
      const save = await A.askConfirm("Hay cambios sin guardar en la tabla de recepciones. ¿Guardarlos?", "Guardar", "Descartar");
      if (save && !(await saveTable())) return false;
    }
    loadSeq++; releaseUrls(); img.removeAttribute("src");
    if (dlg.open) dlg.close();
    cur = null; work = null;
    return true;
  }
  $("lotClose").addEventListener("click", () => closeLote());
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); closeLote(); });

  function setBusy(on, text) {
    busy = on;
    ["lotSend", "lotSave", "lotDownload", "lotDelete", "lotClose"].forEach((id) => { $(id).disabled = on; });
    $("lotSend").classList.toggle("is-busy", !!on && text !== undefined && /Enviando|Preparando/.test(text));
    if (on && text) $("lotDest").textContent = text; else if (!on && cur) refreshPeriodInfo();
  }

  // Guarda la tabla y el período. Devuelve las filas (o null si hay errores).
  async function saveTable(opts = {}) {
    const rows = collect();
    if (rows === null) return null;
    const tabla = fromWork(), periodo = periodOf(cur, mode);
    const changed = dirty();
    let estado = tabla.oc && rows.length ? "lista" : "pendiente";
    if (isSent(cur) && !changed && !opts.force) estado = "enviado";      // abrir y cerrar un enviado no lo cambia
    if (!changed && estado === cur.estado && !opts.force) return rows;
    setBusy(true, "Guardando…");
    try {
      await S.update(cur, { tabla, periodo, estado });
      orig = snapshot();
      A.setStatus("Tabla de recepciones guardada ✔", 3500);
      render();
      return rows;
    } catch (e) {
      errEl.textContent = "No se pudo guardar: " + (e.message || e);
      return null;
    } finally { setBusy(false); }
  }
  $("lotSave").addEventListener("click", async () => {
    const rows = await saveTable({ force: true });
    if (!rows) return;
    if (!work.oc || !rows.length) { errEl.textContent = ""; $("lotDest").textContent = "Guardado. Para poder enviarlo falta " + (!work.oc ? "el número de OC" : "cargar al menos una cantidad") + "."; }
    else await closeLote();
  });

  async function buildPdfOf(rows) {
    const f = shots || await loadShots(cur);
    if (!f) throw new Error("No se pudieron cargar las fotos.");
    const per = periodOf(cur, mode), name = fileOf(work.oc, per);
    return { pdf: A.makePdf(f, name, work.oc, per, rows), name, per };
  }

  async function sendCurrent() {
    if (busy || !cur) return;
    if (!A.bridgeReady()) {
      await A.showMessage("Para enviarlo al borrador de Gmail desde este dispositivo, configurá el puente en Ajustes (dirección y clave del puente de Google).\n\nMientras tanto podés usar “Descargar PDF”.");
      return;
    }
    if (!work.oc) { ocEl.classList.add("bad"); ocEl.focus(); errEl.textContent = "Escribí el número de la orden de compra (OC): con él se nombra el PDF y la carpeta de Drive."; return; }
    const rows = collect();
    if (rows === null) return;
    if (!rows.length && !(await A.askConfirm("No cargaste ninguna cantidad: el PDF va a salir sin la tabla de recepciones.\n\n¿Enviarlo igual?", "Enviar igual", "Volver"))) return;
    if (!(await saveTable({ force: true }))) return;
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
      await closeLote();
      refresh();
      A.setStatus("Enviado ✔ " + built.name + ".pdf", 8000);
      await A.showMessage("PDF guardado en Drive:\n" + (sent.carpeta || P.folderPath(it.tabla.oc, built.per)) +
        (sent.reemplazado ? "\n(reemplazó un PDF con el mismo nombre; el anterior está en la papelera de Drive)" : "") +
        "\n\nBorrador creado en Gmail para revisar y enviar.");
    } catch (e) {
      console.error(e);
      setBusy(false);
      const msg = "No se pudo enviar: " + (e.message || e);
      if (built && await A.askConfirm(msg + "\n\n¿Querés descargar el PDF en este dispositivo?", "Descargar", "No")) A.downloadBlob(built.pdf, built.name + ".pdf");
      else if (!built) await A.showMessage(msg);
    }
  }
  $("lotSend").addEventListener("click", sendCurrent);

  $("lotDownload").addEventListener("click", async () => {
    if (busy || !cur) return;
    const rows = collect();
    if (rows === null) return;
    setBusy(true, "Preparando el PDF…");
    try {
      const b = await buildPdfOf(rows);
      A.downloadBlob(b.pdf, b.name + ".pdf");
      A.setStatus("PDF “" + b.name + ".pdf” descargado", 6000);
    } catch (e) { errEl.textContent = "No se pudo generar el PDF: " + (e.message || e); }
    finally { setBusy(false); }
  });

  $("lotDelete").addEventListener("click", async () => {
    if (busy || !cur) return;
    const it = cur;
    const warn = isSent(it) ? "" : "\n\nTodavía no se envió al borrador de Gmail.";
    if (!(await A.askConfirm("¿Borrar este PDF guardado (" + hojas(it.paginas || 0) + ")? No se puede deshacer." + warn, "Borrar", "Cancelar"))) return;
    setBusy(true, "Borrando…");
    try {
      await S.remove(it);
      cache.delete(it.id);
      setBusy(false); orig = snapshot();
      await closeLote();
      A.setStatus("PDF borrado.", 4000);
      refresh();
    } catch (e) { setBusy(false); errEl.textContent = "No se pudo borrar: " + (e.message || e); }
  });

  // ---------------------------------------------------------------- inicio
  let unlocked = false;
  A.onSettings = () => { render(); if (cur && dlg.open && !dirty()) { work = toWork(cur); orig = snapshot(); buildRows(); refreshPeriodInfo(); } };
  const start = () => { unlocked = true; refresh(); S.retryUploads(); };
  if (window.LAGAuth) window.LAGAuth.onUnlock(start); else start();

  window.Lotes = {
    async saveBatch(list, periodo, onProgress) {
      const r = await S.save(list, periodo, onProgress);
      refresh();
      return r;
    },
    refresh
  };
})();
