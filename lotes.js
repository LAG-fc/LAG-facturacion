// lotes.js — Remitos guardados (v8.3; v8.8 planilla; v9.0 comparación con el Excel de despachos y PDF a Drive).
// Cada "Guardar remitos" del escáner deja un lote (fotos + OC + período) en la cuenta del usuario. Al abrirlo se ven las
// fotos junto a la tabla de recepciones: un renglón por producto de la OC, una columna por remito, el total y la columna
// "Excel" con lo que dice el Excel de despachos para ese período.
// "Confirmar y guardar en Drive":
//   · si la tabla coincide con el Excel, arma el PDF (remitos + tabla) y lo guarda en Mi unidad / OC-año / Cliente / OC-n;
//   · si no coincide, no confirma la tabla escaneada y pide la tabla de despachos real; el PDF sale con esa tabla;
//   · si todavía no hay Excel del período, avisa y deja guardarlo con la tabla de los remitos.
// El resultado queda en el estado de la unidad (unidades-store.js) para Facturas y Enviar mails.
(() => {
  "use strict";
  const A = window.App, R = () => window.RemitosApp, S = window.LotesStore, P = window.Period, O = window.OcParse, F = window.Flujo, U = window.UnidadesStore, $ = (id) => document.getElementById(id);
  if (!A || !S || !P) { console.warn("Remitos guardados: faltan archivos (app.js, lotes-store.js o period.js)."); return; }
  const esc = A.esc;
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
  const periodOf = (it) => it.periodo || P.forDate("semanal", new Date(it.creado));
  const ocRec = (oc) => (window.Datos && oc ? window.Datos.ocByNumber(oc) : null);
  const clienteOf = (it, oc) => (it.tabla && it.tabla.cliente) || ((ocRec(oc || ocOf(it)) || {}).cliente) || "";
  function stateOf(it) {
    const up = S.uploadingInfo(it.id);
    if (up) return { k: "subiendo", cls: "info", text: up.total ? "Subiendo " + up.done + " de " + up.total + "…" : "Subiendo…" };
    if (it.where === "local" && it.pendiente) return { k: "sin-subir", cls: "warn", text: "Sin subir · está solo en este dispositivo" };
    if (it.where === "cloud" && !it.subido) return { k: "incompleto", cls: "warn", text: "Subida sin terminar (desde otro dispositivo)" };
    if (it.estado === "enviado") return { k: "enviado", cls: "ok", text: "PDF en Drive desde el " + fmtDay(it.enviado) };
    if (it.estado === "lista") return { k: "lista", cls: "info", text: "Tabla completa · falta confirmar" };
    return { k: "pendiente", cls: "warn", text: ocOf(it) ? "Falta la tabla de recepciones" : "Falta la OC y la tabla de recepciones" };
  }
  const titleOf = (it) => { const oc = ocOf(it); return (oc ? "OC " + oc + " · " : "Remitos del ") + P.dateRange(periodOf(it)); };
  const fileOf = (oc, per) => (oc ? P.fileName(oc, per) : "REMITOS_" + per.from + "_al_" + per.to);

  // ---------------------------------------------------------------- lista
  const listEl = $("lotesList"), sentEl = $("lotesSentList"), whereEl = $("lotesWhere"), refreshBtn = $("lotesRefresh");
  let items = [], listError = null, loading = false, again = false, lastLoad = 0;

  async function refresh() {
    if (loading) { again = true; return; }
    loading = true; refreshBtn.classList.add("spin");
    try { const r = await S.list(); items = r.items; listError = r.error; }
    catch (e) { console.error(e); listError = e.message || String(e); }
    finally { loading = false; lastLoad = Date.now(); refreshBtn.classList.remove("spin"); }
    render();
    A.emit("lotes");
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

  // Sugerencias para el número de OC: las de los remitos guardados y las leídas de Drive.
  function fillOcSuggest() {
    const dl = $("ocSuggest");
    if (!dl) return;
    const seen = new Set(), list = [];
    const add = (oc, label) => { oc = P.cleanOc(oc); if (!oc || seen.has(oc)) return; seen.add(oc); list.push('<option value="' + esc(oc) + '">' + esc(label) + "</option>"); };
    if (window.Datos) window.Datos.allOcs().forEach((r) => add(r.numero, (r.cliente === "grupol" ? "Grupo L" : "Cook Master · " + F.sedeLabel(r))));
    items.forEach((it) => add(ocOf(it), "Remitos del " + P.dateRange(periodOf(it))));
    dl.innerHTML = list.slice(0, 80).join("");
  }

  function card(it) {
    const st = stateOf(it), el = document.createElement("div");
    el.className = "lote" + (st.k === "lista" ? " ready" : "") + (isSent(it) ? " sent" : "");
    const r = ocRec(ocOf(it)), who = r ? (r.cliente === "grupol" ? "Grupo L" : F.sedeLabel(r)) : "";
    el.innerHTML =
      '<button type="button" class="lote-open" title="Abrir: ver los remitos y cargar la tabla de recepciones">' +
        (it.miniatura ? '<img class="lote-thumb" alt="" src="' + esc(it.miniatura) + '">' : '<span class="lote-thumb">' + ICON("image") + "</span>") +
        '<span class="lote-info"><strong>' + esc(titleOf(it)) + "</strong>" +
        "<small>" + esc((who ? who + " · " : "") + hojas(it.paginas || 0) + " · guardado " + fmtDay(it.creado) + " " + fmtTime(it.creado)) + "</small>" +
        '<span class="chip ' + st.cls + '">' + esc(st.text) + "</span></span>" +
      "</button>";
    el.querySelector(".lote-open").addEventListener("click", () => openLote(it));
    if (st.k === "lista") el.appendChild(actBtn("primary", "check", "Confirmar", "Comparar con el Excel y guardar el PDF en Drive", () => openLote(it, { send: true })));
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
    try { await S.upload(it.id); A.toast("Subido a tu cuenta ✔"); }
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
  A.on("datos", () => { fillOcSuggest(); if (cur && dlg.open && !busy) { paintCompare(); } });

  // ---------------------------------------------------------------- un lote: fotos + tabla de recepciones
  const dlg = $("lotDialog"), grid = $("lotGrid"), gridWrap = $("lotGridWrap"), errEl = $("lotErr"), ocEl = $("lotOc"), savedEl = $("lotSaved"), perEl = $("lotPeriod"), cmpEl = $("lotCmp");
  const stage = $("lvStage"), img = $("lvImg"), lvMsg = $("lvMsg"), strip = $("lvStrip");
  let cur = null, work = null, orig = "", periodo = null, busy = false;
  let shots = null, urls = [], idx = 0, loadSeq = 0;
  const cache = new Map();                          // id -> fotos ya bajadas (los últimos 2 lotes abiertos)

  // La tabla en memoria: work = {oc, n (remitos = columnas), rows: [{nombre, cat (renglón fijo), cant: [texto por remito]}]}.
  // Con la OC leída de Drive, los renglones son los productos de la OC (en el orden del remito de LAG); si no, la lista
  // de productos de Ajustes. Se guarda en el lote como tabla = {oc, cliente, remitos, filas: [{nombre, cant}], valores, extras}.
  const blank = (n) => Array.from({ length: n }, () => "");
  function baseRows(oc, n) {
    const rec = ocRec(oc);
    if (rec && rec.items && rec.items.length) {
      const cat = R().catalog(), rank = (it) => {
        const m = O.matchRows([{ name: it.desc, key: O.keyOf(it.desc), sum: 1 }], cat.map((c) => ({ desc: c })), {}, {})[0];
        return m.target !== null && m.target >= 0 ? m.target : m.suggestions.length ? m.suggestions[0] + 0.5 : 99;
      };
      return rec.items.map((it, i) => ({ it, i, r: rank(it) })).sort((a, b) => a.r - b.r || a.i - b.i).map(({ it }) => ({ nombre: it.short || it.desc, cat: true, cant: blank(n) }));
    }
    return R().catalog().map((nombre) => ({ nombre, cat: true, cant: blank(n) }));
  }
  function toWork(it, ocOverride) {
    const t = it.tabla || {};
    const n = Math.max(1, Math.min(300, (it.paginas | 0) || (t.remitos | 0) || 1));
    const oc = P.cleanOc(ocOverride !== undefined ? ocOverride : t.oc || "");
    const rows = baseRows(oc, n);
    const byKey = new Map(rows.map((r) => [O.keyOf(r.nombre), r]));
    const put = (nombre, cant) => {
      nombre = String(nombre == null ? "" : nombre).trim();
      let r = nombre ? byKey.get(O.keyOf(nombre)) : null;
      if (!r) { r = { nombre, cat: false, cant: blank(n) }; rows.push(r); if (nombre) byKey.set(O.keyOf(nombre), r); }
      cant.forEach((v, i) => { v = String(v == null ? "" : v).trim(); if (v && i < n) r.cant[i] = r.cant[i] ? r.cant[i] + "+" + v : v; });
    };
    if (Array.isArray(t.filas)) t.filas.forEach((f) => { if (f) put(f.nombre, Array.isArray(f.cant) ? f.cant : []); });
    else {                                           // lotes anteriores a la v8.8: un total por producto (va al remito 1)
      (Array.isArray(t.valores) ? t.valores : []).forEach((v) => { if (v && v.nombre) put(v.nombre, [v.texto]); });
      (Array.isArray(t.extras) ? t.extras : []).forEach((x) => { if (x && (x.nombre || x.texto)) put(x.nombre, [x.texto]); });
    }
    return { oc, n, rows };
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
    return { oc: work.oc, cliente: clienteOf(cur, work.oc) || (cur.tabla && cur.tabla.cliente) || "", remitos: work.n, filas, valores, extras: [] };
  }
  function issues() {
    let bad = 0, noName = 0, any = 0;
    work.rows.forEach((r) => { const t = rowTotal(r); bad += t.bad.length; if (t.has) { any++; if (!String(r.nombre).trim()) noName++; } });
    return { bad, noName, any };
  }
  const newEstado = () => { const q = issues(); return work.oc && q.any && !q.bad && !q.noName ? "lista" : "pendiente"; };
  const snapshot = () => JSON.stringify({ t: fromWork(), p: P.id(periodo) });
  const dirty = () => !!(cur && work && snapshot() !== orig);

  function fillHead() {
    const st = stateOf(cur);
    $("lotTitle").textContent = (work.oc ? "OC " + work.oc + " · " : "Remitos del ") + P.dateRange(periodo);
    const rec = ocRec(work.oc);
    $("lotSub").textContent = (rec ? (rec.cliente === "grupol" ? "Grupo L · " : "Cook Master · " + F.sedeNombre(rec) + " · ") : "") + hojas(cur.paginas || 0) + " · guardado el " + fmtDay(cur.creado) + " a las " + fmtTime(cur.creado) +
      (cur.where === "local" ? " · en este dispositivo" : " · en tu cuenta") + (isSent(cur) && cur.carpeta ? " · Drive: " + cur.carpeta : "");
    const chip = $("lotState");
    chip.className = "lot-state chip " + st.cls; chip.textContent = st.text;
    $("lotSend").lastElementChild.textContent = isSent(cur) ? "Confirmar y guardar otra vez" : "Confirmar y guardar en Drive";
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
    const it = cur, snap = snapshot(), tabla = fromWork(), per = periodo, estado = isSent(it) ? newEstado() : newEstado();
    saving = S.update(it, { tabla, periodo: per, estado }).then(
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
  function changed() { errEl.textContent = ""; errEl.className = "err"; fillHead(); scheduleSave(); paintCompare(); }
  function note(text, ok) { errEl.className = ok ? "note" : "err"; errEl.textContent = text; }

  // ---------------------------------------------------------------- OC y período del lote
  function fillPeriods() {
    const list = [], seen = new Set(), add = (p, label) => { const k = P.id(p); if (seen.has(k)) return; seen.add(k); list.push({ p, label }); };
    add(periodo, P.dateRange(periodo) + " (" + (periodo.label || "período") + ")");
    if (window.Datos && work.oc) window.Datos.units().filter((u) => u.oc.numero === work.oc).forEach((u) => add(u.periodo, P.dateRange(u.periodo) + " (" + (u.periodo.label || "") + ")"));
    const d = new Date(cur.creado);
    add(P.forDate("quincenal", d), P.dateRange(P.forDate("quincenal", d)) + " (quincena)");
    add(P.forDate("semanal", d), P.dateRange(P.forDate("semanal", d)) + " (semana)");
    perEl.innerHTML = list.map((x, i) => '<option value="' + i + '"' + (P.same(x.p, periodo) ? " selected" : "") + ">" + esc(x.label) + "</option>").join("");
    perEl._list = list;
  }
  function refreshPeriodInfo() {
    $("lotFile").textContent = fileOf(work.oc, periodo);
    const rec = ocRec(work.oc), cli = clienteOf(cur, work.oc);
    const esperados = cli === "cookmaster" ? P.days(periodo) : 0;
    $("lotCount").textContent = esperados ? "· " + (cur.paginas || 0) + " de " + esperados + " remitos" : "";
    $("lotCount").className = esperados && (cur.paginas || 0) !== esperados ? "warn-txt" : "";
    $("lotDest").textContent = A.bridgeReady()
      ? "«Confirmar» compara la tabla con el Excel de despachos y guarda el PDF (remitos + tabla) en Mi unidad / " + P.folderPath(work.oc || "número", periodo, cli || (rec && rec.cliente)) + "."
      : "El puente a Google no está configurado en este dispositivo (Ajustes): solo se puede descargar el PDF.";
    fillHead();
  }
  perEl.addEventListener("change", () => {
    const x = (perEl._list || [])[Number(perEl.value)]; if (!x || !cur) return;
    periodo = Object.assign({}, x.p); refreshPeriodInfo(); changed();
  });
  ocEl.addEventListener("input", () => {
    const c = P.cleanOc(ocEl.value);
    if (c !== ocEl.value) ocEl.value = c;
    ocEl.classList.remove("bad");
    work.oc = c; refreshPeriodInfo(); changed();
  });
  ocEl.addEventListener("change", () => {                 // con una OC de Drive, los renglones pasan a ser sus productos
    if (!cur || !ocRec(work.oc)) return;
    const keep = fromWork(); cur.tabla = Object.assign({}, cur.tabla, keep);
    work = toWork(cur, work.oc); buildGrid(); fillPeriods(); refreshPeriodInfo(); changed();
  });
  ocEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); focusCell(0, Math.min(idx, work.n - 1)); } });

  // ---------------------------------------------------------------- comparación con el Excel de despachos
  // Devuelve {state: "ok"|"diff"|"none"|"nooc", desp: qty por producto de la OC, rem, cmp, rowItem: [índice de producto por renglón], info}
  function comparison() {
    const rec = ocRec(work.oc);
    if (!rec) return { state: "nooc", rowItem: work.rows.map(() => null) };
    const unit = { cliente: rec.cliente, oc: rec, periodo, anio: periodo.year, mes: periodo.month };
    const aliases = window.Datos.aliases();
    const rowItem = work.rows.map((r) => { const q = F.qtyByItem([{ name: r.nombre, key: O.keyOf(r.nombre), sum: 1 }], rec.items, aliases); const k = q.qty.findIndex((v) => v > 0); return k >= 0 ? k : null; });
    const remRows = work.rows.map((r) => ({ name: String(r.nombre).trim(), key: O.keyOf(r.nombre), sum: rowTotal(r).value })).filter((r) => r.name && r.sum > 0);
    const rem = F.qtyByItem(remRows, rec.items, aliases);
    const d = F.despachos(unit, window.Datos.ctx);
    if (d.error) return { state: "none", error: d.error, rowItem, rem, rec, unit };
    const desp = F.qtyByItem(d.rows, rec.items, aliases);
    const cmp = F.compare(rec.items, rem, desp);
    return { state: cmp.ok ? "ok" : "diff", desp, rem, cmp, rowItem, info: d.info, rec, unit, d };
  }
  let lastCmp = null;
  function paintCompare() {
    if (!work) return;
    const c = lastCmp = comparison();
    // columna Excel de cada renglón
    work.rows.forEach((r, i) => {
      const tr = grid.tBodies[0] && grid.tBodies[0].rows[i]; if (!tr) return;
      const cell = tr.querySelector("td.xx"); if (!cell) return;
      const k = c.rowItem[i], has = c.desp && k !== null && k !== undefined;
      const v = has ? c.desp.qty[k] : null, t = rowTotal(r);
      cell.className = "xx" + (has && (t.has || v) ? (Math.abs((t.has ? t.value : 0) - (v || 0)) <= F.TOL ? " ok" : " bad") : "");
      const diff = Math.round(((t.has ? t.value : 0) - (v || 0)) * 1000) / 1000;
      cell.innerHTML = has ? (v ? formatQty(v) : "0") + (t.has || v ? (Math.abs(diff) <= F.TOL ? "<small>✓</small>" : "<small>" + (diff > 0 ? "+" : "") + formatQty(diff) + "</small>") : "") : "–";
    });
    let html = "";
    if (c.state === "nooc") html = '<p class="badge info">' + ICON("alert") + "<span>" + (work.oc ? "La OC " + esc(work.oc) + " no está en las carpetas de Drive leídas: no se puede comparar con el Excel de despachos." : "Escribí la OC para comparar la tabla con el Excel de despachos.") + "</span></p>";
    else if (c.state === "none") html = '<p class="badge warn">' + ICON("alert") + "<span>" + esc(c.error) + " Se compara cuando esté en Drive.</span></p>";
    else if (c.state === "ok") html = '<p class="badge good">' + ICON("check") + "<span><b>La tabla coincide con el Excel de despachos.</b> " + esc(c.info || "") + "</span></p>";
    else {
      const bad = c.cmp.lines.filter((l) => !l.ok);
      const extra = c.cmp.pendingDesp.length ? " En el Excel hay productos que no están en la OC: " + c.cmp.pendingDesp.map((p) => p.name).join(", ") + "." : "";
      html = '<p class="badge bad">' + ICON("alert") + "<span><b>No coincide con el Excel de despachos</b> en " + bad.length + (bad.length === 1 ? " producto" : " productos") + (bad.length ? ": " + esc(bad.map((l) => l.desc + " (remitos " + formatQty(l.remitos) + " / Excel " + formatQty(l.despachos) + ")").join(" · ")) : "") + "." + esc(extra) + "</span></p>";
    }
    cmpEl.innerHTML = html;
  }

  // ---------------------------------------------------------------- la planilla
  function buildGrid() {
    const n = work.n, withX = !!ocRec(work.oc);
    let h = '<colgroup><col class="c-n"><col class="c-p">' + '<col class="c-r">'.repeat(n) + '<col class="c-t">' + (withX ? '<col class="c-x">' : "") + "</colgroup>";
    h += '<thead><tr><th class="xn" scope="col">N°</th><th class="xp" scope="col">Producto</th>';
    for (let c = 0; c < n; c++) h += '<th class="xc" scope="col" data-c="' + c + '"><button type="button" class="xh" data-c="' + c + '" title="Ver la foto del remito ' + (c + 1) + '"><small>Remito</small>' + (c + 1) + "</button></th>";
    h += '<th class="xt' + (withX ? " has-x" : "") + '" scope="col">Total</th>' + (withX ? '<th class="xx" scope="col" title="Lo que dice el Excel de despachos del período">Excel</th>' : "") + "</tr></thead><tbody>";
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
      h += '<td class="xt' + (withX ? " has-x" : "") + '"></td>' + (withX ? '<td class="xx">–</td>' : "") + "</tr>";
    });
    h += "</tbody>";
    grid.innerHTML = h;
    work.rows.forEach((r, i) => paintRow(i, true));
    markCol(idx);
    paintCompare();
  }
  const cellAt = (r, c) => grid.querySelector('input.xq[data-r="' + r + '"][data-c="' + c + '"]');
  // Total del renglón y celdas mal escritas (en rojo, salvo la que se está escribiendo)
  function paintRow(i, all) {
    const tr = grid.tBodies[0] && grid.tBodies[0].rows[i];
    if (!tr) return;
    const r = work.rows[i], t = rowTotal(r);
    tr.classList.toggle("has", t.has || t.bad.length > 0);
    const tot = tr.querySelector("td.xt");
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

  // Copia la tabla (Producto + una columna por remito, sin el total) para pegarla en Excel.
  $("lotCopy").addEventListener("click", async () => {
    const used = work.rows.filter(rowUsed);
    if (!used.length) { note("La tabla está vacía: no hay nada para copiar."); return; }
    const cell = (v) => { const q = parseQty(v); return q.empty ? "" : q.ok ? formatQty(q.value) : String(v).trim(); };
    const head = ["Producto"].concat(Array.from({ length: work.n }, (_, c) => "Remito " + (c + 1)));
    const tsv = [head.join("\t")].concat(used.map((r) => [String(r.nombre).trim() || "(sin nombre)"].concat(r.cant.map(cell)).join("\t"))).join("\n");
    note((await copyText(tsv)) ? "✓ Tabla copiada: pegala en Excel (Ctrl+V)." : "No se pudo copiar la tabla en este navegador.", true);
  });
  async function copyText(txt) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(txt); return true; } } catch (e) { /* se prueba de otra forma */ }
    const ta = document.createElement("textarea"); ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
    dlg.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    ta.remove(); return ok;
  }

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
      rows.push({ name: nombre, total: t.value, qtyText: formatQty(t.value), cells: r.cant.map((v) => { const q = parseQty(v); return q.ok ? formatQty(q.value) : ""; }) });
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
    periodo = Object.assign({}, periodOf(it));
    orig = snapshot();
    ocEl.value = work.oc; ocEl.classList.remove("bad"); errEl.textContent = "";
    stage.classList.remove("zoom"); $("lvZoom").setAttribute("aria-pressed", "false");
    buildGrid(); fillPeriods(); refreshPeriodInfo(); setBusy(false);
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
    $("lotSend").classList.toggle("is-busy", !!on && text !== undefined && /Comparando|Preparando|Guardando|Subiendo/.test(text));
    if (on && text) $("lotDest").textContent = text; else if (!on && cur) refreshPeriodInfo();
  }

  // PDF del lote. rows: [{name, qtyText, cells}] (tabla de los remitos) o tabla real (sin columnas por remito).
  async function buildPdfOf(rows, opts) {
    const f = shots || await loadShots(cur);
    if (!f) throw new Error("No se pudieron cargar las fotos.");
    const name = fileOf(work.oc, periodo);
    return { pdf: R().makePdf(f, name, work.oc, periodo, rows, opts && opts.real ? 0 : work.n, opts), name };
  }

  // La tabla de un lote, lista para Facturas: {id, oc, periodo, estado, enviado, remitos, filas: [{nombre, cant: [número|null], total}]}
  function recepcionOf(it) {
    const w = toWork(it);
    return {
      id: it.id, oc: w.oc, periodo: periodOf(it), estado: it.estado, enviado: it.enviado || null, archivo: it.archivo || "", remitos: w.n,
      filas: w.rows.filter(rowUsed).map((r) => ({ nombre: String(r.nombre).trim(), cant: r.cant.map((v) => { const q = parseQty(v); return q.ok ? q.value : null; }), total: rowTotal(r).value }))
    };
  }

  // ---------------------------------------------------------------- confirmar y guardar en Drive
  // 1) valida la tabla, 2) la compara con el Excel de despachos, 3) arma el PDF y lo guarda en la carpeta de la OC.
  async function sendCurrent() {
    if (busy || !cur) return;
    if (!work.oc) { ocEl.classList.add("bad"); ocEl.focus(); note("Escribí el número de la orden de compra (OC): con él se nombra el PDF y la carpeta de Drive."); return; }
    const rows = collect();
    if (rows === null) return;
    if (!rows.length) { note("La tabla de recepciones está vacía: cargá las cantidades de cada remito."); return; }
    setBusy(true, "Guardando la tabla…");
    const saved = await flushSave();
    setBusy(false);
    if (!saved) { note("No se pudo guardar la tabla: " + saveErr); return; }
    const cli = clienteOf(cur, work.oc), esperados = cli === "cookmaster" ? P.days(periodo) : 0;
    if (esperados && (cur.paginas || 0) !== esperados && !(await A.askConfirm("Para el período " + P.text(periodo) + " se esperan " + esperados + " remitos (uno por día) y este lote tiene " + (cur.paginas || 0) + ".\n\n¿Seguir igual?", "Seguir", "Volver"))) return;
    const c = comparison();
    if (c.state === "diff") { openDiff(c, rows); return; }
    if (c.state === "none" && !(await A.askConfirm(c.error + "\n\n¿Guardar el PDF igual, con la tabla de los remitos? Cuando esté el Excel vas a ver la comparación en Facturas.", "Guardar igual", "Esperar"))) return;
    if (c.state === "nooc" && !(await A.askConfirm("La OC " + work.oc + " no está en las carpetas de Drive leídas, así que no se puede comparar con el Excel de despachos.\n\n¿Guardar el PDF igual?", "Guardar igual", "Volver"))) return;
    await finish(rows, { confirmacion: c.state === "ok" ? "coincide" : "sin-excel", cmp: c });
  }

  // rows: filas de la tabla de los remitos; real: [{nombre, total}] si se usaron los despachos reales
  async function finish(rows, o) {
    const it = cur, real = o.real || null;
    let cliente = clienteOf(it, work.oc);
    if (!cliente) cliente = (await A.askConfirm("La OC " + work.oc + " no está en las carpetas leídas de Drive. ¿De qué cliente es?", "Cook Master", "Grupo L")) ? "cookmaster" : "grupol";
    const pdfRows = real ? real.map((r) => ({ name: r.nombre, qtyText: formatQty(r.total) })) : rows;
    const opts = real ? { real: true, title: "TABLA DE RECEPCIONES (DESPACHOS REALES)", note: "La tabla de los remitos escaneados no coincidía con el Excel de despachos: estas son las cantidades de despachos reales ingresadas por el responsable." } : null;
    if (!A.bridgeReady()) {
      if (await A.askConfirm("Este dispositivo no tiene configurado el puente a Google (Ajustes), así que no se puede guardar en Drive.\n\n¿Querés descargar el PDF?", "Descargar PDF", "Cancelar")) {
        try { const b = await buildPdfOf(pdfRows, opts); A.downloadBlob(b.pdf, b.name + ".pdf"); } catch (e) { note("No se pudo generar el PDF: " + (e.message || e)); }
      }
      return;
    }
    let built = null;
    setBusy(true, "Preparando el PDF…");
    try {
      built = await buildPdfOf(pdfRows, opts);
      if (built.pdf.size > 35 * 1024 * 1024) throw new Error("El PDF pesa " + (built.pdf.size / 1048576).toFixed(1) + " MB: es demasiado grande. Dividí el lote en dos.");
      setBusy(true, "Subiendo el PDF a Drive…");
      const up = await window.Puente.call({ action: "subir", tipo: "remitos", oc: work.oc, cliente, anio: periodo.year, nombre: built.name, pdf: await A.blobToBase64(built.pdf) }, 240000);
      const key = F.unitKey(cliente, work.oc, periodo);
      const despTot = o.cmp && o.cmp.desp && o.cmp.rec ? o.cmp.rec.items.map((x, i) => ({ nombre: x.short || x.desc, total: o.cmp.desp.qty[i] || 0 })).filter((x) => x.total) : [];
      await U.update(key, {
        cliente, oc: work.oc, periodo, lote: it.id, confirmacion: o.confirmacion,
        remitos: rows.map((r) => ({ nombre: r.name, total: r.total })), tablaReal: real || null, despachos: despTot,
        pdf: { id: up.id, nombre: up.nombre, ruta: up.ruta, url: up.url, at: Date.now() }
      });
      await S.update(it, { estado: "enviado", enviado: Date.now(), carpeta: String(up.ruta || ""), archivo: built.name, tabla: Object.assign(fromWork(), { cliente }) }).catch((e) => console.warn(e));
      setBusy(false);
      orig = snapshot();
      await closeLote();
      refresh();
      if (window.Datos) window.Datos.syncCarpetas([{ numero: P.cleanOc((it.tabla && it.tabla.oc) || ""), cliente, anio: periodo.year, mes: periodo.month }]).catch(() => {});
      A.emit("datos");
      A.toast("PDF guardado en Drive ✔ " + up.nombre, { action: "Ir a Facturas", onAction: () => A.go("facturas", { unit: key }) });
      await A.showMessage("PDF guardado en Drive:\nMi unidad / " + up.ruta + " / " + up.nombre + (o.confirmacion === "real" ? "\n\nSe guardó con la tabla de despachos reales." : o.confirmacion === "coincide" ? "\n\nLa tabla de recepciones coincide con el Excel de despachos ✔" : "") + "\n\nEl siguiente paso es la factura (sección Facturas).");
    } catch (e) {
      console.error(e);
      setBusy(false);
      const msg = "No se pudo guardar en Drive: " + (e.message || e);
      if (built && await A.askConfirm(msg + "\n\n¿Querés descargar el PDF en este dispositivo?", "Descargar", "No")) A.downloadBlob(built.pdf, built.name + ".pdf");
      else if (!built) await A.showMessage(msg);
    }
  }
  $("lotSend").addEventListener("click", sendCurrent);

  // ---------------------------------------------------------------- no coincide: tabla de despachos real
  const diffDlg = $("diffDialog"), diffTable = $("diffTable");
  let diffRows = null, diffCmp = null;
  function openDiff(c, rows) {
    diffRows = rows; diffCmp = c;
    const lines = c.rec.items.map((it, i) => ({ i, desc: it.short || it.desc, rem: c.rem.qty[i] || 0, desp: c.desp.qty[i] || 0 })).filter((l) => l.rem || l.desp);
    $("diffSub").textContent = "OC " + work.oc + " · " + P.dateRange(periodo) + " · " + (c.info || "");
    diffTable.innerHTML = '<thead><tr><th>Producto</th><th class="num">Remitos</th><th class="num">Excel</th><th class="num">Despachos reales</th></tr></thead><tbody>' +
      lines.map((l) => {
        const ok = Math.abs(l.rem - l.desp) <= F.TOL;
        return '<tr><td>' + esc(l.desc) + '</td><td class="num ' + (ok ? "ok" : "bad") + '">' + formatQty(l.rem) + '</td><td class="num">' + formatQty(l.desp) + '</td><td class="num"><input type="text" inputmode="decimal" data-i="' + l.i + '" data-n="' + esc(l.desc) + '" value="' + formatQty(l.desp) + '" aria-label="Despachos reales de ' + esc(l.desc) + '"></td></tr>';
      }).join("") + "</tbody>";
    (c.cmp.pendingDesp || []).length && ($("diffErr").textContent = "Ojo: el Excel trae productos que no están en la OC (" + c.cmp.pendingDesp.map((p) => p.name).join(", ") + "). Asignalos en Facturas si corresponde.");
    if (!(c.cmp.pendingDesp || []).length) $("diffErr").textContent = "";
    diffDlg.showModal();
    const first = diffTable.querySelector("input"); if (first && finePointer()) first.select();
  }
  diffTable.addEventListener("input", (e) => { const t = e.target; if (t.tagName === "INPUT") t.classList.toggle("bad", parseQty(t.value).ok === false); });
  $("diffBack").addEventListener("click", () => diffDlg.close());
  $("diffClose").addEventListener("click", () => diffDlg.close());
  $("diffSave").addEventListener("click", async () => {
    const real = [];
    let bad = false;
    diffTable.querySelectorAll("input").forEach((inp) => {
      const q = parseQty(inp.value);
      if (q.empty) return;
      if (!q.ok) { bad = true; inp.classList.add("bad"); return; }
      if (q.value > 0) real.push({ nombre: inp.dataset.n, total: q.value });
    });
    if (bad) { $("diffErr").textContent = "Revisá las cantidades marcadas en rojo: tienen que ser números (por ejemplo 12 o 2,5)."; return; }
    if (!real.length) { $("diffErr").textContent = "La tabla de despachos real está vacía."; return; }
    diffDlg.close();
    await finish(diffRows, { confirmacion: "real", real, cmp: diffCmp });
  });

  async function downloadCurrent() {
    if (busy || !cur) return;
    const rows = collect();
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
    const warn = isSent(it) ? "\n\n(El PDF que ya está en Drive no se borra.)" : "\n\nTodavía no se guardó el PDF en Drive.";
    if (!(await A.askConfirm("¿Borrar estos remitos guardados (" + hojas(it.paginas || 0) + ") y su tabla? No se puede deshacer." + warn, "Borrar", "Cancelar"))) return;
    clearTimeout(saveTimer); saveTimer = 0;
    while (saving) await saving;
    setBusy(true, "Borrando…");
    try {
      await S.remove(it);
      cache.delete(it.id);
      setBusy(false); orig = snapshot();
      await closeLote();
      A.toast("Remitos borrados.");
      refresh();
    } catch (e) { setBusy(false); note("No se pudo borrar: " + (e.message || e)); }
  });

  // ---------------------------------------------------------------- inicio
  let unlocked = false;
  A.on("settings", async () => {
    render();
    if (cur && dlg.open) { await flushSave(); if (!cur) return; work = toWork(cur); orig = snapshot(); buildGrid(); refreshPeriodInfo(); }
  });
  const start = () => { unlocked = true; refresh(); S.retryUploads(); };
  if (window.LAGAuth) window.LAGAuth.onUnlock(start); else start();

  window.Lotes = {
    // Guarda las fotos recién escaneadas como un lote nuevo. extra = {oc, cliente}
    async saveBatch(list, per, onProgress, extra) {
      const r = await S.save(list, per, onProgress, extra);
      if (r.fotos) { cache.set(r.id, r.fotos); while (cache.size > 2) cache.delete(cache.keys().next().value); delete r.fotos; }
      await refresh();
      return r;
    },
    refresh,
    items: () => items,
    recepcionOf,
    open(id) { const it = items.find((x) => x.id === id); if (it) { A.go("remitos"); openLote(it); } },
    // Tablas de recepciones guardadas (todas, o las de una OC)
    async recepciones(oc) {
      await refresh();
      const want = oc ? P.cleanOc(oc) : "";
      return items.filter((it) => it.tabla && (!want || ocOf(it) === want)).map(recepcionOf);
    }
  };
})();
