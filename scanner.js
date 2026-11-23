(() => {
  "use strict";
  const APP_VERSION = "8.4";
  const COMPANY = "LAG PANIFICADOS SRL";
  const $ = (id) => document.getElementById(id);

  const video = $("video"), overlay = $("overlay"), videoWrap = $("videoWrap"), detectPill = $("detectPill");
  const cameraSelect = $("cameraSelect"), filterSelect = $("filterSelect"), autoCropChk = $("autoCrop");
  const captureBtn = $("captureBtn"), captureLabel = $("captureLabel"), uploadBtn = $("uploadBtn"), fileInput = $("fileInput");
  const saveBtn = $("saveBtn"), saveLabel = $("saveLabel"), clearBtn = $("clearBtn"), settingsBtn = $("settingsBtn");
  const thumbs = $("thumbs"), countEl = $("count"), emptyEl = $("empty"), pagesPanel = $("pagesPanel");
  const statusEl = $("status"), cameraMsg = $("cameraMsg"), flash = $("flash");
  const settingsDialog = $("settingsDialog"), catalogInput = $("catalogInput"), hiResChk = $("hiResChk");
  const msgDialog = $("msgDialog"), msgText = $("msgText"), msgOk = $("msgOk"), msgCancel = $("msgCancel");
  const previewDialog = $("previewDialog"), previewImg = $("previewImg");

  const DEFAULT_CATALOG = [
    "PAN MIGNON BLANCO", "PAN MIGNON DE SALVADO", "PAN FRANCES", "PAN MIGNON BLANCO SIN SAL",
    "PAN DE SALVADO SIN SAL", "FIGACITAS DE MANTECA", "LIBRITOS DE GRASA", "BIZCOCHUELO DE VAINILLA 50 X 80",
    "MEDIALUNAS DE MANTECA", "MEDIALUNAS PARA RELLENAR", "PAN DE HAMBURGUESA", "PEBETE",
    "SANDWICH DE MIGA TRIPLE", "PIONONO", "PREPIZZA", "PAN ARABE", "PAN DE MOLDE CON SEMILLA", "PAN CIABATTA"
  ];
  const DEFAULTS = { autoCrop: true, filterMode: "mejorado", periodMode: "semanal", bridgeUrl: "", bridgeKey: "", hiRes: true, catalog: DEFAULT_CATALOG.join("\n"), lecturaPreguntar: true };
  let settings = { ...DEFAULTS };
  let stream = null;
  let stillOk = null;               // null = sin probar; true/false = se puede / no se puede la foto de máxima resolución
  let pages = [];                   // {id, blob, w, h, url, thumbUrl, status: processing|ok|error, busy}
  let nextPageId = 1;
  let epoch = 0;                    // sube cada vez que se vacía todo: lo que estaba en proceso se descarta
  let grabbing = false;
  let suspended = false;            // true mientras se está en la sección "Órdenes de compra": la cámara queda apagada
  let saving = false;               // true mientras se guardan las fotos como "PDF guardado"

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toBlob = (canvas, q = 0.9) => new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
  const anyDialogOpen = () => !!document.querySelector("dialog[open]");

  // ---------- Ajustes (se guardan en el navegador) ----------
  function loadSettings() {
    try {
      const st = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("settings") || "{}") };
      ["apiKey", "sensitivity", "decimals", "catalogVersion", "lector", "zones"].forEach((k) => delete st[k]);   // restos de versiones anteriores
      ["visionUsage", "rlV8", "despDia", "totals"].forEach((k) => localStorage.removeItem(k));          // lector de remitos (v8.0-8.2) y tabla suelta
      return st;
    } catch (e) { return { ...DEFAULTS }; }
  }
  function persistSettings() { try { localStorage.setItem("settings", JSON.stringify(settings)); } catch (e) { /* nada */ } }
  const catalogList = () => String(settings.catalog || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

  let statusTimer = null;
  function setStatus(msg, ms = 3500) {
    statusEl.textContent = msg;
    clearTimeout(statusTimer);
    if (ms) statusTimer = setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ""; }, ms);
  }

  // Avisos y preguntas propios de la página. Los cuadros nativos (alert/confirm) congelan la cámara en el
  // celular, por eso no se usan.
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

  // ---------- Cámara ----------
  async function startCamera(deviceId) {
    if (suspended) return;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    cameraMsg.classList.remove("hidden");
    cameraMsg.textContent = "Iniciando cámara…";
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 3840 }, height: { ideal: 2160 },
          // en el celular se usa la cámara trasera salvo que se elija otra
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } })
        },
        audio: false
      });
      if (suspended) { stream.getTracks().forEach((t) => t.stop()); stream = null; return; }   // se cambió de sección mientras arrancaba
      stillOk = null;
      video.srcObject = stream;
      await video.play();
      cameraMsg.classList.add("hidden");
      await listCameras();
    } catch (err) {
      console.error(err);
      let m = "No se pudo acceder a la cámara.";
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) m = "Este navegador no permite usar la cámara en esta página (hace falta abrirla con https://). Igual podés usar “Subir foto”.";
      else if (err.name === "NotAllowedError") m = "Permiso de cámara denegado. Tocá el candado o el ícono de la cámara junto a la dirección de la página (en iPhone: Ajustes > Safari > Cámara) y permitila. Igual podés usar “Subir foto”.";
      else if (err.name === "NotFoundError") m = "No se encontró ninguna cámara conectada.";
      else if (err.name === "NotReadableError") m = "La cámara está siendo usada por otra aplicación. Cerrala e intentá de nuevo.";
      cameraMsg.textContent = m;
    }
  }

  // Si el video se congeló o la cámara se cortó (por ejemplo después de un aviso o de volver a la app), se reinicia sola.
  let camBadTicks = 0, camRestarting = false;
  function cameraAlive() {
    const t = stream && stream.getVideoTracks()[0];
    return !!(t && t.readyState === "live" && !video.paused && !video.ended && video.readyState >= 2);
  }
  async function ensureCamera() {
    if (suspended || camRestarting) return;
    if (cameraAlive()) return;
    camRestarting = true;
    try {
      if (stream && stream.getVideoTracks()[0] && stream.getVideoTracks()[0].readyState === "live") { await video.play(); }
      else await startCamera(cameraSelect.value || undefined);
    } catch (e) { try { await startCamera(cameraSelect.value || undefined); } catch (e2) { /* nada */ } }
    camRestarting = false;
  }
  function watchCamera() {
    if (suspended || document.hidden) return;
    if (cameraAlive()) { camBadTicks = 0; return; }
    if (++camBadTicks >= 5) { camBadTicks = 0; ensureCamera(); }   // ~2 segundos con la cámara trabada
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) ensureCamera(); });

  async function listCameras() {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    const track = stream && stream.getVideoTracks()[0];
    const current = track && track.getSettings().deviceId;
    cameraSelect.innerHTML = "";
    devices.forEach((d, i) => {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || "Cámara " + (i + 1);
      if (d.deviceId === current) o.selected = true;
      cameraSelect.appendChild(o);
    });
  }
  cameraSelect.addEventListener("change", () => startCamera(cameraSelect.value));

  // ---------- Detección del papel ----------
  const probe = document.createElement("canvas");
  const pctx = probe.getContext("2d", { willReadFrequently: true });

  // Devuelve las 4 esquinas [TL,TR,BR,BL] en píxeles de la fuente, o null.
  function detectQuad(source, sw, sh) {
    const s = Math.min(1, 480 / Math.max(sw, sh));
    probe.width = Math.max(2, Math.round(sw * s));
    probe.height = Math.max(2, Math.round(sh * s));
    pctx.drawImage(source, 0, 0, probe.width, probe.height);
    const det = Crop.detectPaper(pctx.getImageData(0, 0, probe.width, probe.height));
    if (!det) return null;
    const kx = sw / probe.width, ky = sh / probe.height;
    return det.quad.map((p) => ({ x: p.x * kx, y: p.y * ky }));
  }

  // ---------- Recuadro en vivo de la hoja ----------
  let stable = 0, pillState = "";
  function setPill(state) {
    if (pillState === state) return;
    pillState = state;
    detectPill.hidden = !state;
    detectPill.className = "pill" + (state === "ok" ? " ok" : "");
    detectPill.textContent = state === "ok" ? "Hoja detectada · lista para sacar la foto" : state === "search" ? "Buscando la hoja…" : "";
  }

  function drawLive(quad) {
    const cw = videoWrap.clientWidth, ch = videoWrap.clientHeight;
    if (overlay.width !== cw) overlay.width = cw;
    if (overlay.height !== ch) overlay.height = ch;
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, cw, ch);
    if (!autoCropChk.checked || !video.videoWidth) { setPill(""); return; }
    if (!quad) { setPill("search"); return; }
    const vw = video.videoWidth, vh = video.videoHeight;
    const sc = Math.min(cw / vw, ch / vh);
    const ox = (cw - vw * sc) / 2, oy = (ch - vh * sc) / 2;
    ctx.beginPath();
    quad.forEach((p, i) => { const x = ox + p.x * sc, y = oy + p.y * sc; if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.fillStyle = "rgba(46,158,91,.14)"; ctx.fill();
    ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.strokeStyle = "#2ee06b"; ctx.stroke();
    setPill("ok");
  }

  function liveLoop() {
    try {
      if (!suspended && autoCropChk.checked && video.videoWidth && !document.hidden) {
        if (!grabbing) {
          const quad = detectQuad(video, video.videoWidth, video.videoHeight);
          stable = quad ? stable + 1 : 0;
          drawLive(quad);
        }
      } else {
        stable = 0;
        drawLive(null);
      }
      watchCamera();
    } catch (e) { /* ignorar errores de un cuadro */ }
    setTimeout(liveLoop, 400);
  }

  // ---------- Imágenes ----------
  // En celulares (sobre todo iPhone) la memoria es limitada: se trabaja con imágenes algo más chicas.
  const IS_MOBILE = (window.matchMedia && matchMedia("(pointer: coarse)").matches) || /iPhone|iPad|Android/i.test(navigator.userAgent);
  const MAX_SIDE = IS_MOBILE ? 2400 : 2800;     // tamaño máximo de cada página del PDF
  const START_SIDE = IS_MOBILE ? 3200 : 4200;   // tamaño máximo con el que se empieza a trabajar

  function fitCanvas(src, maxSide) {
    const sc = Math.min(1, maxSide / Math.max(src.width, src.height));
    if (sc >= 1) return src;
    const c = document.createElement("canvas");
    c.width = Math.round(src.width * sc);
    c.height = Math.round(src.height * sc);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function canvasFromImageData(out) {
    const c = document.createElement("canvas");
    c.width = out.width; c.height = out.height;
    c.getContext("2d").putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
    return c;
  }
  const imageDataOf = (c) => c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);

  function applyFilter(canvas, mode) {
    if (mode === "color") return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    const img = ctx.getImageData(0, 0, w, h);
    if (mode === "mejorado") { Enhance.enhance(img); ctx.putImageData(img, 0, 0); return; }
    const d = img.data;
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) gray[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    if (mode === "gris") {
      let min = 255, max = 0;
      for (let p = 0; p < gray.length; p++) { if (gray[p] < min) min = gray[p]; if (gray[p] > max) max = gray[p]; }
      const range = Math.max(1, max - min);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const v = ((gray[p] - min) * 255) / range;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    } else {   // documento: blanco y negro con umbral adaptativo
      const W = w + 1;
      const integral = new Float64Array(W * (h + 1));
      for (let y = 1; y <= h; y++) {
        let rowSum = 0;
        for (let x = 1; x <= w; x++) {
          rowSum += gray[(y - 1) * w + (x - 1)];
          integral[y * W + x] = integral[(y - 1) * W + x] + rowSum;
        }
      }
      const r = Math.max(8, Math.floor(Math.min(w, h) / 16));
      const t = 0.92;
      for (let y = 0; y < h; y++) {
        const y1 = Math.max(0, y - r), y2 = Math.min(h - 1, y + r);
        for (let x = 0; x < w; x++) {
          const x1 = Math.max(0, x - r), x2 = Math.min(w - 1, x + r);
          const area = (x2 - x1 + 1) * (y2 - y1 + 1);
          const sum = integral[(y2 + 1) * W + (x2 + 1)] - integral[y1 * W + (x2 + 1)] - integral[(y2 + 1) * W + x1] + integral[y1 * W + x1];
          const v = gray[y * w + x] * area < sum * t ? 0 : 255;
          const i = (y * w + x) * 4;
          d[i] = d[i + 1] = d[i + 2] = v;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  async function rotateBlob(blob, deg) {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    const swap = deg === 90 || deg === 270;
    c.width = swap ? bmp.height : bmp.width; c.height = swap ? bmp.width : bmp.height;
    const ctx = c.getContext("2d");
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    if (bmp.close) bmp.close();
    return { canvas: c, blob: await toBlob(c, 0.9) };
  }

  // Abre una imagen respetando la orientación EXIF (las fotos de celular vienen "acostadas").
  async function fileToCanvas(f) {
    const c = document.createElement("canvas");
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: "from-image" });
      c.width = bmp.width; c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      return c;
    } catch (e) { /* se prueba con <img> */ }
    const url = URL.createObjectURL(f);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("imagen inválida")); i.src = url; });
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      return c;
    } finally { URL.revokeObjectURL(url); }
  }

  // Recorta el papel (con perspectiva corregida) y aplica el modo de imagen elegido.
  async function buildPage(source, mode, autoCrop) {
    const full = fitCanvas(source, START_SIDE);
    let work, cropped = false;
    if (autoCrop) {
      const quad = detectQuad(full, full.width, full.height);
      if (quad) { work = canvasFromImageData(Crop.warp(imageDataOf(full), quad, MAX_SIDE)); cropped = true; }
      else work = fitCanvas(full, MAX_SIDE);
    } else work = fitCanvas(full, MAX_SIDE);
    await sleep(0);
    if (work === source || work === full) {            // no tocar el original
      const c = document.createElement("canvas"); c.width = work.width; c.height = work.height;
      c.getContext("2d").drawImage(work, 0, 0); work = c;
    }
    applyFilter(work, mode);
    await sleep(0);
    const blob = await toBlob(work, 0.9);
    const thumb = await toBlob(fitCanvas(work, 440), 0.8);
    return { blob, thumb, w: work.width, h: work.height, cropped };
  }

  // ---------- Cola de trabajo: se puede seguir sacando fotos mientras se procesan ----------
  const MAX_PENDING = 3;
  const queue = [];
  let working = false;
  const pending = () => queue.length + (working ? 1 : 0);

  function updateBusyUI() {
    const full = pending() >= MAX_PENDING;
    captureBtn.disabled = grabbing || full;
    captureLabel.textContent = full ? "Procesando…" : "Sacar foto";
  }

  function enqueue(job) {
    const page = { id: nextPageId++, status: "processing", url: "", thumbUrl: "" };
    pages.push(page);
    queue.push({ ...job, page, epoch, mode: filterSelect.value, autoCrop: autoCropChk.checked });
    syncCards();
    thumbs.scrollTop = thumbs.scrollHeight;
    pump();
    updateBusyUI();
    return page;
  }

  async function pump() {
    if (working) return;
    working = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        if (job.epoch !== epoch || !pages.includes(job.page)) { job.source = null; continue; }   // se vació todo mientras esperaba
        try {
          const source = job.file ? await fileToCanvas(job.file) : job.source;
          job.source = null;
          const r = await buildPage(source, job.mode, job.autoCrop);
          if (job.epoch !== epoch || !pages.includes(job.page)) continue;
          const p = job.page;
          p.blob = r.blob; p.w = r.w; p.h = r.h; p.cropped = r.cropped;
          p.url = URL.createObjectURL(r.blob); p.thumbUrl = URL.createObjectURL(r.thumb);
          p.status = "ok";
        } catch (e) {
          console.error("No se pudo procesar la foto:", e);
          if (pages.includes(job.page)) job.page.status = "error";
        }
        if (job.epoch === epoch) syncCards();
        updateBusyUI();
        await sleep(0);
      }
    } finally {
      working = false;
      updateBusyUI();
    }
  }

  // ---------- Captura con la cámara ----------
  async function takeStill() {
    const track = stream && stream.getVideoTracks()[0];
    if (!track || typeof ImageCapture === "undefined" || stillOk === false) return null;
    try {
      const ic = new ImageCapture(track);
      const caps = await ic.getPhotoCapabilities();
      const mw = caps.imageWidth && caps.imageWidth.max, mh = caps.imageHeight && caps.imageHeight.max;
      if (!mw || !mh || mw <= video.videoWidth * 1.15) { stillOk = false; return null; }
      const blob = await ic.takePhoto({ imageWidth: mw, imageHeight: mh });
      stillOk = true;
      return await createImageBitmap(blob);
    } catch (e) {
      console.warn("Foto de máxima resolución no disponible, se usa el video:", e);
      stillOk = false;
      return null;
    }
  }

  async function grabFrame() {
    if (settings.hiRes) {
      const bmp = await takeStill();
      if (bmp) {
        const c = document.createElement("canvas");
        c.width = bmp.width; c.height = bmp.height;
        c.getContext("2d").drawImage(bmp, 0, 0);
        if (bmp.close) bmp.close();
        return c;
      }
    }
    const c = document.createElement("canvas");
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    return c;
  }

  async function capture() {
    if (!stream || !video.videoWidth) { setStatus("La cámara todavía no está lista."); return; }
    if (grabbing) return;
    if (pending() >= MAX_PENDING) { setStatus("Un momento: se están procesando las fotos anteriores."); return; }
    grabbing = true; updateBusyUI();
    flash.classList.add("on");
    setTimeout(() => flash.classList.remove("on"), 60);
    const e0 = epoch;
    try {
      const frame = await grabFrame();
      if (e0 === epoch) { enqueue({ source: frame }); setStatus("Foto " + pages.length + " tomada ✔", 2500); }
    } catch (err) {
      console.error(err);
      setStatus("No se pudo sacar la foto: " + err.message, 6000);
    } finally {
      grabbing = false; updateBusyUI();
    }
  }
  captureBtn.addEventListener("click", capture);

  // ---------- Subir fotos (botón o arrastrar y soltar) ----------
  function importFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    const bad = [], good = [];
    for (const f of files) {
      if (f.type === "application/pdf" || /\.pdf$/i.test(f.name) || !(/^image\//.test(f.type) || /\.(jpe?g|png|webp|bmp|gif)$/i.test(f.name))) bad.push(f.name);
      else good.push(f);
    }
    good.forEach((f) => enqueue({ file: f }));
    if (good.length) setStatus(good.length + (good.length === 1 ? " foto agregada" : " fotos agregadas") + " · procesando…", 5000);
    if (bad.length) {
      showMessage("No se pudieron abrir estos archivos:\n• " + bad.join("\n• ") +
        "\n\nSolo se aceptan imágenes (JPG, PNG, WEBP). Si la foto es HEIC, convertila a JPG; si es un PDF, exportá sus páginas como imágenes.");
    }
  }
  uploadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { importFiles(fileInput.files); fileInput.value = ""; });

  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  // El resaltado se apaga solo si deja de llegar "dragover" (así nunca queda pegado).
  let dragTimer = null;
  function resetDragState() { clearTimeout(dragTimer); dragTimer = null; pagesPanel.classList.remove("dragover"); }
  function markDrag() { pagesPanel.classList.add("dragover"); clearTimeout(dragTimer); dragTimer = setTimeout(resetDragState, 250); }
  window.addEventListener("dragenter", (e) => { if (suspended || !hasFiles(e)) return; e.preventDefault(); markDrag(); });
  window.addEventListener("dragover", (e) => { if (suspended || !hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; markDrag(); });
  window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) resetDragState(); });
  window.addEventListener("dragend", resetDragState);
  window.addEventListener("drop", (e) => {
    if (suspended || !hasFiles(e)) return;
    e.preventDefault();
    resetDragState();
    importFiles(e.dataTransfer.files);
  });

  window.addEventListener("keydown", (e) => {
    if (suspended) return;
    const tag = (e.target && e.target.tagName) || "";
    if (e.code === "Space" && !anyDialogOpen() && !["SELECT", "INPUT", "TEXTAREA", "BUTTON"].includes(tag)) { e.preventDefault(); capture(); }
  });

  // ---------- Lista de remitos ----------
  const cards = new Map();
  const ICON = (n) => '<svg class="i"><use href="#i-' + n + '"/></svg>';

  function cardFor(page) {
    let c = cards.get(page.id);
    if (c) return c;
    c = document.createElement("div");
    c.className = "thumb";
    c.innerHTML =
      '<div class="imgbox"><img alt=""><span class="num"></span><div class="state"></div></div>' +
      '<div class="tools"><button type="button" class="rot" title="Girar 90°">' + ICON("rotate") + 'Girar</button>' +
      '<button type="button" class="del" title="Eliminar">' + ICON("trash") + 'Quitar</button></div>';
    c.querySelector(".imgbox").addEventListener("click", () => { if (page.status === "ok" && page.url) openPreview(page); });
    c.querySelector(".del").addEventListener("click", () => removePage(page));
    c.querySelector(".rot").addEventListener("click", () => rotatePage(page));
    cards.set(page.id, c);
    return c;
  }

  function fillCard(c, page, i) {
    c.classList.toggle("processing", page.status !== "ok");
    c.querySelector(".num").textContent = i + 1;
    const img = c.querySelector("img");
    const src = page.thumbUrl || "";
    if (img.getAttribute("src") !== src) { if (src) img.src = src; else img.removeAttribute("src"); }
    img.hidden = !src;
    const st = c.querySelector(".state");
    if (page.status === "processing" || page.busy) { st.hidden = false; st.innerHTML = '<div class="spinner"></div><span>' + (page.busy ? "Girando…" : "Procesando…") + "</span>"; }
    else if (page.status === "error") { st.hidden = false; st.innerHTML = "<span>No se pudo procesar.<br>Quitala y probá de nuevo.</span>"; }
    else st.hidden = true;
    c.querySelector(".rot").disabled = page.status !== "ok" || !!page.busy;
  }

  function syncCards() {
    const ids = new Set(pages.map((p) => p.id));
    for (const [id, c] of cards) if (!ids.has(id)) { c.remove(); cards.delete(id); }
    pages.forEach((p, i) => {
      const c = cardFor(p);
      if (thumbs.children[i] !== c) thumbs.insertBefore(c, thumbs.children[i] || null);
      fillCard(c, p, i);
    });
    countEl.textContent = pages.length;
    emptyEl.hidden = pages.length > 0;
    thumbs.hidden = pages.length === 0;
    saveBtn.disabled = pages.length === 0 || saving;
    clearBtn.disabled = pages.length === 0 || saving;
  }

  function releasePage(p) {
    if (p.url) URL.revokeObjectURL(p.url);
    if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
    p.url = p.thumbUrl = ""; p.blob = null;
  }

  function removePage(p) {
    const i = pages.indexOf(p);
    if (i < 0) return;
    pages.splice(i, 1);
    releasePage(p);
    syncCards();
  }

  async function rotatePage(p) {
    if (p.status !== "ok" || p.busy) return;
    p.busy = true; syncCards();
    const myEpoch = epoch;
    try {
      const r = await rotateBlob(p.blob, 90);
      const thumb = await toBlob(fitCanvas(r.canvas, 440), 0.8);
      if (myEpoch !== epoch || !pages.includes(p)) return;
      URL.revokeObjectURL(p.url); URL.revokeObjectURL(p.thumbUrl);
      p.blob = r.blob; [p.w, p.h] = [r.canvas.width, r.canvas.height];
      p.url = URL.createObjectURL(r.blob); p.thumbUrl = URL.createObjectURL(thumb);
    } catch (e) { console.error(e); setStatus("No se pudo girar la foto.", 4000); }
    p.busy = false;
    if (myEpoch === epoch) syncCards();
  }

  function openPreview(p) {
    previewImg.src = p.url;
    previewDialog.showModal();
  }
  $("previewClose").addEventListener("click", () => previewDialog.close());
  previewDialog.addEventListener("click", (e) => { if (e.target === previewDialog) previewDialog.close(); });

  function clearAll(msg) {
    epoch++;                                   // lo que estaba procesándose se descarta
    queue.length = 0;
    pages.forEach(releasePage);
    pages = [];
    grabbing = false;
    resetDragState();
    stable = 0;
    syncCards();
    updateBusyUI();
    ensureCamera();
    setStatus(msg || "Todo borrado. Podés seguir escaneando.", msg ? 7000 : 4000);
  }

  clearBtn.addEventListener("click", async () => {
    if (await askConfirm("¿Borrar todas las fotos que todavía no guardaste?", "Sí, vaciar todo", "Cancelar")) clearAll();
  });

  // ---------- Período (semanal / quincenal) ----------
  // Se calcula con la fecha en que se guardan las fotos; en cada PDF guardado se puede cambiar después.
  const currentPeriod = () => Period.forDate(settings.periodMode === "quincenal" ? "quincenal" : "semanal", new Date());
  const periodSeg = $("periodSeg"), periodText = $("periodText"), periodSub = $("periodSub");

  function refreshPeriod() {
    const p = currentPeriod();
    periodSeg.querySelectorAll(".seg-btn").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === p.mode)));
    periodText.textContent = "día " + Period.text(p);
    periodSub.textContent = "(" + p.label + ")";
  }
  periodSeg.addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn");
    if (!b) return;
    settings.periodMode = b.dataset.mode;
    persistSettings();
    refreshPeriod();
  });
  setInterval(refreshPeriod, 60000);

  // ---------- Guardar PDF ----------
  // Las fotos se guardan como un "PDF guardado" (lotes.js): en la cuenta del usuario si hay sesión, si no en este
  // dispositivo. La tabla de recepciones y el envío al borrador de Gmail se hacen después, desde cualquier dispositivo.
  function setSaving(on, label) {
    saving = on;
    saveLabel.textContent = label || "Guardar PDF";
    saveBtn.classList.toggle("is-busy", on);
    syncCards();
  }
  saveBtn.addEventListener("click", async () => {
    if (saving) return;
    if (!window.Lotes) { await showMessage("Falta el archivo lotes.js: volvé a cargar la página."); return; }
    if (pages.some((p) => p.status === "processing")) { await showMessage("Todavía se están procesando algunas fotos. Esperá unos segundos y probá de nuevo."); return; }
    const errors = pages.filter((p) => p.status === "error").length;
    if (errors && !(await askConfirm(errors + " foto(s) no se pudieron procesar y no se van a guardar.\n\n¿Seguir igual?", "Seguir", "Cancelar"))) return;
    const ok = pages.filter((p) => p.status === "ok" && p.blob);
    if (!ok.length) { await showMessage("No hay fotos listas para guardar."); return; }
    const e0 = epoch;
    setSaving(true, "Guardando…");
    try {
      const shots = ok.map((p) => ({ blob: p.blob, w: p.w, h: p.h, thumb: p.thumbUrl }));
      const r = await window.Lotes.saveBatch(shots, currentPeriod(), (done, total) => setSaving(true, "Subiendo " + done + " de " + total + "…"));
      setSaving(false);
      if (e0 === epoch) clearAll(r.cloud
        ? "Guardado ✔ Está en “PDF guardados”: completá la tabla de recepciones cuando quieras, desde acá o desde la computadora."
        : "Guardado en este dispositivo ✔ " + (r.reason || ""));
      if (!r.cloud && r.reason) await showMessage("El PDF quedó guardado en este dispositivo, pero no se pudo subir a tu cuenta:\n\n" + r.reason + "\n\nSe vuelve a intentar solo; también podés tocar “Subir” en la lista.");
      if (window.Lotes.offerReading) window.Lotes.offerReading(r.id).catch((e) => console.warn("Lectura con el iPhone:", e));
    } catch (e) {
      console.error(e);
      setSaving(false);
      await showMessage("No se pudo guardar: " + (e.message || e) + "\n\nLas fotos siguen en pantalla; probá de nuevo.");
    }
  });

  // ---------- Puente a Google Drive y Gmail (lo usa lotes.js para enviar) ----------
  const bridgeReady = () => /^https:\/\/script\.google(usercontent)?\.com\//.test(String(settings.bridgeUrl || "").trim()) && !!String(settings.bridgeKey || "").trim();
  const blobToBase64 = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = () => rej(new Error("No se pudo leer el PDF"));
    r.readAsDataURL(blob);
  });
  // Envía el PDF al puente. Lanza Error con un mensaje claro si algo falla.
  async function sendToBridge(pdfBlob, name, oc, period) {
    const MAX = 17 * 1024 * 1024;                      // Gmail admite ~25 MB; en base64 el archivo crece un tercio
    if (pdfBlob.size > MAX) throw new Error("El PDF pesa " + (pdfBlob.size / 1048576).toFixed(1) + " MB y es demasiado grande para adjuntarlo en Gmail (máximo ~17 MB). Dividí el lote en dos.");
    const now = new Date();
    const payload = {
      key: String(settings.bridgeKey).trim(), oc, filename: name, year: period.year, month: period.month,
      subject: Period.emailSubject(oc, period), body: Period.emailBody(oc, period, now),
      pdf: await blobToBase64(pdfBlob)
    };
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 180000);
    let res;
    try {
      res = await fetch(String(settings.bridgeUrl).trim(), { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload), redirect: "follow", signal: ctl.signal });
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "El envío tardó demasiado (probá con mejor señal)." : "No se pudo completar la conexión con Google (revisá internet y la dirección del puente). Si dudás, mirá Drive y los Borradores de Gmail antes de reintentar, por si el envío sí llegó.");
    } finally { clearTimeout(timer); }
    let out;
    try { out = await res.json(); }
    catch (e) { throw new Error("El puente no respondió como se esperaba. Revisá que esté implementado con acceso “Cualquier persona”."); }
    if (!out.ok) throw new Error(out.error === "Clave incorrecta" ? "La clave del puente no coincide (revisá Ajustes)." : "El puente informó: " + (out.error || "error desconocido"));
    return out;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Arma el PDF de un lote: pages = [{bytes (JPEG), w, h}], rows = [{name, qtyText}]
  const b64ToBytes = (b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  function makePdf(data, name, oc, period, rows) {
    const L = window.LOGO_PDF;
    const d = new Date(), pad = (n) => String(n).padStart(2, "0");
    return buildPdf(data, {
      company: COMPANY, title: name, oc, periodText: Period.text(period),
      date: pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear(),
      logo: L ? { bytes: b64ToBytes(L.b64), w: L.w, h: L.h } : null,
      summary: rows.length ? { rows, note: "Cantidades ingresadas manualmente por el responsable de recepción." } : null
    });
  }

  // ---------- Ajustes ----------
  settingsBtn.addEventListener("click", () => {
    catalogInput.value = settings.catalog;
    hiResChk.checked = !!settings.hiRes;
    $("lecturaChk").checked = settings.lecturaPreguntar !== false;
    $("bridgeUrl").value = settings.bridgeUrl || "";
    $("bridgeKey").value = settings.bridgeKey || "";
    $("bridgeMsg").textContent = ""; $("bridgeMsg").className = "bridge-msg";
    settingsDialog.showModal();
  });
  $("cancelSettings").addEventListener("click", () => settingsDialog.close());
  $("saveSettings").addEventListener("click", () => {
    settings.catalog = catalogInput.value;
    settings.hiRes = hiResChk.checked;
    settings.lecturaPreguntar = $("lecturaChk").checked;
    settings.bridgeUrl = $("bridgeUrl").value.trim();
    settings.bridgeKey = $("bridgeKey").value.trim();
    persistSettings();
    settingsDialog.close();
    if (window.RemitosApp.onSettings) { try { window.RemitosApp.onSettings(); } catch (e) { /* nada */ } }
  });
  $("bridgeTest").addEventListener("click", async () => {
    const url = $("bridgeUrl").value.trim(), key = $("bridgeKey").value.trim(), msg = $("bridgeMsg");
    const show = (t, good) => { msg.textContent = t; msg.className = "bridge-msg " + (good ? "good" : "bad"); };
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) { show("La dirección debe empezar con https://script.google.com/…", false); return; }
    if (!key) { show("Falta la clave.", false); return; }
    show("Probando…", true);
    try {
      const res = await fetch(url + (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(key), { redirect: "follow" });
      const out = await res.json();
      if (out.ok) show("Conexión correcta ✔ (borradores para " + out.destinatario + ")", true);
      else show(out.error === "Clave incorrecta" ? "La clave no coincide con la del puente." : "El puente respondió: " + out.error, false);
    } catch (e) { show("No se pudo conectar. Revisá internet, la dirección y que el acceso sea “Cualquier persona”.", false); }
  });
  $("resetCatalog").addEventListener("click", () => { catalogInput.value = DEFAULT_CATALOG.join("\n"); });
  filterSelect.addEventListener("change", () => { settings.filterMode = filterSelect.value; persistSettings(); });
  autoCropChk.addEventListener("change", () => { settings.autoCrop = autoCropChk.checked; persistSettings(); drawLive(null); });

  window.addEventListener("beforeunload", () => { if (stream) stream.getTracks().forEach((t) => t.stop()); });

  // ---------- Inicio ----------
  $("verTag").textContent = "v" + APP_VERSION;
  $("verLabel").textContent = APP_VERSION;
  settings = loadSettings();
  if (settings.periodMode !== "quincenal") settings.periodMode = "semanal";
  refreshPeriod();
  persistSettings();                 // limpia del navegador los datos de versiones anteriores
  autoCropChk.checked = settings.autoCrop !== false;
  filterSelect.value = settings.filterMode || "mejorado";
  syncCards();
  updateBusyUI();
  suspended = true;                  // la cámara se enciende recién con la sesión iniciada (auth.js)
  liveLoop();

  // ---------- Cambio de sección (lo usa oc.js) ----------
  // Las dos secciones son excluyentes: al entrar a "Órdenes de compra" se apaga la cámara y se desactivan
  // la barra espaciadora y el arrastrar-y-soltar de remitos; al volver, la cámara se enciende de nuevo.
  window.RemitosApp = {
    setActive(on) {
      if (on) { if (!suspended) return; suspended = false; startCamera(cameraSelect.value || undefined); }
      else {
        suspended = true;
        if (stream) stream.getTracks().forEach((t) => t.stop());
        stream = null; video.srcObject = null; resetDragState();
      }
    },
    askConfirm, showMessage, setStatus,
    // para los PDF guardados (lotes.js)
    pages: () => pages, catalog: catalogList, settings: () => settings, defaultCatalog: () => DEFAULT_CATALOG.slice(),
    bridgeReady, sendToBridge, downloadBlob, makePdf, toBlob, fitCanvas,
    onSettings: null
  };
  // Con el ingreso de usuarios (auth.js), la cámara espera a que la cuenta esté habilitada.
  if (window.LAGAuth) window.LAGAuth.onUnlock(() => window.RemitosApp.setActive(true));
  else window.RemitosApp.setActive(true);

  // ---------- Instalación como aplicación ----------
  const installBtn = $("installBtn");
  let installEvt = null;
  const isStandalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installEvt = e;
    if (!isStandalone()) installBtn.hidden = false;
  });
  window.addEventListener("appinstalled", () => { installBtn.hidden = true; installEvt = null; setStatus("Aplicación instalada ✔", 5000); });
  installBtn.addEventListener("click", async () => {
    if (!installEvt) return;
    installEvt.prompt();
    try { await installEvt.userChoice; } catch (e) { /* nada */ }
    installEvt = null; installBtn.hidden = true;
  });
  // iPhone/iPad no ofrecen el botón automático: se muestra el cartel con los pasos.
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent) && !isStandalone()) {
    installBtn.hidden = false;
    installBtn.addEventListener("click", () => {
      if (!installEvt) showMessage("Para instalarla en el iPhone:\n\n1. Abrí esta página en Safari.\n2. Tocá el botón Compartir (el cuadrado con la flecha hacia arriba).\n3. Elegí “Añadir a pantalla de inicio”.\n4. Tocá “Añadir”.");
    });
  }
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("No se pudo registrar el service worker:", e));
  }
})();
