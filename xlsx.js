// xlsx.js — Lee un archivo .xlsx (Excel) en el navegador, sin librerías: descomprime el ZIP, lee textos compartidos,
// estilos (para reconocer fechas) y las hojas. Devuelve cada hoja como una grilla de filas.
// Celdas: número · texto · {date:true, y, m, d} para fechas · null si está vacía.
(function (root) {
  "use strict";

  const td = new TextDecoder("utf-8");
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream("deflate-raw");
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer());
  }

  // ---- ZIP ----
  function zipEntries(b) {
    let e = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 70000); i--) if (u32(b, i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error("El archivo no parece un Excel (.xlsx).");
    const n = u16(b, e + 10); let p = u32(b, e + 16);
    const out = new Map();
    for (let k = 0; k < n; k++) {
      if (u32(b, p) !== 0x02014b50) break;
      const method = u16(b, p + 10), csize = u32(b, p + 20), nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), off = u32(b, p + 42);
      const name = td.decode(b.subarray(p + 46, p + 46 + nlen));
      out.set(name, { method, csize, off });
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }
  async function entryText(b, entries, name) {
    const e = entries.get(name); if (!e) return null;
    const nlen = u16(b, e.off + 26), xlen = u16(b, e.off + 28), start = e.off + 30 + nlen + xlen;
    const data = b.subarray(start, start + e.csize);
    if (e.method === 0) return td.decode(data);
    if (e.method === 8) return td.decode(await inflateRaw(data));
    throw new Error("Compresión no soportada en el Excel.");
  }

  // ---- XML sencillo ----
  const ent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, g) => {
    if (g[0] === "#") return String.fromCodePoint(g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[g.toLowerCase()];
  });
  const attr = (tag, name) => { const m = new RegExp("\\b" + name + '="([^"]*)"').exec(tag); return m ? ent(m[1]) : null; };
  const textOf = (xml) => { let s = ""; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let m; while ((m = re.exec(xml))) s += m[1]; return ent(s); };

  function sharedStrings(xml) {
    if (!xml) return [];
    const out = []; const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g; let m;
    while ((m = re.exec(xml))) out.push(textOf(m[1]));
    return out;
  }

  const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  function dateStyles(xml) {
    const set = new Set();
    if (!xml) return set;
    const fmts = new Map(); let m;
    const reF = /<numFmt\b[^>]*>/g;
    while ((m = reF.exec(xml))) { const id = Number(attr(m[0], "numFmtId")), code = attr(m[0], "formatCode") || ""; fmts.set(id, code); }
    const isDateCode = (c) => { const s = c.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "").toLowerCase(); return /[dmyh]/.test(s) && !/^[#0.,?%\s$]*$/.test(s); };
    const cx = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
    if (cx) {
      let i = 0; const reX = /<xf\b[^>]*?(?:\/>|>)/g;
      while ((m = reX.exec(cx[1]))) {
        const id = Number(attr(m[0], "numFmtId") || 0);
        if (BUILTIN_DATE.has(id) || (fmts.has(id) && isDateCode(fmts.get(id)))) set.add(i);
        i++;
      }
    }
    return set;
  }

  const colIndex = (ref) => { const l = /^[A-Z]+/.exec(ref)[0]; let n = 0; for (const c of l) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };
  function serialToDate(v) { const ms = Math.round((v - 25569) * 86400000); const d = new Date(ms); return { date: true, y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), serial: v }; }

  function parseSheet(xml, strings, dstyles) {
    const rows = [];
    const reRow = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g; let rm, autoRow = 0;
    while ((rm = reRow.exec(xml))) {
      const rAttr = attr(rm[1], "r"); const ri = rAttr ? Number(rAttr) - 1 : autoRow; autoRow = ri + 1;
      const cells = [];
      if (rm[2]) {
        const reC = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let cm, autoCol = 0;
        while ((cm = reC.exec(rm[2]))) {
          const ref = attr(cm[1], "r"), ci = ref ? colIndex(ref) : autoCol; autoCol = ci + 1;
          const t = attr(cm[1], "t"), s = attr(cm[1], "s"), body = cm[2] || "";
          let val = null;
          if (t === "inlineStr") val = textOf(body);
          else {
            const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
            if (vm) {
              const raw = ent(vm[1]);
              if (t === "s") val = strings[Number(raw)] === undefined ? null : strings[Number(raw)];
              else if (t === "str" || t === "e") val = raw;
              else if (t === "b") val = raw === "1" ? 1 : 0;
              else { const n = Number(raw); val = Number.isFinite(n) ? (dstyles.has(Number(s)) ? serialToDate(n) : n) : raw; }
            }
          }
          if (val !== null && val !== "") cells[ci] = val;
        }
      }
      rows[ri] = cells;
    }
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return rows;
  }

  async function read(arrayBuffer) {
    const b = new Uint8Array(arrayBuffer), entries = zipEntries(b);
    const wb = await entryText(b, entries, "xl/workbook.xml");
    if (!wb) throw new Error("No encontré las hojas del Excel (¿es un .xls antiguo? Guardalo como .xlsx).");
    const rels = (await entryText(b, entries, "xl/_rels/workbook.xml.rels")) || "";
    const relMap = {}; let m; const reR = /<Relationship\b[^>]*>/g;
    while ((m = reR.exec(rels))) relMap[attr(m[0], "Id")] = attr(m[0], "Target");
    const strings = sharedStrings(await entryText(b, entries, "xl/sharedStrings.xml"));
    const dstyles = dateStyles(await entryText(b, entries, "xl/styles.xml"));
    const sheets = []; const reS = /<sheet\b[^>]*>/g;
    while ((m = reS.exec(wb))) {
      const name = attr(m[0], "name"), rid = attr(m[0], "r:id"), state = attr(m[0], "state");
      let target = relMap[rid]; if (!target) continue;
      target = target.replace(/^\//, ""); const path = target.startsWith("xl/") ? target : "xl/" + target;
      const xml = await entryText(b, entries, path); if (!xml) continue;
      sheets.push({ name, hidden: state === "hidden" || state === "veryHidden", rows: parseSheet(xml, strings, dstyles) });
    }
    return { sheets };
  }

  const api = { read };
  if (typeof module === "object" && module.exports) module.exports = api; else root.Xlsx = api;
})(typeof self !== "undefined" ? self : this);
