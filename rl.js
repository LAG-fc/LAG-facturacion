// rl.js — Aprendizaje por refuerzo del lector de remitos.
// Cada vez que confirmás o corregís una lectura, el programa recibe una recompensa y aprende de tres maneras:
//  1) Bandido contextual: lleva la cuenta de qué estrategia de binarización acierta más en cada zona y calidad de foto (posterior Beta por estrategia)
//     y pondera sus votos según esa experiencia.
//  2) Ajuste de la red: cada dígito corregido es un ejemplo nuevo; se reentrena solo la última capa con una memoria de ejemplos (replay) para no olvidar.
//  3) Calibración: compara la confianza que mostró con la tasa real de aciertos para que el semáforo (verde/amarillo/rojo) sea honesto,
//     y ajusta cuánto confiar en el Excel según cuántas veces coincidió de verdad.
// Todo queda guardado en este navegador (se puede exportar e importar). No se envía nada a ningún servidor.
(function (root) {
  "use strict";
  const C = (typeof require === "function" && typeof module === "object") ? require("./digits-core.js") : root.DigitsCore;
  const RL = {};
  const KEY = "rlV8", MAX_REPLAY = 700, BINS = 10;
  const FIELDS = ["date", "qty", "client", "oc", "nro"];
  let S = null;

  const fresh = () => ({
    v: 8, arms: {}, calib: Array.from({ length: BINS }, () => ({ n: 0, k: 0 })),
    params: { priorExcel: C.params.priorExcel, temp: C.params.temp }, excel: { hit: 0, miss: 0 },
    head: null, replay: [], stats: { total: 0, fields: {}, recent: [] }, updated: 0
  });
  FIELDS.forEach(() => 0);

  const store = () => { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch (e) { return null; } };
  RL.load = function (json) {
    let d = null;
    if (json) { try { d = typeof json === "string" ? JSON.parse(json) : json; } catch (e) { d = null; } }
    else { const st = store(); if (st) { try { d = JSON.parse(st.getItem(KEY) || "null"); } catch (e) { d = null; } } }
    S = d && d.v === 8 ? Object.assign(fresh(), d) : fresh();
    applyState();
    return S;
  };
  RL.save = function () { const st = store(); S.updated = Date.now(); if (st) { try { st.setItem(KEY, JSON.stringify(S)); } catch (e) { /* lleno: se sigue sin guardar */ } } };
  RL.export = () => JSON.stringify(S);
  RL.import = (txt) => { const d = JSON.parse(txt); if (!d || d.v !== 8) throw new Error("No es un archivo de aprendizaje de esta versión."); S = Object.assign(fresh(), d); applyState(); RL.save(); return S; };
  RL.reset = function () { const m = C.model(); if (m) { m.w2.set(m.w2init); m.b2.set(m.b2init); } S = fresh(); applyState(); RL.save(); };
  RL.state = () => S;

  function applyState() {
    C.params.priorExcel = S.params.priorExcel; C.params.temp = S.params.temp;
    const m = C.model();
    if (m) {
      if (S.head && S.head.w2 && S.head.w2.length === m.w2.length) { m.w2.set(S.head.w2); m.b2.set(S.head.b2); }
      else { m.w2.set(m.w2init); m.b2.set(m.b2init); }
    }
  }

  // ---------------- 1) bandido: pesos por estrategia ----------------
  RL.bucket = function (an) {            // an: análisis de una estrategia de referencia
    const ink = an ? an.ink : 0.01;
    return ink < 0.004 ? "tenue" : ink > 0.03 ? "densa" : "normal";
  };
  const armKey = (zone, bucket) => zone + "|" + bucket;
  function armRec(zone, bucket, id) {
    const k = armKey(zone, bucket); if (!S.arms[k]) S.arms[k] = {};
    if (!S.arms[k][id]) S.arms[k][id] = { a: 2, b: 2 };            // creencia inicial: 50 %
    return S.arms[k][id];
  }
  // Pesos para votar: media del posterior elevada al cuadrado (más experiencia = más peso), con un piso para seguir explorando
  RL.weights = function (zone, bucket) {
    const w = {};
    C.armIds().forEach((id) => { const r = armRec(zone, bucket, id); w[id] = 0.12 + Math.pow(r.a / (r.a + r.b), 2); });
    return w;
  };
  RL.armTable = function (zone, bucket) { return C.armIds().map((id) => { const r = armRec(zone, bucket, id), c = C.ARMS.find((x) => x.id === id); return { id, name: c.name, mean: r.a / (r.a + r.b), n: r.a + r.b - 4 }; }); };

  // ---------------- 3) calibración ----------------
  RL.calibrate = function (c) {
    const i = Math.min(BINS - 1, Math.max(0, Math.floor(c * BINS))), b = S.calib[i];
    if (b.n < 8) return c;                                              // sin datos suficientes se muestra la confianza cruda
    const emp = (b.k + 1) / (b.n + 2);
    return Math.min(0.995, Math.max(0.01, 0.4 * c + 0.6 * emp));
  };
  function noteOutcome(field, conf, ok) {
    const i = Math.min(BINS - 1, Math.max(0, Math.floor(conf * BINS))); S.calib[i].n++; if (ok) S.calib[i].k++;
    const f = S.stats.fields[field] || (S.stats.fields[field] = { n: 0, k: 0, recent: [] });
    f.n++; if (ok) f.k++; f.recent.push(ok ? 1 : 0); if (f.recent.length > 40) f.recent.shift();
  }

  // ---------------- 2) red: última capa con memoria de ejemplos ----------------
  const qz = (feat) => { const u = new Uint8Array(257); for (let i = 0; i < 257; i++) u[i] = Math.max(0, Math.min(255, Math.round(feat[i] * 255))); return u; };
  const b64 = (u) => { let s = ""; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return typeof btoa === "function" ? btoa(s) : Buffer.from(s, "binary").toString("base64"); };
  const unb64 = (t) => { const s = typeof atob === "function" ? atob(t) : Buffer.from(t, "base64").toString("binary"), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
  const deq = (u) => { const f = new Float32Array(257); for (let i = 0; i < 257; i++) f[i] = u[i] / 255; return f; };

  function addSample(feat, y) {
    S.replay.push({ f: b64(qz(feat)), y });
    if (S.replay.length > MAX_REPLAY) S.replay.splice(0, S.replay.length - MAX_REPLAY);
  }
  function trainHead(newCount) {
    const m = C.model(); if (!m || !S.replay.length) return;
    const hid = m.hid, out = m.out, lr = 0.06, lam = 0.002;
    const take = Math.min(S.replay.length, Math.max(48, newCount * 6));
    for (let ep = 0; ep < 4; ep++) {
      const batch = [];
      for (let i = 0; i < newCount && i < S.replay.length; i++) batch.push(S.replay[S.replay.length - 1 - i]);    // los nuevos siempre
      while (batch.length < take) batch.push(S.replay[Math.floor(Math.random() * S.replay.length)]);
      batch.forEach((s) => {
        const f = C.forward(deq(unb64(s.f))), p = f.p;
        for (let k = 0; k < out; k++) {
          const g = p[k] - (k === s.y ? 1 : 0);
          for (let j = 0; j < hid; j++) { const idx = j * out + k; m.w2[idx] -= lr * (g * f.h[j] + lam * (m.w2[idx] - m.w2init[idx])); }
          m.b2[k] -= lr * g;
        }
      });
    }
    S.head = { w2: Array.from(m.w2, (x) => Math.round(x * 1e4) / 1e4), b2: Array.from(m.b2, (x) => Math.round(x * 1e4) / 1e4) };
  }

  // Dígitos de una fila de fichas alineados con la verdad (solo si coinciden en cantidad)
  function digitToks(toks) { return toks.filter((t) => t.k === "d"); }
  function collectSamples(toks, digits, out) {
    const dt = digitToks(toks);
    if (dt.length !== digits.length) return 0;
    dt.forEach((t, i) => out.push({ feat: t.feat, y: digits.charCodeAt(i) - 48 }));
    return dt.length;
  }

  // ---------------- retroalimentación ----------------
  // fb = { an, ctx, shown, truth } — an: análisis de todas las estrategias; shown: lo que se mostró; truth: lo que confirmó el usuario
  //   truth = { date:{d,m,y}, nro:"980", rows:{"0":496.68}, oc:"91199", client:"up59" }
  RL.learn = function (fb) {
    if (!S) RL.load();
    const an = fb.an, truth = fb.truth, shown = fb.shown || {}, ctx = fb.ctx || {};
    const bucketQ = RL.bucket((an.qty.find((x) => x.arm === "fina") || an.qty[0] || {}).an);
    const bucketD = (an.date && an.date.length) ? RL.bucket((an.date.find((x) => x.arm === "fina") || an.date[0] || {}).an) : null;
    const eq = (a, b) => Math.abs(a - b) < 0.005;
    const samples = [];
    let reward = 0, nf = 0;

    // fecha
    if (truth.date && truth.date.d && an.date && an.date.length) {
      an.date.forEach((a) => { const r = C.decodeDate([a], { [a.arm]: 1 }, ctx); const ok = r.d === truth.date.d && r.m === truth.date.m; const rec = armRec("date", bucketD, a.arm); if (ok) rec.a++; else rec.b++; });
      if (shown.date) { const ok = shown.date.d === truth.date.d && shown.date.m === truth.date.m; noteOutcome("date", Math.min(shown.date.conf.d, shown.date.conf.m), ok); reward += ok ? 1 : 0; nf++; }
      const ref = an.date.find((x) => x.arm === "fina") || an.date[0];
      if (ref) {
        const cells = [String(truth.date.d).padStart(2, "0"), String(truth.date.m).padStart(2, "0"), String(truth.date.y)];
        const parts = splitDateCells(ref.an);
        cells.forEach((c, i) => { const dt = digitToks(parts[i] || []); if (dt.length === c.length) dt.forEach((t, k) => samples.push({ feat: t.feat, y: c.charCodeAt(k) - 48 })); else if (i === 2 && dt.length === 2 && c.length === 4) dt.forEach((t, k) => samples.push({ feat: t.feat, y: c.charCodeAt(k + 2) - 48 })); });
      }
    }
    // cantidades
    if (truth.rows && Object.keys(truth.rows).length) {
      let day = truth.date ? truth.date.d : null, keys = Object.keys(truth.rows), qctx = ctx;
      if (ctx.noDate && ctx.dayData) {                                   // sin fecha: cada entrega (día × cliente) es una hipótesis
        const all = {}; Object.keys(ctx.dayData).forEach((d) => Object.keys(ctx.dayData[d]).forEach((c) => { all[c + "|" + d] = ctx.dayData[d][c]; }));
        qctx = Object.assign({}, ctx, { dayData: { all } }); day = "all";
      }
      an.qty.forEach((a) => {
        const r = C.decodeQty([a], { [a.arm]: 1 }, qctx, day, an.geom);
        const ok = r.rows.length === keys.length && keys.every((k) => { const g = r.rows.find((x) => x.row === Number(k)); return g && g.value !== null && eq(g.value, truth.rows[k]); });
        const rec = armRec("qty", bucketQ, a.arm); if (ok) rec.a++; else rec.b++;
      });
      if (shown.qty) {
        keys.forEach((k) => { const g = shown.qty.rows.find((x) => x.row === Number(k)); const ok = !!g && g.value !== null && eq(g.value, truth.rows[k]); noteOutcome("qty", g ? g.conf : 0.3, ok); reward += ok ? 1 : 0; nf++; });
        shown.qty.rows.forEach((g) => { if (truth.rows[g.row] === undefined && g.value !== null) { noteOutcome("qty", g.conf, false); nf++; } });
      }
      // ¿coincidió el valor confirmado con el Excel? (ajusta cuánto confiar en él)
      const dayEntries = qctx.dayData && day && qctx.dayData[day];
      if (dayEntries) {
        const matched = Object.keys(dayEntries).some((c) => { const vs = dayEntries[c].any || []; return keys.every((k) => vs.some((v) => eq(v, truth.rows[k]))); });
        if (matched) S.excel.hit++; else S.excel.miss++;
        S.params.priorExcel = Math.min(0.97, Math.max(0.6, (S.excel.hit + 9) / (S.excel.hit + S.excel.miss + 10)));
      }
      // ejemplos de dígitos: se usan las dos estrategias de más peso
      const w = RL.weights("qty", bucketQ), top = an.qty.slice().sort((x, y) => (w[y.arm] || 0) - (w[x.arm] || 0)).slice(0, 2);
      top.forEach((a) => {
        keys.forEach((k) => {
          const row = a.an.rows.find((r) => Math.max(0, Math.round((r.cy - an.geom.firstCy) / an.geom.pitch)) === Number(k)); if (!row) return;
          const vd = C.valueVariants(truth.rows[k]);
          const dt = digitToks(row.toks); const v = vd.find((x) => x.digits.length === dt.length); if (v) dt.forEach((t, i) => samples.push({ feat: t.feat, y: v.digits.charCodeAt(i) - 48 }));
        });
      });
    }
    if (truth.client !== undefined && shown.qty && shown.qty.client) {
      const ok = (shown.qty.client.id || null) === (truth.client || null); noteOutcome("client", shown.qty.client.conf || 0.2, ok); reward += ok ? 1 : 0; nf++;
    }
    if (truth.oc !== undefined && shown.oc && (truth.oc || shown.oc.num)) { const ok = (shown.oc.num || "") === (truth.oc || ""); noteOutcome("oc", shown.oc.conf || 0.2, ok); reward += ok ? 1 : 0; nf++; }
    if (truth.nro && shown.nro && shown.nro.text !== undefined) { const ok = shown.nro.text === String(Number(truth.nro)); noteOutcome("nro", shown.nro.conf || 0.5, ok); reward += ok ? 1 : 0; nf++; }

    samples.forEach((s) => addSample(s.feat, s.y));
    if (samples.length) trainHead(samples.length);
    S.stats.total++;
    const r = nf ? reward / nf : 1; S.stats.recent.push(r >= 0.999 ? 1 : 0); if (S.stats.recent.length > 40) S.stats.recent.shift();
    RL.save();
    return { reward: r, samples: samples.length, fields: nf };
  };
  function splitDateCells(an) { const row = an.rows[0]; return row ? C.splitDateCells(row, an.w) : [[], [], []]; }

  RL.summary = function () {
    if (!S) RL.load();
    const f = {}; Object.keys(S.stats.fields).forEach((k) => { const x = S.stats.fields[k]; f[k] = { n: x.n, pct: x.n ? x.k / x.n : null, recent: x.recent.length ? x.recent.reduce((a, b) => a + b, 0) / x.recent.length : null }; });
    const rc = S.stats.recent;
    return { total: S.stats.total, perfectRecent: rc.length ? rc.reduce((a, b) => a + b, 0) / rc.length : null, fields: f, samples: S.replay.length, priorExcel: S.params.priorExcel, excel: S.excel };
  };

  RL.load();
  if (typeof module === "object" && module.exports) module.exports = RL; else root.RemitoRL = RL;
})(typeof self !== "undefined" ? self : this);
