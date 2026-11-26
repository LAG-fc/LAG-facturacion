// app.js — Armazón de la aplicación (v9.0): ajustes del dispositivo, navegación entre Inicio y las tres secciones
// (Remitos, Facturas, Enviar mails), avisos y preguntas, y un canal de eventos para que los módulos se avisen cambios.
(() => {
  "use strict";
  const APP_VERSION = "9.0";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------------------------------------------------------------- ajustes (por dispositivo)
  const DEFAULT_CATALOG = [
    "PAN MIGNON BLANCO", "PAN MIGNON DE SALVADO", "PAN FRANCES", "PAN MIGNON BLANCO SIN SAL",
    "PAN DE SALVADO SIN SAL", "FIGACITAS DE MANTECA", "LIBRITOS DE GRASA", "BIZCOCHUELO DE VAINILLA 50 X 80",
    "MEDIALUNAS DE MANTECA", "MEDIALUNAS PARA RELLENAR", "PAN DE HAMBURGUESA", "PEBETE",
    "SANDWICH DE MIGA TRIPLE", "PIONONO", "PREPIZZA", "PAN ARABE", "PAN DE MOLDE CON SEMILLA", "PAN CIABATTA"
  ];
  const DEFAULTS = { autoCrop: true, filterMode: "mejorado", periodMode: "semanal", bridgeUrl: "", bridgeKey: "", hiRes: true, catalog: DEFAULT_CATALOG.join("\n"), oc: "", mailModo: "enviar", wppNumero: "", unidad: "" };
  let settings = { ...DEFAULTS };
  function loadSettings() {
    try {
      const st = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("settings") || "{}") };
      ["apiKey", "sensitivity", "decimals", "catalogVersion", "lector", "zones", "lecturaPreguntar"].forEach((k) => delete st[k]);   // restos de versiones anteriores
      ["visionUsage", "rlV8", "despDia", "totals", "lecturaAlias"].forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* nada */ } });
      return st;
    } catch (e) { return { ...DEFAULTS }; }
  }
  function saveSettings() { try { localStorage.setItem("settings", JSON.stringify(settings)); } catch (e) { /* nada */ } }
  const catalogList = () => String(settings.catalog || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const bridgeReady = () => /^https:\/\/script\.google(usercontent)?\.com\//.test(String(settings.bridgeUrl || "").trim()) && !!String(settings.bridgeKey || "").trim();

  // ---------------------------------------------------------------- eventos entre módulos
  const listeners = new Map();
  const on = (evt, fn) => { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt).delete(fn); };
  const emit = (evt, data) => (listeners.get(evt) || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });

  // ---------------------------------------------------------------- avisos y preguntas
  // Los cuadros nativos (alert/confirm) congelan la cámara en el celular, por eso no se usan.
  const msgDialog = $("msgDialog"), msgText = $("msgText"), msgOk = $("msgOk"), msgCancel = $("msgCancel");
  function askConfirm(text, okLabel, cancelLabel) {
    return new Promise((resolve) => {
      msgText.textContent = text;
      msgOk.textContent = okLabel || "Aceptar";
      msgCancel.textContent = cancelLabel || "Cancelar";
      msgCancel.hidden = cancelLabel === null;
      const done = (v) => { msgOk.onclick = msgCancel.onclick = msgDialog.oncancel = null; if (msgDialog.open) msgDialog.close(); resolve(v); };
      msgOk.onclick = () => done(true);
      msgCancel.onclick = () => done(false);
      msgDialog.oncancel = (e) => { e.preventDefault(); done(false); };
      if (!msgDialog.open) msgDialog.showModal();
    });
  }
  const showMessage = (text) => askConfirm(text, "Entendido", null);

  // Aviso flotante abajo (con un botón opcional)
  const toastEl = $("toast");
  let toastTimer = 0;
  function toast(text, opts) {
    opts = opts || {};
    clearTimeout(toastTimer);
    toastEl.innerHTML = "<span>" + esc(text) + "</span>" + (opts.action ? '<button type="button">' + esc(opts.action) + "</button>" : "");
    toastEl.hidden = false;
    const b = toastEl.querySelector("button");
    if (b) b.addEventListener("click", () => { toastEl.hidden = true; if (opts.onAction) opts.onAction(); });
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, opts.ms || (opts.action ? 9000 : 4500));
  }

  // ---------------------------------------------------------------- navegación
  // #inicio · #remitos · #facturas · #mails (el botón "atrás" del celular también funciona)
  const VIEWS = { inicio: $("vInicio"), remitos: $("vRemitos"), facturas: $("vFacturas"), mails: $("vMails") };
  const params = {};
  let current = "";
  function go(view, p) {
    if (!VIEWS[view]) view = "inicio";
    if (p) params[view] = p;
    if (location.hash.slice(1) !== view) location.hash = view;
    else show(view);
  }
  function show(view) {
    if (!VIEWS[view]) view = "inicio";
    const changed = view !== current;
    current = view;
    Object.keys(VIEWS).forEach((k) => { VIEWS[k].hidden = k !== view; });
    $("viewTitle").textContent = VIEWS[view].dataset.title || "Facturación";
    $("backBtn").hidden = view === "inicio";
    document.title = (view === "inicio" ? "Facturación" : VIEWS[view].dataset.title) + " · LAG Panificados";
    if (window.RemitosApp) window.RemitosApp.setActive(view === "remitos" && unlocked);
    const p = params[view]; delete params[view];
    emit("view", { view, params: p || null, changed });
    if (changed) window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", () => { if (unlocked) show(location.hash.slice(1)); });
  $("backBtn").addEventListener("click", () => go("inicio"));
  $("brandLink").addEventListener("click", (e) => { e.preventDefault(); go("inicio"); });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-go]");
    if (b && !b.closest("#authScreen")) { e.preventDefault(); go(b.dataset.go, b.dataset.unit ? { unit: b.dataset.unit } : null); }
  });

  // ---------------------------------------------------------------- ajustes (diálogo)
  const settingsDialog = $("settingsDialog");
  $("settingsBtn").addEventListener("click", () => {
    $("catalogInput").value = settings.catalog;
    $("hiResChk").checked = !!settings.hiRes;
    $("bridgeUrl").value = settings.bridgeUrl || "";
    $("bridgeKey").value = settings.bridgeKey || "";
    $("mailModo").value = settings.mailModo === "borrador" ? "borrador" : "enviar";
    $("wppNumero").value = settings.wppNumero || "";
    $("bridgeMsg").textContent = ""; $("bridgeMsg").className = "bridge-msg";
    settingsDialog.showModal();
  });
  $("cancelSettings").addEventListener("click", () => settingsDialog.close());
  $("saveSettings").addEventListener("click", () => {
    const before = settings.bridgeUrl + "|" + settings.bridgeKey;
    settings.catalog = $("catalogInput").value;
    settings.hiRes = $("hiResChk").checked;
    settings.bridgeUrl = $("bridgeUrl").value.trim();
    settings.bridgeKey = $("bridgeKey").value.trim();
    settings.mailModo = $("mailModo").value;
    settings.wppNumero = $("wppNumero").value.replace(/\D+/g, "");
    saveSettings();
    settingsDialog.close();
    emit("settings", { bridgeChanged: before !== settings.bridgeUrl + "|" + settings.bridgeKey });
  });
  $("resetCatalog").addEventListener("click", () => { $("catalogInput").value = DEFAULT_CATALOG.join("\n"); });
  $("driveReset").addEventListener("click", async () => {
    settingsDialog.close();
    if (await askConfirm("¿Volver a leer todas las OC y los Excel de Drive desde cero? (no se borra nada de Drive ni de la planilla)", "Sí, volver a leer", "Cancelar")) emit("drive:reset");
  });
  $("bridgeTest").addEventListener("click", async () => {
    const url = $("bridgeUrl").value.trim(), key = $("bridgeKey").value.trim(), msg = $("bridgeMsg");
    const say = (t, good) => { msg.textContent = t; msg.className = "bridge-msg " + (good ? "good" : "bad"); };
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { say("La dirección debe empezar con https://script.google.com/…", false); return; }
    if (!key) { say("Falta la clave.", false); return; }
    say("Probando…", true);
    try {
      const res = await fetch(url + (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(key), { redirect: "follow" });
      const out = await res.json();
      if (out.ok && (out.version || 0) >= 5) say("Conexión correcta ✔ (puente v" + out.version + ", mails a " + out.destinatario + ")", true);
      else if (out.ok) say("Conecta, pero el puente es de una versión anterior: actualizalo (INSTRUCCIONES-PUENTE.txt).", false);
      else say(out.error === "Clave incorrecta" ? "La clave no coincide con la del puente." : "El puente respondió: " + out.error, false);
    } catch (e) { say("No se pudo conectar. Revisá internet, la dirección y que el acceso sea “Cualquier persona”.", false); }
  });

  // ---------------------------------------------------------------- instalación como aplicación
  const installBtn = $("installBtn");
  let installEvt = null;
  const isStandalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; if (!isStandalone()) installBtn.hidden = false; });
  window.addEventListener("appinstalled", () => { installBtn.hidden = true; installEvt = null; toast("Aplicación instalada ✔"); });
  installBtn.addEventListener("click", async () => {
    if (installEvt) { installEvt.prompt(); try { await installEvt.userChoice; } catch (e) { /* nada */ } installEvt = null; installBtn.hidden = true; return; }
    showMessage("Para instalarla en el iPhone:\n\n1. Abrí esta página en Safari.\n2. Tocá el botón Compartir (el cuadrado con la flecha hacia arriba).\n3. Elegí “Añadir a pantalla de inicio”.\n4. Tocá “Añadir”.");
  });
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent) && !isStandalone()) installBtn.hidden = false;
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("No se pudo registrar el service worker:", e));
  }

  // ---------------------------------------------------------------- descargar y compartir archivos
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  const blobToBase64 = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = () => rej(new Error("No se pudo leer el archivo"));
    r.readAsDataURL(blob);
  });
  const b64ToBytes = (b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };

  // ---------------------------------------------------------------- inicio
  settings = loadSettings();
  if (settings.periodMode !== "quincenal") settings.periodMode = "semanal";
  saveSettings();                                   // limpia del navegador los datos de versiones anteriores
  $("verTag").textContent = "v" + APP_VERSION;
  $("verLabel").textContent = APP_VERSION;
  let unlocked = false;
  const start = () => { unlocked = true; emit("unlock"); show(location.hash.slice(1) || "inicio"); };

  window.App = {
    version: APP_VERSION, esc, on, emit, go, current: () => current,
    settings: () => settings, saveSettings, catalog: catalogList, defaultCatalog: () => DEFAULT_CATALOG.slice(), bridgeReady,
    askConfirm, showMessage, toast, downloadBlob, blobToBase64, b64ToBytes,
    isUnlocked: () => unlocked
  };
  // Se arranca cuando todos los módulos ya cargaron (los <script> van en orden y este evento llega al final).
  window.addEventListener("DOMContentLoaded", () => { if (window.LAGAuth) window.LAGAuth.onUnlock(start); else start(); });
})();
