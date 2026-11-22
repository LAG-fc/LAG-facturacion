// pdftext.js — Lee el TEXTO que ya trae un PDF (sin OCR). Devuelve cada fragmento con su posición en la hoja.
// Sirve para PDFs generados por sistemas (como las órdenes de compra), no para PDFs que son una foto escaneada.
(function (root) {
  "use strict";

  const CP1252 = { 0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž",
    0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ" };
  const decByte = (b) => CP1252[b] || String.fromCharCode(b);

  async function inflate(bytes) {
    const ds = new DecompressionStream("deflate");                    // los PDF usan formato zlib = "deflate"
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }

  // ---- 1) Objetos del PDF ----
  function parseObjects(bin) {
    const objs = new Map();
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(bin))) {
      const num = Number(m[1]), start = re.lastIndex;
      const endobj = bin.indexOf("endobj", start);
      const sp = bin.indexOf("stream", start);
      let o;
      if (sp !== -1 && (endobj === -1 || sp < endobj) && /^\s*$|>>\s*$/.test(bin.slice(Math.max(start, sp - 4), sp))) {
        let ds = sp + 6;
        if (bin[ds] === "\r") ds++;
        if (bin[ds] === "\n") ds++;
        let de = bin.indexOf("endstream", ds);
        if (de === -1) de = bin.length;
        o = { num, gen: Number(m[2]), dict: bin.slice(start, sp), ds, de };
        re.lastIndex = de + 9;
      } else {
        o = { num, gen: Number(m[2]), dict: bin.slice(start, endobj === -1 ? bin.length : endobj) };
        if (endobj !== -1) re.lastIndex = endobj + 6;
      }
      objs.set(num, o);
    }
    return objs;
  }

  const refs = (s) => { const out = []; const r = /(\d+)\s+\d+\s+R/g; let m; while ((m = r.exec(s))) out.push(Number(m[1])); return out; };

  function pageList(objs) {
    const pages = [];
    const seen = new Set();
    const walk = (n) => {
      if (seen.has(n)) return; seen.add(n);
      const o = objs.get(n); if (!o) return;
      if (/\/Type\s*\/Pages\b/.test(o.dict) || /\/Kids\b/.test(o.dict)) {
        const k = /\/Kids\s*\[([^\]]*)\]/.exec(o.dict);
        if (k) refs(k[1]).forEach(walk);
      } else if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(n);
    };
    for (const o of objs.values()) if (/\/Type\s*\/Catalog\b/.test(o.dict)) { const p = /\/Pages\s+(\d+)\s+\d+\s+R/.exec(o.dict); if (p) walk(Number(p[1])); }
    if (!pages.length) for (const [n, o] of objs) if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(n);   // plan B: orden de aparición
    return pages;
  }

  // ASCII85 (algunos generadores, como reportlab, lo usan antes de Flate)
  function ascii85(d) {
    const out = []; let g = [], i = 0;
    let str = ""; for (let k = 0; k < d.length; k++) str += String.fromCharCode(d[k]);
    str = str.replace(/^\s*<~/, "");
    for (i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === "~") break;
      if (/\s/.test(ch)) continue;
      if (ch === "z" && !g.length) { out.push(0, 0, 0, 0); continue; }
      g.push(ch.charCodeAt(0) - 33);
      if (g.length === 5) { let v = 0; for (const x of g) v = v * 85 + x; out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); g = []; }
    }
    if (g.length > 1) { const n = g.length; while (g.length < 5) g.push(84); let v = 0; for (const x of g) v = v * 85 + x; const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; out.push(...b.slice(0, n - 1)); }
    return new Uint8Array(out);
  }

  let decrypt = null;                       // descifrado del PDF actual (null si no está protegido)
  async function streamOf(objs, bytes, n) {
    const o = objs.get(n);
    if (!o || o.ds === undefined) return "";
    let data = bytes.subarray(o.ds, o.de);
    // quita el salto de línea que precede a "endstream"
    if (data.length && data[data.length - 1] === 10) data = data.subarray(0, data.length - 1);
    if (data.length && data[data.length - 1] === 13) data = data.subarray(0, data.length - 1);
    if (decrypt) data = await decrypt(data, n, o.gen || 0);
    const f = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(o.dict);
    if (f) {
      const a85 = /ASCII85Decode|\/A85\b/.test(f[1]);
      if (/FlateDecode|\/Fl\b/.test(f[1]) && !/DCT|LZW|RunLength|CCITT|JBIG|JPX/.test(f[1])) {
        if (a85) data = ascii85(data);
        data = await inflate(data);
      } else return "";                                                // filtro no soportado
    }
    let s = ""; for (let i = 0; i < data.length; i += 8192) s += String.fromCharCode.apply(null, data.subarray(i, i + 8192));
    return s;
  }

  // ---- 2) Contenido de una página: operadores de texto ----
  const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];

  function readString(s, i) {                // s[i] === "("
    let depth = 1, out = ""; i++;
    while (i < s.length && depth > 0) {
      const c = s[i];
      if (c === "\\") {
        const n = s[i + 1];
        if (n === "n") { out += "\n"; i += 2; } else if (n === "r") { out += "\r"; i += 2; } else if (n === "t") { out += "\t"; i += 2; }
        else if (n === "b") { out += "\b"; i += 2; } else if (n === "f") { out += "\f"; i += 2; }
        else if (/[0-7]/.test(n)) { let o = ""; let k = i + 1; while (k < i + 4 && /[0-7]/.test(s[k])) o += s[k++]; out += decByte(parseInt(o, 8) & 255); i = k; }
        else if (n === "\r") { i += s[i + 2] === "\n" ? 3 : 2; } else if (n === "\n") { i += 2; }
        else { out += n; i += 2; }
      } else if (c === "(") { depth++; out += c; i++; }
      else if (c === ")") { depth--; if (depth > 0) out += c; i++; }
      else { out += decByte(c.charCodeAt(0) & 255); i++; }
    }
    return { str: out, end: i };
  }

  function pageItems(content) {
    const items = [];
    let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
    let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0], leading = 0, last = null;
    const st = [];                                                      // operandos
    const push = (str) => {
      const t = mul(tm, ctm);
      if (last) { last.str += str; return; }                            // otro Tj sin reposicionar: sigue la misma línea
      last = { x: t[4], y: t[5], str }; items.push(last);
    };
    const moveTo = (tx, ty) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm.slice(); last = null; };
    const s = content, n = s.length;
    let i = 0;
    while (i < n) {
      const c = s[i];
      if (c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0") { i++; continue; }
      if (c === "%") { while (i < n && s[i] !== "\n" && s[i] !== "\r") i++; continue; }
      if (c === "(") { const r = readString(s, i); st.push({ t: "s", v: r.str }); i = r.end; continue; }
      if (c === "<" && s[i + 1] !== "<") {
        const e = s.indexOf(">", i); const hex = s.slice(i + 1, e).replace(/\s+/g, ""); let out = "";
        for (let k = 0; k + 1 < hex.length + 1; k += 2) out += decByte(parseInt(hex.substr(k, 2).padEnd(2, "0"), 16));
        st.push({ t: "s", v: out }); i = e + 1; continue;
      }
      if (c === "<" || c === ">") { i += s[i + 1] === c ? 2 : 1; continue; }
      if (c === "[") {
        i++; const arr = [];
        while (i < n && s[i] !== "]") {
          if (s[i] === "(") { const r = readString(s, i); arr.push(r.str); i = r.end; }
          else if (/[-+.\d]/.test(s[i])) { let k = i; while (k < n && /[-+.\d]/.test(s[k])) k++; arr.push(Number(s.slice(i, k))); i = k; }
          else i++;
        }
        i++; st.push({ t: "a", v: arr }); continue;
      }
      if (c === "/") { let k = i + 1; while (k < n && !/[\s/\[\]()<>%]/.test(s[k])) k++; st.push({ t: "n", v: s.slice(i + 1, k) }); i = k; continue; }
      if (/[-+.\d]/.test(c)) { let k = i; while (k < n && /[-+.\d]/.test(s[k])) k++; st.push({ t: "#", v: Number(s.slice(i, k)) }); i = k; continue; }
      let k = i; while (k < n && !/[\s/\[\]()<>%]/.test(s[k])) k++;
      const op = s.slice(i, k); i = k;
      const num = (j) => { const o = st[st.length - j]; return o && o.t === "#" ? o.v : 0; };
      switch (op) {
        case "q": stack.push(ctm.slice()); break;
        case "Q": if (stack.length) ctm = stack.pop(); break;
        case "cm": ctm = mul([num(6), num(5), num(4), num(3), num(2), num(1)], ctm); break;
        case "BT": tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); last = null; break;
        case "Td": moveTo(num(2), num(1)); break;
        case "TD": leading = -num(1); moveTo(num(2), num(1)); break;
        case "TL": leading = num(1); break;
        case "Tm": tm = [num(6), num(5), num(4), num(3), num(2), num(1)]; tlm = tm.slice(); last = null; break;
        case "T*": moveTo(0, -leading); break;
        case "Tj": { const o = st[st.length - 1]; if (o && o.t === "s") push(o.v); break; }
        case "'": { moveTo(0, -leading); const o = st[st.length - 1]; if (o && o.t === "s") push(o.v); break; }
        case "\"": { moveTo(0, -leading); const o = st[st.length - 1]; if (o && o.t === "s") push(o.v); break; }
        case "TJ": {
          const o = st[st.length - 1];
          if (o && o.t === "a") { let str = ""; for (const p of o.v) { if (typeof p === "string") str += p; else if (p < -200) str += " "; } push(str); }
          break;
        }
        default: break;
      }
      st.length = 0;
    }
    return items.filter((it) => it.str.trim() !== "").map((it) => ({ x: Math.round(it.x * 100) / 100, y: Math.round(it.y * 100) / 100, str: it.str.replace(/\s+$/, "") }));
  }

  // ---- protección con clave de usuario vacía ----
  function strAt(s, i) {                       // texto binario en s[i] ("<hex>" o "(literal)")
    if (s[i] === "<") { const hex = s.slice(i + 1, s.indexOf(">", i)).replace(/\s+/g, ""); let out = ""; for (let k = 0; k + 1 < hex.length + 1; k += 2) out += String.fromCharCode(parseInt(hex.substr(k, 2).padEnd(2, "0"), 16)); return out; }
    if (s[i] !== "(") return "";
    let depth = 1, out = ""; i++;                                    // texto literal en bytes crudos (sin convertir caracteres)
    while (i < s.length && depth > 0) {
      const c = s[i];
      if (c === "\\") {
        const n = s[i + 1];
        if (n === "n") { out += "\n"; i += 2; } else if (n === "r") { out += "\r"; i += 2; } else if (n === "t") { out += "\t"; i += 2; }
        else if (n === "b") { out += "\b"; i += 2; } else if (n === "f") { out += "\f"; i += 2; }
        else if (/[0-7]/.test(n)) { let o = "", k = i + 1; while (k < i + 4 && /[0-7]/.test(s[k])) o += s[k++]; out += String.fromCharCode(parseInt(o, 8) & 255); i = k; }
        else if (n === "\r") { i += s[i + 2] === "\n" ? 3 : 2; } else if (n === "\n") { i += 2; }
        else { out += n; i += 2; }
      } else if (c === "(") { depth++; out += c; i++; } else if (c === ")") { depth--; if (depth > 0) out += c; i++; } else { out += c; i++; }
    }
    return out;
  }
  function pdfString(dict, key) {
    const m = new RegExp("/" + key + "\\s*[<(]").exec(dict); if (!m) return "";
    return strAt(dict, m.index + m[0].length - 1);
  }
  async function buildDecryptor(dict, bin) {
    const num = (k, d) => { const m = new RegExp("/" + k + "\\s*(-?\\d+)").exec(dict); return m ? Number(m[1]) : d; };
    const idm = /\/ID\s*\[\s*(?=[<(])/.exec(bin), id0 = idm ? strAt(bin, idm.index + idm[0].length) : "";
    const V = num("V", 1), aes = /\/CFM\s*\/AESV[23]/.test(dict);
    const C = root.PdfCrypt || require("./pdfcrypt.js");
    return await C.makeDecryptor({ R: num("R", 2), P: num("P", 0), Length: V >= 4 ? 128 : num("Length", 40), O: pdfString(dict, "O"), U: pdfString(dict, "U"), UE: pdfString(dict, "UE"), id0, aes, encMeta: !/\/EncryptMetadata\s*false/.test(dict) });
  }

  async function extract(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "%PDF") throw new Error("El archivo no es un PDF.");
    let bin = ""; for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    const objs = parseObjects(bin);
    decrypt = null;
    const em = /\/Encrypt\s*(\d+)\s+(\d+)\s+R/.exec(bin), inl = !em && /\/Encrypt\s*<</.exec(bin);
    if (em || inl) {
      const dict = em ? (objs.get(Number(em[1])) || {}).dict : bin.slice(inl.index, inl.index + 3000);
      if (!dict) throw new Error("El PDF está protegido y no pude leer su protección.");
      decrypt = await buildDecryptor(dict, bin);
    }
    const pages = [];
    try {
      for (const pn of pageList(objs)) {
        const d = objs.get(pn).dict;
        const m = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(d);
        let text = "";
        if (m) for (const r of refs(m[1])) text += (await streamOf(objs, bytes, r)) + "\n";
        pages.push({ items: pageItems(text) });
      }
    } catch (e) {
      if (decrypt) throw new Error("El PDF tiene una contraseña de apertura y no se puede leer automáticamente.");
      throw e;
    }
    return { pages, hasText: pages.some((p) => p.items.length > 0) };
  }

  const api = { extract, pageItems, version: "7.4" };
  if (typeof module === "object" && module.exports) module.exports = api; else root.PdfText = api;
})(typeof self !== "undefined" ? self : this);
