(() => {
  "use strict";
  const APP_VERSION = "7.3";
  const COMPANY = "LAG PANIFICADOS SRL";
  const $ = (id) => document.getElementById(id);

  const video = $("video"), overlay = $("overlay"), videoWrap = $("videoWrap"), detectPill = $("detectPill");
  const cameraSelect = $("cameraSelect"), filterSelect = $("filterSelect"), autoCropChk = $("autoCrop");
  const captureBtn = $("captureBtn"), captureLabel = $("captureLabel"), uploadBtn = $("uploadBtn"), fileInput = $("fileInput");
  const saveBtn = $("saveBtn"), clearBtn = $("clearBtn"), settingsBtn = $("settingsBtn"), totalsBtn = $("totalsBtn");
  const thumbs = $("thumbs"), countEl = $("count"), emptyEl = $("empty"), pagesPanel = $("pagesPanel");
  const statusEl = $("status"), cameraMsg = $("cameraMsg"), flash = $("flash"), totalsInfo = $("totalsInfo");
  const settingsDialog = $("settingsDialog"), catalogInput = $("catalogInput"), hiResChk = $("hiResChk");
  const msgDialog = $("msgDialog"), msgText = $("msgText"), msgOk = $("msgOk"), msgCancel = $("msgCancel");
  const totalsDialog = $("totalsDialog"), totalsForm = $("totalsForm"), totalsRows = $("totalsRows"), totalsErr = $("totalsErr");
  const totalsOk = $("totalsOk"), ocField = $("ocField"), ocInput = $("ocInput"), totalsHint = $("totalsHint");
  const previewDialog = $("previewDialog"), previewImg = $("previewImg");

  const DEFAULT_CATALOG = [
    "PAN MIGNON BLANCO", "PAN MIGNON DE SALVADO", "PAN FRANCES", "PAN MIGNON BLANCO SIN SAL",
    "PAN DE SALVADO SIN SAL", "FIGACITAS DE MANTECA", "LIBRITOS DE GRASA", "BIZCOCHUELO DE VAINILLA 50 X 80",
    "MEDIALUNAS DE MANTECA", "MEDIALUNAS PARA RELLENAR", "PAN DE HAMBURGUESA", "PEBETE",
    "SANDWICH DE MIGA TRIPLE", "PIONONO", "PREPIZZA", "PAN ARABE", "PAN DE MOLDE CON SEMILLA", "PAN CIABATTA"
  ];
  const DEFAULTS = { autoCrop: true, filterMode: "mejorado", periodMode: "semanal", bridgeUrl: "", bridgeKey: "", hiRes: true, catalog: DEFAULT_CATALOG.join("\n") };
  let settings = { ...DEFAULTS };
  let stream = null;
  let stillOk = null;               // null = sin probar; true/false = se puede / no se puede la foto de máxima resolución
  let pages = [];                   // {id, blob, w, h, url, thumbUrl, status: processing|ok|error, busy}
  let nextPageId = 1;
  let epoch = 0;                    // sube cada vez que se vacía todo: lo que estaba en proceso se descarta
  let grabbing = false;
  let suspended = false;            // true mientras se está en la sección "Órdenes de compra": la cámara queda apagada

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const toBlob = (canvas, q = 0.9) => new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
  const anyDialogOpen = () => !!document.querySelector("dialog[open]");

  // ---------- Ajustes (se guardan en el navegador) ----------
  function loadSettings() {
    try {
      const st = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("settings") || "{}") };
      ["apiKey", "sensitivity", "decimals", "catalogVersion"].forEach((k) => delete st[k]);   // restos de versiones anteriores
      localStorage.removeItem("visionUsage");
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
    saveBtn.disabled = pages.length === 0;
    clearBtn.disabled = pages.length === 0 && !totalsFilledCount();
    updateTotalsInfo();
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

  function clearAll() {
    epoch++;                                   // lo que estaba procesándose se descarta
    queue.length = 0;
    pages.forEach(releasePage);
    pages = [];
    totalsState = { values: {}, extras: [], oc: "" };
    persistTotals();
    grabbing = false;
    resetDragState();
    stable = 0;
    syncCards();
    updateBusyUI();
    ensureCamera();
    setStatus("Todo borrado. Podés seguir escaneando.", 4000);
  }

  clearBtn.addEventListener("click", async () => {
    if (await askConfirm("¿Borrar todas las fotos y las cantidades cargadas?", "Sí, vaciar todo", "Cancelar")) clearAll();
  });

  // ---------- Tabla de recepciones (cantidades totales) ----------
  let totalsState = loadTotals();
  let totalsMode = "edit";
  function loadTotals() {
    try { const t = JSON.parse(localStorage.getItem("totals") || "{}"); return { values: t.values || {}, extras: Array.isArray(t.extras) ? t.extras : [], oc: Period.cleanOc(t.oc) }; }
    catch (e) { return { values: {}, extras: [], oc: "" }; }
  }
  function persistTotals() { try { localStorage.setItem("totals", JSON.stringify(totalsState)); } catch (e) { /* nada */ } }

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

  function totalsFilledCount() {
    let n = 0;
    for (const name of catalogList()) if (String(totalsState.values[name] || "").trim()) n++;
    for (const x of totalsState.extras) if (String(x.text || "").trim() && String(x.name || "").trim()) n++;
    return n;
  }
  function updateTotalsInfo() {
    const n = totalsFilledCount();
    const base = n ? n + (n === 1 ? " producto con cantidad" : " productos con cantidad") : "Sin cantidades cargadas";
    totalsInfo.textContent = (totalsState.oc ? "OC " + totalsState.oc + " · " : "") + base;
    totalsInfo.classList.toggle("filled", n > 0);
  }

  // ---------- Período (semanal / quincenal) y nombre del PDF ----------
  const currentPeriod = () => Period.forDate(settings.periodMode === "quincenal" ? "quincenal" : "semanal", new Date());
  const periodSeg = $("periodSeg"), periodText = $("periodText"), periodSub = $("periodSub");
  const fileNamePreview = $("fileNamePreview"), periodHint = $("periodHint");
  const pdfName = () => Period.fileName(totalsState.oc || "", currentPeriod());

  function refreshPeriod() {
    const p = currentPeriod();
    periodSeg.querySelectorAll(".seg-btn").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === p.mode)));
    periodText.textContent = "día " + Period.text(p);
    periodSub.textContent = "(" + p.label + ")";
    periodHint.textContent = "· período " + Period.text(p);
    $("destHint").textContent = bridgeReady()
      ? "Se sube a Drive: " + Period.folderPath(totalsState.oc || "número", p) + " y queda un borrador en Gmail."
      : "Puente a Drive/Gmail sin configurar: el PDF se descarga en el dispositivo.";
    fileNamePreview.textContent = "REMITOS_" + (totalsState.oc || "OC") + "_" + p.from + "_al_" + p.to;
  }
  periodSeg.addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn");
    if (!b) return;
    settings.periodMode = b.dataset.mode;
    persistSettings();
    refreshPeriod();
  });
  setInterval(refreshPeriod, 60000);

  function calcLabel(row, input) {
    const q = parseQty(input.value);
    let lab = row.querySelector(".calc");
    if (q.ok && q.isSum) {
      if (!lab) { lab = document.createElement("div"); lab.className = "calc"; row.appendChild(lab); }
      lab.textContent = "= " + formatQty(q.value);
    } else if (lab) lab.remove();
  }

  function buildTotalsRows() {
    totalsRows.innerHTML = "";
    const mkQty = (get, set, placeholder) => {
      const inp = document.createElement("input");
      inp.type = "text"; inp.className = "q"; inp.inputMode = "decimal"; inp.autocomplete = "off"; inp.placeholder = placeholder || "—";
      inp.value = get();
      inp.addEventListener("input", () => { set(inp.value); inp.classList.remove("bad"); totalsErr.textContent = ""; calcLabel(inp.parentElement, inp); updateTotalsInfo(); });
      inp.addEventListener("blur", () => { const q = parseQty(inp.value); inp.classList.toggle("bad", q.ok === false); });
      return inp;
    };
    catalogList().forEach((name, i) => {
      const row = document.createElement("div");
      row.className = "tt-row";
      const n = document.createElement("div"); n.className = "n"; n.textContent = i + 1;
      const nm = document.createElement("div"); nm.className = "name"; nm.textContent = name;
      const inp = mkQty(() => totalsState.values[name] || "", (v) => { totalsState.values[name] = v; persistTotals(); });
      row.append(n, nm, inp);
      calcLabel(row, inp);
      totalsRows.appendChild(row);
    });
    totalsState.extras.forEach((x, i) => {
      const row = document.createElement("div");
      row.className = "tt-row extra";
      const rm = document.createElement("button"); rm.type = "button"; rm.className = "rm"; rm.title = "Quitar"; rm.innerHTML = ICON("x");
      rm.addEventListener("click", () => { totalsState.extras.splice(i, 1); persistTotals(); buildTotalsRows(); updateTotalsInfo(); });
      const nm = document.createElement("input"); nm.type = "text"; nm.className = "name-in"; nm.placeholder = "Nombre del producto"; nm.value = x.name || "";
      nm.addEventListener("input", () => { x.name = nm.value; persistTotals(); updateTotalsInfo(); });
      const inp = mkQty(() => x.text || "", (v) => { x.text = v; persistTotals(); });
      row.append(rm, nm, inp);
      calcLabel(row, inp);
      totalsRows.appendChild(row);
    });
  }

  function openTotals(mode) {
    totalsMode = mode;
    const save = mode === "save";
    ocField.hidden = !save;
    totalsOk.textContent = save ? (bridgeReady() ? "Guardar y enviar" : "Guardar PDF") : "Aceptar";
    totalsHint.textContent = save
      ? "Cargá la cantidad total recibida de cada producto antes de guardar. Los que dejes vacíos no aparecen en el PDF."
      : "Cargá la cantidad total recibida de cada producto. Quedan guardadas hasta que vacíes todo.";
    if (save) ocInput.value = totalsState.oc || "";
    refreshPeriod();
    totalsErr.textContent = "";
    buildTotalsRows();
    totalsDialog.showModal();
    totalsRows.scrollTop = 0;
    const first = totalsRows.querySelector("input.q");
    if (save) { ocInput.focus(); ocInput.select(); } else if (first) first.focus();
  }

  // Enter pasa al siguiente casillero (en vez de cerrar el cuadro)
  totalsDialog.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.target.tagName !== "INPUT") return;
    e.preventDefault();
    const inputs = [...totalsDialog.querySelectorAll("input")].filter((x) => !x.closest("[hidden]"));
    const k = inputs.indexOf(e.target);
    if (k >= 0 && k < inputs.length - 1) { inputs[k + 1].focus(); inputs[k + 1].select && inputs[k + 1].select(); }
    else totalsOk.focus();
  });

  ocInput.addEventListener("input", () => {
    const c = Period.cleanOc(ocInput.value);
    if (c !== ocInput.value) ocInput.value = c;
    ocInput.classList.remove("bad");
    totalsState.oc = c; persistTotals(); refreshPeriod(); updateTotalsInfo();
    totalsErr.textContent = "";
  });

  $("addExtraBtn").addEventListener("click", () => {
    totalsState.extras.push({ name: "", text: "" });
    persistTotals(); buildTotalsRows();
    const names = totalsRows.querySelectorAll("input.name-in");
    if (names.length) { names[names.length - 1].focus(); totalsRows.scrollTop = totalsRows.scrollHeight; }
  });
  $("clearTotalsBtn").addEventListener("click", () => {
    totalsState = { values: {}, extras: [], oc: totalsState.oc };   // la OC no se borra
    persistTotals(); buildTotalsRows(); updateTotalsInfo();
  });
  $("totalsCancel").addEventListener("click", () => totalsDialog.close());
  totalsBtn.addEventListener("click", () => openTotals("edit"));

  // Filas listas para el PDF; devuelve null si hay datos inválidos
  function collectTotals() {
    const rows = [];
    let bad = 0, noName = 0;
    const inputs = [...totalsRows.querySelectorAll(".tt-row")];
    const mark = (idx, isBad) => { const q = inputs[idx] && inputs[idx].querySelector("input.q"); if (q) q.classList.toggle("bad", isBad); };
    const names = catalogList();
    names.forEach((name, i) => {
      const q = parseQty(totalsState.values[name]);
      if (q.empty) { mark(i, false); return; }
      if (!q.ok) { bad++; mark(i, true); return; }
      rows.push({ name, qtyText: formatQty(q.value) });
    });
    totalsState.extras.forEach((x, k) => {
      const q = parseQty(x.text), nm = String(x.name || "").trim();
      const idx = names.length + k;
      if (q.empty && !nm) return;
      if (!q.empty && !q.ok) { bad++; mark(idx, true); return; }
      if (q.empty) { bad++; mark(idx, true); return; }
      if (!nm) { noName++; return; }
      mark(idx, false);
      rows.push({ name: nm, qtyText: formatQty(q.value) });
    });
    if (bad || noName) {
      totalsErr.textContent = bad ? "Revisá las cantidades marcadas en rojo (por ejemplo 12 o 2,5)." : "Falta el nombre de un producto agregado.";
      return null;
    }
    return rows;
  }

  totalsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rows = collectTotals();
    if (rows === null) return;
    if (totalsMode === "edit") { totalsDialog.close(); updateTotalsInfo(); return; }
    if (!totalsState.oc) {
      ocInput.classList.add("bad"); ocInput.focus();
      totalsErr.textContent = "Escribí el número de la orden de compra (OC) para poder nombrar el PDF.";
      return;
    }
    const period = currentPeriod();
    const name = Period.fileName(totalsState.oc, period);
    if (!rows.length) {
      totalsDialog.close();
      if (!(await askConfirm("No cargaste ninguna cantidad, así que el PDF saldrá sin la tabla de recepciones.\n\n¿Guardarlo igual?", "Guardar igual", "Volver"))) { openTotals("save"); return; }
    } else totalsDialog.close();
    await savePdf(name, rows, period);
  });

  // ---------- Guardar PDF ----------
  const b64ToBytes = (b64) => { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };

  saveBtn.addEventListener("click", async () => {
    if (pages.some((p) => p.status === "processing")) { await showMessage("Todavía se están procesando algunas fotos. Esperá unos segundos y probá de nuevo."); return; }
    const errors = pages.filter((p) => p.status === "error").length;
    if (errors && !(await askConfirm(errors + " foto(s) no se pudieron procesar y no van a estar en el PDF.\n\n¿Seguir igual?", "Seguir", "Cancelar"))) return;
    if (!pages.some((p) => p.status === "ok")) { await showMessage("No hay fotos listas para guardar."); return; }
    openTotals("save");
  });

  // ---------- Puente a Google Drive y Gmail ----------
  const bridgeReady = () => /^https:\/\/script\.google(usercontent)?\.com\//.test(String(settings.bridgeUrl || "").trim()) && !!String(settings.bridgeKey || "").trim();
  const blobToBase64 = (blob) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = () => rej(new Error("No se pudo leer el PDF"));
    r.readAsDataURL(blob);
  });
  // Envía el PDF al puente. Lanza Error con un mensaje claro si algo falla.
  async function sendToBridge(pdfBlob, name, period) {
    const MAX = 17 * 1024 * 1024;                      // Gmail admite ~25 MB; en base64 el archivo crece un tercio
    if (pdfBlob.size > MAX) throw new Error("El PDF pesa " + (pdfBlob.size / 1048576).toFixed(1) + " MB y es demasiado grande para adjuntarlo en Gmail (máximo ~17 MB). Dividí el lote en dos.");
    const now = new Date();
    const payload = {
      key: String(settings.bridgeKey).trim(), oc: totalsState.oc, filename: name, year: period.year, month: period.month,
      subject: Period.emailSubject(totalsState.oc, period), body: Period.emailBody(totalsState.oc, period, now),
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

  let sending = false;
  async function savePdf(name, rows, period) {
    if (sending) return;
    sending = true; saveBtn.disabled = true;
    setStatus("Generando PDF…", 0);
    try {
      const ok = pages.filter((p) => p.status === "ok" && p.blob);
      const data = [];
      for (const p of ok) data.push({ bytes: new Uint8Array(await p.blob.arrayBuffer()), w: p.w, h: p.h });
      const L = window.LOGO_PDF;
      const d = new Date(), pad = (n) => String(n).padStart(2, "0");
      const pdf = buildPdf(data, {
        company: COMPANY, title: name, oc: totalsState.oc, periodText: Period.text(period),
        date: pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear(),
        logo: L ? { bytes: b64ToBytes(L.b64), w: L.w, h: L.h } : null,
        summary: rows.length ? { rows, note: "Cantidades ingresadas manualmente por el responsable de recepción." } : null
      });
      let sent = null, failMsg = "";
      if (bridgeReady()) {
        setStatus("Enviando a Google Drive y Gmail…", 0);
        try { sent = await sendToBridge(pdf, name, period); } catch (e) { failMsg = e.message; }
      }
      if (sent) {
        setStatus("Enviado ✔ " + name + ".pdf", 8000);
        const q = "PDF guardado en Drive:\n" + sent.carpeta + (sent.reemplazado ? "\n(reemplazó un PDF con el mismo nombre; el anterior está en la papelera de Drive)" : "") +
          "\n\nBorrador creado en Gmail para revisar y enviar.\n\n¿Querés vaciar las fotos y las cantidades para empezar un lote nuevo?";
        if (await askConfirm(q, "Sí, vaciar", "No, dejarlas")) clearAll();
      } else {
        // Sin puente o con error: se descarga en el dispositivo para no perder el trabajo
        downloadBlob(pdf, name + ".pdf");
        setStatus("PDF “" + name + ".pdf” guardado en Descargas", 7000);
        const why = bridgeReady() ? "No se pudo enviar a Drive/Gmail: " + failMsg + "\n\nEl PDF se descargó en este dispositivo para que no lo pierdas." : "El PDF se descargó en este dispositivo (el puente a Drive/Gmail no está configurado en Ajustes).";
        if (await askConfirm(why + "\n\n¿Querés vaciar las fotos y las cantidades para empezar un lote nuevo?", "Sí, vaciar", "No, dejarlas")) clearAll();
      }
    } catch (err) {
      console.error(err);
      setStatus("Error al generar el PDF: " + err.message, 8000);
    } finally {
      sending = false; saveBtn.disabled = !pages.some((p) => p.status === "ok");
    }
  }

  // ---------- Ajustes ----------
  settingsBtn.addEventListener("click", () => {
    catalogInput.value = settings.catalog;
    hiResChk.checked = !!settings.hiRes;
    $("bridgeUrl").value = settings.bridgeUrl || "";
    $("bridgeKey").value = settings.bridgeKey || "";
    $("bridgeMsg").textContent = ""; $("bridgeMsg").className = "bridge-msg";
    settingsDialog.showModal();
  });
  $("cancelSettings").addEventListener("click", () => settingsDialog.close());
  $("saveSettings").addEventListener("click", () => {
    settings.catalog = catalogInput.value;
    settings.hiRes = hiResChk.checked;
    settings.bridgeUrl = $("bridgeUrl").value.trim();
    settings.bridgeKey = $("bridgeKey").value.trim();
    persistSettings();
    settingsDialog.close();
    updateTotalsInfo();
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
  updateTotalsInfo();
  persistSettings();                 // limpia del navegador los datos de la lectura de texto de versiones anteriores
  autoCropChk.checked = settings.autoCrop !== false;
  filterSelect.value = settings.filterMode || "mejorado";
  syncCards();
  updateBusyUI();
  startCamera();
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
    askConfirm, showMessage
  };

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
