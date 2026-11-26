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
  // Bytes ya descomprimidos de un stream (null si el filtro no está soportado)
  async function streamBytes(objs, bytes, n) {
    const o = objs.get(n);
    if (!o || o.ds === undefined) return null;
    let data = bytes.subarray(o.ds, o.de);
    const lm = /\/Length\s+(\d+)\b(?!\s+\d+\s+R)/.exec(o.dict);
    if (lm && Number(lm[1]) <= data.length) data = data.subarray(0, Number(lm[1]));
    else {
      if (data.length && data[data.length - 1] === 10) data = data.subarray(0, data.length - 1);
      if (data.length && data[data.length - 1] === 13) data = data.subarray(0, data.length - 1);
    }
    if (decrypt) data = await decrypt(data, n, o.gen || 0);
    const f = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(o.dict);
    if (f) {
      if (/FlateDecode|\/Fl\b/.test(f[1]) && !/DCT|LZW|RunLength|CCITT|JBIG|JPX/.test(f[1])) {
        if (/ASCII85Decode|\/A85\b/.test(f[1])) data = ascii85(data);
        data = await inflate(data);
      } else return null;
    }
    return data;
  }
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
        else if (/[0-7]/.test(n)) { let o = ""; let k = i + 1; while (k < i + 4 && /[0-7]/.test(s[k])) o += s[k++]; out += String.fromCharCode(parseInt(o, 8) & 255); i = k; }
        else if (n === "\r") { i += s[i + 2] === "\n" ? 3 : 2; } else if (n === "\n") { i += 2; }
        else { out += n; i += 2; }
      } else if (c === "(") { depth++; out += c; i++; }
      else if (c === ")") { depth--; if (depth > 0) out += c; i++; }
      else { out += c; i++; }
    }
    return { str: out, end: i };
  }

  // Texto de un string del PDF según la fuente: fuentes simples (1 byte por letra, WinAnsi o su tabla ToUnicode)
  // y fuentes compuestas Type0 (2 bytes por letra: tabla ToUnicode o la tabla cmap de la fuente TrueType incrustada).
  function decodeWith(font, raw) {
    if (!font) { let o = ""; for (let i = 0; i < raw.length; i++) o += decByte(raw.charCodeAt(i) & 255); return o; }
    let o = "";
    if (font.two) {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const code = ((raw.charCodeAt(i) & 255) << 8) | (raw.charCodeAt(i + 1) & 255);
        const u = font.map ? font.map.get(code) : undefined;
        o += u !== undefined ? u : (code >= 32 && code < 0xd800 ? String.fromCharCode(code) : "");
      }
      return o;
    }
    for (let i = 0; i < raw.length; i++) {
      const b = raw.charCodeAt(i) & 255, u = font.map ? font.map.get(b) : undefined;
      o += u !== undefined ? u : decByte(b);
    }
    return o;
  }

  function pageItems(content, fonts) {
    fonts = fonts || {};
    const items = [];
    let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
    let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0], leading = 0, last = null, font = null;
    const st = [];                                                      // operandos
    const push = (str) => {
      const t = mul(tm, ctm);
      if (last) { last.str += str; return; }                            // otro Tj sin reposicionar: sigue la misma línea
      last = { x: t[4], y: t[5], str }; items.push(last);
    };
    const moveTo = (tx, ty) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm.slice(); last = null; };
    const hexRaw = (hex) => { hex = hex.replace(/\s+/g, ""); if (hex.length % 2) hex += "0"; let out = ""; for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.substr(k, 2), 16)); return out; };
    const s = content, n = s.length;
    let i = 0;
    while (i < n) {
      const c = s[i];
      if (c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0") { i++; continue; }
      if (c === "%") { while (i < n && s[i] !== "\n" && s[i] !== "\r") i++; continue; }
      if (c === "(") { const r = readString(s, i); st.push({ t: "s", v: r.str }); i = r.end; continue; }
      if (c === "<" && s[i + 1] !== "<") {
        const e = s.indexOf(">", i);
        st.push({ t: "s", v: hexRaw(s.slice(i + 1, e)) }); i = e + 1; continue;
      }
      if (c === "<" || c === ">") { i += s[i + 1] === c ? 2 : 1; continue; }
      if (c === "[") {
        i++; const arr = [];
        while (i < n && s[i] !== "]") {
          if (s[i] === "(") { const r = readString(s, i); arr.push(r.str); i = r.end; }
          else if (s[i] === "<") { const e = s.indexOf(">", i); arr.push(hexRaw(s.slice(i + 1, e))); i = e + 1; }
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
      const strArg = () => { const o = st[st.length - 1]; return o && o.t === "s" ? decodeWith(font, o.v) : null; };
      switch (op) {
        case "q": stack.push(ctm.slice()); break;
        case "Q": if (stack.length) ctm = stack.pop(); break;
        case "cm": ctm = mul([num(6), num(5), num(4), num(3), num(2), num(1)], ctm); break;
        case "BT": tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); last = null; break;
        case "Tf": { const o = st[st.length - 2]; font = o && o.t === "n" ? fonts[o.v] || null : null; break; }
        case "Td": moveTo(num(2), num(1)); break;
        case "TD": leading = -num(1); moveTo(num(2), num(1)); break;
        case "TL": leading = num(1); break;
        case "Tm": tm = [num(6), num(5), num(4), num(3), num(2), num(1)]; tlm = tm.slice(); last = null; break;
        case "T*": moveTo(0, -leading); break;
        case "Tj": { const v = strArg(); if (v !== null) push(v); break; }
        case "'": case "\"": { moveTo(0, -leading); const v = strArg(); if (v !== null) push(v); break; }
        case "TJ": {
          const o = st[st.length - 1];
          if (o && o.t === "a") { let str = ""; for (const p of o.v) { if (typeof p === "string") str += decodeWith(font, p); else if (p < -200) str += " "; } push(str); }
          break;
        }
        default: break;
      }
      st.length = 0;
    }
    return items.filter((it) => it.str.trim() !== "").map((it) => ({ x: Math.round(it.x * 100) / 100, y: Math.round(it.y * 100) / 100, str: it.str.replace(/\s+$/, "") }));
  }

  // ---- 3) Fuentes de la página ----
  // Tabla ToUnicode (CMap): código -> texto
  function parseToUnicode(cmap) {
    const map = new Map();
    const hexStr = (h) => { h = h.replace(/\s+/g, ""); if (h.length <= 2) return h ? String.fromCharCode(parseInt(h, 16)) : ""; let o = ""; for (let k = 0; k < h.length; k += 4) o += String.fromCharCode(parseInt(h.substr(k, 4).padEnd(4, "0"), 16)); return o; };
    let m;
    const chars = /beginbfchar([\s\S]*?)endbfchar/g;
    while ((m = chars.exec(cmap))) {
      const re = /<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]*)>/g; let p;
      while ((p = re.exec(m[1]))) map.set(parseInt(p[1].replace(/\s+/g, ""), 16), hexStr(p[2]));
    }
    const ranges = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = ranges.exec(cmap))) {
      const re = /<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]+)>\s*(<[0-9a-fA-F\s]*>|\[[^\]]*\])/g; let p;
      while ((p = re.exec(m[1]))) {
        const lo = parseInt(p[1].replace(/\s+/g, ""), 16), hi = parseInt(p[2].replace(/\s+/g, ""), 16);
        if (hi - lo > 65535) continue;
        if (p[3][0] === "[") { const list = p[3].match(/<([0-9a-fA-F\s]*)>/g) || []; list.forEach((h, k) => map.set(lo + k, hexStr(h.slice(1, -1)))); }
        else {
          const base = hexStr(p[3].slice(1, -1)); if (!base) continue;
          const head = base.slice(0, -1), last = base.charCodeAt(base.length - 1);
          for (let c = lo; c <= hi; c++) map.set(c, head + String.fromCharCode(last + c - lo));
        }
      }
    }
    return map;
  }
  // Fuente TrueType incrustada: número de glifo -> letra, leyendo su tabla "cmap" (formatos 4 y 12)
  function trueTypeGlyphs(b) {
    if (!b || b.length < 12) return null;
    const u16 = (o) => (b[o] << 8) | b[o + 1], u32 = (o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
    const nt = u16(4); let cmap = -1;
    for (let t = 0; t < nt; t++) { const o = 12 + 16 * t; if (String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) === "cmap") cmap = u32(o + 8); }
    if (cmap < 0 || cmap + 4 > b.length) return null;
    let best = null, score = -1;
    for (let t = 0, n = u16(cmap + 2); t < n; t++) {
      const pid = u16(cmap + 4 + 8 * t), eid = u16(cmap + 6 + 8 * t), off = cmap + u32(cmap + 8 + 8 * t);
      if (off + 2 > b.length) continue;
      const fmt = u16(off);
      const sc = fmt === 12 && pid === 3 && eid === 10 ? 4 : fmt === 4 && pid === 3 && eid === 1 ? 3 : fmt === 4 && pid === 0 ? 2 : fmt === 4 && pid === 3 && eid === 0 ? 1 : -1;
      if (sc > score) { score = sc; best = { off, fmt, sym: pid === 3 && eid === 0 }; }
    }
    if (!best) return null;
    const map = new Map(), put = (gid, code) => { if (gid && !map.has(gid)) map.set(gid, String.fromCodePoint(best.sym && code >= 0xf000 ? code - 0xf000 : code)); };
    const o = best.off;
    if (best.fmt === 4) {
      const segX2 = u16(o + 6), ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ros = deltas + segX2;
      for (let k = 0; k < segX2 / 2; k++) {
        const end = u16(ends + 2 * k), start = u16(starts + 2 * k), delta = u16(deltas + 2 * k), ro = u16(ros + 2 * k);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let gid;
          if (!ro) gid = (c + delta) & 0xffff;
          else { const a = ros + 2 * k + ro + 2 * (c - start); gid = a + 1 < b.length ? u16(a) : 0; if (gid) gid = (gid + delta) & 0xffff; }
          put(gid, c);
        }
      }
    } else {
      for (let g = 0, n = u32(o + 12); g < n; g++) {
        const p = o + 16 + 12 * g, s0 = u32(p), e0 = u32(p + 4), gid0 = u32(p + 8);
        for (let c = s0; c <= e0 && c - s0 < 65536; c++) put(gid0 + c - s0, c);
      }
    }
    return map;
  }
  const dictOf = (objs, s) => { const r = /^\s*(\d+)\s+\d+\s+R/.exec(s); return r ? ((objs.get(Number(r[1])) || {}).dict || "") : s; };
  function subDict(s, key) {                         // contenido de /Key << ... >> (respetando diccionarios anidados)
    const m = new RegExp("/" + key + "\\s*(<<|\\d+\\s+\\d+\\s+R)").exec(s); if (!m) return "";
    if (m[1] !== "<<") return m[1];
    let depth = 0, i = m.index + m[0].length - 2;
    for (let k = i; k < s.length - 1; k++) {
      if (s[k] === "<" && s[k + 1] === "<") { depth++; k++; }
      else if (s[k] === ">" && s[k + 1] === ">") { depth--; k++; if (!depth) return s.slice(i + 2, k - 1); }
    }
    return s.slice(i + 2);
  }
  async function loadFonts(objs, bytes, pageNum, cache) {
    let d = objs.get(pageNum).dict, res = "", guard = 0;
    while (d && guard++ < 10) {                      // los recursos pueden venir del /Pages padre
      res = subDict(d, "Resources"); if (res) break;
      const pm = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(d); d = pm ? (objs.get(Number(pm[1])) || {}).dict : "";
    }
    res = dictOf(objs, res);
    const fd = dictOf(objs, subDict(res, "Font")), out = {};
    const re = /\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g; let m;
    while ((m = re.exec(fd))) {
      const num = Number(m[2]);
      if (!cache.has(num)) cache.set(num, await fontInfo(objs, bytes, num));
      out[m[1]] = cache.get(num);
    }
    return out;
  }
  async function fontInfo(objs, bytes, num) {
    const fd = (objs.get(num) || {}).dict || "";
    const two = /\/Subtype\s*\/Type0\b/.test(fd);
    let map = null;
    const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(fd);
    if (tu) {
      try { const data = await streamBytes(objs, bytes, Number(tu[1])); if (data) { let t = ""; for (let i = 0; i < data.length; i += 8192) t += String.fromCharCode.apply(null, data.subarray(i, i + 8192)); map = parseToUnicode(t); if (!map.size) map = null; } }
      catch (e) { map = null; }
    }
    if (!map && two) {                               // sin ToUnicode: se usa la tabla de la fuente TrueType (CIDToGIDMap Identity)
      try {
        let df = /\/DescendantFonts\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(fd), dd = "";
        if (df) { let arr = df[1]; if (arr[0] !== "[") arr = dictOf(objs, arr); const r = refs(arr)[0]; dd = r ? (objs.get(r) || {}).dict || "" : ""; }
        const desc = /\/FontDescriptor\s+(\d+)\s+\d+\s+R/.exec(dd);
        const ff = desc && /\/FontFile2\s+(\d+)\s+\d+\s+R/.exec((objs.get(Number(desc[1])) || {}).dict || "");
        if (ff && !/\/CIDToGIDMap\s+\d+\s+\d+\s+R/.test(dd)) map = trueTypeGlyphs(await streamBytes(objs, bytes, Number(ff[1])));
      } catch (e) { map = null; }
    }
    return { two, map };
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
      const fontCache = new Map();
      for (const pn of pageList(objs)) {
        const d = objs.get(pn).dict;
        const m = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(d);
        let text = "";
        if (m) for (const r of refs(m[1])) text += (await streamOf(objs, bytes, r)) + "\n";
        let fonts = {};
        try { fonts = await loadFonts(objs, bytes, pn, fontCache); } catch (e) { fonts = {}; }
        pages.push({ items: pageItems(text, fonts) });
      }
    } catch (e) {
      if (decrypt) throw new Error("El PDF tiene una contraseña de apertura y no se puede leer automáticamente.");
      throw e;
    }
    return { pages, hasText: pages.some((p) => p.items.length > 0) };
  }

  const api = { extract, pageItems, version: "9.0" };
  if (typeof module === "object" && module.exports) module.exports = api; else root.PdfText = api;
})(typeof self !== "undefined" ? self : this);
