// =====================================================================================================================
// PUENTE DE GOOGLE · LAG PANIFICADOS SRL — versión 5 (para la página v9.0)
// =====================================================================================================================
// Se pega en un proyecto de Google Apps Script (script.google.com) y se implementa como "Aplicación web"
// (Ejecutar como: Yo · Quién tiene acceso: Cualquier persona). Paso a paso: INSTRUCCIONES-PUENTE.txt.
//
// La página le habla por POST (texto JSON) con {key, action, ...}. Qué hace cada acción:
//   escanear       Lee "Compartido conmigo / Facturacion / <Mes> / <Cliente>": OC (PDF) y Excel de despachos.
//   files          Devuelve archivos (en base64), solo de Facturacion o de las carpetas OC-<año> de Mi unidad.
//   carpetas       Qué hay en la carpeta de cada OC (remitos y facturas ya guardados).
//   subir          Guarda un PDF (remitos o factura) en Mi unidad / OC-<año> / <Cliente> / OC-<número>.
//   planillaAgregar  Agrega UNA fila nueva a la planilla de Facturación (nunca borra ni cambia filas existentes).
//   planillaMarcar   En la fila de una factura, completa "REMITOS ENV" y "FC (MAIL O PORTAL)".
//   enviarMail     Manda (o deja en borrador) un mail con PDF de Drive adjuntos, solo a los destinatarios de abajo.
//
// Nunca borra archivos ni filas. No modifica los Excel de despachos (solo los lee).
// =====================================================================================================================

// 1) Escribí acá tu clave (la misma que pongas en la página, en Ajustes). Entre comillas, sin espacios.
const CLAVE = "CAMBIAR";

// 2) Ajustes (normalmente no hace falta tocarlos)
const CONFIG = {
  carpetaFacturacion: "Facturacion",                       // en "Compartido conmigo"
  clientes: { cookmaster: "Cook Master", grupol: "Grupo L" },
  // Hojas de la planilla de Facturación: Grupo L va en la 1.ª hoja (índice 0) y Cook Master en la 2.ª (índice 1).
  // Si algún día se reordenan, se puede poner el nombre exacto de la hoja en "nombre" (tiene prioridad sobre la posición).
  hojas: { grupol: { nombre: "", indice: 0 }, cookmaster: { nombre: "", indice: 1 } },
  planillaEmpiezaCon: "Facturacion",                        // nombre de la planilla dentro de la carpeta Facturacion
  destinatarios: ["cuentasapagar@cook-master.com.ar"],     // únicos correos a los que el puente puede mandar mails
  remitente: "LAG Panificados SRL"
};
const VERSION = 5;
const MESES = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];

// ---------------------------------------------------------------------------------------------------- entrada
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!claveOk(p.key)) return json({ ok: false, error: claveError() });
  return json({ ok: true, version: VERSION, destinatario: CONFIG.destinatarios[0] || "", destinatarios: CONFIG.destinatarios, cuenta: Session.getEffectiveUser().getEmail() });
}

function doPost(e) {
  let req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || "{}"); } catch (err) { return json({ ok: false, error: "Pedido inválido." }); }
  if (!claveOk(req.key)) return json({ ok: false, error: claveError() });
  try {
    const acciones = { escanear, files, carpetas, subir, planillaAgregar, planillaMarcar, enviarMail, ping: () => ({ version: VERSION, destinatarios: CONFIG.destinatarios }) };
    const fn = acciones[req.action];
    if (!fn) return json({ ok: false, error: "Acción desconocida: " + req.action + ". ¿El puente es de otra versión? (este es el v" + VERSION + ")" });
    return json(Object.assign({ ok: true, version: VERSION }, fn(req)));
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String((err && err.message) || err) });
  }
}

// Ejecutala una vez desde el editor (botón «Ejecutar») para que Google pida los permisos y para comprobar que el puente
// encuentra la carpeta Facturacion y la planilla. El resultado se ve en el «Registro de ejecución».
function autorizar() {
  const fac = carpetaFacturacion(), ss = planilla();
  const msg = "OK · carpeta: " + fac.getName().trim() + " · planilla: " + ss.getName().trim() + " (hojas: " + ss.getSheets().map((s) => s.getName()).join(", ") + ")" +
    " · mails a: " + CONFIG.destinatarios.join(", ") + " · Gmail: " + GmailApp.getAliases().length + " alias";
  console.log(msg);
  return msg;
}

function claveOk(k) { return CLAVE && CLAVE !== "CAMBIAR" && typeof k === "string" && k === CLAVE; }
function claveError() { return CLAVE === "CAMBIAR" ? "Falta poner la clave en el puente (línea CLAVE de Codigo.gs)." : "Clave incorrecta"; }
function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// ---------------------------------------------------------------------------------------------------- ayudas
// Compara nombres sin importar mayúsculas, acentos ni espacios de más ("Noviembre " = "NOVIEMBRE")
function norm(s) { return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim(); }
function hijaCarpeta(padre, nombre) {
  const want = norm(nombre), it = padre.getFolders();
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed() && norm(f.getName()) === want) return f; }
  return null;
}
function hijaQueContiene(padre, re) {
  const it = padre.getFolders();
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed() && re.test(norm(f.getName()))) return f; }
  return null;
}
function crearCarpeta(padre, nombre) { return hijaCarpeta(padre, nombre) || padre.createFolder(nombre); }
function archivosDe(carpeta) {
  const out = [], it = carpeta.getFiles();
  while (it.hasNext()) {
    const f = it.next(); if (f.isTrashed()) continue;
    out.push({ id: f.getId(), name: f.getName(), mime: f.getMimeType(), updated: f.getLastUpdated().getTime(), size: f.getSize() });
  }
  return out;
}

// Carpeta "Facturacion" (compartida conmigo): la que tiene carpetas de meses adentro
function carpetaFacturacion() {
  const cache = CacheService.getScriptCache(), id = cache.get("facturacionId");
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* se busca de nuevo */ } }
  const want = norm(CONFIG.carpetaFacturacion), it = DriveApp.searchFolders("title contains '" + CONFIG.carpetaFacturacion.replace(/'/g, "") + "' and trashed = false");
  let best = null;
  while (it.hasNext()) {
    const f = it.next(); if (norm(f.getName()) !== want) continue;
    const meses = MESES.filter((m) => hijaCarpeta(f, m)).length;
    if (!best || meses > best.meses) best = { f, meses };
  }
  if (!best) throw new Error("No encontré la carpeta «" + CONFIG.carpetaFacturacion + "» en Drive (Compartido conmigo).");
  cache.put("facturacionId", best.f.getId(), 21600);
  return best.f;
}

// Solo se entregan archivos de Facturacion o de las carpetas OC-<año> de Mi unidad
function permitido(file) {
  const fac = carpetaFacturacion().getId(), root = DriveApp.getRootFolder().getId();
  let nivel = [file], vueltas = 0;
  while (nivel.length && vueltas++ < 8) {
    const sig = [];
    for (const x of nivel) {
      const it = x.getParents();
      while (it.hasNext()) {
        const p = it.next();
        if (p.getId() === fac) return true;
        if (/^OC-\d{4}$/.test(norm(p.getName()))) { const pp = p.getParents(); while (pp.hasNext()) if (pp.next().getId() === root) return true; }
        sig.push(p);
      }
    }
    nivel = sig;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------- escanear
// req.meses: [{anio, mes}] → para cada mes, los archivos de cada cliente (sin bajarlos)
function escanear(req) {
  const fac = carpetaFacturacion(), out = [];
  for (const m of req.meses || []) {
    const nombre = MESES[(Number(m.mes) || 1) - 1], carpeta = hijaCarpeta(fac, nombre);
    const r = { anio: Number(m.anio), mes: Number(m.mes), nombre, carpeta: !!carpeta, clientes: {} };
    if (carpeta) {
      for (const id of Object.keys(CONFIG.clientes)) {
        const c = hijaCarpeta(carpeta, CONFIG.clientes[id]) || hijaQueContiene(carpeta, new RegExp(norm(CONFIG.clientes[id]).split(" ")[0]));
        r.clientes[id] = c ? { carpeta: true, ruta: "Facturacion/" + carpeta.getName().trim() + "/" + c.getName().trim(), archivos: archivosDe(c) } : { carpeta: false, archivos: [] };
      }
    }
    out.push(r);
  }
  return { meses: out, planilla: planillaInfo() };
}
function planillaInfo() {
  try { const ss = planilla(); return { id: ss.getId(), nombre: ss.getName(), url: ss.getUrl(), hojas: ss.getSheets().map((s) => s.getName()) }; }
  catch (e) { return { error: String(e.message || e) }; }
}

// ---------------------------------------------------------------------------------------------------- files
function files(req) {
  const ids = (req.ids || []).slice(0, 8), out = [];
  for (const id of ids) {
    try {
      const f = DriveApp.getFileById(String(id));
      if (!permitido(f)) { out.push({ id, error: "Ese archivo no está en Facturacion ni en OC-año." }); continue; }
      out.push({ id, name: f.getName(), mime: f.getMimeType(), updated: f.getLastUpdated().getTime(), b64: Utilities.base64Encode(f.getBlob().getBytes()) });
    } catch (e) { out.push({ id, error: String(e.message || e) }); }
  }
  return { archivos: out };
}

// ---------------------------------------------------------------------------------------------------- carpetas
// Carpeta de una OC: Mi unidad / OC-<año> / <Cliente> / OC-<número> (también mira la estructura anterior OC-<año>/<MES>/OC-<n>)
function carpetaOc(anio, cliente, oc, crear) {
  const root = DriveApp.getRootFolder(), nombreCli = CONFIG.clientes[cliente] || cliente;
  const y = crear ? crearCarpeta(root, "OC-" + anio) : hijaCarpeta(root, "OC-" + anio);
  if (!y) return null;
  const c = crear ? crearCarpeta(y, nombreCli) : hijaCarpeta(y, nombreCli);
  if (!c) return null;
  const f = crear ? crearCarpeta(c, "OC-" + oc) : hijaCarpeta(c, "OC-" + oc);
  return f ? { folder: f, ruta: "OC-" + anio + "/" + nombreCli + "/OC-" + oc } : null;
}
function listarRecursivo(carpeta, ruta, prof, out) {
  archivosDe(carpeta).forEach((a) => { a.ruta = ruta; out.push(a); });
  if (prof <= 0) return;
  const it = carpeta.getFolders();
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) listarRecursivo(f, ruta + "/" + f.getName(), prof - 1, out); }
}
function carpetas(req) {
  const res = {}, root = DriveApp.getRootFolder();
  for (const it of (req.items || []).slice(0, 40)) {
    const oc = String(it.oc || "").replace(/\D+/g, ""); if (!oc) continue;
    const r = { carpeta: false, ruta: "", archivos: [] };
    const nueva = carpetaOc(Number(it.anio), it.cliente, oc, false);
    if (nueva) { r.carpeta = true; r.ruta = nueva.ruta; listarRecursivo(nueva.folder, nueva.ruta, 2, r.archivos); }
    const y = hijaCarpeta(root, "OC-" + it.anio), mesF = y && it.mes ? hijaCarpeta(y, MESES[Number(it.mes) - 1]) : null, vieja = mesF ? hijaCarpeta(mesF, "OC-" + oc) : null;
    if (vieja) { r.carpeta = true; const ru = "OC-" + it.anio + "/" + MESES[Number(it.mes) - 1] + "/OC-" + oc; if (!r.ruta) r.ruta = ru; listarRecursivo(vieja, ru, 2, r.archivos); }
    res[it.cliente + "|" + oc] = r;
  }
  return { resultados: res };
}

// ---------------------------------------------------------------------------------------------------- subir
// req: {oc, cliente, anio, nombre (sin .pdf), pdf (base64), tipo: "remitos" | "factura"}
function subir(req) {
  const oc = String(req.oc || "").replace(/\D+/g, "");
  if (!oc) throw new Error("Falta el número de OC.");
  if (!CONFIG.clientes[req.cliente]) throw new Error("Cliente desconocido.");
  if (!/^\d{4}$/.test(String(req.anio))) throw new Error("Año inválido.");
  const base = String(req.nombre || "").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "_").trim();
  if (!base) throw new Error("Nombre de archivo inválido.");
  const dest = carpetaOc(Number(req.anio), req.cliente, oc, true), carpeta = dest.folder;
  // Si ya existe un archivo con ese nombre: una factura se reutiliza; unos remitos se guardan con (2), (3)… (no se borra nada)
  let nombre = base + ".pdf";
  if (carpeta.getFilesByName(nombre).hasNext()) {
    if (req.tipo === "factura") { const f = carpeta.getFilesByName(nombre).next(); return { id: f.getId(), nombre: f.getName(), ruta: dest.ruta, url: f.getUrl(), existente: true }; }
    let k = 2; while (carpeta.getFilesByName(base + " (" + k + ").pdf").hasNext()) k++;
    nombre = base + " (" + k + ").pdf";
  }
  const blob = Utilities.newBlob(Utilities.base64Decode(String(req.pdf || "")), "application/pdf", nombre);
  const f = carpeta.createFile(blob);
  return { id: f.getId(), nombre: f.getName(), ruta: dest.ruta, url: f.getUrl(), existente: false };
}

// ---------------------------------------------------------------------------------------------------- planilla
function planilla() {
  const fac = carpetaFacturacion(), want = norm(CONFIG.planillaEmpiezaCon), it = fac.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed() && norm(f.getName()).indexOf(want) === 0) return SpreadsheetApp.openById(f.getId()); }
  throw new Error("No encontré la planilla «" + CONFIG.planillaEmpiezaCon + "…» (hoja de cálculo de Google) en la carpeta Facturacion.");
}
function hojaDe(ss, cliente) {
  const h = CONFIG.hojas[cliente]; if (!h) throw new Error("Cliente desconocido.");
  const sh = (h.nombre && ss.getSheets().find((s) => norm(s.getName()) === norm(h.nombre))) || ss.getSheets()[h.indice];
  if (!sh) throw new Error("La planilla no tiene la hoja de " + CONFIG.clientes[cliente] + ".");
  return sh;
}
// Columnas por el texto del encabezado
function columnas(sh) {
  const n = Math.min(10, sh.getLastRow()), w = Math.min(40, sh.getLastColumn()), vals = sh.getRange(1, 1, n, w).getDisplayValues();
  const k = (s) => norm(s).replace(/[^A-Z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  for (let r = 0; r < n; r++) {
    const row = vals[r].map(k), find = (re) => { const i = row.findIndex((x) => re.test(x)); return i >= 0 ? i + 1 : 0; };
    const numero = find(/^N\s*O?\s*FACT/), desc = find(/^DESCRIPCI/);
    if (!numero || !desc) continue;
    const c = { header: r + 1, numero, desc, fecha: find(/^FECHA$/) || 1, tipo: find(/^TIPO FACT/), razon: find(/^RAZON SOCIAL/), subtotal: find(/^SUBTOTAL$/),
      iva: find(/^IVA$/), final: find(/^FINAL$/), remitos: find(/^REMITOS ENV/), fc: find(/^FC\b/), estado: find(/^ESTADO$/), debe: find(/^TOTAL DEBE$/) };
    c.ultima = Math.max(c.debe, c.estado, c.fc, c.remitos, c.final, 15);      // la tabla principal (A:O); a la derecha puede haber otra tabla
    return c;
  }
  throw new Error("No encontré el encabezado (Nº FACT / DESCRIPCIÓN) en la hoja " + sh.getName() + ".");
}
function anioDe(v) {
  if (v instanceof Date) return v.getFullYear();
  const m = /(\d{4})\s*$/.exec(String(v || "").trim()); return m ? Number(m[1]) : null;
}
function fecha(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || "").trim());
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : new Date();
}
const libre = (row, c) => [c.fecha, c.numero, c.tipo, c.razon, c.desc, c.subtotal].filter(Boolean).every((k) => row[k - 1] === "" || row[k - 1] === null);
const casi = (a, b) => Math.abs(Number(a) - Number(b)) < 0.02;

// Busca la fila de una factura ya cargada (mismo número, tipo y total)
function buscarFila(sh, c, numero, tipo, total) {
  const last = sh.getLastRow(); if (last <= c.header) return 0;
  const vals = sh.getRange(c.header + 1, 1, last - c.header, c.ultima).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    const v = vals[i];
    if (String(v[c.numero - 1]).trim() !== String(numero).trim()) continue;
    if (c.tipo && tipo && norm(v[c.tipo - 1]) !== norm(tipo)) continue;
    if (c.final && total != null && v[c.final - 1] !== "" && !casi(v[c.final - 1], total)) continue;
    return c.header + 1 + i;
  }
  return 0;
}

// req: {cliente, bloque: {anio, mes}, fila: {fecha "dd/mm/aaaa", numero, tipo, descripcion, subtotal, iva, total, estado}}
function planillaAgregar(req) {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const ss = planilla(), sh = hojaDe(ss, req.cliente), c = columnas(sh), f = req.fila || {};
    if (!f.numero || !f.descripcion || typeof f.total !== "number") throw new Error("Faltan datos de la factura (número, descripción o total).");
    const ya = buscarFila(sh, c, f.numero, f.tipo, f.total);
    if (ya) return { hoja: sh.getName(), fila: ya, duplicada: true, url: ss.getUrl() + "#gid=" + sh.getSheetId() + "&range=A" + ya };
    const anio = Number(req.bloque && req.bloque.anio), mes = Number(req.bloque && req.bloque.mes);
    const last = sh.getLastRow(), vals = sh.getRange(1, 1, last, c.ultima).getValues();
    // Filas de total de cada mes ("NOVIEMBRE" en la columna A)
    const totales = [];
    for (let r = c.header + 1; r <= last; r++) { const i = MESES.indexOf(norm(vals[r - 1][0])); if (i >= 0) totales.push({ fila: r, mes: i + 1 }); }
    // El bloque del mes: filas entre el total anterior y el total de ese mes, con fechas de ese año
    let bloque = null;
    for (let t = totales.length - 1; t >= 0; t--) {
      if (totales[t].mes !== mes) continue;
      const desde = t > 0 ? totales[t - 1].fila + 1 : c.header + 1, hasta = totales[t].fila - 1;
      const anios = []; for (let r = desde; r <= hasta; r++) { const y = anioDe(vals[r - 1][c.fecha - 1]); if (y && y > 2000 && y < 2100) anios.push(y); }
      const ok = anios.length ? anios.filter((y) => y === anio).length * 2 >= anios.length : t === totales.length - 1;
      if (ok) { bloque = { desde, hasta, total: totales[t].fila }; break; }
    }
    let fila;
    if (bloque) {
      let ultimaUsada = bloque.desde - 1;
      for (let r = bloque.desde; r <= bloque.hasta; r++) if (!libre(vals[r - 1], c)) ultimaUsada = r;
      fila = ultimaUsada + 1;
      if (fila > bloque.hasta) {                                     // no quedan filas libres: se insertan celdas solo en la tabla (A:O)
        fila = bloque.total;
        sh.getRange(fila, 1, 1, c.ultima).insertCells(SpreadsheetApp.Dimension.ROWS);
        ajustarTotal(sh, c, fila + 1, fila - 1, fila);
        if (fila - 1 > c.header) sh.getRange(fila - 1, 1, 1, c.ultima).copyTo(sh.getRange(fila, 1, 1, c.ultima), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      }
    } else {                                                         // mes nuevo: fila de datos + fila de total al final
      let ultimaUsada = c.header;
      for (let r = c.header + 1; r <= last; r++) if (!libre(vals[r - 1], c) || MESES.indexOf(norm(vals[r - 1][0])) >= 0) ultimaUsada = r;
      fila = ultimaUsada + 1;
      const tot = fila + 1, prev = totales.length ? totales[totales.length - 1].fila : 0;
      if (prev) {
        sh.getRange(prev, 1, 1, c.ultima).copyTo(sh.getRange(tot, 1, 1, c.ultima), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
        const fs = sh.getRange(prev, 1, 1, c.ultima).getFormulas()[0];
        fs.forEach((fm, i) => { const m = /^=\s*SUM\(\s*\$?([A-Z]+)\$?\d+\s*:\s*\$?([A-Z]+)\$?\d+\s*\)$/i.exec(fm); if (m) sh.getRange(tot, i + 1).setFormula("=SUM(" + m[1] + fila + ":" + m[2] + fila + ")"); });
      }
      sh.getRange(tot, 1).setValue(MESES[mes - 1]);
      const ref = ultimaDeDatos(vals, c, last);
      if (ref) sh.getRange(ref, 1, 1, c.ultima).copyTo(sh.getRange(fila, 1, 1, c.ultima), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    }
    // Formato igual al de la fila de datos anterior, y los valores de la factura
    const ref = ultimaDeDatos(sh.getRange(1, 1, fila - 1, c.ultima).getValues(), c, fila - 1);
    if (ref && ref !== fila) sh.getRange(ref, 1, 1, c.ultima).copyTo(sh.getRange(fila, 1, 1, c.ultima), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    const razon = c.razon && ref ? sh.getRange(ref, c.razon).getValue() : "";
    const set = (col, v) => { if (col) sh.getRange(fila, col).setValue(v); };
    set(c.fecha, fecha(f.fecha));
    set(c.numero, /^\d+$/.test(String(f.numero)) ? Number(f.numero) : String(f.numero));
    set(c.tipo, f.tipo || "");
    set(c.razon, razon || "");
    set(c.desc, f.descripcion);
    set(c.subtotal, Number(f.subtotal) || 0);
    set(c.iva, Number(f.iva) || 0);
    set(c.final, Number(f.total));
    if (f.estado) set(c.estado, f.estado);
    SpreadsheetApp.flush();
    return { hoja: sh.getName(), fila, duplicada: false, url: ss.getUrl() + "#gid=" + sh.getSheetId() + "&range=A" + fila };
  } finally { lock.releaseLock(); }
}
function ultimaDeDatos(vals, c, hasta) {
  for (let r = hasta; r > c.header; r--) { const v = vals[r - 1]; if (v && !libre(v, c) && MESES.indexOf(norm(v[0])) < 0) return r; }
  return 0;
}
// La fila de total del mes bajó una fila: sus SUM(G32:G48) pasan a terminar en la fila nueva
function ajustarTotal(sh, c, filaTotal, viejoFin, nuevoFin) {
  const rg = sh.getRange(filaTotal, 1, 1, c.ultima), fs = rg.getFormulas()[0];
  fs.forEach((fm, i) => {
    const m = /^=\s*SUM\(\s*(\$?[A-Z]+\$?)(\d+)\s*:\s*(\$?[A-Z]+\$?)(\d+)\s*\)$/i.exec(fm);
    if (m && Number(m[4]) === viejoFin) sh.getRange(filaTotal, i + 1).setFormula("=SUM(" + m[1] + m[2] + ":" + m[3] + nuevoFin + ")");
  });
}

// req: {cliente, numero, tipo, total, remitos ("si"), fc ("portal" | "mail" | "wpp")}
function planillaMarcar(req) {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const ss = planilla(), sh = hojaDe(ss, req.cliente), c = columnas(sh);
    const fila = buscarFila(sh, c, req.numero, req.tipo, req.total);
    if (!fila) throw new Error("No encontré la factura N.º " + req.numero + " en la hoja " + sh.getName() + ".");
    if (req.remitos && c.remitos) sh.getRange(fila, c.remitos).setValue(String(req.remitos));
    if (req.fc && c.fc) sh.getRange(fila, c.fc).setValue(String(req.fc));
    SpreadsheetApp.flush();
    return { hoja: sh.getName(), fila };
  } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------------------------------------------- mail
// req: {para, asunto, cuerpo, adjuntos: [ids de Drive], borrador: true|false}
function enviarMail(req) {
  const para = String(req.para || CONFIG.destinatarios[0] || "").trim().toLowerCase();
  if (!CONFIG.destinatarios.map((d) => d.toLowerCase()).includes(para)) throw new Error("El puente solo puede mandar mails a: " + CONFIG.destinatarios.join(", ") + ".");
  const asunto = String(req.asunto || "").slice(0, 200), cuerpo = String(req.cuerpo || "").slice(0, 5000);
  if (!asunto) throw new Error("Falta el asunto del mail.");
  const blobs = [];
  for (const id of (req.adjuntos || []).slice(0, 6)) {
    const f = DriveApp.getFileById(String(id));
    if (!permitido(f)) throw new Error("Un adjunto no está en las carpetas permitidas.");
    blobs.push(f.getBlob());
  }
  const total = blobs.reduce((s, b) => s + b.getBytes().length, 0);
  if (total > 24 * 1024 * 1024) throw new Error("Los adjuntos pesan más de 24 MB: Gmail no los acepta.");
  const opts = { attachments: blobs, name: CONFIG.remitente };
  if (req.borrador) GmailApp.createDraft(para, asunto, cuerpo, opts); else GmailApp.sendEmail(para, asunto, cuerpo, opts);
  return { para, borrador: !!req.borrador, adjuntos: blobs.length };
}
