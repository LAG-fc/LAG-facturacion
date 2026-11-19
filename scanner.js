(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const video = $("video"), overlay = $("overlay"), videoWrap = $("videoWrap");
  const cameraSelect = $("cameraSelect"), filterSelect = $("filterSelect"), autoCropChk = $("autoCrop");
  const captureBtn = $("captureBtn"), saveBtn = $("saveBtn"), clearBtn = $("clearBtn"), settingsBtn = $("settingsBtn");
  const thumbs = $("thumbs"), countEl = $("count"), emptyEl = $("empty");
  const statusEl = $("status"), cameraMsg = $("cameraMsg"), flash = $("flash");
  const totalsTable = $("totalsTable"), totalsEmpty = $("totalsEmpty");
  const nameDialog = $("nameDialog"), nameForm = $("nameForm"), nameInput = $("nameInput"), cancelName = $("cancelName");
  const settingsDialog = $("settingsDialog"), keyInput = $("keyInput"), keyMsg = $("keyMsg");
  const qtyModeSelect = $("qtyModeSelect"), sensSelect = $("sensSelect");
  const uploadBtn = $("uploadBtn"), fileInput = $("fileInput"), pagesPanel = $("pagesPanel");
  const catalogInput = $("catalogInput"), hiResChk = $("hiResChk");
  const editDialog = $("editDialog"), editRowsEl = $("editRows"), editImg = $("editImg"), editNum = $("editNum"), editErr = $("editErr");

  const DEFAULTS = {
    apiKey: "", qtyMode: "primero", sensitivity: "normal", autoCrop: true,
    filterMode: "mejorado", hiRes: true, catalog: OCR.DEFAULT_CATALOG.join("\n")
  };
  let settings = { ...DEFAULTS };
  let stream = null;
  let capturing = false;
  let pages = [];   // {id, blob, ocrBlob, w, h, url, status: reading|ok|alert|manual, rows, runId}
  let nextPageId = 1;

  // ---------- Ajustes (se guardan en el navegador) ----------
  function loadSettings() {
    try { return Promise.resolve({ ...DEFAULTS, ...JSON.parse(localStorage.getItem("settings") || "{}") }); }
    catch (e) { return Promise.resolve({ ...DEFAULTS }); }
  }
  function persistSettings() {
    try { localStorage.setItem("settings", JSON.stringify(settings)); } catch (e) { /* nada */ }
  }

  function setStatus(msg, ms = 3500) {
    statusEl.textContent = msg;
    if (ms) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ""; }, ms);
  }
  const anyDialogOpen = () => nameDialog.open || settingsDialog.open || editDialog.open;
  const toBlob = (canvas, q = 0.92) => new Promise((res) => canvas.toBlob(res, "image/jpeg", q));

  // ---------- Cámara ----------
  async function startCamera(deviceId) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
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

  // Contorno verde en vivo sobre la cámara: muestra qué se va a recortar.
  function drawOverlay(quad) {
    const cw = videoWrap.clientWidth, ch = videoWrap.clientHeight;
    if (overlay.width !== cw) overlay.width = cw;
    if (overlay.height !== ch) overlay.height = ch;
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, cw, ch);
    if (!quad || !video.videoWidth) return;
    const vw = video.videoWidth, vh = video.videoHeight;
    const sc = Math.min(cw / vw, ch / vh);
    const ox = (cw - vw * sc) / 2, oy = (ch - vh * sc) / 2;
    ctx.beginPath();
    quad.forEach((p, i) => { const x = ox + p.x * sc, y = oy + p.y * sc; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.fillStyle = "rgba(46,158,91,.18)";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#2ee06b";
    ctx.stroke();
  }

  function liveLoop() {
    try {
      if (autoCropChk.checked && video.videoWidth && !capturing && !document.hidden) {
        drawOverlay(detectQuad(video, video.videoWidth, video.videoHeight));
      } else {
        drawOverlay(null);
      }
    } catch (e) { /* ignorar errores de un cuadro */ }
    setTimeout(liveLoop, 400);
  }

  // ---------- Filtros (idéntico a la versión 1) ----------
  function applyFilter(canvas, mode) {
    if (mode === "color") return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      gray[p] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    }
    if (mode === "gris") {
      let min = 255, max = 0;
      for (let p = 0; p < gray.length; p++) { if (gray[p] < min) min = gray[p]; if (gray[p] > max) max = gray[p]; }
      const range = Math.max(1, max - min);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const v = ((gray[p] - min) * 255) / range;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    } else {
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

  // ---------- Procesamiento de imágenes (cámara y fotos subidas) ----------
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

  function cloneCanvas(src) {
    const c = document.createElement("canvas");
    c.width = src.width; c.height = src.height;
    c.getContext("2d", { willReadFrequently: true }).drawImage(src, 0, 0);
    return c;
  }

  function canvasFromImageData(out) {
    const c = document.createElement("canvas");
    c.width = out.width; c.height = out.height;
    c.getContext("2d").putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
    return c;
  }

  // Recorta el papel, mejora la imagen y la agrega como una página nueva.
  async function addPageFromCanvas(source) {
    const full = fitCanvas(source, START_SIDE);
    let work, note = "";
    if (autoCropChk.checked) {
      const quad = detectQuad(full, full.width, full.height);
      if (quad) {
        const src = full.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, full.width, full.height);
        work = canvasFromImageData(Crop.warp(src, quad, MAX_SIDE));
      } else {
        work = fitCanvas(full, MAX_SIDE);
        note = " · sin recorte (no se distinguió el borde del papel)";
      }
    } else {
      work = fitCanvas(full, MAX_SIDE);
    }

    // "Color mejorado": se usa para leer el texto y es la imagen del PDF en el modo por defecto.
    const enh = cloneCanvas(work);
    const ectx = enh.getContext("2d", { willReadFrequently: true });
    const imgData = ectx.getImageData(0, 0, enh.width, enh.height);
    Enhance.enhance(imgData);
    ectx.putImageData(imgData, 0, 0);
    const ocrBlob = await toBlob(enh, 0.92);

    let blob = ocrBlob;
    const mode = filterSelect.value;
    if (mode === "color") {
      blob = await toBlob(work, 0.92);
    } else if (mode !== "mejorado") {
      const c2 = cloneCanvas(enh);
      applyFilter(c2, mode);
      blob = await toBlob(c2, 0.92);
    }

    const page = {
      id: nextPageId++, blob, ocrBlob, w: work.width, h: work.height,
      url: URL.createObjectURL(blob), status: "reading", rows: [], runId: 0
    };
    pages.push(page);
    render();
    thumbs.scrollTop = thumbs.scrollHeight;
    runOcr(page);
    return { page, note, w: work.width, h: work.height };
  }

  // ---------- Captura con la cámara ----------
  let stillOk = null;   // null = sin probar, true/false = se puede / no se puede sacar foto de máxima resolución

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

  function setBusy(b) {
    capturing = b;
    captureBtn.disabled = b;
    uploadBtn.disabled = b;
  }

  async function capture() {
    if (!stream || !video.videoWidth) { setStatus("La cámara todavía no está lista."); return; }
    if (capturing) return;
    setBusy(true);
    flash.classList.add("on");
    setTimeout(() => flash.classList.remove("on"), 60);
    try {
      setStatus("Procesando foto…", 0);
      const frame = await grabFrame();
      const r = await addPageFromCanvas(frame);
      setStatus("Foto " + pages.length + " guardada ✔ (" + r.w + "×" + r.h + ")" + r.note, 7000);
    } catch (err) {
      console.error(err);
      setStatus("No se pudo sacar la foto: " + err.message, 6000);
    } finally {
      setBusy(false);
    }
  }
  captureBtn.addEventListener("click", capture);

  // ---------- Subir fotos (botón o arrastrar y soltar) ----------
  // Abre una imagen respetando la orientación EXIF (las fotos de celular vienen "acostadas"
  // y llevan anotado cuánto girarlas). Si el navegador no lo soporta, usa <img>, que lo aplica solo.
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

  async function importFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    if (capturing) { setStatus("Esperá a que termine la foto en curso."); return; }
    setBusy(true);
    const failed = [];
    let ok = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setStatus("Procesando " + (i + 1) + " de " + files.length + "…", 0);
        if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) { failed.push(f.name); continue; }
        try {
          const c = await fileToCanvas(f);
          await addPageFromCanvas(c);
          ok++;
        } catch (e) {
          console.error("No se pudo abrir", f.name, e);
          failed.push(f.name);
        }
        await new Promise((r) => setTimeout(r, 0));   // deja respirar a la pantalla
      }
    } finally {
      setBusy(false);
    }
    setStatus(ok ? ok + " foto(s) cargada(s) ✔" : "", 6000);
    if (failed.length) {
      alert("No se pudieron abrir estos archivos:\n• " + failed.join("\n• ") +
        "\n\nSolo se aceptan imágenes (JPG, PNG, WEBP). Si la foto es HEIC, convertila a JPG; si es un PDF, exportá sus páginas como imágenes.");
    }
  }

  uploadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { importFiles(fileInput.files); fileInput.value = ""; });

  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  let dragDepth = 0;
  pagesPanel.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; pagesPanel.classList.add("dragover"); });
  pagesPanel.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  pagesPanel.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) pagesPanel.classList.remove("dragover"); });
  pagesPanel.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    dragDepth = 0;
    pagesPanel.classList.remove("dragover");
    importFiles(e.dataTransfer.files);
  });
  // Si sueltan una foto en cualquier otro lugar de la ventana, también se carga (y el navegador no la abre).
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => { if (hasFiles(e)) { e.preventDefault(); if (!anyDialogOpen()) importFiles(e.dataTransfer.files); } });
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (e.code === "Space" && !anyDialogOpen() && tag !== "SELECT" && tag !== "INPUT" && tag !== "TEXTAREA") {
      e.preventDefault();
      capture();
    }
  });

  // ---------- Lectura de texto ----------
  let ocrActive = 0;
  const ocrWaiting = [];
  const ocrAcquire = () => new Promise((res) => { if (ocrActive < 3) { ocrActive++; res(); } else ocrWaiting.push(res); });
  const ocrRelease = () => { const next = ocrWaiting.shift(); if (next) next(); else ocrActive--; };
  const catalogList = () => String(settings.catalog || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

  async function runOcr(page) {
    const myRun = ++page.runId;
    page.rows = [];
    if (!settings.apiKey) { page.status = "alert"; render(); return; }
    page.status = "reading";
    render();
    await ocrAcquire();
    try {
      if (page.runId !== myRun || !pages.includes(page) || page.status === "manual") return;
      const resp = await OCR.recognize(page.ocrBlob, settings.apiKey);
      if (page.runId !== myRun || !pages.includes(page) || page.status === "manual") return;
      const { words, width, rotation } = OCR.extractWords(resp);
      if (rotation) {
        // la foto estaba de costado o al revés: se endereza la imagen (ya se corrigieron las posiciones)
        await rotatePageBy(page, rotation);
        if (page.runId !== myRun || !pages.includes(page)) return;
      }
      const { rows } = OCR.buildRows(words, {
        width, qtyMode: settings.qtyMode, minConf: OCR.minConfFor(settings.sensitivity), catalog: catalogList()
      });
      page.rows = rows;
      page.status = rows.length && !rows.some((r) => r.low) ? "ok" : "alert";
    } catch (err) {
      console.error("Lectura de texto falló:", err);
      if (page.runId !== myRun || page.status === "manual") return;
      page.rows = [];
      page.status = "alert";
    } finally {
      ocrRelease();
    }
    render();
  }

  // ---------- Lista de páginas ----------
  function render() {
    const scroll = thumbs.scrollTop;
    thumbs.innerHTML = "";
    pages.forEach((p, i) => {
      const card = document.createElement("div");
      card.className = "thumb";
      card.innerHTML =
        '<span class="num">' + (i + 1) + "</span>" +
        (p.status === "reading" ? '<span class="badge reading">⏳</span>' : "") +
        (p.status === "alert" ? '<button class="badge alert">⚠</button>' : "") +
        '<img alt="Página ' + (i + 1) + '">' +
        '<div class="tools"><button class="btn small edit">✏ Datos</button>' +
        '<button class="btn small rot">⟳ Girar</button>' +
        '<button class="btn small danger del">🗑</button></div>';
      card.querySelector("img").src = p.url;
      card.querySelector("img").addEventListener("click", () => openEditor(p));
      card.querySelector(".edit").addEventListener("click", () => openEditor(p));
      const alertBtn = card.querySelector(".badge.alert");
      if (alertBtn) alertBtn.addEventListener("click", () => openEditor(p));
      card.querySelector(".del").addEventListener("click", () => {
        URL.revokeObjectURL(p.url);
        pages.splice(pages.indexOf(p), 1);
        render();
      });
      card.querySelector(".rot").addEventListener("click", () => rotatePage(p));
      thumbs.appendChild(card);
    });
    thumbs.scrollTop = scroll;
    countEl.textContent = pages.length;
    emptyEl.style.display = pages.length ? "none" : "block";
    saveBtn.disabled = pages.length === 0;
    renderTotals();
  }

  function currentTotals() { return OCR.aggregate(pages.map((p) => p.rows)); }

  function renderTotals() {
    const totals = currentTotals();
    totalsTable.innerHTML = "";
    for (const t of totals) {
      const tr = document.createElement("tr");
      const a = document.createElement("td"), b = document.createElement("td");
      a.textContent = t.name;
      b.textContent = OCR.formatQty(t.qty);
      tr.append(a, b);
      totalsTable.appendChild(tr);
    }
    totalsEmpty.style.display = totals.length ? "none" : "block";
  }

  // Gira una imagen "deg" grados en sentido horario (90, 180 o 270).
  async function rotateBlob(blob, deg) {
    deg = deg || 90;
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    const swap = deg === 90 || deg === 270;
    c.width = swap ? bmp.height : bmp.width; c.height = swap ? bmp.width : bmp.height;
    const ctx = c.getContext("2d");
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    if (bmp.close) bmp.close();
    return toBlob(c, 0.92);
  }

  // "rotation" es lo que informa la lectura: 90 = hay que girar 90° a la izquierda (= 270° horario).
  async function rotatePageBy(p, rotation) {
    const cw = rotation === 90 ? 270 : rotation === 270 ? 90 : 180;
    p.blob = await rotateBlob(p.blob, cw);
    p.ocrBlob = await rotateBlob(p.ocrBlob, cw);
    if (cw !== 180) [p.w, p.h] = [p.h, p.w];
    URL.revokeObjectURL(p.url);
    p.url = URL.createObjectURL(p.blob);
  }

  async function rotatePage(p) {
    await rotatePageBy(p, 270);   // 270 = girar 90° a la derecha
    if (p.status === "manual") render();
    else runOcr(p);   // con la hoja girada se vuelve a leer
  }

  clearBtn.addEventListener("click", () => {
    if (!pages.length) return;
    if (confirm("¿Borrar todas las fotos tomadas?")) {
      pages.forEach((p) => URL.revokeObjectURL(p.url));
      pages = [];
      render();
    }
  });

  // ---------- Edición manual de datos ----------
  let editing = null;
  let editRows = [];

  function openEditor(page) {
    editing = page;
    editRows = page.rows.map((r) => ({
      name: r.name || "",
      qtyText: r.qty !== null && r.qty !== undefined ? OCR.formatQty(r.qty) : "",
      low: !!r.low
    }));
    if (!editRows.length) editRows.push({ name: "", qtyText: "", low: false });
    editNum.textContent = String(pages.indexOf(page) + 1);
    editImg.src = page.url;
    editErr.textContent = "";
    renderEditRows();
    editDialog.showModal();
  }

  function renderEditRows() {
    editRowsEl.innerHTML = "";
    editRows.forEach((row, i) => {
      const div = document.createElement("div");
      div.className = "erow" + (row.low ? " low" : "");
      const warn = document.createElement("span");
      warn.className = "warn";
      warn.textContent = row.low ? "⚠" : "";
      const nameIn = document.createElement("input");
      nameIn.type = "text"; nameIn.value = row.name; nameIn.placeholder = "Producto";
      const qtyIn = document.createElement("input");
      qtyIn.type = "text"; qtyIn.value = row.qtyText; qtyIn.placeholder = "0"; qtyIn.inputMode = "decimal";
      const del = document.createElement("button");
      del.type = "button"; del.textContent = "✕";
      const touched = () => { row.low = false; div.classList.remove("low"); warn.textContent = ""; };
      nameIn.addEventListener("input", () => { row.name = nameIn.value; nameIn.classList.remove("bad"); touched(); });
      qtyIn.addEventListener("input", () => { row.qtyText = qtyIn.value; qtyIn.classList.remove("bad"); touched(); });
      del.addEventListener("click", () => { editRows.splice(i, 1); renderEditRows(); });
      div.append(warn, nameIn, qtyIn, del);
      editRowsEl.appendChild(div);
    });
  }

  $("addRowBtn").addEventListener("click", () => {
    editRows.push({ name: "", qtyText: "", low: false });
    renderEditRows();
    const inputs = editRowsEl.querySelectorAll("input");
    if (inputs.length >= 2) inputs[inputs.length - 2].focus();
    editRowsEl.scrollTop = editRowsEl.scrollHeight;
  });

  $("cancelEdit").addEventListener("click", () => editDialog.close());

  $("saveEdit").addEventListener("click", () => {
    const out = [];
    let bad = false;
    const inputs = editRowsEl.querySelectorAll(".erow");
    editRows.forEach((row, i) => {
      const name = row.name.trim(), qtyText = row.qtyText.trim();
      if (!name && !qtyText) return;                       // fila vacía: se descarta
      const qty = OCR.parseManualQty(qtyText);
      const nameOk = !!name, qtyOk = qty !== null;
      if (!nameOk) inputs[i].children[1].classList.add("bad");
      if (!qtyOk) inputs[i].children[2].classList.add("bad");
      if (!nameOk || !qtyOk) { bad = true; return; }
      out.push({ name, qty, qtyText, conf: 1, lineText: name, low: false });
    });
    if (bad) { editErr.textContent = "Completá producto y una cantidad válida (por ejemplo 12 o 2,5) en las filas marcadas."; return; }
    editing.rows = out;
    editing.status = "manual";
    editing.runId++;          // descarta cualquier lectura que siga en curso
    editDialog.close();
    render();
  });

  // ---------- Ajustes ----------
  settingsBtn.addEventListener("click", () => {
    keyInput.value = settings.apiKey;
    qtyModeSelect.value = settings.qtyMode;
    sensSelect.value = settings.sensitivity;
    catalogInput.value = settings.catalog;
    hiResChk.checked = !!settings.hiRes;
    keyMsg.textContent = "";
    settingsDialog.showModal();
  });
  $("cancelSettings").addEventListener("click", () => settingsDialog.close());
  $("saveSettings").addEventListener("click", () => {
    settings.apiKey = keyInput.value.trim();
    settings.qtyMode = qtyModeSelect.value;
    settings.sensitivity = sensSelect.value;
    settings.catalog = catalogInput.value;
    settings.hiRes = hiResChk.checked;
    persistSettings();
    settingsDialog.close();
    updateKeyHint();
  });
  $("resetCatalog").addEventListener("click", () => { catalogInput.value = OCR.DEFAULT_CATALOG.join("\n"); });
  filterSelect.addEventListener("change", () => { settings.filterMode = filterSelect.value; persistSettings(); });
  autoCropChk.addEventListener("change", () => { settings.autoCrop = autoCropChk.checked; persistSettings(); });

  $("testKeyBtn").addEventListener("click", async () => {
    const key = keyInput.value.trim();
    if (!key) { keyMsg.textContent = "Pegá primero la clave."; return; }
    keyMsg.textContent = "Probando…";
    try {
      const c = document.createElement("canvas");
      c.width = 320; c.height = 120;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 320, 120);
      ctx.fillStyle = "#000"; ctx.font = "40px sans-serif"; ctx.fillText("Prueba 123", 20, 70);
      await OCR.recognize(await toBlob(c, 0.9), key);
      keyMsg.textContent = "✔ La clave funciona.";
    } catch (err) {
      keyMsg.textContent = "✖ " + err.message + " — revisá que la clave esté bien copiada, que la API Cloud Vision esté habilitada y la facturación activa.";
    }
  });

  function updateKeyHint() {
    if (!settings.apiKey) setStatus("Falta la clave de lectura de texto: tocá ⚙ Ajustes para cargarla.", 0);
    else if (statusEl.textContent.startsWith("Falta la clave")) setStatus("");
  }

  // ---------- Guardar PDF ----------
  function defaultName() {
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    return "Remitos " + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + "." + p(d.getMinutes());
  }

  saveBtn.addEventListener("click", () => {
    if (pages.some((p) => p.status === "reading")) {
      alert("Todavía se están leyendo algunas páginas (⏳). Esperá unos segundos y probá de nuevo.");
      return;
    }
    const unverified = pages.filter((p) => p.status === "alert").length;
    if (unverified && !confirm(
      "Hay " + unverified + " página(s) con el símbolo ⚠ (datos sin verificar).\n\n" +
      "Sus cantidades se suman tal como se leyeron, o no se suman si no se leyó nada.\n\n" +
      "¿Guardar el PDF igual?\n(Cancelar para revisarlas con “✏ Datos”.)")) return;
    nameInput.value = defaultName();
    nameDialog.showModal();
    nameInput.focus();
    nameInput.select();
  });
  cancelName.addEventListener("click", () => nameDialog.close());

  nameForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    let name = nameInput.value.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\.pdf$/i, "");
    if (!name) name = defaultName();
    nameDialog.close();
    setStatus("Generando PDF…", 0);
    try {
      const data = [];
      for (const p of pages) data.push({ bytes: new Uint8Array(await p.blob.arrayBuffer()), w: p.w, h: p.h });

      const totals = currentTotals();
      const unverified = pages.filter((p) => p.status === "alert").length;
      const d = new Date(), pad = (n) => String(n).padStart(2, "0");
      const summary = totals.length ? {
        title: "Total recepcionado",
        subtitle: "Fecha: " + pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + d.getFullYear() +
                  "  ·  Remitos escaneados: " + pages.length,
        note: unverified ? "* Incluye datos sin verificar de " + unverified + " página(s)." : "",
        rows: totals.map((t) => ({ name: t.name, qtyText: OCR.formatQty(t.qty) }))
      } : null;

      const pdf = buildPdf(data, summary);
      const url = URL.createObjectURL(pdf);
      const a = document.createElement("a");
      a.href = url;
      a.download = name + ".pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setStatus("PDF “" + name + ".pdf” guardado en Descargas ✔", 6000);
      if (confirm("PDF guardado en Descargas.\n\n¿Querés vaciar las fotos para empezar un remito nuevo?")) {
        pages.forEach((p) => URL.revokeObjectURL(p.url));
        pages = [];
        render();
      }
    } catch (err) {
      console.error(err);
      setStatus("Error al generar el PDF: " + err.message, 8000);
    }
  });

  window.addEventListener("beforeunload", () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  });

  // ---------- Inicio ----------
  (async () => {
    settings = await loadSettings();
    autoCropChk.checked = settings.autoCrop !== false;
    filterSelect.value = settings.filterMode || "mejorado";
    render();
    updateKeyHint();
    startCamera();
    liveLoop();
  })();

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
      if (!installEvt) alert("Para instalarla en el iPhone:\n\n1. Abrí esta página en Safari.\n2. Tocá el botón Compartir (el cuadrado con la flecha hacia arriba).\n3. Elegí “Añadir a pantalla de inicio”.\n4. Tocá “Añadir”.");
    });
  }
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("No se pudo registrar el service worker:", e));
  }
})();
