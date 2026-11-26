// drive.js — Conexión con Google Drive a través del puente (Apps Script) y datos leídos de Drive (v9.0).
//   · window.Puente: llamadas al puente ({key, action, ...} por POST, texto plano para evitar la verificación CORS).
//   · window.Datos: al abrir la página lee "Compartido conmigo / Facturacion / <Mes> / <Cliente>" del mes anterior,
//     el actual y el siguiente: las OC (PDF) y los Excel de despachos de Cook Master y de Grupo L. Los archivos se
//     guardan en el dispositivo (IndexedDB) y solo se bajan los nuevos o los que cambiaron.
//     Arma las "unidades de facturación" (OC + período) con su progreso (flujo.js).
(() => {
  "use strict";
  const A = window.App, P = window.Period, O = window.OcParse, F = window.Flujo, G = window.GrupoL, U = window.UnidadesStore, $ = (id) => document.getElementById(id);
  const jget = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v === null ? d : v; } catch (e) { return d; } };
  const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn("No se pudo guardar " + k, e); } };

  // ================================================================ puente
  async function call(payload, ms) {
    const s = A.settings();
    if (!A.bridgeReady()) throw new Error("Primero configurá el puente a Google en Ajustes (dirección y clave).");
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms || 180000);
    let res;
    try { res = await fetch(String(s.bridgeUrl).trim(), { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(Object.assign({ key: String(s.bridgeKey).trim() }, payload)), redirect: "follow", signal: ctl.signal }); }
    catch (e) { throw new Error(e.name === "AbortError" ? "Google tardó demasiado en responder (probá con mejor señal)." : "No hay conexión con Google (revisá internet y la dirección del puente)."); }
    finally { clearTimeout(timer); }
    let out; try { out = await res.json(); } catch (e) { throw new Error("El puente no respondió como se esperaba. Revisá que esté implementado con acceso “Cualquier persona”."); }
    if (!out.ok) {
      if (out.error === "Clave incorrecta") throw new Error("La clave del puente no coincide (revisá Ajustes).");
      if (/Acción desconocida|OC inválida|Nombre de archivo inválido/.test(out.error || "") || (out.version || 5) < 5) throw new Error("El puente es de una versión anterior: actualizalo con el código nuevo (INSTRUCCIONES-PUENTE.txt).");
      throw new Error(out.error || "El puente informó un error.");
    }
    if ((out.version || 0) < 5) throw new Error("El puente es de una versión anterior: actualizalo con el código nuevo (INSTRUCCIONES-PUENTE.txt).");
    return out;
  }
  const b64ToBuf = (b64) => A.b64ToBytes(b64).buffer;
  window.Puente = { call, ready: () => A.bridgeReady() };

  // ================================================================ archivos guardados en el dispositivo
  let idbP = null;
  function idb() {
    if (idbP) return idbP;
    idbP = new Promise((res, rej) => {
      if (!window.indexedDB) { rej(new Error("sin IndexedDB")); return; }
      const rq = indexedDB.open("lag-drive", 1);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains("archivos")) rq.result.createObjectStore("archivos", { keyPath: "id" }); };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
    idbP.catch(() => { idbP = null; });
    return idbP;
  }
  const fileCache = {
    async get(id) { try { const d = await idb(); return await new Promise((res) => { const r = d.transaction("archivos").objectStore("archivos").get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); }); } catch (e) { return null; } },
    async put(rec) { try { const d = await idb(); await new Promise((res) => { const t = d.transaction("archivos", "readwrite"); t.objectStore("archivos").put(rec); t.oncomplete = res; t.onerror = res; t.onabort = res; }); } catch (e) { /* sin caché */ } },
    async clear() { try { const d = await idb(); await new Promise((res) => { const t = d.transaction("archivos", "readwrite"); t.objectStore("archivos").clear(); t.oncomplete = res; t.onerror = res; }); } catch (e) { /* nada */ } }
  };
  // Bytes de varios archivos de Drive (de la caché si no cambiaron). metas: [{id, updated, name}]
  async function bytesOf(metas, say) {
    const out = new Map(), need = [];
    for (const m of metas) { const c = await fileCache.get(m.id); if (c && c.updated === m.updated && c.bytes) out.set(m.id, c.bytes); else need.push(m); }
    for (let i = 0; i < need.length; i += 4) {
      const part = need.slice(i, i + 4);
      if (say) say("Bajando de Drive " + (i + 1) + "–" + (i + part.length) + " de " + need.length + " archivos nuevos…");
      const r = await call({ action: "files", ids: part.map((m) => m.id) });
      for (const f of r.archivos || []) {
        if (f.error) { out.set(f.id, { error: f.error }); continue; }
        const bytes = b64ToBuf(f.b64), meta = part.find((m) => m.id === f.id) || {};
        out.set(f.id, bytes);
        await fileCache.put({ id: f.id, updated: meta.updated || f.updated, name: f.name, bytes });
      }
    }
    return out;
  }

  // ================================================================ datos de Drive
  // state.meses: [{anio, mes, nombre, carpeta, clientes: {cookmaster: {carpeta, ruta, ocs, despachos, problemas}, grupol: {…, semanas}}}]
  let state = jget("datosDrive", null) || { at: 0, meses: [], planilla: null, carpetas: {} };
  if (!state.carpetas) state.carpetas = {};
  let ajustes = jget("ocAjustes", {}) || {};                   // por OC: {sede, otherSheet, iva: {índice: tasa}}
  const aliases = () => jget("ocAliases", {}) || {};          // nombre en el Excel -> producto de la OC
  const clientAliases = () => jget("ocClientAliases", {}) || {};
  const workbooks = new Map();                                 // id del Excel de Cook Master -> libro leído
  let busy = false, lastError = "", log = [];

  const mesesALeer = (d) => { d = d || new Date(); return [-1, 0, 1].map((k) => { const x = new Date(d.getFullYear(), d.getMonth() + k, 1); return { anio: x.getFullYear(), mes: x.getMonth() + 1 }; }); };
  function setChip(cls, text) { const b = $("syncBtn"); b.className = "sync-chip " + (cls || ""); $("syncText").textContent = text; }
  function say(text, cls) { log.push({ text, cls: cls || "" }); if (log.length > 60) log.shift(); A.emit("drive:log", log); }
  const fmtHora = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  function chipIdle() {
    if (!A.bridgeReady()) setChip("bad", "Sin puente");
    else if (lastError) setChip("bad", "Error de Drive");
    else if (state.at) setChip("ok", "Drive " + fmtHora(state.at));
    else setChip("", "Drive");
  }

  // Ajustes guardados de cada OC (sede, hoja del Excel, IVA corregido)
  function applyAjustes(rec) {
    const a = ajustes[rec.id]; if (!a) return rec;
    if (a.sede) { rec.sede = a.sede; rec.sedeHow = "elegido"; }
    if (a.otherSheet !== undefined) rec.otherSheet = a.otherSheet;
    if (a.iva) Object.keys(a.iva).forEach((i) => { if (rec.items[i]) { rec.items[i].iva = a.iva[i]; rec.items[i].ivaSrc = "elegido"; } });
    return rec;
  }
  function setAjuste(ocId, patch) {
    ajustes[ocId] = Object.assign({}, ajustes[ocId], patch);
    if (patch.iva) ajustes[ocId].iva = Object.assign({}, (ajustes[ocId] || {}).iva, patch.iva);
    jset("ocAjustes", ajustes);
    state.meses.forEach((m) => Object.values(m.clientes || {}).forEach((c) => (c.ocs || []).forEach((r) => { if (r.id === ocId) applyAjustes(r); })));
    if (patch.sede) { const r = ocById(ocId); if (r && r.delivery) { const ca = clientAliases(); ca[window.Despachos.norm(r.delivery)] = patch.sede; jset("ocClientAliases", ca); } }
    persist(); A.emit("datos");
  }
  const persist = () => jset("datosDrive", state);
  const allOcs = () => { const out = []; state.meses.forEach((m) => Object.values(m.clientes || {}).forEach((c) => (c.ocs || []).forEach((r) => out.push(r)))); return out; };
  const ocById = (id) => allOcs().find((r) => r.id === id) || null;
  const ocByNumber = (n) => allOcs().find((r) => r.numero === P.cleanOc(n)) || null;

  // Libro del Excel de despachos de Cook Master de un mes (ya leído en memoria)
  function workbook(anio, mes) {
    const m = state.meses.find((x) => x.anio === anio && x.mes === mes), d = m && m.clientes && m.clientes.cookmaster && m.clientes.cookmaster.despachos;
    return d ? workbooks.get(d.id) || null : null;
  }
  function weeklies(anio, mes) {
    const m = state.meses.find((x) => x.anio === anio && x.mes === mes);
    const ws = (m && m.clientes && m.clientes.grupol && m.clientes.grupol.semanas) || [];
    return ws.slice().sort((a, b) => (b.updated || 0) - (a.updated || 0));
  }
  async function loadWorkbooks() {
    for (const m of state.meses) {
      const d = m.clientes && m.clientes.cookmaster && m.clientes.cookmaster.despachos;
      if (!d || workbooks.has(d.id)) continue;
      const c = await fileCache.get(d.id);
      if (c && c.bytes) { try { workbooks.set(d.id, await window.Xlsx.read(c.bytes)); } catch (e) { console.warn(e); } }
    }
  }

  // Lee Drive. Con {full: true} vuelve a bajar y leer todo.
  async function sync(opts) {
    opts = opts || {};
    if (busy) return;
    if (!A.bridgeReady()) { lastError = ""; chipIdle(); A.emit("datos"); return; }
    busy = true; lastError = ""; log = [];
    setChip("busy", "Leyendo Drive…");
    A.emit("drive:busy", true);
    try {
      if (opts.full) { await fileCache.clear(); workbooks.clear(); }
      say("Buscando las carpetas del mes en Drive (Facturacion)…");
      const r = await call({ action: "escanear", meses: mesesALeer() });
      const prevOcs = new Map(allOcs().map((x) => [x.archivo && x.archivo.id, x]));
      const meses = [];
      for (const m of r.meses || []) {
        const mm = { anio: m.anio, mes: m.mes, nombre: m.nombre, carpeta: m.carpeta, clientes: {} };
        if (!m.carpeta) { meses.push(mm); continue; }
        for (const cid of ["cookmaster", "grupol"]) {
          const cl = (m.clientes || {})[cid] || { carpeta: false, archivos: [] };
          const c = { carpeta: cl.carpeta, ruta: cl.ruta || "", ocs: [], problemas: [], semanas: [], despachos: null };
          mm.clientes[cid] = c;
          if (!cl.carpeta) continue;
          const pdfs = cl.archivos.filter((f) => /pdf/i.test(f.mime) || /\.pdf$/i.test(f.name));
          const xls = cl.archivos.filter((f) => /spreadsheetml|ms-excel/i.test(f.mime) || /\.xlsx$/i.test(f.name));
          // OC: se reutiliza lo ya leído si el archivo no cambió
          const toRead = [];
          for (const f of pdfs) { const p = prevOcs.get(f.id); if (p && p.archivo.updated === f.updated && !opts.full) c.ocs.push(applyAjustes(p)); else toRead.push(f); }
          if (toRead.length) {
            say(F.CLIENTES[cid].nombre + " " + m.nombre.toLowerCase() + ": leyendo " + toRead.length + (toRead.length === 1 ? " orden de compra…" : " órdenes de compra…"));
            const bytes = await bytesOf(toRead, say);
            for (const f of toRead) {
              const b = bytes.get(f.id);
              if (!b || b.error) { c.problemas.push(f.name + ": " + ((b && b.error) || "no se pudo bajar")); continue; }
              try {
                const ex = await window.PdfText.extract(b);
                if (!ex.hasText) { c.problemas.push(f.name + ": no trae texto (no es una OC del sistema)."); continue; }
                const parsed = O.parseAnyOc(ex.pages);
                if (!parsed.items.length) { c.problemas.push(f.name + ": no parece una orden de compra."); continue; }
                if (!parsed.ocNumber) parsed.ocNumber = (/(\d{5,})/.exec(f.name) || [])[1] || "";
                if (!parsed.ocNumber) { c.problemas.push(f.name + ": no pude saber el número de OC."); continue; }
                c.ocs.push(applyAjustes(F.ocRecord(parsed, { cliente: cid, anio: m.anio, mes: m.mes, archivo: { id: f.id, name: f.name, updated: f.updated }, aliases: clientAliases() })));
              } catch (e) { c.problemas.push(f.name + ": " + (e.message || e)); }
            }
          }
          c.ocs.sort((a, b) => String(a.numero).localeCompare(String(b.numero), undefined, { numeric: true }));
          // Excel de despachos
          if (cid === "cookmaster" && xls.length) {
            const pref = xls.filter((f) => /despacho/i.test(f.name)).sort((a, b) => b.updated - a.updated);
            const d = pref[0] || xls.slice().sort((a, b) => b.updated - a.updated)[0];
            c.despachos = { id: d.id, name: d.name, updated: d.updated };
            if (!workbooks.has(d.id) || opts.full) {
              say("Cook Master " + m.nombre.toLowerCase() + ": leyendo el Excel «" + d.name + "»…");
              const b = (await bytesOf([d], say)).get(d.id);
              if (b && !b.error) { try { workbooks.set(d.id, await window.Xlsx.read(b)); } catch (e) { c.problemas.push(d.name + ": " + e.message); c.despachos = null; } }
              else { c.problemas.push(d.name + ": " + ((b && b.error) || "no se pudo bajar")); c.despachos = null; }
            }
          }
          if (cid === "grupol" && xls.length) {
            const prevW = new Map(((((state.meses.find((x) => x.anio === m.anio && x.mes === m.mes) || {}).clientes || {}).grupol || {}).semanas || []).map((w) => [w.id, w]));
            const need = xls.filter((f) => { const w = prevW.get(f.id); return !w || w.updated !== f.updated || opts.full; });
            xls.forEach((f) => { const w = prevW.get(f.id); if (w && w.updated === f.updated && !opts.full) c.semanas.push(w); });
            if (need.length) {
              say("Grupo L " + m.nombre.toLowerCase() + ": leyendo " + need.length + (need.length === 1 ? " Excel semanal…" : " Excel semanales…"));
              const bytes = await bytesOf(need, say);
              for (const f of need) {
                const b = bytes.get(f.id);
                if (!b || b.error) { c.problemas.push(f.name + ": " + ((b && b.error) || "no se pudo bajar")); continue; }
                try {
                  const w = G.parseWeekly(await window.Xlsx.read(b), f.name);
                  if (w.error) { c.problemas.push(w.error); continue; }
                  c.semanas.push(Object.assign(w, { id: f.id, name: f.name, updated: f.updated }));
                } catch (e) { c.problemas.push(f.name + ": " + e.message); }
              }
            }
          }
          const nOc = c.ocs.length, nX = cid === "grupol" ? c.semanas.length : c.despachos ? 1 : 0;
          say(F.CLIENTES[cid].nombre + " " + m.nombre.toLowerCase() + ": " + nOc + " OC" + (cid === "grupol" ? ", " + nX + (nX === 1 ? " Excel semanal" : " Excel semanales") : nX ? ", Excel de despachos ✔" : ", sin Excel de despachos todavía") + ".", "ok-line");
          c.problemas.forEach((p) => say(p, "bad-line"));
        }
        meses.push(mm);
      }
      state.meses = meses; state.planilla = r.planilla || null; state.at = Date.now();
      if (r.planilla && r.planilla.error) say("Planilla de Facturación: " + r.planilla.error, "bad-line");
      persist(); A.emit("datos");
      await syncCarpetas();
      say("Listo: Drive leído a las " + fmtHora(state.at) + ".", "ok-line");
    } catch (e) {
      console.error(e);
      lastError = e.message || String(e);
      say(lastError, "bad-line");
    } finally {
      busy = false; chipIdle(); A.emit("drive:busy", false); A.emit("datos");
    }
  }
  // Qué hay en la carpeta de cada OC (Mi unidad / OC-año / Cliente / OC-número)
  async function syncCarpetas(only) {
    const items = (only || allOcs()).map((r) => ({ oc: r.numero, cliente: r.cliente, anio: r.anio, mes: r.mes }));
    if (!items.length) return;
    try {
      for (let i = 0; i < items.length; i += 30) {
        const r = await call({ action: "carpetas", items: items.slice(i, i + 30) });
        Object.assign(state.carpetas, r.resultados || {});
      }
      persist(); A.emit("datos");
    } catch (e) { say("Carpetas de las OC: " + (e.message || e), "bad-line"); }
  }

  // ================================================================ unidades de facturación
  const ctx = { workbook, weeklies };
  function scanForFlujo() {
    return { meses: state.meses.map((m) => ({ anio: m.anio, mes: m.mes, clientes: { cookmaster: { ocs: ((m.clientes || {}).cookmaster || {}).ocs || [] }, grupol: { ocs: ((m.clientes || {}).grupol || {}).ocs || [], semanas: ((m.clientes || {}).grupol || {}).semanas || [] } } })) };
  }
  // Archivos de la carpeta de una OC
  const carpetaDe = (cliente, oc) => state.carpetas[cliente + "|" + P.cleanOc(oc)] || null;
  function pdfRemitos(u) {
    const c = carpetaDe(u.cliente, u.oc.numero); if (!c) return null;
    const base = P.fileName(u.oc.numero, u.periodo).toUpperCase();
    return (c.archivos || []).find((a) => {
      const n = String(a.name || "").toUpperCase().replace(/\.PDF$/, "");
      if (n === base || n.indexOf(base + " (") === 0) return true;
      const m = /REMITOS_(\d+)_AL_(\d+)/i.exec(a.ruta || "");          // estructura anterior: carpeta Remitos_1_al_15
      return m && /pdf/i.test(a.mime) && Math.abs(Number(m[1]) - u.periodo.from) <= 1 && Math.abs(Number(m[2]) - u.periodo.to) <= 1;
    }) || null;
  }
  function facturasEnCarpeta(u) {
    const c = carpetaDe(u.cliente, u.oc.numero); if (!c) return [];
    return (c.archivos || []).filter((a) => window.FactParse.parseName(a.name)).map((a) => Object.assign({}, a, window.FactParse.parseName(a.name)));
  }
  function units() {
    const lotes = window.Lotes ? window.Lotes.items() : [];
    const list = F.units(scanForFlujo(), lotes, U.all(), new Date());
    list.forEach((u) => {
      u.recepcion = u.lote && window.Lotes ? window.Lotes.recepcionOf(u.lote) : null;
      const pdf = pdfRemitos(u); u.pdfEnDrive = !!pdf; u.pdfDrive = pdf;
      u.progreso = F.progress(u);
    });
    return list;
  }
  const unitByKey = (k) => units().find((u) => u.key === k) || null;

  // ================================================================ inicio
  $("syncBtn").addEventListener("click", () => { if (!A.bridgeReady()) { $("settingsBtn").click(); return; } sync(); });
  A.on("settings", (e) => { chipIdle(); if (e && e.bridgeChanged) sync(); });
  A.on("drive:reset", () => sync({ full: true }));
  U.onChange(() => A.emit("datos"));
  chipIdle();
  const ready = loadWorkbooks().then(() => A.emit("datos"));
  A.on("unlock", () => { ready.then(() => sync()); });

  window.Datos = {
    sync, syncCarpetas, units, unitByKey, ctx, state: () => state, busy: () => busy, error: () => lastError, log: () => log,
    ocById, ocByNumber, allOcs, setAjuste, aliases, setAlias(rowKey, itemDesc) { const a = aliases(); a[rowKey] = O.keyOf(itemDesc); jset("ocAliases", a); A.emit("datos"); },
    carpetaDe, facturasEnCarpeta, pdfRemitos, workbook, weeklies
  };
})();
