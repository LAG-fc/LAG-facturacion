// lector.js — Pantalla del lector de remitos: lee cada foto (fecha, N° de remito, cantidades, cliente y OC) comparando con el Excel de Despachos,
// muestra un borrador con semáforo de confianza, y aprende de lo que confirmás o corregís (rl.js).
(() => {
  "use strict";
  const A = window.RemitosApp, R = window.DigitsCore, RL = window.RemitoRL, P = window.Period, D = window.Despachos, $ = (id) => document.getElementById(id);
  if (!A || !R || !RL || !R.model()) { console.warn("El lector de remitos no se pudo iniciar (faltan archivos)."); return; }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const enabled = () => A.settings().lector !== false;
  const zones = () => A.settings().zones || R.DEFAULT_ZONES;
  const calibrated = () => !!A.settings().zones;
  const ready = () => A.pages().filter((p) => p.status === "ok");

  // ---------------------------------------------------------------- contexto (Excel y OC guardados en el navegador)
  const jget = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v === null ? d : v; } catch (e) { return d; } };
  function buildCtx() {
    const now = new Date(), dd = jget("despDia", null), ocs = (jget("ocData", []) || []).map((r) => String(r.oc || "")).filter(Boolean);
    const ctx = { month: dd && dd.month ? dd.month : now.getMonth() + 1, year: now.getFullYear(), ocs };
    if (dd && dd.data) {
      const out = {};
      Object.keys(dd.data).forEach((day) => Object.keys(dd.data[day]).forEach((cid) => {
        const e = ((out[day] = out[day] || {})[cid] = { any: [], names: {} }), prods = dd.data[day][cid];
        Object.keys(prods).forEach((name) => prods[name].forEach((v) => { e.any.push(v); e.names[String(v)] = name; }));
      }));
      ctx.dayData = out; ctx.excelName = dd.file || ""; ctx.excelMes = dd.mes || "";
    }
    return ctx;
  }

  // ---------------------------------------------------------------- lectura de una página
  async function grayOf(blob) {
    const bmp = await createImageBitmap(blob), c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
    const id = x.getImageData(0, 0, c.width, c.height);
    return { g: R.toGray(id.data, c.width, c.height), w: c.width, h: c.height };
  }
  async function analyzePage(page) {
    const { g, w, h } = await grayOf(page.blob);
    await sleep(0);
    const crops = R.extract(g, w, h, zones());
    await sleep(0);
    const an = { nro: [], date: [], qty: [], oc: [], geom: crops.geom };
    for (const id of R.armIds()) {
      an.nro.push({ arm: id, an: R.analyze(crops.nro, "nro", id) }); await sleep(0);
      an.date.push({ arm: id, an: R.analyze(crops.date, "date", id) }); await sleep(0);
      an.qty.push({ arm: id, an: R.analyze(crops.qty, "qty", id, { digitH: crops.geom.pitch * 0.62 }) }); await sleep(0);
      an.oc.push({ arm: id, an: R.analyze(crops.oc, "oc", id, { digitH: crops.geom.pitch * 0.62 }) }); await sleep(0);
    }
    return { crops, an };
  }
  function weightsOf(an) {
    const ref = (l) => (l.find((x) => x.arm === "fina") || l[0] || {}).an;
    const bq = RL.bucket(ref(an.qty)), bd = RL.bucket(ref(an.date));
    return { qty: RL.weights("qty", bq), date: RL.weights("date", bd), nro: RL.weights("nro", bd), oc: RL.weights("oc", bq) };
  }
  function decode(read) {
    read.ctx = buildCtx();
    read.result = R.decodeAll(read.an, read.ctx, weightsOf(read.an));
    const r = read.result;
    read.noInk = !r.qty.rows.length && !(r.date.conf && r.date.conf.d > 0.5);
    return r;
  }
  const level = (c) => { const v = RL.calibrate(c); return v >= 0.85 ? "ok" : v >= 0.55 ? "warn" : "bad"; };
  const worst = (a, b) => ({ ok: 0, warn: 1, bad: 2 }[a] >= { ok: 0, warn: 1, bad: 2 }[b] ? a : b);
  function overall(read) {
    const r = read.result; if (!r) return "bad";
    let lv = level(Math.min(r.date.conf.d, r.date.conf.m));
    if (!r.qty.rows.length) return "bad";
    r.qty.rows.forEach((x) => { lv = worst(lv, level(x.conf)); });
    return lv;
  }
  const fmtDate = (d) => String(d.d).padStart(2, "0") + "/" + String(d.m).padStart(2, "0");
  function label(page) {
    const rd = page.read;
    if (!rd) { page.readLabel = ""; page.readClass = ""; return; }
    if (rd.status === "reading") { page.readLabel = "Leyendo…"; page.readClass = "busy"; return; }
    if (rd.status === "error") { page.readLabel = "No se pudo leer"; page.readClass = "bad"; return; }
    if (rd.confirmed) { page.readLabel = "✔ " + (rd.values.rows.map((x) => A.formatQty(x.value)).join(" · ") || "confirmado"); page.readClass = "done"; return; }
    const r = rd.result;
    page.readLabel = rd.noInk ? "Revisar" : (r.qty.rows.map((x) => x.text).join(" · ") || "—") + " · " + fmtDate(r.date);
    page.readClass = rd.noInk ? "bad" : overall(rd);
  }

  // cola: se lee de a una foto para no trabar la pantalla
  const queue = []; let working = false;
  async function pump() {
    if (working) return; working = true;
    try {
      while (queue.length) {
        const p = queue.shift();
        if (!A.pages().includes(p) || p.status !== "ok" || !p.blob) continue;
        p.read = { status: "reading" }; label(p); A.refresh();
        try {
          const { crops, an } = await analyzePage(p);
          if (!A.pages().includes(p)) continue;
          p.read = { status: "ready", crops, an, confirmed: false }; decode(p.read);
        } catch (e) { console.error("No se pudo leer el remito:", e); p.read = { status: "error", message: e.message }; }
        label(p); A.refresh(); summary(); if ($("readDialog").open) renderReview();
        await sleep(0);
      }
    } finally { working = false; }
  }
  function enqueue(p) { if (!queue.includes(p)) { queue.push(p); pump(); } }
  A.onPageReady = (p) => { if (enabled()) enqueue(p); };

  function summary() {
    const ok = ready(), n = ok.length;
    $("readSummary").hidden = !enabled() || !n;
    const done = ok.filter((p) => p.read && p.read.confirmed).length, pend = ok.filter((p) => !p.read || p.read.status === "reading").length;
    $("readInfo").textContent = !n ? "—" : (calibrated() ? "" : "Marcá las zonas una vez · ") + (done + " de " + n + " confirmados") + (pend ? " · leyendo " + pend : "");
    $("readInfo").classList.toggle("filled", n > 0 && done === n);
  }

  // ---------------------------------------------------------------- pantalla de revisión
  let idx = 0, edit = null;                        // edit: campos tal como están en pantalla
  const clientNames = () => D.CLIENTS.filter((c) => c.sheet).map((c) => ({ id: c.id, name: c.name }));
  const dot = (id, c, text) => { const e = $(id); const lv = c === null ? "" : level(c); e.className = "dot " + lv; e.title = c === null ? "" : (text || "Confianza") + ": " + Math.round(RL.calibrate(c) * 100) + " %"; };

  function drawGray(cv, crop, maxW) {
    const f = Math.min(1, maxW / crop.w), w = Math.max(1, Math.round(crop.w * f)), h = Math.max(1, Math.round(crop.h * f));
    const tmp = document.createElement("canvas"); tmp.width = crop.w; tmp.height = crop.h;
    const x = tmp.getContext("2d"), id = x.createImageData(crop.w, crop.h);
    for (let i = 0; i < crop.g.length; i++) { const v = crop.g[i]; id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
    x.putImageData(id, 0, 0);
    cv.width = w; cv.height = h; cv.getContext("2d").drawImage(tmp, 0, 0, w, h);
  }

  function renderReview() {
    const list = ready();
    if (!list.length) { $("readDialog").close(); return; }
    idx = Math.max(0, Math.min(idx, list.length - 1));
    const page = list[idx], rd = page.read;
    $("rdPos").textContent = (idx + 1) + " / " + list.length;
    $("rdPrev").disabled = idx === 0; $("rdNext").disabled = idx === list.length - 1;
    $("rdImg").src = page.url || "";
    const cat = A.catalog(), ctx = rd && rd.ctx ? rd.ctx : buildCtx();
    $("rdSub").textContent = ctx.dayData ? "Comparando con el Excel de Despachos (" + (ctx.excelMes || ctx.excelName || "cargado") + ")." : "Sin Excel cargado: leo solo lo escrito. Tocá “Buscar OC del mes” en Facturación para sumar el Excel y acertar más.";
    const banner = $("rdBanner"); banner.hidden = true; banner.className = "rd-banner";
    $("rdCrops").innerHTML = "";
    edit = null;
    if (!rd || rd.status === "reading") { banner.hidden = false; banner.textContent = "Leyendo esta foto…"; fillFields(null); return; }
    if (rd.status === "error") { banner.hidden = false; banner.className = "rd-banner bad"; banner.textContent = "No pude leer esta foto (" + (rd.message || "error") + "). Podés cargar los datos a mano."; fillFields(null); return; }
    const r = rd.result;
    // recortes de lo que "vio" el lector
    const mk = (title, crop, w) => { if (!crop) return; const d = document.createElement("div"); d.className = "rd-crop"; d.innerHTML = "<small>" + title + "</small>"; const cv = document.createElement("canvas"); drawGray(cv, crop, w); d.appendChild(cv); $("rdCrops").appendChild(d); };
    mk("Fecha", rd.crops.date, 260); mk("N° de remito", rd.crops.nro, 260); mk("Cantidades", rd.crops.qty, 260);
    if (!calibrated()) { banner.hidden = false; banner.className = "rd-banner warn"; banner.textContent = "Todavía no marcaste las zonas del remito: tocá “Marcar zonas” (una sola vez) para que lea en el lugar correcto."; }
    else if (rd.confirmed) { banner.hidden = false; banner.className = "rd-banner ok"; banner.textContent = "Confirmado ✔. Si corregís algo, volvé a tocar “Confirmar y aprender”."; }
    else if (rd.noInk) { banner.hidden = false; banner.className = "rd-banner bad"; banner.textContent = "No encontré escritura en las zonas marcadas. Revisá que la foto muestre el remito completo y derecho, o ajustá las zonas."; }
    fillFields(rd);
    // N° de remito repetido
    const nroOf = (p) => { const q = p.read; if (!q) return ""; if (q.confirmed && q.values) return q.values.nro; return q.result && q.result.nro ? q.result.nro.text : ""; };
    const nro = $("rdNro").value;
    if (nro) { const other = list.findIndex((p, i) => i !== idx && nroOf(p) === nro); if (other >= 0) { banner.hidden = false; banner.className = "rd-banner warn"; banner.textContent = "El N° de remito " + nro + " también aparece en la foto " + (other + 1) + ": ¿es un duplicado?"; } }
  }

  function fillFields(rd) {
    const cat = A.catalog();
    const sel = $("rdClient");
    sel.innerHTML = '<option value="">— sin identificar —</option>' + clientNames().map((c) => '<option value="' + c.id + '">' + esc(c.name) + "</option>").join("");
    const saved = rd && rd.edit, r = rd && rd.result;
    const src = saved || (r ? {
      d: r.date.d, m: r.date.m, y: r.date.y, nro: r.nro.text || "", client: r.qty.client && r.qty.client.id ? r.qty.client.id : "", oc: r.oc.num || "",
      rows: r.qty.rows.map((x) => ({ row: x.row, text: x.text, value: x.value, conf: x.conf, source: x.source, excelName: x.excelName }))
    } : { d: "", m: "", y: "", nro: "", client: "", oc: "", rows: [] });
    if (rd && rd.confirmed && rd.values && !saved) { /* se muestra lo confirmado */ }
    $("rdD").value = src.d || ""; $("rdM").value = src.m || ""; $("rdY").value = src.y || ""; $("rdNro").value = src.nro || ""; sel.value = src.client || ""; $("rdOc").value = src.oc || "";
    dot("rdDateDot", r ? Math.min(r.date.conf.d, r.date.conf.m) : null, "Fecha");
    dot("rdNroDot", r && r.nro ? r.nro.conf : null, "N° de remito");
    dot("rdClientDot", r && r.qty.client && r.qty.client.id ? r.qty.client.conf : null, "Cliente según las cantidades");
    dot("rdOcDot", r && r.oc && r.oc.num ? r.oc.conf : null, "OC");
    const box = $("rdRows"); box.innerHTML = "";
    src.rows.forEach((x) => box.appendChild(rowEl(x, cat)));
    if (!src.rows.length) box.innerHTML = '<p class="hint">No encontré cantidades. Agregá un renglón para cargarlas a mano.</p>';
    $("rdNote").textContent = r && r.qty.client && r.qty.client.id ? "El cliente se dedujo de las cantidades: coinciden con las entregas de " + (clientNames().find((c) => c.id === r.qty.client.id) || {}).name + " ese día." : (r && ctxHas(rd) ? "Ninguna entrega del Excel coincide con lo escrito: revisá las cantidades." : "");
    const sm = RL.summary();
    $("rdStats").textContent = sm.total ? "Aprendizaje: " + sm.total + " remitos confirmados" + (sm.perfectRecent !== null ? " · " + Math.round(sm.perfectRecent * 100) + " % sin correcciones (últimos " + Math.min(40, sm.total) + ")" : "") : "Cada confirmación enseña al lector: al principio habrá que corregir más.";
    $("rdConfirm").textContent = "Confirmar y aprender";
    $("rdConfirm").prepend(svgIcon("check"));
  }
  const ctxHas = (rd) => !!(rd && rd.ctx && rd.ctx.dayData);
  function svgIcon(n) { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("class", "i"); const u = document.createElementNS("http://www.w3.org/2000/svg", "use"); u.setAttributeNS("http://www.w3.org/1999/xlink", "href", "#i-" + n); u.setAttribute("href", "#i-" + n); s.appendChild(u); return s; }

  function rowEl(x, cat) {
    const d = document.createElement("div"); d.className = "rd-row";
    const names = cat.map((n, i) => '<option value="' + i + '"' + (i === x.row ? " selected" : "") + ">" + esc(n) + "</option>").join("");
    d.innerHTML = '<select class="rr">' + names + '</select><input class="rq" inputmode="decimal" value="' + esc(x.text || "") + '" placeholder="0,00"><i class="dot"></i><button type="button" class="rm" title="Quitar">×</button><small></small>';
    const lv = x.conf !== undefined ? level(x.conf) : ""; d.querySelector(".dot").className = "dot " + lv; if (x.conf !== undefined) d.querySelector(".dot").title = "Confianza: " + Math.round(RL.calibrate(x.conf) * 100) + " %";
    d.querySelector("small").textContent = x.source === "excel" ? "✔ coincide con el Excel" + (x.excelName ? ": " + x.excelName : "") : (x.source === "libre" ? "Lectura directa (no figura en el Excel): verificala" : "");
    d.querySelector("small").className = x.source === "excel" ? "ok" : "warn";
    d.querySelector(".rm").addEventListener("click", () => d.remove());
    d.querySelector(".rq").addEventListener("input", () => { d.querySelector(".rq").classList.remove("bad"); d.querySelector("small").textContent = ""; });
    return d;
  }
  $("rdAddRow").addEventListener("click", () => {
    const box = $("rdRows"); if (!box.querySelector(".rd-row")) box.innerHTML = "";
    const used = new Set([...box.querySelectorAll(".rr")].map((s) => Number(s.value))); let k = 0; while (used.has(k)) k++;
    const el = rowEl({ row: k, text: "" }, A.catalog()); box.appendChild(el); el.querySelector(".rq").focus();
  });

  // Lee los campos de pantalla. Devuelve null si hay algo inválido.
  function collect() {
    let bad = false; const mark = (el, b) => { el.classList.toggle("bad", !!b); if (b) bad = true; };
    const d = Number($("rdD").value), m = Number($("rdM").value); let y = Number($("rdY").value);
    mark($("rdD"), !(d >= 1 && d <= 31)); mark($("rdM"), !(m >= 1 && m <= 12)); if (y && y < 100) y += 2000; mark($("rdY"), !(y >= 2000 && y <= 2100));
    const rows = [];
    $("rdRows").querySelectorAll(".rd-row").forEach((el) => {
      const row = Number(el.querySelector(".rr").value), t = el.querySelector(".rq").value.trim();
      if (!t) return;
      const v = A.parseNumber(t); if (v === null || Number.isNaN(v)) { mark(el.querySelector(".rq"), true); return; }
      rows.push({ row, value: v, text: A.formatQty(v) });
    });
    const keys = rows.map((x) => x.row); if (new Set(keys).size !== keys.length) { bad = true; A.setStatus("Hay dos renglones con el mismo producto.", 4000); }
    if (bad) return null;
    return { d, m, y, nro: $("rdNro").value.replace(/\D/g, ""), client: $("rdClient").value, oc: $("rdOc").value.replace(/\D/g, ""), rows };
  }

  function confirmCurrent() {
    const list = ready(), page = list[idx]; if (!page || !page.read || !page.read.result) return;
    const f = collect(); if (!f) { A.setStatus("Revisá los campos marcados en rojo.", 4000); return; }
    const rd = page.read, truthRows = {}; f.rows.forEach((x) => { truthRows[x.row] = x.value; });
    // lo mostrado (lo que dedujo el lector) frente a lo confirmado: esa diferencia es la recompensa
    let res = { reward: 1, samples: 0 };
    if (rd.an) {
      try { res = RL.learn({ an: rd.an, ctx: rd.ctx, shown: rd.result, truth: { date: { d: f.d, m: f.m, y: f.y }, nro: f.nro, rows: truthRows, oc: f.oc, client: f.client || null } }); }
      catch (e) { console.error("No se pudo aprender de esta lectura:", e); }
    }
    rd.confirmed = true; rd.values = f; rd.edit = Object.assign({}, f, { rows: f.rows.map((x) => ({ row: x.row, text: x.text, value: x.value })) });
    rd.an = null; if (rd.crops) rd.crops.oc = null;                 // se libera memoria
    label(page); A.refresh(); summary();
    A.setStatus(res.reward >= 0.999 ? "¡Sin correcciones! El lector acertó todo." : "Gracias: aprendí de " + res.samples + " dígitos de esta lectura.", 3500);
    if (idx < list.length - 1) { idx++; }
    renderReview();
  }
  $("rdConfirm").addEventListener("click", confirmCurrent);
  $("rdPrev").addEventListener("click", () => { saveEdit(); idx--; renderReview(); });
  $("rdNext").addEventListener("click", () => { saveEdit(); idx++; renderReview(); });
  $("rdClose").addEventListener("click", () => { saveEdit(); $("readDialog").close(); });
  function saveEdit() { /* los campos se releen de la lectura al cambiar de foto; lo corregido se guarda recién al confirmar */ }
  $("rdReread").addEventListener("click", async () => {
    const p = ready()[idx]; if (!p) return;
    p.read = null; label(p); A.refresh(); enqueue(p); renderReview();
  });
  $("readDialog").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); const inputs = [...$("readDialog").querySelectorAll("input,select")].filter((x) => !x.closest("[hidden]")); const k = inputs.indexOf(e.target); if (k >= 0 && k < inputs.length - 1) inputs[k + 1].focus(); else $("rdConfirm").focus(); } });
  $("readOpenBtn").addEventListener("click", () => { idx = Math.max(0, ready().findIndex((p) => !(p.read && p.read.confirmed))); if (idx < 0) idx = 0; $("readDialog").showModal(); renderReview(); });

  // ---------------------------------------------------------------- pasar a la tabla de recepciones
  $("rdApply").addEventListener("click", async () => {
    const list = ready(), done = list.filter((p) => p.read && p.read.confirmed && p.read.values);
    if (!done.length) { A.setStatus("Primero confirmá al menos un remito.", 4000); return; }
    const cat = A.catalog(), sums = {};
    done.forEach((p) => p.read.values.rows.forEach((x) => { const nm = cat[x.row]; if (!nm) return; (sums[nm] = sums[nm] || []).push(x.text); }));
    const names = Object.keys(sums); if (!names.length) { A.setStatus("Los remitos confirmados no tienen cantidades.", 4000); return; }
    const tot = A.totals(), had = names.some((n) => String(tot.values[n] || "").trim());
    if (had && !(await A.askConfirm("Ya hay cantidades cargadas en la tabla de recepciones. ¿Reemplazarlas por las de los remitos confirmados?", "Reemplazar", "Cancelar"))) return;
    names.forEach((n) => { tot.values[n] = sums[n].join("+"); });
    const ocs = [...new Set(done.map((p) => p.read.values.oc).filter(Boolean))];
    if (ocs.length === 1 && !tot.oc) tot.oc = ocs[0];
    A.persistTotals(); A.updateTotalsInfo();
    const missing = list.length - done.length;
    $("readDialog").close();
    A.setStatus("Cargué " + names.length + " producto" + (names.length === 1 ? "" : "s") + " en la tabla de recepciones (" + done.length + " remito" + (done.length === 1 ? "" : "s") + ")." + (missing ? " Faltan " + missing + " sin confirmar." : "") + (ocs.length > 1 ? " Ojo: hay más de una OC en los remitos." : ""), 7000);
  });

  // ---------------------------------------------------------------- marcar las zonas
  const ZN = [{ k: "nro", t: "N° de remito", c: "#2f6fd1" }, { k: "date", t: "Fecha", c: "#1f9d62" }, { k: "qty", t: "Cantidad", c: "#d33a3a" }, { k: "oc", t: "OC / cliente", c: "#d98a12" }];
  let zWork = null;
  function openZones() {
    const list = ready(); if (!list.length) { A.setStatus("Primero sacá o subí la foto de un remito completo.", 5000); return; }
    const page = list[Math.min(idx, list.length - 1)];
    zWork = JSON.parse(JSON.stringify(zones())); $("znRows").value = zWork.qty.rows || 14;
    $("znImg").src = page.url; $("znLegend").innerHTML = ZN.map((z) => '<span><i style="background:' + z.c + '"></i>' + z.t + "</span>").join("");
    $("zonesDialog").showModal(); buildStage();
  }
  function buildStage() {
    const st = $("znStage"); st.querySelectorAll(".zn").forEach((e) => e.remove());
    ZN.forEach((z) => {
      const el = document.createElement("div"); el.className = "zn"; el.dataset.k = z.k; el.style.borderColor = z.c; el.style.background = z.c + "22";
      el.innerHTML = "<b style=\"background:" + z.c + '">' + z.t + '</b><span class="hd"></span>'; st.appendChild(el); place(el, zWork[z.k]);
      const drag = (mode) => (ev) => {
        ev.preventDefault(); el.setPointerCapture(ev.pointerId);
        const r = st.getBoundingClientRect(), z0 = Object.assign({}, zWork[z.k]), sx = ev.clientX, sy = ev.clientY;
        const mv = (e2) => {
          const dx = (e2.clientX - sx) / r.width, dy = (e2.clientY - sy) / r.height, q = zWork[z.k];
          if (mode === "move") { const w = z0.x1 - z0.x0, h = z0.y1 - z0.y0; q.x0 = Math.max(0, Math.min(1 - w, z0.x0 + dx)); q.y0 = Math.max(0, Math.min(1 - h, z0.y0 + dy)); q.x1 = q.x0 + w; q.y1 = q.y0 + h; }
          else { q.x1 = Math.max(z0.x0 + 0.02, Math.min(1, z0.x1 + dx)); q.y1 = Math.max(z0.y0 + 0.01, Math.min(1, z0.y1 + dy)); }
          place(el, q);
        };
        const up = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
        el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
      };
      el.addEventListener("pointerdown", (ev) => { if (ev.target.classList.contains("hd")) drag("resize")(ev); else drag("move")(ev); });
    });
  }
  function place(el, z) { el.style.left = z.x0 * 100 + "%"; el.style.top = z.y0 * 100 + "%"; el.style.width = (z.x1 - z.x0) * 100 + "%"; el.style.height = (z.y1 - z.y0) * 100 + "%"; }
  $("rdZones").addEventListener("click", openZones);
  $("rlZones").addEventListener("click", () => { $("settingsDialog").close(); openZones(); });
  $("znClose").addEventListener("click", () => $("zonesDialog").close());
  $("znCancel").addEventListener("click", () => $("zonesDialog").close());
  $("znReset").addEventListener("click", () => { zWork = JSON.parse(JSON.stringify(R.DEFAULT_ZONES)); $("znRows").value = zWork.qty.rows; buildStage(); });
  $("znSave").addEventListener("click", () => {
    const rows = Math.max(3, Math.min(40, Number($("znRows").value) || 14)); zWork.qty.rows = rows;
    A.settings().zones = zWork; A.persistSettings();
    $("zonesDialog").close();
    // todo se vuelve a leer con las zonas nuevas
    ready().forEach((p) => { if (!(p.read && p.read.confirmed)) { p.read = null; enqueue(p); } });
    A.setStatus("Zonas guardadas. Leyendo de nuevo…", 4000); summary();
  });

  // ---------------------------------------------------------------- ajustes: aprendizaje
  function refreshSettings() {
    $("lectorChk").checked = enabled();
    const s = RL.summary(), f = s.fields;
    const pc = (k) => (f[k] && f[k].pct !== null ? Math.round(f[k].pct * 100) + " %" : "—");
    $("rlSummary").textContent = s.total ? s.total + " remitos confirmados · aciertos: fecha " + pc("date") + ", cantidades " + pc("qty") + ", cliente " + pc("client") + ", OC " + pc("oc") + " · " + s.samples + " dígitos aprendidos · confianza en el Excel " + Math.round(s.priorExcel * 100) + " %." : "Todavía no aprendió nada: confirmá remitos en “Revisar lecturas”.";
  }
  $("settingsBtn").addEventListener("click", refreshSettings);
  $("saveSettings").addEventListener("click", () => { const was = enabled(); A.settings().lector = $("lectorChk").checked; A.persistSettings(); if (!was && enabled()) ready().forEach((p) => { if (!p.read) enqueue(p); }); summary(); });
  $("rlExport").addEventListener("click", () => {
    const blob = new Blob([RL.export()], { type: "application/json" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "aprendizaje-remitos.json"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $("rlImport").addEventListener("click", () => $("rlFile").click());
  $("rlFile").addEventListener("change", async () => {
    const f = $("rlFile").files[0]; $("rlFile").value = ""; if (!f) return;
    try { RL.import(await f.text()); refreshSettings(); A.setStatus("Aprendizaje importado ✔", 4000); } catch (e) { A.setStatus("No se pudo importar: " + e.message, 6000); }
  });
  $("rlReset").addEventListener("click", async () => {
    if (!(await A.askConfirm("Se borra todo lo que el lector aprendió en este dispositivo (la red vuelve a su estado de fábrica). ¿Seguir?", "Reiniciar", "Cancelar"))) return;
    RL.reset(); refreshSettings(); A.setStatus("Aprendizaje reiniciado.", 4000);
  });

  A.onSync = summary;
  summary();
  window.Lector = { enqueue, buildCtx, openZones };
})();
