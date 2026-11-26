// inicio.js — Pantalla de inicio (v9.0): avance del mes, los tres botones (Remitos, Facturas, Enviar mails) con lo que
// falta en cada uno, y todas las OC encontradas en Drive con el progreso de cada período y el botón del paso siguiente.
(() => {
  "use strict";
  const A = window.App, P = window.Period, F = window.Flujo, $ = (id) => document.getElementById(id);
  const esc = A.esc;
  let filter = "todos", month = "";             // month: "2026-11"
  const mkey = (a, m) => a + "-" + String(m).padStart(2, "0");
  const cap = (s) => s.charAt(0) + s.slice(1).toLowerCase();

  function nextAction(u) {
    const p = u.progreso, s = p.siguiente;
    if (!u.started) return '<span class="hint">Desde el ' + u.periodo.from + "/" + u.periodo.month + "</span>";
    if (!s) return '<span class="chip ok">Completo ✔</span>';
    if (s === "remitos") return u.lote
      ? '<button type="button" class="btn soft next-btn" data-lote="' + esc(u.lote.id) + '">Confirmar tabla</button>'
      : '<button type="button" class="btn soft next-btn" data-go="remitos" data-unit="' + esc(u.key) + '">Escanear</button>';
    if (s === "factura") return '<button type="button" class="btn soft next-btn" data-go="facturas" data-unit="' + esc(u.key) + '">Facturar</button>';
    if (u.cliente === "grupol") return '<button type="button" class="btn soft next-btn" data-go="facturas" data-unit="' + esc(u.key) + '">WhatsApp</button>';
    return (u.estado && u.estado.envio)
      ? '<button type="button" class="btn soft next-btn" data-go="mails">Enviar mail</button>'
      : '<button type="button" class="btn soft next-btn" data-go="facturas" data-unit="' + esc(u.key) + '">Portal o Mail</button>';
  }

  function render() {
    if (A.current() !== "inicio") return;
    const D = window.Datos, st = D.state(), all = D.units();
    const prof = window.LAGAuth && window.LAGAuth.profile && window.LAGAuth.profile();
    $("homeHello").textContent = "Hola" + (prof && prof.nombre ? ", " + String(prof.nombre).split(" ")[0] : "");
    // meses con datos
    const months = [];
    all.forEach((u) => { const k = mkey(u.anio, u.mes); if (!months.includes(k)) months.push(k); });
    months.sort().reverse();
    const now = new Date(), nowKey = mkey(now.getFullYear(), now.getMonth() + 1);
    if (!month || !months.includes(month)) month = months.includes(nowKey) ? nowKey : months[0] || nowKey;
    $("homeMonths").innerHTML = months.map((k) => {
      const [y, m] = k.split("-").map(Number), us = all.filter((u) => u.anio === y && u.mes === m && u.started), done = us.filter((u) => u.progreso.completa).length;
      return '<button type="button" role="tab" data-m="' + k + '" aria-selected="' + (k === month) + '">' + cap(P.MESES[m - 1]) + " " + y + (us.length ? "<small>" + done + "/" + us.length + "</small>" : "") + "</button>";
    }).join("");
    const [yy, mm] = month.split("-").map(Number);
    const inMonth = all.filter((u) => u.anio === yy && u.mes === mm && (filter === "todos" || u.cliente === filter));
    const started = inMonth.filter((u) => u.started);
    // avance
    const pasos = started.reduce((s, u) => s + u.progreso.total, 0), hechos = started.reduce((s, u) => s + u.progreso.hechos, 0);
    const pct = pasos ? Math.round(hechos / pasos * 100) : 0;
    $("homeMonth").textContent = cap(P.MESES[mm - 1]) + " " + yy;
    $("homePct").textContent = pct + "%";
    $("homeRing").style.setProperty("--p", pct);
    $("homeRing").classList.toggle("done", pasos > 0 && pct === 100);
    $("homeBar").style.width = pct + "%";
    $("homeBar").parentElement.classList.toggle("done", pasos > 0 && pct === 100);
    // pendientes (de todos los meses leídos)
    const act = all.filter((u) => u.started);
    const nRem = act.filter((u) => u.progreso.pasos[0].estado !== "hecho" && (u.ended || u.lote)).length;
    const nFac = act.filter((u) => u.progreso.pasos[1].estado === "listo").length;
    const nMail = act.filter((u) => u.cliente === "cookmaster" && u.progreso.pasos[2].estado === "listo").length;
    const badge = (id, n, title) => { const b = $(id); b.hidden = !n; b.textContent = n; b.title = title; };
    badge("nRemitos", nRem, nRem + " período(s) con remitos por escanear o confirmar");
    badge("nFacturas", nFac, nFac + " factura(s) para cargar");
    badge("nMails", nMail, nMail + " mail(s) listos para enviar");
    let sum;
    if (!A.bridgeReady()) sum = "Configurá el puente a Google (Ajustes) para leer las OC y los Excel de Drive.";
    else if (D.busy()) sum = "Leyendo Drive…";
    else if (D.error()) sum = "No se pudo leer Drive: " + D.error();
    else if (!started.length) sum = st.at ? "No hay períodos en curso para este mes." : "Leyendo Drive…";
    else sum = hechos + " de " + pasos + " pasos hechos · " + started.filter((u) => u.progreso.completa).length + " de " + started.length + " períodos completos" + (st.at ? " · Drive leído a las " + String(new Date(st.at).getHours()).padStart(2, "0") + ":" + String(new Date(st.at).getMinutes()).padStart(2, "0") : "");
    $("homeSummary").textContent = sum;
    // tarjetas por OC
    const byOc = new Map();
    inMonth.forEach((u) => { const k = u.cliente + "|" + u.oc.numero; if (!byOc.has(k)) byOc.set(k, []); byOc.get(k).push(u); });
    const cards = [...byOc.values()].map((us) => {
      const u0 = us[0], oc = u0.oc, gl = u0.cliente === "grupol";
      const st2 = us.filter((u) => u.started), ph = st2.reduce((s, u) => s + u.progreso.hechos, 0), pt = st2.reduce((s, u) => s + u.progreso.total, 0);
      const p = pt ? Math.round(ph / pt * 100) : 0;
      return '<article class="card occ"><div class="occ-head"><span class="cli ' + (gl ? "gl" : "cm") + '">' + (gl ? "GL" : "CM") + '</span><div class="occ-title"><strong>OC ' + esc(oc.numero) + "</strong><small>" +
        esc((gl ? "Grupo L" : "Cook Master · " + F.sedeLabel(oc)) + (oc.delivery ? " — " + oc.delivery : "")) + '</small></div><span class="occ-pct' + (p === 100 ? " ok" : "") + '">' + (pt ? p + "%" : "") + "</span></div>" +
        us.map((u) => '<div class="per-row"><span class="per-name">' + esc(P.text(u.periodo) + "/" + u.periodo.month) + " <small>" + esc(gl ? "semana" : u.periodo.label) + "</small></span>" + nextAction(u) +
          '<div class="steps">' + u.progreso.pasos.map((s) => '<span class="step ' + (u.started ? s.estado : "") + '" title="' + esc(s.texto) + '">' + esc(s.label) + "</span>").join("") + "</div></div>").join("") + "</article>";
    });
    $("ocCards").innerHTML = cards.join("");
    const empty = !cards.length;
    $("ocEmptyHome").hidden = !empty;
    if (empty) {
      $("ocEmptyTitle").textContent = !A.bridgeReady() ? "Falta conectar Google Drive." : D.busy() ? "Leyendo las OC de Drive…" : "No hay órdenes de compra en este mes.";
      $("ocEmptySub").textContent = !A.bridgeReady() ? "En Ajustes poné la dirección y la clave del puente de Google (INSTRUCCIONES-PUENTE.txt)." : "Se buscan en Compartido conmigo / Facturacion / " + cap(P.MESES[mm - 1]) + " / Cook Master y Grupo L.";
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

  $("homeMonths").addEventListener("click", (e) => { const b = e.target.closest("button[data-m]"); if (b) { month = b.dataset.m; render(); } });
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
