// pdf.js — Generador de PDF sin librerías externas.
// buildPdf(pages, opts)
//   pages: [{bytes: Uint8Array (JPEG), w, h}]   -> una página A4 por remito, con encabezado y pie
//   opts:  {company, date, logo:{bytes,w,h}|null, summary: null | {rows:[{name, qtyText, cells?:[texto por remito]}], cols, title, note}}
// La tabla de recepciones (summary) va al final. Devuelve un Blob PDF.
(function (root) {
  "use strict";

  // Anchos de Helvetica (caracteres 32..126) para alinear y recortar texto.
  const HELV = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584
  ];

  function textWidth(str, size, bold) {
    let w = 0;
    for (const ch of str) {
      let c = ch.charCodeAt(0);
      if (c > 126) {
        const base = ch.normalize("NFD").charCodeAt(0);
        c = base >= 32 && base <= 126 ? base : 0;
      }
      w += c >= 32 && c <= 126 ? HELV[c - 32] : 556;
    }
    return (w * size / 1000) * (bold ? 1.07 : 1);
  }

  function fitText(str, maxW, size, bold) {
    if (textWidth(str, size, bold) <= maxW) return str;
    let s = str;
    while (s.length > 1 && textWidth(s + "...", size, bold) > maxW) s = s.slice(0, -1);
    return s + "...";
  }

  const WIN_MAP = { 0x2013: 0x96, 0x2014: 0x97, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2026: 0x85, 0x20AC: 0x80 };

  // Texto -> literal PDF (WinAnsi), con escape de ( ) \
  function esc(s) {
    let o = "";
    for (const ch of s) {
      let c = ch.charCodeAt(0);
      c = WIN_MAP[c] || (c < 32 ? 32 : c < 256 ? c : 63);
      const chr = String.fromCharCode(c);
      o += chr === "(" || chr === ")" || chr === "\\" ? "\\" + chr : chr;
    }
    return o;
  }

  function latin1(str) {
    const u = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 255;
    return u;
  }

  const f = (n) => n.toFixed(2);
  const A4W = 595.28, A4H = 841.89;
  const WINE = "0.455 0.078 0.125";        // vino del logotipo
  const INK = "0.13 0.11 0.10";
  const MUTED = "0.45 0.42 0.40";
  const MX = 28;                           // margen lateral de las páginas con remito

  // ---- operadores de dibujo ----
  const text = (str, x, y, size, font, color) =>
    color + " rg BT /" + font + " " + f(size) + " Tf 1 0 0 1 " + f(x) + " " + f(y) + " Tm (" + esc(str) + ") Tj ET\n";
  const rect = (x, y, w, h, color) => color + " rg " + f(x) + " " + f(y) + " " + f(w) + " " + f(h) + " re f\n";
  const line = (x1, y1, x2, y2, color, w) => color + " RG " + f(w) + " w " + f(x1) + " " + f(y1) + " m " + f(x2) + " " + f(y2) + " l S\n";
  const rightText = (str, xRight, y, size, font, color, bold) => text(str, xRight - textWidth(str, size, bold), y, size, font, color);

  function logoOp(logo, x, y, h) {
    const w = h * logo.w / logo.h;
    return { ops: "q " + f(w) + " 0 0 " + f(h) + " " + f(x) + " " + f(y) + " cm /Lg Do Q\n", w };
  }

  // Encabezado de una página con remito: logo a la izquierda, datos a la derecha, filete vino.
  function scanHeader(pw, ph, o, n, total) {
    const top = ph - 20, hh = 40;
    let ops = "";
    let tx = MX;
    if (o.logo) { const l = logoOp(o.logo, MX, top - hh, hh); ops += l.ops; tx = MX + l.w + 12; }
    ops += text(o.company || "", tx, top - 16, 12, "F3", WINE);
    ops += text(["Remito escaneado", o.oc ? "OC " + o.oc : "", o.periodText ? "Período " + o.periodText : ""].filter(Boolean).join("  ·  "), tx, top - 30, 8.5, "F1", MUTED);
    ops += rightText("Remito " + n + " de " + total, pw - MX, top - 16, 10.5, "F2", INK, true);
    if (o.date) ops += rightText(o.date, pw - MX, top - 30, 8.5, "F1", MUTED, false);
    ops += line(MX, top - hh - 7, pw - MX, top - hh - 7, WINE, 1.1);
    return { ops, bottom: top - hh - 7 };
  }

  function footer(pw, o, pageNo, pageTotal) {
    let ops = line(MX, 34, pw - MX, 34, "0.82 0.79 0.76", 0.5);
    ops += text((o.company || "") + "  ·  Escáner de Remitos", MX, 21, 7.5, "F1", MUTED);
    ops += rightText("Página " + pageNo + " de " + pageTotal, pw - MX, 21, 7.5, "F1", MUTED, false);
    return ops;
  }

  // Páginas de la tabla de recepciones. Con varias columnas (una por remito: summary.cols y rows[i].cells) se arma la
  // planilla Producto | Rem. 1 | Rem. 2 | … | Total; de 5 remitos en adelante la hoja va apaisada. Con más de 14
  // remitos (no entran) queda solo el total de cada producto.
  const MAX_COLS = 14;
  function tableGeom(S) {
    const cols = S.cols >= 2 && S.cols <= MAX_COLS && S.rows.every((r) => Array.isArray(r.cells)) ? S.cols : 0;
    const land = cols > 4, pw = land ? A4H : A4W, ph = land ? A4W : A4H;
    const TM = cols ? 40 : 56, TW = pw - 2 * TM, C_N = cols ? 28 : 34, C_Q = cols ? 66 : 120;
    const C_R = cols ? Math.min(58, (TW - C_N - C_Q - 170) / cols) : 0;
    return { cols, pw, ph, TM, TW, C_N, C_Q, C_R, C_P: TW - C_N - C_Q - cols * C_R, FS: cols > 9 ? 8.5 : cols ? 9.5 : 10.5 };
  }
  function layoutTable(o, pageNoStart, pageTotal) {
    const S = o.summary, G = tableGeom(S), { pw: PW, ph: PH, TM, TW, C_N, C_Q, C_R, C_P, FS, cols } = G;
    const RH = cols ? 20 : 22, BOTTOM = 62;
    const out = [];
    let ops, y, first = true, pageNo = pageNoStart;
    const colLabel = (k) => (C_R >= 44 ? "Rem. " : "R") + (k + 1);
    const colRight = (k) => TM + C_N + C_P + (k + 1) * C_R - 6;

    function header() {
      ops = "";
      if (first) {
        let tx = TM, logoH = 74;
        if (o.logo) { const l = logoOp(o.logo, TM, PH - 40 - logoH, logoH); ops += l.ops; tx = TM + l.w + 20; }
        ops += text(fitText(S.title || "TABLA DE RECEPCIONES", PW - tx - TM, 21, true), tx, PH - 72, 21, "F3", WINE);
        ops += text(o.company || "", tx, PH - 90, 10.5, "F2", INK);
        const meta = [o.oc ? "OC: " + o.oc : "", o.periodText ? "Período: " + o.periodText : "", o.date ? "Fecha: " + o.date : "", o.remitos ? "Remitos escaneados: " + o.remitos : ""].filter(Boolean).join("   ·   ");
        if (meta) ops += text(meta, tx, PH - 105, 9, "F1", MUTED);
        ops += line(TM, PH - 128, PW - TM, PH - 128, WINE, 1.4);
        y = PH - 148;
      } else {
        let tx = TM;
        if (o.logo) { const l = logoOp(o.logo, TM, PH - 28 - 34, 34); ops += l.ops; tx = TM + l.w + 12; }
        ops += text((S.title ? S.title.charAt(0) + S.title.slice(1).toLowerCase() : "Tabla de recepciones") + " (continuación)", tx, PH - 50, 12, "F3", WINE);
        ops += line(TM, PH - 72, PW - TM, PH - 72, WINE, 1.1);
        y = PH - 90;
      }
      // fila de títulos
      const HS = cols > 9 ? 8.5 : 9.5;
      ops += rect(TM, y - RH, TW, RH, WINE);
      ops += text("N°", TM + 8, y - RH + 6.5, HS, "F2", "1 1 1");
      ops += text("Producto", TM + C_N + 8, y - RH + 6.5, HS, "F2", "1 1 1");
      for (let k = 0; k < cols; k++) ops += rightText(colLabel(k), colRight(k), y - RH + 6.5, HS, "F2", "1 1 1", true);
      ops += rightText(cols ? "Total" : "Cantidad", TM + TW - 10, y - RH + 6.5, HS, "F2", "1 1 1", true);
      y -= RH;
    }
    const close = () => { ops += footer(PW, o, pageNo, pageTotal); out.push(ops); pageNo++; first = false; };

    header();
    S.rows.forEach((r, i) => {
      if (y - RH < BOTTOM) { close(); header(); }
      if (i % 2 === 1) ops += rect(TM, y - RH, TW, RH, "0.965 0.945 0.93");
      if (cols) ops += rect(TM + TW - C_Q, y - RH, C_Q, RH, i % 2 === 1 ? "0.93 0.90 0.88" : "0.955 0.935 0.92");
      ops += text(String(i + 1), TM + 8, y - RH + 6.5, FS - 1, "F1", MUTED);
      ops += text(fitText(r.name, C_P - 14, FS, false), TM + C_N + 8, y - RH + 6.5, FS, "F1", INK);
      for (let k = 0; k < cols; k++) {
        const c = r.cells[k] || "";
        ops += rightText(c ? fitText(c, C_R - 8, FS, false) : "–", colRight(k), y - RH + 6.5, FS, "F1", c ? INK : "0.72 0.69 0.66", false);
      }
      ops += rightText(r.qtyText, TM + TW - 10, y - RH + 6.5, FS, "F2", INK, true);
      ops += line(TM, y - RH, TM + TW, y - RH, "0.86 0.83 0.80", 0.5);
      y -= RH;
    });
    // cierre de la tabla
    ops += line(TM, y, TM + TW, y, WINE, 1.1);
    const notes = [S.note, cols && C_R < 44 ? "R1, R2…: remito 1, 2… de este PDF." : ""].filter(Boolean).join("  ");
    if (notes) {                                          // la nota se parte en renglones del ancho de la tabla
      const lines = [];
      let cur = "";
      notes.split(/\s+/).forEach((w) => { const t = cur ? cur + " " + w : w; if (textWidth(t, 8.5, false) > TW && cur) { lines.push(cur); cur = w; } else cur = t; });
      if (cur) lines.push(cur);
      lines.slice(0, 4).forEach((l, k) => { ops += text(l, TM, y - 18 - k * 11, 8.5, "F1", MUTED); });
    }
    close();
    return { pages: out, pw: PW, ph: PH };
  }

  function buildPdf(pages, opts) {
    const o = opts || {};
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let offset = 0;
    const push = (d) => { const u = typeof d === "string" ? enc.encode(d) : d; chunks.push(u); offset += u.length; };
    const startObj = (id) => { offsets[id] = offset; push(id + " 0 obj\n"); };

    const F1 = 3, F2 = 4, F3 = 5, LG = 6;
    let nextId = 7;
    const hasTable = !!(o.summary && o.summary.rows && o.summary.rows.length);
    const tableCount = hasTable ? layoutTable({ ...o, remitos: pages.length }, 1, 1).pages.length : 0;
    const pageTotal = pages.length + tableCount;
    const tbl = hasTable ? layoutTable({ ...o, remitos: pages.length }, pages.length + 1, pageTotal) : { pages: [], pw: A4W, ph: A4H };
    const tableContents = tbl.pages;

    const plan = [];
    for (const p of pages) { plan.push({ type: "img", p, pageId: nextId, contId: nextId + 1, imgId: nextId + 2 }); nextId += 3; }
    for (const content of tableContents) { plan.push({ type: "table", content, pageId: nextId, contId: nextId + 1 }); nextId += 2; }
    const total = nextId - 1;

    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    startObj(1); push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
    startObj(2); push("<< /Type /Pages /Kids [" + plan.map((e) => e.pageId + " 0 R").join(" ") + "] /Count " + plan.length + " >>\nendobj\n");
    startObj(F1); push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n");
    startObj(F2); push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n");
    startObj(F3); push("<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold /Encoding /WinAnsiEncoding >>\nendobj\n");
    startObj(LG);
    if (o.logo) {
      push("<< /Type /XObject /Subtype /Image /Width " + o.logo.w + " /Height " + o.logo.h +
           " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + o.logo.bytes.length + " >>\nstream\n");
      push(o.logo.bytes); push("\nendstream\nendobj\n");
    } else {
      push("<< >>\nendobj\n");
    }
    const fonts = "/Font << /F1 " + F1 + " 0 R /F2 " + F2 + " 0 R /F3 " + F3 + " 0 R >>";
    const logoRes = o.logo ? " /Lg " + LG + " 0 R" : "";

    let n = 0;
    for (const e of plan) {
      if (e.type === "img") {
        n++;
        const p = e.p;
        const landscape = p.w > p.h;
        const pw = landscape ? A4H : A4W, ph = landscape ? A4W : A4H;
        const hd = scanHeader(pw, ph, o, n, pages.length);
        const areaTop = hd.bottom - 10, areaBottom = 44;
        const scale = Math.min((pw - 2 * MX) / p.w, (areaTop - areaBottom) / p.h);
        const dw = p.w * scale, dh = p.h * scale;
        const x = (pw - dw) / 2, y = areaTop - dh;

        startObj(e.pageId);
        push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + f(pw) + " " + f(ph) + "] /Resources << " + fonts +
             " /XObject << /Im0 " + e.imgId + " 0 R" + logoRes + " >> >> /Contents " + e.contId + " 0 R >>\nendobj\n");
        const bytes = latin1(hd.ops + footer(pw, o, n, pageTotal) +
          "q " + f(dw) + " 0 0 " + f(dh) + " " + f(x) + " " + f(y) + " cm /Im0 Do Q\n" +
          "0.80 0.77 0.74 RG 0.5 w " + f(x) + " " + f(y) + " " + f(dw) + " " + f(dh) + " re S\n");
        startObj(e.contId);
        push("<< /Length " + bytes.length + " >>\nstream\n"); push(bytes); push("\nendstream\nendobj\n");

        startObj(e.imgId);
        push("<< /Type /XObject /Subtype /Image /Width " + p.w + " /Height " + p.h +
             " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + p.bytes.length + " >>\nstream\n");
        push(p.bytes); push("\nendstream\nendobj\n");
      } else {
        const bytes = latin1(e.content);
        startObj(e.pageId);
        push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + f(tbl.pw) + " " + f(tbl.ph) + "] /Resources << " + fonts +
             (o.logo ? " /XObject << /Lg " + LG + " 0 R >>" : "") + " >> /Contents " + e.contId + " 0 R >>\nendobj\n");
        startObj(e.contId);
        push("<< /Length " + bytes.length + " >>\nstream\n"); push(bytes); push("\nendstream\nendobj\n");
      }
    }

    const infoId = nextId;
    startObj(infoId);
    push("<< /Title (" + esc((o.title || "Remitos")) + ") /Producer (Escaner de Remitos) /Creator (" + esc(o.company || "") + ") >>\nendobj\n");

    const xrefPos = offset, count = infoId;
    let xref = "xref\n0 " + (count + 1) + "\n0000000000 65535 f \n";
    for (let id = 1; id <= count; id++) xref += String(offsets[id]).padStart(10, "0") + " 00000 n \n";
    push(xref);
    push("trailer\n<< /Size " + (count + 1) + " /Root 1 0 R /Info " + infoId + " 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF\n");
    return new Blob(chunks, { type: "application/pdf" });
  }

  const api = { buildPdf, textWidth };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.buildPdf = buildPdf;
})(typeof self !== "undefined" ? self : this);
