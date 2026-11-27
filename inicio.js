// inicio.js — Pantalla de inicio (v9.1): el período a facturar hoy, los tres botones (Remitos, Facturas, Enviar mails)
// con lo que falta en cada uno, y las OC de ese período con el progreso y el botón del paso siguiente.
//   · Cook Master: la quincena que se factura el 15 o el último día del mes (Period.quincenaActual).
//   · Grupo L: la semana de lunes a sábado en la que está el día de hoy (Period.semanaActual).
// Las OC y los períodos que ya están completos quedan ocultos (se pueden mostrar con el enlace de abajo).
(() => {
  "use strict";
  const A = window.App, P = window.Period, F = window.Flujo, $ = (id) => document.getElementById(id);
  const esc = A.esc;
  let filter = "todos", showDone = false;

  function nextAction(u) {
    const p = u.progreso, s = p.siguiente;
    if (!s) return '<span class="chip ok">Completo ✔</span>';
    if (s === "remitos" && u.cliente === "grupol" && !u.lote) return '<button type="button" class="btn soft next-btn" data-go="remitos" data-unit="' + esc(u.key) + '">Escanear</button> <button type="button" class="btn ghost next-btn" data-go="facturas" data-unit="' + esc(u.key) + '">Sin remitos</button>';
    if (s === "remitos") return u.lote
      ? '<button type="button" class="btn soft next-btn" data-lote="' + esc(u.lote.id) + '">Confirmar tabla</button>'
      : '<button type="button" class="btn soft next-btn" data-go="remitos" data-unit="' + esc(u.key) + '">Escanear</button>';
    if (s === "factura") return '<button type="button" class="btn soft next-btn" data-go="facturas" data-unit="' + esc(u.key) + '">Facturar</button>';
    if (u.cliente === "grupol") return '<button type="button" class="btn soft next-btn" data-go="facturas" data-unit="' + esc(u.key) + '">WhatsApp</button>';
    return (u.estado && u.estado.envio)
      ? '<button type="button" class="btn soft next-btn" data-go="mails">Enviar mail</button>'
      : '<button type="button" class="btn soft next-btn" data-go="facturas" data-unit="' + esc(u.key) + '">Portal o Mail</button>';
  }
  const hhmm = (ms) => { const d = new Date(ms); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };

  function render() {
    if (A.current() !== "inicio") return;
    const D = window.Datos, st = D.state(), today = new Date();
    const prof = window.LAGAuth && window.LAGAuth.profile && window.LAGAuth.profile();
    $("homeHello").textContent = "Hola" + (prof && prof.nombre ? ", " + String(prof.nombre).split(" ")[0] : "") + " · " + today.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" });
    // período a facturar de cada cliente
    const cm = F.periodoActual("cookmaster", today), gl = F.periodoActual("grupol", today);
    $("homeNow").innerHTML =
      '<div><span class="cli cm">CM</span><b>Cook Master</b><span class="pn-t">' + esc(cm.texto) + " <small>· se factura el " + esc(cm.factura) + "</small></span></div>" +
      '<div><span class="cli gl">GL</span><b>Grupo L</b><span class="pn-t">' + esc(gl.texto) + " <small>· se factura el " + esc(gl.factura) + "</small></span></div>";
    // unidades de este período
    const cur = D.units().filter((u) => F.esActual(u, today));
    const shown = cur.filter((u) => filter === "todos" || u.cliente === filter);
    const pasos = cur.reduce((s, u) => s + u.progreso.total, 0), hechos = cur.reduce((s, u) => s + u.progreso.hechos, 0);
    const pct = pasos ? Math.round(hechos / pasos * 100) : 0, done = pasos > 0 && pct === 100;
    $("homePct").textContent = pct + "%";
    $("homeRing").style.setProperty("--p", pct);
    $("homeRing").classList.toggle("done", done);
    $("homeBar").style.width = pct + "%";
    $("homeBar").parentElement.classList.toggle("done", done);
    // pendientes del período (en los tres botones)
    const nRem = cur.filter((u) => u.progreso.pasos[0].estado !== "hecho").length;
    const nFac = cur.filter((u) => u.progreso.pasos[1].estado === "listo").length;
    const nMail = cur.filter((u) => u.cliente === "cookmaster" && u.progreso.pasos[2].estado === "listo").length;
    const badge = (id, n, title) => { const b = $(id); b.hidden = !n; b.textContent = n; b.title = title; };
    badge("nRemitos", nRem, nRem + " OC con remitos por escanear o confirmar");
    badge("nFacturas", nFac, nFac + " factura(s) para cargar");
    badge("nMails", nMail, nMail + " mail(s) listos para enviar");
    let sum;
    if (!A.bridgeReady()) sum = "Configurá el puente a Google (Ajustes) para leer las OC y los Excel de Drive.";
    else if (D.busy()) sum = "Buscando las OC en Drive…";
    else if (D.error()) sum = "No se pudo leer Drive: " + D.error();
    else if (!cur.length) sum = st.at ? "No encontré en Drive OC para este período." : "Tocá «Buscar OC en Drive».";
    else sum = (done ? "¡Todo listo para este período! " : "") + hechos + " de " + pasos + " pasos hechos · " + cur.filter((u) => u.progreso.completa).length + " de " + cur.length + " OC completas" + (st.at ? " · Drive leído a las " + hhmm(st.at) : "");
    $("homeSummary").textContent = sum;
    const syncBtn = $("homeSync");
    syncBtn.classList.toggle("is-busy", D.busy()); syncBtn.disabled = D.busy();
    syncBtn.lastElementChild.textContent = D.busy() ? "Buscando en Drive…" : "Buscar OC en Drive";
    // tarjetas: una por OC del período (las completas, ocultas salvo que se pidan)
    const byOc = new Map();
    shown.forEach((u) => { const k = u.cliente + "|" + u.oc.numero; if (!byOc.has(k)) byOc.set(k, []); byOc.get(k).push(u); });
    const groups = [...byOc.values()], complete = groups.filter((us) => us.every((u) => u.progreso.completa));
    const visible = groups.filter((us) => showDone || !us.every((u) => u.progreso.completa));
    $("ocCards").innerHTML = visible.map((us) => {
      const u0 = us[0], oc = u0.oc, g = u0.cliente === "grupol";
      const ph = us.reduce((s, u) => s + u.progreso.hechos, 0), pt = us.reduce((s, u) => s + u.progreso.total, 0), p = pt ? Math.round(ph / pt * 100) : 0;
      return '<article class="card occ"><div class="occ-head"><span class="cli ' + (g ? "gl" : "cm") + '">' + (g ? "GL" : "CM") + '</span><div class="occ-title"><strong>OC ' + esc(oc.numero) + "</strong><small>" +
        esc((g ? "Grupo L" : "Cook Master · " + F.sedeLabel(oc)) + (oc.delivery ? " — " + oc.delivery : "")) + '</small></div><span class="occ-pct' + (p === 100 ? " ok" : "") + '">' + p + "%</span></div>" +
        us.map((u) => '<div class="per-row"><span class="per-name">' + esc(P.text(u.periodo) + "/" + u.periodo.month) + " <small>" + esc(g ? "semana" : u.periodo.label) + "</small></span>" + nextAction(u) +
          '<div class="steps">' + u.progreso.pasos.map((s) => '<span class="step ' + s.estado + '" title="' + esc(s.texto) + '">' + esc(s.label) + "</span>").join("") + "</div></div>").join("") + "</article>";
    }).join("");
    const more = $("homeShowDone");
    more.hidden = !complete.length;
    more.textContent = showDone ? "Ocultar las OC completas" : "Mostrar las OC completas (" + complete.length + ")";
    const empty = !visible.length;
    $("ocEmptyHome").hidden = !empty;
    if (empty) {
      $("ocEmptyTitle").textContent = !A.bridgeReady() ? "Falta conectar Google Drive." : D.busy() ? "Buscando las OC en Drive…" : complete.length ? "¡Todas las OC de este período están completas! ✔" : "No hay OC para este período.";
      $("ocEmptySub").textContent = !A.bridgeReady() ? "En Ajustes poné la dirección y la clave del puente de Google (INSTRUCCIONES-PUENTE.txt)."
        : complete.length ? "Las podés ver con «Mostrar las OC completas»."
        : "Se buscan en Compartido conmigo / Facturacion / " + P.MESES[cm.periodo.month - 1].charAt(0) + P.MESES[cm.periodo.month - 1].slice(1).toLowerCase() + " / Cook Master y Grupo L. Tocá «Buscar OC en Drive» para volver a mirar.";
      $("ocEmptyBtn").hidden = A.bridgeReady();
    }
  }
  function renderLog(log) {
    const D = window.Datos, box = $("driveLog");
    const lines = (log || D.log()).slice(-8);
    const show = D.busy() || lines.some((l) => l.cls === "bad-line");
    box.hidden = !show || !lines.length;
    box.innerHTML = lines.map((l) => '<div class="' + l.cls + '">' + esc(l.text) + "</div>").join("");
    box.scrollTop = box.scrollHeight;
  }

  $("homeSync").addEventListener("click", () => { if (!A.bridgeReady()) { $("settingsBtn").click(); return; } window.Datos.sync(); });
  $("homeShowDone").addEventListener("click", () => { showDone = !showDone; render(); });
  $("homeFilter").addEventListener("click", (e) => {
    const b = e.target.closest(".seg-btn"); if (!b) return;
    filter = b.dataset.f;
    $("homeFilter").querySelectorAll(".seg-btn").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    render();
  });
  $("ocCards").addEventListener("click", (e) => { const b = e.target.closest("[data-lote]"); if (b && window.Lotes) window.Lotes.open(b.dataset.lote); });
  $("ocEmptyBtn").addEventListener("click", () => $("settingsBtn").click());

  A.on("view", (e) => { if (e.view === "inicio") { render(); renderLog(); } });
  A.on("datos", render);
  A.on("lotes", render);
  A.on("settings", render);
  A.on("drive:log", renderLog);
  A.on("drive:busy", () => { render(); renderLog(); });
})();
