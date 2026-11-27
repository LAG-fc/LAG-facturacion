// unidades-store.js — Estado de cada "unidad de facturación" (una OC + un período), v9.0.
// Guarda lo que pasó en cada paso: tabla confirmada (coincide / despachos reales), PDF de remitos en Drive, factura
// cargada, canal (portal / mail / WhatsApp), fila de la planilla y envío del mail.
//   · Con la sesión iniciada: en la cuenta (Firestore usuarios/<uid>/unidades/<clave>) y una copia en el dispositivo.
//   · Sin cuenta: solo en este dispositivo (localStorage "unidades").
// La clave es "<cliente>|<OC>|<período>" (Flujo.unitKey). Los lotes de fotos se borran a los 15 días; esto no.
(function (root) {
  "use strict";
  const FB = () => root.LAGFirebase;
  const KEY = "unidades";
  const FIELDS = ["cliente", "oc", "periodo", "lote", "confirmacion", "tablaReal", "despachos", "remitos", "pdf", "factura", "envio", "planilla", "mail", "wpp", "sinRemitos", "creado", "actualizado"];
  const cloud = () => (root.LAGAuth && root.LAGAuth.cloud ? root.LAGAuth.cloud() : null);
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } });
  const docId = (k) => String(k).replace(/\//g, "_");
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("Tiempo de espera agotado"), { code: "deadline-exceeded" })), ms))]);

  let map = {};
  try { map = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { map = {}; }
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(map)); } catch (e) { /* nada */ } };
  const clean = (o) => { const out = {}; FIELDS.forEach((f) => { if (o[f] !== undefined) out[f] = o[f]; }); return out; };
  let lastError = "";

  // Trae las de la cuenta y las junta con las del dispositivo (gana la que se cambió más tarde).
  async function refresh() {
    const c = cloud(); if (!c) return map;
    try {
      const snap = await withTimeout(FB().getDocs(FB().collection(c.db, "usuarios", c.uid, "unidades")), 20000);
      const seen = new Set();
      snap.docs.forEach((d) => {
        const r = d.data(), k = r.key || d.id; seen.add(k);
        if (!map[k] || (r.actualizado || 0) >= (map[k].actualizado || 0)) map[k] = Object.assign({}, r, { _sync: true });
      });
      // Lo que se guardó en el dispositivo sin conexión se sube ahora
      for (const k of Object.keys(map)) if (!map[k]._sync) await pushRemote(k).catch(() => {});
      lastError = ""; persist(); emit();
    } catch (e) { console.warn("Unidades:", e); lastError = (root.LotesStore && root.LotesStore.describe ? root.LotesStore.describe(e) : e.message || String(e)); }
    return map;
  }
  async function pushRemote(k) {
    const c = cloud(); if (!c) return false;
    const data = JSON.parse(JSON.stringify(Object.assign(clean(map[k]), { key: k })));      // Firestore no acepta "undefined"
    await withTimeout(FB().setDoc(FB().doc(c.db, "usuarios", c.uid, "unidades", docId(k)), data), 20000);
    map[k]._sync = true; persist();
    return true;
  }

  // "cookmaster|93032|2026-11-01_2026-11-15" -> {cliente, oc, periodo}
  function fromKey(k) {
    const m = /^(cookmaster|grupol)\|(\d+)\|(\d{4})-(\d{2})-(\d{2})_(\d{4})-(\d{2})-(\d{2})$/.exec(String(k));
    if (!m || !root.Period) return {};
    const n = m.slice(3).map(Number);
    const periodo = root.Period.range({ y: n[0], m: n[1], d: n[2] }, { y: n[3], m: n[4], d: n[5] }, m[1] === "grupol" ? "semanal" : "quincenal", m[1] === "grupol" ? "semana" : n[2] === 1 ? "1ª quincena" : "2ª quincena");
    return { cliente: m[1], oc: m[2], periodo };
  }

  const API = {
    all: () => map,
    get: (k) => map[k] || null,
    error: () => lastError,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    refresh,
    // Cambia campos de una unidad (los objetos se reemplazan enteros). Devuelve el estado nuevo.
    async update(k, patch) {
      const now = Date.now(), prev = map[k] || Object.assign({ creado: now }, fromKey(k));
      map[k] = Object.assign({}, prev, patch, { actualizado: now, _sync: false });
      Object.keys(map[k]).forEach((f) => { if (map[k][f] === undefined) delete map[k][f]; });
      persist(); emit();
      if (cloud()) {
        try { await pushRemote(k); lastError = ""; }
        catch (e) { console.warn(e); lastError = root.LotesStore && root.LotesStore.describe ? root.LotesStore.describe(e) : String(e.message || e); }
      }
      return map[k];
    }
  };
  if (root.LAGAuth) root.LAGAuth.onUnlock(() => { refresh(); });
  root.addEventListener("online", () => refresh());
  root.UnidadesStore = API;
})(typeof self !== "undefined" ? self : this);
