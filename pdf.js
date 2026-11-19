// pdf.js — Generador de PDF sin librerías externas.
// buildPdf(pages, summary)
//   pages:   [{bytes: Uint8Array (JPEG), w, h}]  -> una página A4 por imagen
//   summary: null o {title, subtitle, note, rows:[{name, qtyText}]} -> tabla de totales al final
// Devuelve un Blob PDF.
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
  const PW = 595.28, PH = 841.89;

  // Arma el contenido de las páginas de la tabla de totales.
  function layoutTable(summary) {
    const MX = 56, TOP = PH - 64, BOTTOM = 64, RH = 20, FS = 11;
    const COL_NAME = 320, COL_QTY = 130, TW = COL_NAME + COL_QTY;
    const out = [];
    let ops, y;

    const text = (str, x, yy, size, bold, gray) =>
      (gray !== undefined ? gray + " g " : "") +
      "BT /" + (bold ? "F2" : "F1") + " " + size + " Tf 1 0 0 1 " + f(x) + " " + f(yy) + " Tm (" + esc(str) + ") Tj ET" +
      (gray !== undefined ? " 0 g" : "") + "\n";

    function header(first) {
      ops = [];
      y = TOP;
      ops.push(text(first ? summary.title : summary.title + " (continuación)", MX, y - 14, 18, true));
      y -= 32;
      if (first && summary.subtitle) {
        ops.push(text(summary.subtitle, MX, y - 8, 10, false, 0.35));
        y -= 26;
      }
      ops.push("0.90 g " + f(MX) + " " + f(y - RH) + " " + f(TW) + " " + f(RH) + " re f 0 g\n");
      ops.push(text("Producto", MX + 8, y - RH + 6, 10.5, true));
      const hq = "Cantidad total";
      ops.push(text(hq, MX + TW - 8 - textWidth(hq, 10.5, true), y - RH + 6, 10.5, true));
      y -= RH;
    }

    header(true);
    for (const r of summary.rows) {
      if (y - RH < BOTTOM) { out.push(ops.join("")); header(false); }
      ops.push(text(fitText(r.name, COL_NAME - 16, FS, false), MX + 8, y - RH + 6, FS, false));
      ops.push(text(r.qtyText, MX + TW - 8 - textWidth(r.qtyText, FS, false), y - RH + 6, FS, false));
      ops.push("0.80 G 0.5 w " + f(MX) + " " + f(y - RH) + " m " + f(MX + TW) + " " + f(y - RH) + " l S\n");
      y -= RH;
    }
    if (summary.note) {
      if (y - 30 < BOTTOM) { out.push(ops.join("")); header(false); }
      ops.push(text(summary.note, MX, y - 18, 9, false, 0.35));
    }
    out.push(ops.join(""));
    return out;
  }

  function buildPdf(pages, summary) {
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let offset = 0;

    const push = (d) => {
      const u = typeof d === "string" ? enc.encode(d) : d;
      chunks.push(u);
      offset += u.length;
    };
    const startObj = (id) => { offsets[id] = offset; push(id + " 0 obj\n"); };

    const A4W = 595.28, A4H = 841.89, MARGIN = 14;
    const F1 = 3, F2 = 4;

    // Plan de objetos
    let nextId = 5;
    const plan = [];
    for (const p of pages) {
      plan.push({ type: "img", p, pageId: nextId, contId: nextId + 1, imgId: nextId + 2 });
      nextId += 3;
    }
    if (summary && summary.rows && summary.rows.length) {
      for (const content of layoutTable(summary)) {
        plan.push({ type: "table", content, pageId: nextId, contId: nextId + 1 });
        nextId += 2;
      }
    }
    const total = nextId - 1;

    push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    startObj(1);
    push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

    startObj(2);
    push("<< /Type /Pages /Kids [" + plan.map((e) => e.pageId + " 0 R").join(" ") + "] /Count " + plan.length + " >>\nendobj\n");

    startObj(F1);
    push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n");
    startObj(F2);
    push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n");

    for (const e of plan) {
      if (e.type === "img") {
        const p = e.p;
        const landscape = p.w > p.h;
        const pw = landscape ? A4H : A4W, ph = landscape ? A4W : A4H;
        const scale = Math.min((pw - 2 * MARGIN) / p.w, (ph - 2 * MARGIN) / p.h);
        const dw = p.w * scale, dh = p.h * scale;
        const x = (pw - dw) / 2, y = (ph - dh) / 2;

        startObj(e.pageId);
        push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + f(pw) + " " + f(ph) + "] " +
             "/Resources << /XObject << /Im0 " + e.imgId + " 0 R >> >> /Contents " + e.contId + " 0 R >>\nendobj\n");

        const content = "q " + f(dw) + " 0 0 " + f(dh) + " " + f(x) + " " + f(y) + " cm /Im0 Do Q";
        startObj(e.contId);
        push("<< /Length " + content.length + " >>\nstream\n" + content + "\nendstream\nendobj\n");

        startObj(e.imgId);
        push("<< /Type /XObject /Subtype /Image /Width " + p.w + " /Height " + p.h +
             " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + p.bytes.length + " >>\nstream\n");
        push(p.bytes);
        push("\nendstream\nendobj\n");
      } else {
        const bytes = latin1(e.content);
        startObj(e.pageId);
        push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + f(PW) + " " + f(PH) + "] " +
             "/Resources << /Font << /F1 " + F1 + " 0 R /F2 " + F2 + " 0 R >> >> /Contents " + e.contId + " 0 R >>\nendobj\n");
        startObj(e.contId);
        push("<< /Length " + bytes.length + " >>\nstream\n");
        push(bytes);
        push("\nendstream\nendobj\n");
      }
    }

    const xrefPos = offset;
    let xref = "xref\n0 " + (total + 1) + "\n0000000000 65535 f \n";
    for (let id = 1; id <= total; id++) xref += String(offsets[id]).padStart(10, "0") + " 00000 n \n";
    push(xref);
    push("trailer\n<< /Size " + (total + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefPos + "\n%%EOF\n");

    return new Blob(chunks, { type: "application/pdf" });
  }

  const api = { buildPdf };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.buildPdf = buildPdf;
})(typeof self !== "undefined" ? self : this);
