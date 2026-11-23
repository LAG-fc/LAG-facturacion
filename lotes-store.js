// lotes-store.js — Dónde se guardan los "PDF guardados" (cada lote de remitos escaneados), v8.3.
//
// · Con la sesión iniciada (cuenta aprobada) se guardan en la cuenta del usuario, en Cloud Firestore
//   (Firebase, plan gratuito "Spark", sin tarjeta). Así se sacan las fotos con el celular y la tabla de
//   recepciones se completa desde la computadora:
//       usuarios/<uid>/lotes/<id>               datos del lote: período, tabla de recepciones, estado, miniatura
//       usuarios/<uid>/lotes/<id>/partes/<p-k>  las fotos (JPEG), en partes de hasta 900 KB
//                                               (Firestore admite hasta 1 MB por documento)
//   (Firebase Storage ya no es gratis: desde 2026 exige el plan pago Blaze. Por eso las fotos van en Firestore.)
// · Primero se guarda todo en este dispositivo (IndexedDB) y después se sube. Si no hay conexión, el lote queda
//   "sin subir" y se reintenta solo. Sin cuenta (Firebase sin configurar) los lotes quedan solo en el dispositivo.
// · Los lotes enviados al borrador de Gmail se borran solos a los 15 días (el PDF queda en Drive).
(function (root) {
  "use strict";
  const FB = () => root.LAGFirebase;
  const CHUNK = 900 * 1024;
  const KEEP_SENT_MS = 15 * 24 * 3600 * 1000;
  const CLOUD_KEYS = ["creado", "actualizado", "paginas", "partes", "tamano", "subido", "periodo", "miniatura", "tabla", "estado", "enviado", "carpeta", "archivo"];
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } });

  // ---------------------------------------------------------------- cuenta
  const cloud = () => (root.LAGAuth && root.LAGAuth.cloud ? root.LAGAuth.cloud() : null);
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("Tiempo de espera agotado"), { code: "deadline-exceeded" })), ms))]);
  const isNet = (e) => !navigator.onLine || (e && ["unavailable", "deadline-exceeded", "auth/network-request-failed"].includes(e.code));

  // Mensaje claro para cada error de Firebase.
  function describe(e) {
    const code = (e && e.code) || "";
    if (isNet(e)) return "No hay conexión a internet (o es muy lenta).";
    if (code === "permission-denied") return "Firebase no permitió guardar los PDF en tu cuenta: falta publicar las reglas nuevas de firestore.rules (INSTRUCCIONES-USUARIOS.txt, paso 5).";
    if (code === "resource-exhausted") return "Se alcanzó el límite gratuito diario de Firebase. Se vuelve a intentar más tarde.";
    if (code === "unauthenticated") return "La sesión venció. Cerrá la sesión y volvé a ingresar.";
    if (code === "invalid-argument") return "Firebase rechazó los datos (" + ((e && e.message) || code) + ").";
    return "Error de Firebase" + (code ? " (" + code + ")" : "") + ": " + ((e && e.message) || e);
  }

  // ---------------------------------------------------------------- dispositivo (IndexedDB)
  let idbP = null;
  function idb() {
    if (idbP) return idbP;
    idbP = new Promise((res, rej) => {
      if (!root.indexedDB) { rej(new Error("Este navegador no permite guardar datos en el dispositivo.")); return; }
      const rq = indexedDB.open("lag-remitos", 1);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains("lotes")) d.createObjectStore("lotes", { keyPath: "id" });
        if (!d.objectStoreNames.contains("fotos")) d.createObjectStore("fotos", { keyPath: ["lote", "pagina"] });
      };
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error || new Error("No se pudo abrir el almacenamiento del dispositivo."));
    });
    idbP.catch(() => { idbP = null; });
    return idbP;
  }
  // Ejecuta fn(transacción) y espera a que termine. fn solo debe hacer pedidos a IndexedDB (sin await en el medio).
  function tx(stores, mode, fn) {
    return idb().then((d) => new Promise((res, rej) => {
      const t = d.transaction(stores, mode), out = {};
      t.oncomplete = () => res(out.v);
      t.onerror = () => rej(t.error || new Error("Error del almacenamiento del dispositivo."));
      t.onabort = () => rej(t.error || new Error("No hay espacio suficiente en el dispositivo."));
      fn(t, out);
    }));
  }
  const fotoRange = (id) => IDBKeyRange.bound([id, 0], [id, 1e9]);
  const local = {
    all: () => tx(["lotes"], "readonly", (t, out) => { t.objectStore("lotes").getAll().onsuccess = (e) => { out.v = e.target.result || []; }; }),
    get: (id) => tx(["lotes"], "readonly", (t, out) => { t.objectStore("lotes").get(id).onsuccess = (e) => { out.v = e.target.result || null; }; }),
    put: (rec) => tx(["lotes"], "readwrite", (t) => { t.objectStore("lotes").put(rec); }),
    putAll: (rec, fotos) => tx(["lotes", "fotos"], "readwrite", (t) => {
      t.objectStore("lotes").put(rec);
      const st = t.objectStore("fotos");
      fotos.forEach((f, i) => st.put({ lote: rec.id, pagina: i, w: f.w, h: f.h, datos: f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength) }));
    }),
    fotos: (id) => tx(["fotos"], "readonly", (t, out) => {
      t.objectStore("fotos").getAll(fotoRange(id)).onsuccess = (e) => {
        out.v = (e.target.result || []).sort((a, b) => a.pagina - b.pagina).map((f) => ({ bytes: new Uint8Array(f.datos), w: f.w, h: f.h }));
      };
    }),
    remove: (id) => tx(["lotes", "fotos"], "readwrite", (t) => { t.objectStore("lotes").delete(id); t.objectStore("fotos").delete(fotoRange(id)); })
  };

  // ---------------------------------------------------------------- cuenta (Firestore)
  const lotesCol = (c) => FB().collection(c.db, "usuarios", c.uid, "lotes");
  const loteDoc = (c, id) => FB().doc(c.db, "usuarios", c.uid, "lotes", id);
  const partesCol = (c, id) => FB().collection(c.db, "usuarios", c.uid, "lotes", id, "partes");
  const toCloud = (rec) => { const o = {}; CLOUD_KEYS.forEach((k) => { if (rec[k] !== undefined) o[k] = rec[k]; }); return o; };
  const remote = {
    async all(c) {
      const snap = await withTimeout(FB().getDocs(lotesCol(c)), 20000);
      return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    },
    put: (c, rec) => withTimeout(FB().setDoc(loteDoc(c, rec.id), toCloud(rec)), 30000),
    update: (c, id, patch) => withTimeout(FB().updateDoc(loteDoc(c, id), toCloud(patch)), 30000),
    async putFotos(c, id, fotos, onProgress) {
      let n = 0;
      for (let i = 0; i < fotos.length; i++) {
        const f = fotos[i], parts = Math.max(1, Math.ceil(f.bytes.length / CHUNK));
        for (let k = 0; k < parts; k++) {
          const datos = FB().Bytes.fromUint8Array(f.bytes.subarray(k * CHUNK, (k + 1) * CHUNK));
          const pid = String(i).padStart(3, "0") + "-" + k;
          await withTimeout(FB().setDoc(FB().doc(c.db, "usuarios", c.uid, "lotes", id, "partes", pid), { pagina: i, parte: k, de: parts, w: f.w, h: f.h, datos }), 120000);
          n++;
        }
        if (onProgress) onProgress(i + 1, fotos.length);
      }
      return n;
    },
    async fotos(c, id) {
      const snap = await withTimeout(FB().getDocs(partesCol(c, id)), 120000);
      const pages = new Map();
      snap.docs.forEach((d) => {
        const x = d.data(), p = pages.get(x.pagina) || { w: x.w, h: x.h, de: x.de, parts: [] };
        p.parts[x.parte] = x.datos.toUint8Array(); pages.set(x.pagina, p);
      });
      return [...pages.keys()].sort((a, b) => a - b).map((k) => {
        const p = pages.get(k);
        if (p.parts.length !== p.de || p.parts.some((x) => !x)) throw new Error("Falta una parte de la foto " + (k + 1) + " (la subida no terminó).");
        const total = p.parts.reduce((s, x) => s + x.length, 0), bytes = new Uint8Array(total);
        let o = 0; p.parts.forEach((x) => { bytes.set(x, o); o += x.length; });
        return { bytes, w: p.w, h: p.h };
      });
    },
    async remove(c, id) {
      const snap = await withTimeout(FB().getDocs(partesCol(c, id)), 30000);
      const ids = snap.docs.map((d) => d.id);
      for (let i = 0; i < ids.length; i += 6) await Promise.all(ids.slice(i, i + 6).map((pid) => FB().deleteDoc(FB().doc(c.db, "usuarios", c.uid, "lotes", id, "partes", pid))));
      await withTimeout(FB().deleteDoc(loteDoc(c, id)), 30000);
    }
  };

  // ---------------------------------------------------------------- miniatura
  async function miniatura(blob) {
    try {
      const bmp = await createImageBitmap(blob), w = 180, h = Math.round(bmp.height * (w / bmp.width));
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const x = cv.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(bmp, 0, 0, w, h); if (bmp.close) bmp.close();
      return cv.toDataURL("image/jpeg", 0.62);
    } catch (e) { return ""; }
  }
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // ---------------------------------------------------------------- subir lo pendiente
  const uploading = new Map();          // id -> {done, total}
  async function upload(id, onProgress) {
    const c = cloud();
    if (!c) throw new Error("Iniciá sesión para subir los PDF a tu cuenta.");
    if (uploading.has(id)) return false;
    uploading.set(id, { done: 0, total: 0 }); emit();
    try {
      const rec = await local.get(id);
      if (!rec) return false;
      const fotos = await local.fotos(id);
      if (!fotos.length) throw new Error("No se encontraron las fotos en este dispositivo.");
      const meta = Object.assign({}, rec, { subido: false, actualizado: Date.now() });
      await remote.put(c, meta);
      const partes = await remote.putFotos(c, id, fotos, (d, t) => { uploading.set(id, { done: d, total: t }); emit(); if (onProgress) onProgress(d, t); });
      await remote.update(c, id, { subido: true, partes, actualizado: Date.now() });
      await local.remove(id);
      return true;
    } catch (e) {
      try { const rec = await local.get(id); if (rec) { rec.error = describe(e); await local.put(rec); } } catch (e2) { /* nada */ }
      throw e;
    } finally { uploading.delete(id); emit(); }
  }
  let retrying = false;
  async function retryUploads() {
    const c = cloud();
    if (!c || retrying || !navigator.onLine) return;
    retrying = true;
    try {
      const mine = (await local.all().catch(() => [])).filter((r) => r.pendiente && (r.uid === c.uid || !r.uid));
      for (const r of mine) {
        if (!r.uid) { r.uid = c.uid; await local.put(r).catch(() => {}); }    // guardado sin cuenta: pasa a la cuenta actual
        try { await upload(r.id); } catch (e) { console.warn("No se pudo subir el lote " + r.id + ":", e); if (!isNet(e)) break; }
      }
    } finally { retrying = false; emit(); }
  }
  root.addEventListener("online", () => { retryUploads(); });

  // ---------------------------------------------------------------- API
  const API = {
    describe,
    mode: () => (cloud() ? "cloud" : "local"),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    uploadingInfo: (id) => uploading.get(id) || null,
    retryUploads,
    upload,

    // Lista de lotes: los de la cuenta + los que siguen en este dispositivo. {items, error}
    async list() {
      const c = cloud();
      let locals = await local.all().catch(() => []);
      locals = locals.filter((r) => (c ? (r.uid === c.uid || !r.uid) : !r.uid));
      let items = [], error = null;
      if (c) {
        try { items = await remote.all(c); } catch (e) { console.warn("Lista de PDF guardados:", e); error = describe(e); }
      }
      const map = new Map(items.map((r) => [r.id, Object.assign(r, { where: "cloud" })]));
      locals.forEach((r) => {
        const cl = map.get(r.id);
        if (cl && cl.subido && !uploading.has(r.id)) { local.remove(r.id).catch(() => {}); return; }   // ya está en la cuenta
        map.set(r.id, Object.assign({}, r, { where: "local" }));
      });
      const now = Date.now(), out = [];
      for (const r of map.values()) {
        if (r.estado === "enviado" && r.enviado && now - r.enviado > KEEP_SENT_MS) { API.remove(r).catch(() => {}); continue; }
        out.push(r);
      }
      out.sort((a, b) => (b.creado || 0) - (a.creado || 0));
      if (c && locals.some((r) => r.pendiente)) setTimeout(retryUploads, 300);
      return { items: out, error };
    },

    // Guarda las fotos recién escaneadas. shots = [{blob, w, h}]. Devuelve {id, cloud, reason}
    async save(shots, periodo, onProgress) {
      const c = cloud();
      const fotos = [];
      for (const s of shots) fotos.push({ bytes: new Uint8Array(await s.blob.arrayBuffer()), w: s.w, h: s.h });
      const now = Date.now();
      const rec = {
        id: newId(), creado: now, actualizado: now, paginas: fotos.length, partes: 0,
        tamano: fotos.reduce((s, f) => s + f.bytes.length, 0), subido: false,
        periodo: Object.assign({}, periodo), miniatura: await miniatura(shots[0].blob),
        tabla: { oc: "", valores: [], extras: [] }, estado: "pendiente", enviado: null, carpeta: "", archivo: "",
        uid: c ? c.uid : null, pendiente: !!c, error: ""
      };
      let savedLocal = true;
      try { await local.putAll(rec, fotos); } catch (e) { console.warn("No se pudo guardar en el dispositivo:", e); savedLocal = false; }
      if (!c) {
        if (!savedLocal) throw new Error("No hay espacio para guardar en este dispositivo.");
        emit(); return { id: rec.id, cloud: false, reason: "", fotos };
      }
      if (!savedLocal) {                 // sin almacenamiento local (por ejemplo, navegación privada): se sube directo
        const meta = Object.assign({}, rec, { subido: false });
        try {
          await remote.put(c, meta);
          const partes = await remote.putFotos(c, rec.id, fotos, onProgress);
          await remote.update(c, rec.id, { subido: true, partes, actualizado: Date.now() });
          emit(); return { id: rec.id, cloud: true, fotos };
        } catch (e) { throw new Error(describe(e)); }
      }
      try { await upload(rec.id, onProgress); return { id: rec.id, cloud: true, fotos }; }
      catch (e) { emit(); return { id: rec.id, cloud: false, reason: describe(e), fotos }; }
    },

    // Fotos de un lote: [{bytes (JPEG), w, h}]
    fotos(item) {
      if (item.where === "local") return local.fotos(item.id);
      const c = cloud();
      if (!c) return Promise.reject(new Error("Iniciá sesión para ver este PDF."));
      return remote.fotos(c, item.id).catch((e) => { throw new Error(e.code ? describe(e) : e.message); });
    },

    // Cambia datos del lote (tabla, período, estado...). Devuelve el lote actualizado.
    async update(item, patch) {
      patch = Object.assign({}, patch, { actualizado: Date.now() });
      if (item.where === "local") {
        const rec = await local.get(item.id);
        if (!rec) throw new Error("El PDF ya no está en este dispositivo (quizás ya se subió). Actualizá la lista.");
        Object.assign(rec, patch); await local.put(rec);
      } else {
        const c = cloud();
        if (!c) throw new Error("Iniciá sesión para modificar este PDF.");
        try { await remote.update(c, item.id, patch); } catch (e) { throw new Error(describe(e)); }
      }
      Object.assign(item, patch); emit();
      return item;
    },

    async remove(item) {
      if (item.where === "local") await local.remove(item.id);
      else {
        const c = cloud();
        if (!c) throw new Error("Iniciá sesión para borrar este PDF.");
        try { await remote.remove(c, item.id); } catch (e) { throw new Error(describe(e)); }
      }
      emit();
    },

    // Cuántos lotes de este usuario siguen sin subir en este dispositivo
    async pendingCount() {
      const c = cloud();
      const all = await local.all().catch(() => []);
      return all.filter((r) => r.pendiente && (!c || r.uid === c.uid)).length;
    }
  };
  root.LotesStore = API;
})(typeof self !== "undefined" ? self : this);
