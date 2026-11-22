// pdfcrypt.js — Descifra PDF "protegidos" que se abren sin contraseña (clave de usuario vacía), muy comunes en facturas.
// Soporta RC4 40/128 bits y AES-128 (revisiones 2 a 4). Trabaja sobre strings binarios / Uint8Array.
(function (root) {
  "use strict";
  // ---- MD5 ----
  function md5(bytes) {
    const K = new Int32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    const n = bytes.length, total = (((n + 8) >> 6) + 1) << 6, buf = new Uint8Array(total);
    buf.set(bytes); buf[n] = 0x80;
    const dv = new DataView(buf.buffer); dv.setUint32(total - 8, (n * 8) >>> 0, true); dv.setUint32(total - 4, Math.floor(n / 536870912), true);
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    for (let o = 0; o < total; o += 64) {
      const M = new Int32Array(16); for (let i = 0; i < 16; i++) M[i] = dv.getInt32(o + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; } else { F = C ^ (B | ~D); g = (7 * i) & 15; }
        F = (F + A + K[i] + M[g]) | 0; A = D; D = C; C = B;
        const s = S[(i >> 4) * 4 + (i & 3)]; B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16), v = new DataView(out.buffer); v.setInt32(0, a0, true); v.setInt32(4, b0, true); v.setInt32(8, c0, true); v.setInt32(12, d0, true);
    return out;
  }
  function rc4(key, data) {
    const s = new Uint8Array(256); for (let i = 0; i < 256; i++) s[i] = i;
    for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t; }
    const out = new Uint8Array(data.length);
    for (let k = 0, i = 0, j = 0; k < data.length; k++) { i = (i + 1) & 255; j = (j + s[i]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t; out[k] = data[k] ^ s[(s[i] + s[j]) & 255]; }
    return out;
  }
  const toBytes = (str) => { const u = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 255; return u; };
  const cat = (...arr) => { const n = arr.reduce((s, a) => s + a.length, 0), o = new Uint8Array(n); let p = 0; arr.forEach((a) => { o.set(a, p); p += a.length; }); return o; };
  const PAD = Uint8Array.from([0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A]);

  // ---- AES-256 (revisiones 5 y 6), clave de usuario vacía ----
  const sha = async (alg, d) => new Uint8Array(await crypto.subtle.digest(alg, d));
  async function aesCbcNoPad(key, iv, data, encrypt) {
    const k = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["encrypt", "decrypt"]);
    if (encrypt) return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, k, data)).slice(0, data.length);
    const fake = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: data.subarray(data.length - 16) }, k, new Uint8Array(0)));   // bloque de relleno válido para poder descifrar sin relleno
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv }, k, cat(data, fake)));
  }
  async function hash2B(pwd, salt, udata, R) {
    let K = await sha("SHA-256", cat(pwd, salt, udata));
    if (R < 6) return K;
    for (let i = 0; i < 64 || E_last > i - 32; i++) {
      const one = cat(pwd, K, udata), K1 = new Uint8Array(one.length * 64); for (let j = 0; j < 64; j++) K1.set(one, j * one.length);
      const E = await aesCbcNoPad(K.subarray(0, 16), K.subarray(16, 32), K1, true);
      let mod = 0; for (let j = 0; j < 16; j++) mod += E[j]; mod %= 3;
      K = await sha(["SHA-256", "SHA-384", "SHA-512"][mod], E); E_last = E[E.length - 1];
    }
    return K.subarray(0, 32);
  }
  let E_last = 0;
  async function makeAes256(p) {
    E_last = 0;
    const U = toBytes(p.U), UE = toBytes(p.UE || ""), pwd = new Uint8Array(0);
    if (UE.length < 32) throw new Error("El PDF está protegido y no pude leer su protección.");
    const inter = await hash2B(pwd, U.subarray(40, 48), new Uint8Array(0), p.R);
    const fileKey = await aesCbcNoPad(inter.slice(0, 32), new Uint8Array(16), UE.subarray(0, 32), false);
    const k = await crypto.subtle.importKey("raw", fileKey, "AES-CBC", false, ["decrypt"]);
    return async function (data) { if (data.length < 32) return new Uint8Array(0); return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: data.subarray(0, 16) }, k, data.subarray(16))); };
  }

  // p: { R, P, Length (bits), O, U (strings binarios), id0 (string binario), aes (bool), encMeta (bool) }
  function makeDecryptor(p) {
    if (p.R >= 5) return makeAes256(p);
    const n = p.R === 2 ? 5 : Math.max(5, Math.min(16, Math.round((p.Length || 128) / 8)));
    const pv = new Uint8Array(4); new DataView(pv.buffer).setInt32(0, p.P | 0, true);
    let input = cat(PAD, toBytes(p.O).subarray(0, 32), pv, toBytes(p.id0 || ""));
    if (p.R >= 4 && p.encMeta === false) input = cat(input, Uint8Array.from([255, 255, 255, 255]));
    let h = md5(input);
    if (p.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
    const key = h.slice(0, n);
    return async function (data, num, gen) {
      const ext = cat(key, Uint8Array.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]), p.aes ? toBytes("sAlT") : new Uint8Array(0));
      const ok = md5(ext).slice(0, Math.min(n + 5, 16));
      if (!p.aes) return rc4(ok, data);
      if (data.length < 32) return new Uint8Array(0);
      const k = await crypto.subtle.importKey("raw", ok, "AES-CBC", false, ["decrypt"]);
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: data.subarray(0, 16) }, k, data.subarray(16)));
    };
  }
  const api = { makeDecryptor, md5, rc4 };
  if (typeof module === "object" && module.exports) module.exports = api; else root.PdfCrypt = api;
})(typeof self !== "undefined" ? self : this);
