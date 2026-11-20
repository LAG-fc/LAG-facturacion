(() => {
  "use strict";
  const APP_VERSION = "4.3";
  document.addEventListener("DOMContentLoaded", () => { const a = document.getElementById("verTag"), b = document.getElementById("verLabel"); if (a) a.textContent = "v" + APP_VERSION; if (b) b.textContent = APP_VERSION; });
  const $ = (id) => document.getElementById(id);
  const video = $("video"), overlay = $("overlay"), videoWrap = $("videoWrap");
  const cameraSelect = $("cameraSelect"), filterSelect = $("filterSelect"), autoCropChk = $("autoCrop");
  const captureBtn = $("captureBtn"), saveBtn = $("saveBtn"), clearBtn = $("clearBtn"), settingsBtn = $("settingsBtn");
  const thumbs = $("thumbs"), countEl = $("count"), emptyEl = $("empty");
  const statusEl = $("status"), cameraMsg = $("cameraMsg"), flash = $("flash");
  const totalsTable = $("totalsTable"), totalsEmpty = $("totalsEmpty");
  const nameDialog = $("nameDialog"), nameForm = $("nameForm"), nameInput = $("nameInput"), cancelName = $("cancelName");
  const settingsDialog = $("settingsDialog"), keyInput = $("keyInput"), keyMsg = $("keyMsg");
  const sensSelect = $("sensSelect");
  const uploadBtn = $("uploadBtn"), fileInput = $("fileInput"), pagesPanel = $("pagesPanel");
  const catalogInput = $("catalogInput"), hiResChk = $("hiResChk");
  const editWrap = $("editWrap");
  const editDialog = $("editDialog"), editRowsEl = $("editRows"), editImg = $("editImg"), editNum = $("editNum"), editErr = $("editErr");

  const DEFAULTS = {
    apiKey: "", sensitivity: "normal", autoCrop: true,
    filterMode: "mejorado", hiRes: true, catalog: OCR.DEFAULT_CATALOG.join("\n"), catalogVersion: 5
  };
  let settings = { ...DEFAULTS };
  let stream = null;
  let capturing = false;
  let pages = [];   // {id, blob, ocrBlob, w, h, url, status: reading|ok|alert|manual, rows, runId}
  let nextPageId = 1;

  // ---------- Ajustes (se guardan en el navegador) ----------
  function loadSettings() {
    try {
      const st = { ...DEFAULTS, ...JSON.parse(localStorage.getItem("settings") || "{}") };
      // La lista de productos ahora es el ORDEN de las filas: se actualiza una sola vez a la lista nueva.
      if (st.catalogVersion !== DEFAULTS.catalogVersion) { st.catalog = DEFAULTS.catalog; st.catalogVersion = DEFAULTS.catalogVersion; }
      return Promise.resolve(st);
    } catch (e) { return Promise.resolve({ ...DEFAULTS }); }
  }
  function persistSettings() {
    try { localStorage.setItem("settings", JSON.stringify(settings)); } catch (e) { /* nada */ }
  }

  function setStatus(msg, ms = 3500) {
    statusEl.textContent = msg;
    if (ms) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ""; }, ms);
  }
  const anyDialogOpen = () => nameDialog.open || settingsDialog.open || editDialog.open || msgDialog.open;
  const toBlob = (canvas, q = 0.92) => new Promise((res) => canvas.toBlob(res, "image/jpeg", q));

  // Avisos y preguntas propios de la página. Los cuadros nativos (alert/confirm) congelan la cámara y
  // frenan todo en el celular, por eso no se usan.
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

  // Cuántas lecturas de Cloud Vision se usaron este mes (en este dispositivo). Gratis hasta 1.000 por mes.
  const FREE_READS = 1000;
  function monthKey() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"); }
  function getUsage() {
    try { const u = JSON.parse(localStorage.getItem("visionUsage") || "{}"); return u.m === monthKey() ? u.n || 0 : 0; } catch (e) { return 0; }
  }
  function addUsage(n) {
    try { localStorage.setItem("visionUsage", JSON.stringify({ m: monthKey(), n: getUsage() + n })); } catch (e) { /* nada */ }
    updateUsageLabels();
  }
  function updateUsageLabels() {
    const n = getUsage();
    const el = $("usageLabel");
    if (el) el.textContent = "Lecturas de Cloud Vision usadas este mes en este dispositivo: " + n + " de " + FREE_READS + " gratis" + (n >= FREE_READS * 0.9 ? " ⚠ cerca del límite gratuito" : "") + ".";
  }

  // ---------- Cámara ----------
  async function startCamera(deviceId) {
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
    if (camRestarting) return;
    if (cameraAlive()) return;
    camRestarting = true;
    try {
      if (stream && stream.getVideoTracks()[0] && stream.getVideoTracks()[0].readyState === "live") { await video.play(); }
      else await startCamera(cameraSelect.value || undefined);
    } catch (e) { try { await startCamera(cameraSelect.value || undefined); } catch (e2) { /* nada */ } }
    camRestarting = false;
  }
  function watchCamera() {
    if (document.hidden) return;
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

  // ---------- Recuadros en vivo, en orden: 1) hoja  2) columna de cantidades  3) filas ----------
  const COLORS = { page: "#2ee06b", table: "#4da3ff", rows: "#ffd24d", filled: "#ff9d2e" };
  const stepsBadge = $("stepsBadge");
  const live = { an: null, stable: 0, analyzing: false, shown: 0, ticks: 0, runs: 0 };
  const analysisCanvas = document.createElement("canvas");
  const actx = analysisCanvas.getContext("2d", { willReadFrequently: true });

  // Con un cuadro del video: ubica la tabla, ajusta las 19 filas a los renglones y calcula la probabilidad
  // de que cada fila tenga un número (el mismo cálculo que se hace al sacar la foto).
  function analyzeLive(quad) {
    const vw = video.videoWidth, vh = video.videoHeight;
    const s = Math.min(1, 1600 / Math.max(vw, vh));
    analysisCanvas.width = Math.round(vw * s); analysisCanvas.height = Math.round(vh * s);
    actx.drawImage(video, 0, 0, analysisCanvas.width, analysisCanvas.height);
    const src = actx.getImageData(0, 0, analysisCanvas.width, analysisCanvas.height);
    const q = quad.map((p) => ({ x: p.x * s, y: p.y * s }));
    const page = canvasFromImageData(Crop.warp(src, q, 800));
    const pc = page.getContext("2d", { willReadFrequently: true });
    const d = pc.getImageData(0, 0, page.width, page.height);
    Enhance.enhance(d); pc.putImageData(d, 0, 0);
    // cada 4 análisis se vuelven a probar todos los giros; el resto, el que ya se conocía
    const hint = live.an && live.runs % 4 !== 0 ? live.an.deg : undefined;
    const o = bestOrientation(page, hint);
    const table = o.table;
    const strip = makeStripCanvas(table, o.deg ? rotateCanvas(analysisCanvas, o.deg) : analysisCanvas, Crop.rotateQuad(q, o.deg / 90));
    const m = measureStrip(strip);
    return { table, deg: o.deg, rowFracs: m.rowFracs, rowMeta: m.rowMeta, t: Date.now() };
  }

  function maybeAnalyzeLive(quad) {
    if (live.analyzing || live.stable < 2) return;
    if (live.an && Date.now() - live.an.t < 700) return;
    live.analyzing = true;
    setTimeout(() => {
      try { live.an = analyzeLive(quad); live.runs++; } catch (e) { console.warn("análisis en vivo:", e); live.an = null; }
      live.analyzing = false;
    }, 0);
  }

  function setSteps(n, approx) {
    const key = n + (approx ? 0.5 : 0);
    if (live.shown === key) return;
    live.shown = key;
    const t = ["", "①", "①②", "①②③"][n];
    stepsBadge.hidden = n === 0;
    stepsBadge.textContent = n === 0 ? "" : t + " " + ["", "Hoja", "Hoja → Cantidades", "Hoja → Cantidades → Filas"][n] +
      (approx && n >= 2 ? " (posición estimada)" : "");
  }

  function poly(ctx, pts, close) {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (close) ctx.closePath();
  }

  function drawLive(quad) {
    const cw = videoWrap.clientWidth, ch = videoWrap.clientHeight;
    if (overlay.width !== cw) overlay.width = cw;
    if (overlay.height !== ch) overlay.height = ch;
    const ctx = overlay.getContext("2d");
    ctx.clearRect(0, 0, cw, ch);
    if (!quad || !video.videoWidth) { setSteps(0); return; }
    const vw = video.videoWidth, vh = video.videoHeight;
    const sc = Math.min(cw / vw, ch / vh);
    const ox = (cw - vw * sc) / 2, oy = (ch - vh * sc) / 2;
    const scr = (p) => ({ x: ox + p.x * sc, y: oy + p.y * sc });

    // 1) hoja completa
    poly(ctx, quad.map(scr), true);
    ctx.fillStyle = "rgba(46,158,91,.14)"; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = COLORS.page; ctx.stroke();
    let steps = 1, approx = false;

    const an = live.an;
    if (an && an.table && live.stable >= 2) {
      live.ticks++;
      approx = !an.table.ok;
      // 2) recuadro interior de la columna de cantidades
      const rq = Crop.rotateQuad(quad, an.deg / 90);
      const T = an.table;
      const at = (fx, fy) => scr(Crop.mapPoint(rq, fx, fy));
      const box = [at(T.x0, T.y0), at(T.x1, T.y0), at(T.x1, T.y1), at(T.x0, T.y1)];
      poly(ctx, box, true);
      ctx.fillStyle = "rgba(77,163,255,.16)"; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = COLORS.table;
      ctx.setLineDash(approx ? [8, 6] : []); ctx.stroke(); ctx.setLineDash([]);
      steps = 2;
      if (live.ticks >= 2 && an.rowFracs && an.rowFracs.length > 1) {
        // 3) las 19 filas, siguiendo la perspectiva de la hoja; las que tienen número, en naranja
        const fr = an.rowFracs, N = fr.length - 1, H = T.y1 - T.y0;
        const yAt = (k) => T.y0 + H * fr[k];
        for (const r of an.rowMeta || []) {
          if (!r.nonEmpty) continue;
          const i = r.index - 1;
          poly(ctx, [at(T.x0, yAt(i)), at(T.x1, yAt(i)), at(T.x1, yAt(i + 1)), at(T.x0, yAt(i + 1))], true);
          ctx.fillStyle = r.sure ? "rgba(255,157,46,.40)" : "rgba(255,157,46,.20)"; ctx.fill();
        }
        ctx.strokeStyle = COLORS.rows; ctx.lineWidth = 1.2; ctx.fillStyle = COLORS.rows;
        ctx.font = "bold 11px system-ui, sans-serif";
        for (let i = 0; i <= N; i++) {
          poly(ctx, [at(T.x0, yAt(i)), at(T.x1, yAt(i))], false); ctx.stroke();
          if (i < N) {
            const m = at(T.x0, (yAt(i) + yAt(i + 1)) / 2);
            ctx.fillText(String(i + 1), m.x + 3, m.y + 4);
          }
        }
        for (const r of an.rowMeta || []) {     // probabilidad de que la fila tenga un número
          if (r.p < 0.15) continue;
          const i = r.index - 1, m = at(T.x1, (yAt(i) + yAt(i + 1)) / 2);
          ctx.fillStyle = r.nonEmpty ? COLORS.filled : "rgba(255,255,255,.6)";
          ctx.fillText(Math.round(r.p * 100) + "%", m.x + 4, m.y + 4);
        }
        steps = 3;
      }
    } else if (!an) { live.ticks = 0; }
    setSteps(steps, approx);
  }

  function liveLoop() {
    try {
      if (autoCropChk.checked && video.videoWidth && !capturing && !document.hidden) {
        const quad = detectQuad(video, video.videoWidth, video.videoHeight);
        if (quad) { live.stable++; maybeAnalyzeLive(quad); }
        else { live.stable = 0; live.an = null; live.ticks = 0; }
        drawLive(quad);
      } else {
        live.stable = 0;
        drawLive(null);
      }
      watchCamera();
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

  // Gira un canvas "deg" grados en sentido horario (0, 90, 180 o 270).
  function rotateCanvas(src, deg) {
    deg = ((deg % 360) + 360) % 360;
    if (!deg) return src;
    const c = document.createElement("canvas");
    const swap = deg === 90 || deg === 270;
    c.width = swap ? src.height : src.width; c.height = swap ? src.width : src.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }

  const imageDataOf = (c) => c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let epoch = 0;   // sube cada vez que se vacía todo: lo que estaba en proceso se descarta

  // Busca la tabla en la hoja. Una hoja derecha tiene la columna de cantidades a la izquierda; si la
  // hoja está de costado o al revés, se prueban los giros posibles y gana el que muestra la tabla bien.
  function bestOrientation(enh, hintDeg) {
    const portrait = enh.height >= enh.width;
    const options = portrait ? [0, 180] : [90, 270];
    if (hintDeg !== undefined && options.includes(hintDeg)) {    // se prueba primero el giro que ya se sabía
      const r = Layout.findTable(imageDataOf(rotateCanvas(enh, hintDeg)));
      if (r.ok) return { deg: hintDeg, score: r.score, table: r };
    }
    let best = null;
    for (const deg of options) {
      const r = Layout.findTable(imageDataOf(rotateCanvas(enh, deg)));
      const score = r.ok ? r.score : -1;
      if (!best || score > best.score + 1e-9) best = { deg, score, table: r };
    }
    return best;
  }

  // Recorta SOLO la columna de cantidades (a máxima resolución) y la mejora. Devuelve un canvas.
  function makeStripCanvas(table, srcCanvas, quadForSrc) {
    let strip;
    if (quadForSrc) {
      strip = canvasFromImageData(Crop.warp(imageDataOf(srcCanvas), Crop.subQuad(quadForSrc, table), 2600, { noSnap: true }));
    } else {
      const sx = Math.round(table.x0 * srcCanvas.width), sy = Math.round(table.y0 * srcCanvas.height);
      const sw = Math.max(8, Math.round((table.x1 - table.x0) * srcCanvas.width));
      const sh = Math.max(8, Math.round((table.y1 - table.y0) * srcCanvas.height));
      strip = document.createElement("canvas");
      strip.width = sw; strip.height = sh;
      strip.getContext("2d").drawImage(srcCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    }
    const ctx = strip.getContext("2d", { willReadFrequently: true });
    const d = ctx.getImageData(0, 0, strip.width, strip.height);
    Enhance.enhance(d);
    ctx.putImageData(d, 0, 0);
    return strip;
  }

  // Recorte de UNA fila para mandarlo a Cloud Vision: la escritura con aire blanco alrededor y agrandada.
  async function cropRowBlob(strip, bbox, pitch) {
    const padX = Math.round(pitch * 0.6), padY = Math.round(pitch * 0.25);
    const sx = Math.max(0, bbox.x0 - padX), sx1 = Math.min(strip.width, bbox.x1 + padX);
    const sy = Math.max(0, bbox.y0 - padY), sy1 = Math.min(strip.height, bbox.y1 + padY);
    const inkH = Math.max(1, bbox.y1 - bbox.y0 + 1);
    const scale = Math.min(4, Math.max(1, 110 / inkH));
    const margin = Math.round(pitch * 0.5 * scale);
    const w = Math.round((sx1 - sx) * scale), h = Math.round((sy1 - sy) * scale);
    const c = document.createElement("canvas");
    c.width = w + 2 * margin; c.height = h + 2 * margin;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(strip, sx, sy, sx1 - sx, sy1 - sy, margin, margin, w, h);
    return toBlob(c, 0.92);
  }

  // Mide la tira: grilla de filas, renglones borrados y probabilidad de que cada fila tenga un número.
  function measureStrip(strip) {
    const ctx = strip.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, strip.width, strip.height);
    const grid = Rows.fitGrid(img, Rows.N_ROWS);
    Rows.removeRuling(img, grid);
    ctx.putImageData(img, 0, 0);
    const ink = Rows.rowInk(img, grid);
    const rowFracs = [];
    for (let k = 0; k <= grid.n; k++) rowFracs.push(Math.min(1, Math.max(0, (grid.top + k * grid.pitch) / strip.height)));
    const rowMeta = ink.map((r, i) => ({ index: i + 1, p: r.p, nonEmpty: r.nonEmpty, sure: r.sure, ambiguous: r.ambiguous, alt: r.alt }));
    return { img, grid, ink, rowFracs, rowMeta, gridFitted: grid.fitted };
  }

  // Además arma, para cada fila con número, el recorte que se manda a Cloud Vision (solo con los trazos de esa fila).
  async function analyzeStrip(strip) {
    const m = measureStrip(strip);
    const tmp = document.createElement("canvas");
    tmp.width = strip.width; tmp.height = strip.height;
    const tctx = tmp.getContext("2d");
    const rowCrops = {};
    for (let i = 0; i < m.ink.length; i++) {
      if (!m.ink[i].nonEmpty) continue;
      const masked = Rows.maskRow(m.img, m.ink, i);
      tctx.putImageData(new ImageData(masked.data, masked.width, masked.height), 0, 0);
      const blob = await cropRowBlob(tmp, m.ink[i].bbox, m.grid.pitch);
      rowCrops[i + 1] = { blob, url: URL.createObjectURL(blob) };
    }
    return { rowFracs: m.rowFracs, rowMeta: m.rowMeta, rowCrops, gridFitted: m.gridFitted };
  }

  function freeAnalysis(p) {
    for (const k of Object.keys(p.rowCrops || {})) URL.revokeObjectURL(p.rowCrops[k].url);
    p.rowCrops = {};
  }

  // Recorta el papel, mejora la imagen y la agrega como una página nueva.
  async function addPageFromCanvas(source, fromFile, startEpoch) {
    const myEpoch = startEpoch === undefined ? epoch : startEpoch;   // la "época" con la que empezó el trabajo
    const full = fitCanvas(source, START_SIDE);
    let work, note = "", quad = null;
    if (autoCropChk.checked) {
      quad = detectQuad(full, full.width, full.height);
      if (quad) {
        work = canvasFromImageData(Crop.warp(imageDataOf(full), quad, MAX_SIDE));
      } else {
        work = fitCanvas(full, MAX_SIDE);
        note = " · sin recorte (no se distinguió el borde del papel)";
      }
    } else {
      work = fitCanvas(full, MAX_SIDE);
    }

    // "Color mejorado": es la imagen del PDF en el modo por defecto y sirve para ubicar la tabla.
    let enh = cloneCanvas(work);
    const ectx = enh.getContext("2d", { willReadFrequently: true });
    const imgData = ectx.getImageData(0, 0, enh.width, enh.height);
    Enhance.enhance(imgData);
    ectx.putImageData(imgData, 0, 0);

    // Orientación según la tabla, recuadro de cantidades y filas
    const hint = live.an && live.an.deg !== undefined && Date.now() - live.an.t < 3000 && !fromFile ? live.an.deg : undefined;
    const o = bestOrientation(enh, hint);
    if (o.deg) { work = rotateCanvas(work, o.deg); enh = rotateCanvas(enh, o.deg); }
    const table = o.table;
    let an = { rowFracs: [], rowMeta: [], rowCrops: {}, gridFitted: false };
    try {
      const strip = makeStripCanvas(table, o.deg ? rotateCanvas(full, o.deg) : full, quad ? Crop.rotateQuad(quad, o.deg / 90) : null);
      an = await analyzeStrip(strip);
    } catch (e) { console.error("No se pudo analizar la columna de cantidades:", e); }
    if (!table.ok) note += " · no se encontró la tabla: revisá las cantidades (⚠)";
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
      table: { x0: table.x0, x1: table.x1, y0: table.y0, y1: table.y1 }, layoutOk: table.ok,
      rowFracs: an.rowFracs, rowMeta: an.rowMeta, rowCrops: an.rowCrops,
      stage: 0, url: URL.createObjectURL(blob), status: "reading", rows: [], runId: 0
    };
    if (myEpoch !== epoch) {            // mientras tanto se apretó "Vaciar todo": se descarta
      URL.revokeObjectURL(page.url); freeAnalysis(page);
      return { page: null, note: "", w: work.width, h: work.height, discarded: true };
    }
    pages.push(page);
    render();
    thumbs.scrollTop = thumbs.scrollHeight;
    playStages(page);
    runOcr(page);
    return { page, note, w: work.width, h: work.height };
  }

  // Muestra los recuadros de la página uno por uno: 1) hoja  2) cantidades  3) filas  4) filas con número
  async function playStages(page) {
    for (let s = 1; s <= 4; s++) {
      if (!pages.includes(page)) return;
      page.stage = s;
      refreshOverlay(page);
      await sleep(s === 1 ? 250 : 500);
    }
  }

  function drawPageOverlay(canvas, page) {
    const W = canvas.width, H = canvas.height, ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    const st = page.stage || 0;
    if (!st) return;
    const lw = Math.max(2, W / 160);
    // 1) hoja completa
    ctx.lineWidth = lw * 1.6; ctx.strokeStyle = COLORS.page;
    ctx.strokeRect(lw, lw, W - 2 * lw, H - 2 * lw);
    const T = page.table;
    const X0 = T.x0 * W, X1 = T.x1 * W, Y0 = T.y0 * H, Y1 = T.y1 * H;
    if (st >= 2) {   // 2) recuadro interior de cantidades
      ctx.fillStyle = "rgba(77,163,255,.14)"; ctx.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
      ctx.lineWidth = lw * 1.4; ctx.strokeStyle = COLORS.table; ctx.strokeRect(X0, Y0, X1 - X0, Y1 - Y0);
    }
    const fr = page.rowFracs || [];
    if (st >= 3 && fr.length > 1) {   // 3) filas
      ctx.lineWidth = Math.max(1, lw * 0.5); ctx.strokeStyle = COLORS.rows; ctx.fillStyle = COLORS.rows;
      ctx.font = "bold " + Math.max(8, Math.round((Y1 - Y0) / (fr.length - 1) * 0.55)) + "px system-ui, sans-serif";
      for (let k = 0; k < fr.length; k++) {
        const y = Y0 + fr[k] * (Y1 - Y0);
        ctx.beginPath(); ctx.moveTo(X0, y); ctx.lineTo(X1, y); ctx.stroke();
        if (k < fr.length - 1) ctx.fillText(String(k + 1), X0 + 3, y + (fr[k + 1] - fr[k]) * (Y1 - Y0) * 0.72);
      }
    }
    if (st >= 4) {   // 4) filas con número (las únicas que se mandan a leer) y su probabilidad
      ctx.font = "bold " + Math.max(8, Math.round((Y1 - Y0) / Math.max(1, fr.length - 1) * 0.5)) + "px system-ui, sans-serif";
      for (const r of page.rowMeta || []) {
        const ya = Y0 + fr[r.index - 1] * (Y1 - Y0), yb = Y0 + fr[r.index] * (Y1 - Y0);
        if (r.nonEmpty) {
          ctx.fillStyle = r.sure ? "rgba(255,157,46,.40)" : "rgba(255,157,46,.20)"; ctx.fillRect(X0, ya, X1 - X0, yb - ya);
          ctx.lineWidth = lw * 1.2; ctx.strokeStyle = COLORS.filled;
          ctx.setLineDash(r.sure ? [] : [lw * 2, lw * 1.5]); ctx.strokeRect(X0, ya, X1 - X0, yb - ya); ctx.setLineDash([]);
        }
        if (r.p >= 0.15) {
          ctx.fillStyle = r.nonEmpty ? "#b45f00" : "#667";
          ctx.fillText(Math.round(r.p * 100) + "%", X1 + 3, yb - (yb - ya) * 0.25);
        }
      }
    }
  }

  // Redibuja solo los recuadros de la tarjeta de esa página (sin rearmar la lista)
  function refreshOverlay(page) {
    for (const cv of document.querySelectorAll('canvas.ov[data-id="' + page.id + '"]')) drawPageOverlay(cv, page);
    const m = document.querySelector('.thumb[data-id="' + page.id + '"] .meta');
    if (m) m.textContent = stageText(page);
  }

  const STAGE_NAMES = ["", "Paso 1/4 · hoja completa", "Paso 2/4 · recuadro de cantidades", "Paso 3/4 · filas numeradas", ""];
  function stageText(page) {
    if ((page.stage || 0) < 4) return STAGE_NAMES[page.stage || 0] || "";
    const idx = (page.rowMeta || []).filter((r) => r.nonEmpty).map((r) => r.index);
    const dud = (page.rowMeta || []).filter((r) => r.nonEmpty && !r.sure).map((r) => r.index);
    return idx.length ? "Filas con número: " + idx.join(", ") + " → " + idx.length + (idx.length === 1 ? " lectura" : " lecturas") + (dud.length ? " · dudosas: " + dud.join(", ") : "")
                      : "Ninguna fila con número (no se envió nada)";
  }

  // Un canvas del tamaño (proporción) de la página, para dibujar encima de la imagen
  function makeOverlayCanvas(page) {
    const cv = document.createElement("canvas");
    cv.className = "ov"; cv.dataset.id = page.id;
    cv.width = 420; cv.height = Math.max(2, Math.round(420 * page.h / page.w));
    drawPageOverlay(cv, page);
    return cv;
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
    const e0 = epoch;
    try {
      setStatus("Procesando foto…", 0);
      const frame = await grabFrame();
      const r = await addPageFromCanvas(frame, false, e0);
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
    const myEpoch = epoch;
    try {
      for (let i = 0; i < files.length; i++) {
        if (myEpoch !== epoch) break;        // se apretó "Vaciar todo": se cancela lo que faltaba subir
        const f = files[i];
        setStatus("Procesando " + (i + 1) + " de " + files.length + "…", 0);
        if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) { failed.push(f.name); continue; }
        try {
          const c = await fileToCanvas(f);
          await addPageFromCanvas(c, true, myEpoch);
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
      showMessage("No se pudieron abrir estos archivos:\n• " + failed.join("\n• ") +
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
  pagesPanel.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); markDrag(); });
  pagesPanel.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; markDrag(); });
  pagesPanel.addEventListener("dragleave", () => { resetDragState(); });
  pagesPanel.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    resetDragState();
    importFiles(e.dataTransfer.files);
  });
  window.addEventListener("dragend", resetDragState);
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
    const myRun = ++page.runId, myEpoch = epoch;
    page.rows = [];
    const todo = (page.rowMeta || []).filter((r) => r.nonEmpty && page.rowCrops[r.index]);
    if (!todo.length || !settings.apiKey) { page.status = "alert"; render(); return; }
    page.status = "reading";
    render();
    await ocrAcquire();
    const stale = () => page.runId !== myRun || myEpoch !== epoch || !pages.includes(page) || page.status === "manual";
    try {
      if (stale()) return;
      // A Cloud Vision se le mandan SOLO las filas con número (cada una es una lectura facturable).
      const resps = await OCR.recognizeBatch(todo.map((r) => page.rowCrops[r.index].blob), settings.apiKey);
      addUsage(todo.length);
      if (stale()) return;
      const cells = todo.map((r, k) => {
        const resp = resps[k];
        if (!resp || resp.error) return { index: r.index, words: [], failed: true };
        const { words } = OCR.extractWords(resp, { autoRotate: false });
        return { index: r.index, words, uncertain: !r.sure };
      });
      page.rows = OCR.buildRowsFromCells(cells, {
        products: catalogList(), minConf: OCR.minConfFor(settings.sensitivity),
        layoutOk: page.layoutOk
      });
      page.status = page.rows.length && !page.rows.some((r) => r.low) ? "ok" : "alert";
    } catch (err) {
      console.error("Lectura de texto falló:", err);
      if (stale()) return;
      page.rows = [];
      page.status = "alert";
      setStatus("No se pudo leer: " + err.message, 8000);
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
        '<div class="imgwrap"><img alt="Página ' + (i + 1) + '"></div>' +
        '<div class="meta"></div>' +
        '<div class="tools"><button class="btn small edit">✏ Datos</button>' +
        '<button class="btn small rot">⟳ Girar</button>' +
        '<button class="btn small danger del">🗑</button></div>';
      card.dataset.id = p.id;
      card.querySelector("img").src = p.url;
      card.querySelector(".imgwrap").appendChild(makeOverlayCanvas(p));
      card.querySelector(".meta").textContent = stageText(p);
      card.querySelector(".imgwrap").addEventListener("click", () => openEditor(p));
      card.querySelector(".edit").addEventListener("click", () => openEditor(p));
      const alertBtn = card.querySelector(".badge.alert");
      if (alertBtn) alertBtn.addEventListener("click", () => openEditor(p));
      card.querySelector(".del").addEventListener("click", () => {
        URL.revokeObjectURL(p.url);
        freeAnalysis(p);
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
    // Con la hoja girada se vuelve a ubicar la tabla y las filas (sobre la imagen de la página) y se vuelve a leer.
    try {
      const bmp = await createImageBitmap(p.ocrBlob);
      const c = document.createElement("canvas");
      c.width = bmp.width; c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      const table = Layout.findTable(imageDataOf(c));
      const an = await analyzeStrip(makeStripCanvas(table, c, null));
      freeAnalysis(p);
      Object.assign(p, { table: { x0: table.x0, x1: table.x1, y0: table.y0, y1: table.y1 }, layoutOk: table.ok,
        rowFracs: an.rowFracs, rowMeta: an.rowMeta, rowCrops: an.rowCrops, stage: 4 });
    } catch (e) { console.error("No se pudo analizar la columna de cantidades:", e); }
    if (p.status === "manual") render();
    else runOcr(p);
  }

  function clearAll() {
    epoch++;                                   // lo que estaba procesándose se descarta
    pages.forEach((p) => { URL.revokeObjectURL(p.url); freeAnalysis(p); });
    pages = [];
    setBusy(false);
    resetDragState();
    live.stable = 0; live.an = null; live.ticks = 0;
    render();
    ensureCamera();
    setStatus("Fotos borradas. Podés seguir escaneando.", 4000);
  }

  clearBtn.addEventListener("click", async () => {
    if (!pages.length) return;
    if (await askConfirm("¿Borrar todas las fotos tomadas?", "Sí, vaciar todo", "Cancelar")) clearAll();
  });

  // ---------- Edición manual de datos ----------
  let editing = null;
  let editRows = [];

  function openEditor(page) {
    editing = page;
    editRows = page.rows.map((r) => ({
      name: r.name || "",
      qtyText: r.qty !== null && r.qty !== undefined ? OCR.formatQty(r.qty) : "",
      low: !!r.low, index: r.index || 0, crop: r.index && page.rowCrops[r.index] ? page.rowCrops[r.index].url : "",
      meta: (page.rowMeta || []).find((m) => m.index === r.index) || null
    }));
    if (!editRows.length) editRows.push({ name: "", qtyText: "", low: false });
    editNum.textContent = String(pages.indexOf(page) + 1);
    editImg.src = page.url;
    editWrap.querySelectorAll("canvas.ov").forEach((c) => c.remove());
    const ov = makeOverlayCanvas({ ...page, stage: 4 });
    editWrap.appendChild(ov);
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
      if (row.crop) {
        const lab = document.createElement("div");
        lab.className = "rowcrop";
        const im = document.createElement("img"); im.src = row.crop; im.alt = "Fila " + row.index;
        const sp = document.createElement("span"); sp.textContent = "Fila " + row.index + (row.meta ? " · " + Math.round(row.meta.p * 100) + "% de probabilidad de número" : "") +
          (row.meta && row.meta.ambiguous ? " · ¿o es de la fila " + row.meta.alt + "?" : "") + " — lo que se envió a Google";
        lab.append(sp, im);
        div.appendChild(lab);
      }
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
      out.push({ name, qty, qtyText, conf: 1, lineText: name, low: false, index: row.index || undefined });
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
    sensSelect.value = settings.sensitivity;
    updateUsageLabels();
    catalogInput.value = settings.catalog;
    hiResChk.checked = !!settings.hiRes;
    keyMsg.textContent = "";
    settingsDialog.showModal();
  });
  $("cancelSettings").addEventListener("click", () => settingsDialog.close());
  $("saveSettings").addEventListener("click", () => {
    settings.apiKey = keyInput.value.trim();
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
      addUsage(1);
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

  saveBtn.addEventListener("click", async () => {
    if (pages.some((p) => p.status === "reading")) {
      await showMessage("Todavía se están leyendo algunas páginas (⏳). Esperá unos segundos y probá de nuevo.");
      return;
    }
    const unverified = pages.filter((p) => p.status === "alert").length;
    if (unverified && !(await askConfirm(
      "Hay " + unverified + " página(s) con el símbolo ⚠ (datos sin verificar).\n\n" +
      "Sus cantidades se suman tal como se leyeron, o no se suman si no se leyó nada.\n\n" +
      "¿Guardar el PDF igual? (Con “Revisar” podés corregirlas con ✏ Datos.)", "Guardar igual", "Revisar"))) return;
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
      if (await askConfirm("PDF guardado en Descargas.\n\n¿Querés vaciar las fotos para empezar un remito nuevo?", "Sí, vaciar", "No, dejarlas")) clearAll();
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
      if (!installEvt) showMessage("Para instalarla en el iPhone:\n\n1. Abrí esta página en Safari.\n2. Tocá el botón Compartir (el cuadrado con la flecha hacia arriba).\n3. Elegí “Añadir a pantalla de inicio”.\n4. Tocá “Añadir”.");
    });
  }
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("No se pudo registrar el service worker:", e));
  }
})();
