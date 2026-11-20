// pdf.js — Generador de PDF sin librerías externas.
// buildPdf(pages, opts)
//   pages: [{bytes: Uint8Array (JPEG), w, h}]   -> una página A4 por remito, con encabezado y pie
//   opts:  {company, date, logo:{bytes,w,h}|null, summary: null | {title, rows:[{name, qtyText}]}}
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
    ops += text("Remito escaneado", tx, top - 30, 8.5, "F1", MUTED);
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

  // Páginas de la tabla de recepciones
  function layoutTable(o, pageNoStart, pageTotal) {
    const S = o.summary, TM = 56, TW = A4W - 2 * TM;
    const RH = 22, FS = 10.5, BOTTOM = 62;
    const C_N = 34, C_Q = 120;
    const out = [];
    let ops, y, first = true, pageNo = pageNoStart;

    function header() {
      ops = "";
      if (first) {
        let tx = TM, logoH = 74;
        if (o.logo) { const l = logoOp(o.logo, TM, A4H - 40 - logoH, logoH); ops += l.ops; tx = TM + l.w + 20; }
        ops += text("TABLA DE RECEPCIONES", tx, A4H - 72, 21, "F3", WINE);
        ops += text(o.company || "", tx, A4H - 90, 10.5, "F2", INK);
        const meta = [o.date ? "Fecha: " + o.date : "", o.remitos ? "Remitos escaneados: " + o.remitos : ""].filter(Boolean).join("   ·   ");
        if (meta) ops += text(meta, tx, A4H - 105, 9, "F1", MUTED);
        ops += line(TM, A4H - 128, A4W - TM, A4H - 128, WINE, 1.4);
        y = A4H - 148;
      } else {
        let tx = TM;
        if (o.logo) { const l = logoOp(o.logo, TM, A4H - 28 - 34, 34); ops += l.ops; tx = TM + l.w + 12; }
        ops += text("Tabla de recepciones (continuación)", tx, A4H - 50, 12, "F3", WINE);
        ops += line(TM, A4H - 72, A4W - TM, A4H - 72, WINE, 1.1);
        y = A4H - 90;
      }
      // fila de títulos
      ops += rect(TM, y - RH, TW, RH, WINE);
      ops += text("N°", TM + 10, y - RH + 7, 9.5, "F2", "1 1 1");
      ops += text("Producto", TM + C_N + 10, y - RH + 7, 9.5, "F2", "1 1 1");
      ops += rightText("Cantidad", TM + TW - 12, y - RH + 7, 9.5, "F2", "1 1 1", true);
      y -= RH;
    }
    const close = () => { ops += footer(A4W, o, pageNo, pageTotal); out.push(ops); pageNo++; first = false; };

    header();
    S.rows.forEach((r, i) => {
      if (y - RH < BOTTOM) { close(); header(); }
      if (i % 2 === 1) ops += rect(TM, y - RH, TW, RH, "0.965 0.945 0.93");
      ops += text(String(i + 1), TM + 10, y - RH + 7, 9, "F1", MUTED);
      ops += text(fitText(r.name, TW - C_N - C_Q - 16, FS, false), TM + C_N + 10, y - RH + 7, FS, "F1", INK);
      ops += rightText(r.qtyText, TM + TW - 12, y - RH + 7, FS, "F2", INK, true);
      ops += line(TM, y - RH, TM + TW, y - RH, "0.86 0.83 0.80", 0.5);
      y -= RH;
    });
    // cierre de la tabla
    ops += line(TM, y, TM + TW, y, WINE, 1.1);
    if (S.note) ops += text(S.note, TM, y - 18, 8.5, "F1", MUTED);
    close();
    return out;
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
    const tableCount = hasTable ? layoutTable({ ...o, remitos: pages.length }, 1, 1).length : 0;
    const pageTotal = pages.length + tableCount;
    const tableContents = hasTable ? layoutTable({ ...o, remitos: pages.length }, pages.length + 1, pageTotal) : [];

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
        push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + f(A4W) + " " + f(A4H) + "] /Resources << " + fonts +
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
