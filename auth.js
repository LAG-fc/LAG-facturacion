// auth.js — Ingreso y registro de usuarios (v8.2).
//
// Usa Firebase, plan gratuito "Spark" (sin tarjeta de crédito):
//   · Firebase Authentication guarda las cuentas (correo y contraseña cifrada por Google) y envía los correos
//     para recuperar la contraseña.
//   · Cloud Firestore guarda el perfil de cada persona en la colección "usuarios": nombre, correo, estado
//     (pendiente / aprobado / deshabilitado) y rol (usuario / admin). Lo protegen las reglas de firestore.rules.
//
// La aplicación (cámara, remitos y facturación) queda oculta hasta que la cuenta esté aprobada por un administrador.
// Sin internet: si la sesión ya estaba iniciada en este dispositivo, se usa el último perfil verificado.
// Configuración: firebase-config.js. Paso a paso: INSTRUCCIONES-USUARIOS.txt.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const FB = window.LAGFirebase;
  const CFG = window.LAG_FIREBASE_CONFIG || {};
  const screen = $("authScreen");
  const CACHE_KEY = "authPerfil", EMAIL_KEY = "authUltimoCorreo", SKIP_KEY = "authSinCuenta", SEEN_KEY = "authIngresoAnotado";
  const ESTADOS = ["pendiente", "aprobado", "deshabilitado"];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, area = localStorage) { try { return JSON.parse(area.getItem(k) || "null"); } catch (e) { return null; } },
    set(k, v, area = localStorage) { try { area.setItem(k, JSON.stringify(v)); } catch (e) { /* nada */ } },
    del(k, area = localStorage) { try { area.removeItem(k); } catch (e) { /* nada */ } }
  };

  let auth = null, db = null, currentUser = null, profile = null, registering = false;

  // ---------- Desbloqueo de la aplicación ----------
  let unlocked = false;
  const unlockCbs = [];
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    document.body.classList.remove("auth-locked");
    unlockCbs.splice(0).forEach((cb) => { try { cb(); } catch (e) { console.error(e); } });
  }
  window.LAGAuth = {
    onUnlock(cb) { if (unlocked) cb(); else unlockCbs.push(cb); },
    user: () => currentUser,
    profile: () => profile,
    isAdmin: () => !!(profile && profile.rol === "admin" && profile.estado === "aprobado"),
    signOut: () => logout(true)
  };

  // ---------- Vistas de la pantalla de ingreso ----------
  const views = Array.from(screen.querySelectorAll(".auth-view"));
  const finePointer = window.matchMedia && matchMedia("(pointer: fine)").matches;   // en el celular no se abre el teclado solo
  let view = "splash";
  function show(name) {
    view = name;
    views.forEach((v) => { v.hidden = v.dataset.v !== name; });
    const v = views.find((x) => x.dataset.v === name);
    if (!v) return;
    const empty = Array.from(v.querySelectorAll("input")).find((i) => !i.value);
    const target = finePointer && empty ? empty : v.querySelector("h3");
    if (target) setTimeout(() => { try { target.focus({ preventScroll: true }); } catch (e) { /* nada */ } }, 30);
  }
  function setSplash(text) { $("authSplashText").textContent = text; show("splash"); }

  function say(el, text, kind) {
    if (!text) { el.hidden = true; el.textContent = ""; el.className = "auth-alert"; return; }
    el.className = "auth-alert" + (kind ? " " + kind : "");
    el.textContent = text;
    el.hidden = false;
  }
  function busy(btn, on) { btn.classList.toggle("is-busy", on); btn.disabled = on; btn.setAttribute("aria-busy", String(on)); }
  function markBad(input, bad) { if (bad) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid"); }
  function fieldError(input, msgEl, text) { markBad(input, true); say(msgEl, text); input.focus(); return false; }

  document.querySelectorAll(".auth-year").forEach((el) => { el.textContent = String(new Date().getFullYear()); });

  // ---------- Validaciones ----------
  const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
  const cleanName = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const strongEnough = (p) => p.length >= 8 && /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(p) && /\d/.test(p);
  function pwScore(p) {
    if (!p) return 0;
    if (!strongEnough(p)) return 1;
    let s = 2;
    if (p.length >= 12) s++;
    if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
    if (/[^A-Za-z0-9]/.test(p)) s++;
    return Math.min(4, s);
  }
  const PW_LABEL = ["", "Débil", "Aceptable", "Buena", "Muy segura"];
  function initials(name) {
    const parts = cleanName(name).split(" ").filter(Boolean);
    const ini = (parts[0] || "?").charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "");
    return ini.toUpperCase();
  }

  // ---------- Mensajes de error en castellano ----------
  const NET_CODES = ["auth/network-request-failed", "unavailable", "deadline-exceeded", "auth/timeout"];
  const isNetError = (e) => !navigator.onLine || (e && NET_CODES.includes(e.code));
  function authError(e) {
    const code = (e && e.code) || "";
    const map = {
      "auth/invalid-credential": "El correo o la contraseña no son correctos.",
      "auth/invalid-login-credentials": "El correo o la contraseña no son correctos.",
      "auth/wrong-password": "El correo o la contraseña no son correctos.",
      "auth/user-not-found": "El correo o la contraseña no son correctos.",
      "auth/invalid-email": "El correo electrónico no es válido.",
      "auth/missing-password": "Escribí tu contraseña.",
      "auth/email-already-in-use": "Ya existe una cuenta con ese correo. Iniciá sesión o recuperá la contraseña.",
      "auth/weak-password": "La contraseña es demasiado débil. Usá al menos 8 caracteres, con letras y números.",
      "auth/password-does-not-meet-requirements": "La contraseña no cumple los requisitos de seguridad del sistema.",
      "auth/too-many-requests": "Hubo demasiados intentos seguidos. Esperá unos minutos y volvé a probar.",
      "auth/network-request-failed": "No hay conexión a internet. Revisá la conexión y volvé a intentar.",
      "auth/user-disabled": "Esta cuenta fue deshabilitada. Consultá con el administrador.",
      "auth/operation-not-allowed": "El ingreso con correo y contraseña no está activado en Firebase (INSTRUCCIONES-USUARIOS.txt, paso 3).",
      "auth/unauthorized-domain": "Esta dirección web no está autorizada en Firebase (INSTRUCCIONES-USUARIOS.txt, paso 6).",
      "auth/unauthorized-continue-uri": "Esta dirección web no está autorizada en Firebase (INSTRUCCIONES-USUARIOS.txt, paso 6).",
      "auth/invalid-api-key": "Los datos de firebase-config.js no son correctos. Revisalos (INSTRUCCIONES-USUARIOS.txt, paso 2).",
      "auth/api-key-not-valid.-please-pass-a-valid-api-key.": "Los datos de firebase-config.js no son correctos. Revisalos (INSTRUCCIONES-USUARIOS.txt, paso 2).",
      "auth/configuration-not-found": "Falta activar Authentication en Firebase (INSTRUCCIONES-USUARIOS.txt, paso 3).",
      "auth/requests-from-referer-<empty>-are-blocked.": "Esta dirección web no está autorizada en Firebase (INSTRUCCIONES-USUARIOS.txt, paso 6)."
    };
    if (map[code]) return map[code];
    if (/referer|unauthorized-domain/.test(code)) return map["auth/unauthorized-domain"];
    if (/api-key/.test(code)) return map["auth/invalid-api-key"];
    if (!navigator.onLine) return map["auth/network-request-failed"];
    return "No se pudo completar la operación" + (code ? " (" + code + ")" : "") + ". Volvé a intentar en unos minutos.";
  }
  function dataError(e) {
    const code = (e && e.code) || "", msg = String((e && e.message) || "");
    if (isNetError(e)) return "No hay conexión con el servidor. Revisá la conexión a internet y volvé a intentar.";
    if (code === "permission-denied") return "Firebase no permitió leer tu perfil. Revisá que las reglas de seguridad de Firestore estén publicadas tal como figuran en firestore.rules (INSTRUCCIONES-USUARIOS.txt, paso 5).";
    if (code === "not-found" || /database .* does not exist/i.test(msg)) return "Todavía no se creó la base de datos Firestore del proyecto (INSTRUCCIONES-USUARIOS.txt, paso 4).";
    if (code === "failed-precondition" || code === "invalid-argument") return "La base de datos Firestore no está lista (" + code + "). Revisá los pasos 4 y 5 de INSTRUCCIONES-USUARIOS.txt.";
    return "Ocurrió un error inesperado" + (code ? " (" + code + ")" : "") + ". Volvé a intentar en unos minutos.";
  }
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("Tiempo de espera agotado"), { code: "deadline-exceeded" })), ms))]);

  // ---------- Perfil del usuario (Firestore: usuarios/<uid>) ----------
  function normalize(d, user) {
    return {
      uid: user.uid,
      nombre: cleanName(d.nombre) || cleanName(user.displayName) || user.email,
      email: d.email || user.email,
      estado: ESTADOS.includes(d.estado) ? d.estado : "pendiente",
      rol: d.rol === "admin" ? "admin" : "usuario"
    };
  }
  async function loadProfile(user, nombre) {
    const ref = FB.doc(db, "usuarios", user.uid);
    const snap = await FB.getDoc(ref);
    if (snap.exists()) {
      const d = snap.data();
      // se anota el último ingreso una vez por sesión del navegador (si falla, no importa)
      if (store.get(SEEN_KEY, sessionStorage) !== user.uid && cleanName(d.nombre).length >= 2) {
        FB.updateDoc(ref, { ultimoIngreso: FB.serverTimestamp() }).then(() => store.set(SEEN_KEY, user.uid, sessionStorage)).catch(() => {});
      }
      return normalize(d, user);
    }
    // Primera vez (o el perfil no llegó a guardarse al registrarse): se crea pendiente de aprobación.
    let n = cleanName(nombre || user.displayName || String(user.email || "").split("@")[0]);
    if (n.length < 2) n = "Usuario";
    const d = { nombre: n, email: user.email, estado: "pendiente", rol: "usuario", creado: FB.serverTimestamp(), ultimoIngreso: FB.serverTimestamp() };
    await FB.setDoc(ref, d);
    store.set(SEEN_KEY, user.uid, sessionStorage);
    return normalize(d, user);
  }

  async function checkAccess(user, opts = {}) {
    if (!opts.quiet) setSplash("Verificando tu cuenta…");
    const cached = store.get(CACHE_KEY);
    const cachedOk = cached && cached.uid === user.uid ? cached : null;
    let p = null;
    if (!navigator.onLine && cachedOk) p = cachedOk;            // sin internet: último perfil verificado en este dispositivo
    else {
      try { p = await withTimeout(loadProfile(user, opts.nombre), 15000); store.set(CACHE_KEY, p); }
      catch (e) {
        console.warn("Perfil de usuario:", e);
        if (cachedOk && isNetError(e)) p = cachedOk;
        else { showError(dataError(e)); return null; }
      }
    }
    profile = p;
    route();
    return p;
  }

  function route() {
    screen.querySelectorAll(".js-name").forEach((el) => { el.textContent = profile.nombre; });
    screen.querySelectorAll(".js-email").forEach((el) => { el.textContent = profile.email; });
    if (profile.estado === "aprobado") { setupUserMenu(); unlock(); }
    else if (profile.estado === "deshabilitado") show("blocked");
    else { say($("pendingMsg"), ""); show("pending"); }
  }

  let retryAction = null;
  function showError(text, retry) {
    $("authErrorText").textContent = text;
    retryAction = retry || (() => (currentUser ? checkAccess(currentUser) : location.reload()));
    $("authErrorLogout").hidden = !currentUser;
    show("error");
  }
  $("authRetry").addEventListener("click", async () => {
    const b = $("authRetry");
    busy(b, true);
    try { await retryAction(); } finally { busy(b, false); }
  });

  // ---------- Inicio ----------
  const configured = !!(CFG.apiKey && CFG.projectId && CFG.appId && CFG.authDomain);
  function init() {
    if (!configured) {
      if (store.get(SKIP_KEY, sessionStorage)) unlock();
      else show("setup");
      return;
    }
    if (!FB) { showError("No se pudo cargar el módulo de usuarios (firebase-sdk.js). Volvé a cargar la página; si sigue pasando, revisá que el archivo esté subido al repositorio.", () => location.reload()); return; }
    try {
      const app = FB.initializeApp(CFG);
      auth = FB.initializeAuth(app, { persistence: [FB.indexedDBLocalPersistence, FB.browserLocalPersistence] });
      auth.languageCode = "es";
      db = FB.getFirestore(app);
    } catch (e) {
      console.error(e);
      showError("Los datos de firebase-config.js no son válidos. Revisalos (INSTRUCCIONES-USUARIOS.txt, paso 2).", () => location.reload());
      return;
    }
    FB.onAuthStateChanged(auth, (user) => {
      currentUser = user;
      if (registering) return;                       // el registro termina su propio recorrido
      if (!user) {
        profile = null;
        if (unlocked) { location.reload(); return; } // se cerró la sesión (por ejemplo, desde otra pestaña)
        if (!["login", "register", "reset"].includes(view)) show("login");
        return;
      }
      checkAccess(user);
    });
  }
  $("authSkip").addEventListener("click", () => { store.set(SKIP_KEY, true, sessionStorage); unlock(); });

  // ---------- Navegación entre formularios ----------
  const loginEmail = $("loginEmail"), loginPass = $("loginPass"), regName = $("regName"), regEmail = $("regEmail");
  const regPass = $("regPass"), regPass2 = $("regPass2"), resetEmail = $("resetEmail");
  const lastEmail = store.get(EMAIL_KEY);
  if (lastEmail) { loginEmail.value = lastEmail; resetEmail.value = lastEmail; }

  screen.addEventListener("click", (e) => {
    const b = e.target.closest("[data-go]");
    if (!b) return;
    const to = b.dataset.go;
    const typed = (view === "login" ? loginEmail : view === "register" ? regEmail : resetEmail).value.trim();
    if (typed) { if (to === "reset") resetEmail.value = typed; if (to === "login") loginEmail.value = typed; if (to === "register" && !regEmail.value) regEmail.value = typed; }
    ["loginMsg", "registerMsg", "resetMsg"].forEach((id) => say($(id), ""));
    screen.querySelectorAll("[aria-invalid]").forEach((i) => i.removeAttribute("aria-invalid"));
    show(to);
  });
  screen.addEventListener("input", (e) => {
    if (!e.target.matches("input")) return;
    markBad(e.target, false);
    const form = e.target.closest("form"), alert = form && form.querySelector(".auth-alert");
    if (alert && !alert.classList.contains("ok")) say(alert, "");   // el aviso de error se borra al corregir
  });

  // Mostrar / ocultar contraseña
  screen.querySelectorAll(".af-eye").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = btn.parentElement.querySelector("input");
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      btn.setAttribute("aria-pressed", String(!showing));
      btn.setAttribute("aria-label", showing ? "Mostrar contraseña" : "Ocultar contraseña");
      btn.querySelector("use").setAttribute("href", showing ? "#i-eye" : "#i-eye-off");
      input.focus();
    });
  });

  // Medidor de seguridad de la contraseña
  const meter = $("pwMeter");
  regPass.addEventListener("input", () => {
    const s = pwScore(regPass.value);
    meter.dataset.score = String(s);
    meter.dataset.label = PW_LABEL[s];
  });

  // ---------- Iniciar sesión ----------
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("loginMsg"), btn = e.target.querySelector(".auth-submit");
    const email = loginEmail.value.trim(), pass = loginPass.value;
    say(msg, "");
    if (!validEmail(email)) return fieldError(loginEmail, msg, "Escribí un correo electrónico válido.");
    if (!pass) return fieldError(loginPass, msg, "Escribí tu contraseña.");
    if (!auth) return say(msg, "El registro de usuarios no está configurado.");
    busy(btn, true);
    try {
      await FB.signInWithEmailAndPassword(auth, email, pass);
      store.set(EMAIL_KEY, email);
      loginPass.value = "";
      // sigue en onAuthStateChanged → checkAccess
    } catch (err) {
      say(msg, authError(err));
      if (/credential|password|user-not-found/.test(err.code || "")) { markBad(loginPass, true); loginPass.select(); }
    } finally { busy(btn, false); }
  });

  // ---------- Crear cuenta ----------
  $("registerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("registerMsg"), btn = e.target.querySelector(".auth-submit");
    const nombre = cleanName(regName.value), email = regEmail.value.trim(), p1 = regPass.value, p2 = regPass2.value;
    say(msg, "");
    if (nombre.length < 2 || !/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(nombre)) return fieldError(regName, msg, "Escribí tu nombre y apellido.");
    if (!validEmail(email)) return fieldError(regEmail, msg, "Escribí un correo electrónico válido.");
    if (!strongEnough(p1)) return fieldError(regPass, msg, "La contraseña tiene que tener al menos 8 caracteres, con letras y números.");
    if (p1 !== p2) return fieldError(regPass2, msg, "Las contraseñas no coinciden.");
    if (!auth) return say(msg, "El registro de usuarios no está configurado.");
    busy(btn, true);
    registering = true;
    let cred = null;
    try {
      cred = await FB.createUserWithEmailAndPassword(auth, email, p1);
    } catch (err) {
      registering = false;
      busy(btn, false);
      say(msg, authError(err));
      if (err.code === "auth/email-already-in-use") markBad(regEmail, true);
      return;
    }
    try { await FB.updateProfile(cred.user, { displayName: nombre }); } catch (err) { /* el nombre igual queda en el perfil */ }
    registering = false;
    currentUser = cred.user;
    store.set(EMAIL_KEY, email);
    loginEmail.value = email;
    regPass.value = regPass2.value = "";
    meter.dataset.score = "0"; meter.dataset.label = "";
    busy(btn, false);
    await checkAccess(cred.user, { nombre });
  });

  // ---------- Recuperar contraseña ----------
  $("resetForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $("resetMsg"), btn = e.target.querySelector(".auth-submit");
    const email = resetEmail.value.trim();
    say(msg, "");
    if (!validEmail(email)) return fieldError(resetEmail, msg, "Escribí un correo electrónico válido.");
    if (!auth) return say(msg, "El registro de usuarios no está configurado.");
    busy(btn, true);
    const ok = () => say(msg, "Listo. Si " + email + " tiene una cuenta, en unos minutos vas a recibir un correo con el enlace. Revisá también la carpeta de correo no deseado.", "ok");
    try { await FB.sendPasswordResetEmail(auth, email); ok(); }
    catch (err) { if (err.code === "auth/user-not-found") ok(); else say(msg, authError(err)); }
    finally { busy(btn, false); }
  });

  // ---------- Cuenta pendiente: volver a comprobar ----------
  $("pendingCheck").addEventListener("click", async () => {
    const btn = $("pendingCheck"), msg = $("pendingMsg");
    if (!currentUser) return;
    busy(btn, true);
    say(msg, "");
    const p = await checkAccess(currentUser, { quiet: true });
    busy(btn, false);
    if (p && p.estado === "pendiente") say(msg, "Tu cuenta todavía está pendiente. Avisale al administrador y volvé a comprobar más tarde.", "info");
  });

  // ---------- Cerrar sesión ----------
  async function logout(ask) {
    if (ask && unlocked && window.RemitosApp && window.RemitosApp.askConfirm) {
      const n = (window.RemitosApp.pages && window.RemitosApp.pages().length) || 0;
      const extra = n ? "\n\nAtención: hay " + n + (n === 1 ? " remito escaneado" : " remitos escaneados") + " en pantalla que se van a perder si no los guardaste." : "";
      if (!(await window.RemitosApp.askConfirm("¿Cerrar la sesión en este dispositivo?" + extra, "Cerrar sesión", "Cancelar"))) return;
    }
    store.del(CACHE_KEY);
    store.del(SKIP_KEY, sessionStorage);
    store.del(SEEN_KEY, sessionStorage);
    if (auth) { try { await FB.signOut(auth); } catch (e) { /* nada */ } }
    location.reload();
  }
  document.addEventListener("click", (e) => { if (e.target.closest(".js-logout")) { closeMenu(); logout(true); } });

  // ---------- Menú del usuario (encabezado) ----------
  const userBtn = $("userBtn"), userPop = $("userPop");
  function closeMenu() { userPop.hidden = true; userBtn.setAttribute("aria-expanded", "false"); }
  function setupUserMenu() {
    if (!profile) return;
    $("userMenu").hidden = false;
    $("userAvatar").textContent = $("userAvatarLg").textContent = initials(profile.nombre);
    $("userFirst").textContent = profile.nombre.split(" ")[0];
    $("userName").textContent = profile.nombre;
    $("userEmail").textContent = profile.email;
    $("userRole").textContent = profile.rol === "admin" ? "Administrador" : "Usuario";
    $("userRole").classList.toggle("admin", profile.rol === "admin");
    $("adminBtn").hidden = !window.LAGAuth.isAdmin();
    if (window.LAGAuth.isAdmin() && navigator.onLine) loadUsers().then(updatePendingBadge).catch(() => {});
  }
  userBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = userPop.hidden;
    userPop.hidden = !open;
    userBtn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => { if (!userPop.hidden && !e.target.closest("#userMenu")) closeMenu(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !userPop.hidden) { closeMenu(); userBtn.focus(); } });

  // ---------- Administración de usuarios ----------
  const usersDialog = $("usersDialog"), usersList = $("usersList"), usersMsg = $("usersMsg");
  let users = [], usersFilter = "pendiente";
  async function loadUsers() {
    const snap = await withTimeout(FB.getDocs(FB.collection(db, "usuarios")), 15000);
    users = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    const order = { pendiente: 0, aprobado: 1, deshabilitado: 2 };
    const t = (x) => (x && typeof x.toMillis === "function" ? x.toMillis() : 0);
    users.sort((a, b) => (order[a.estado] ?? 0) - (order[b.estado] ?? 0) || t(b.creado) - t(a.creado));
    return users;
  }
  function updatePendingBadge() {
    const n = users.filter((u) => u.estado === "pendiente").length;
    const badge = $("pendingCount");
    badge.hidden = !n; badge.textContent = String(n);
    $("userBtn").classList.toggle("has-alert", n > 0);
    $("usersPendN").textContent = n ? "(" + n + ")" : "";
    $("usersAllN").textContent = "(" + users.length + ")";
  }
  const fmtDate = (ts) => {
    if (!ts || typeof ts.toDate !== "function") return "—";
    const d = ts.toDate(), p = (n) => String(n).padStart(2, "0");
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear();
  };
  const ST_LABEL = { pendiente: "Pendiente", aprobado: "Aprobado", deshabilitado: "Deshabilitado" };
  function renderUsers() {
    updatePendingBadge();
    const me = currentUser && currentUser.uid;
    const list = usersFilter === "pendiente" ? users.filter((u) => u.estado === "pendiente") : users;
    if (!list.length) {
      usersList.innerHTML = '<div class="users-empty"><svg class="i big"><use href="#i-check"/></svg><p>' +
        (usersFilter === "pendiente" ? "No hay cuentas pendientes de aprobación." : "Todavía no hay usuarios registrados.") + "</p></div>";
      return;
    }
    usersList.innerHTML = list.map((u) => {
      const estado = ESTADOS.includes(u.estado) ? u.estado : "pendiente", admin = u.rol === "admin", self = u.id === me;
      let actions = "";
      if (self) actions = '<span class="hint">Tu cuenta</span>';
      else if (estado === "pendiente") actions = btn("aprobar", "Aprobar", "primary") + btn("rechazar", "Rechazar", "ghost danger-text");
      else if (estado === "aprobado") actions = btn(admin ? "quitar-admin" : "hacer-admin", admin ? "Quitar administrador" : "Hacer administrador", "ghost") + btn("deshabilitar", "Deshabilitar", "ghost danger-text");
      else actions = btn("habilitar", "Habilitar", "soft");
      return '<div class="user-row" data-id="' + esc(u.id) + '">' +
        '<span class="avatar">' + esc(initials(u.nombre || u.email)) + "</span>" +
        '<div class="ur-id"><strong>' + esc(u.nombre || "Sin nombre") + "</strong><small>" + esc(u.email || "") + "</small>" +
        '<small class="ur-dates">Registro: ' + fmtDate(u.creado) + " · Último ingreso: " + fmtDate(u.ultimoIngreso) + "</small></div>" +
        '<div class="ur-tags"><span class="st-tag ' + estado + '">' + ST_LABEL[estado] + "</span>" + (admin ? '<span class="role-tag admin">Administrador</span>' : "") + "</div>" +
        '<div class="ur-actions">' + actions + "</div></div>";
    }).join("");
    function btn(act, label, cls) { return '<button type="button" class="btn small ' + cls + '" data-act="' + act + '">' + label + "</button>"; }
  }
  async function openUsers() {
    closeMenu();
    usersMsg.textContent = "";
    usersList.innerHTML = '<div class="users-empty"><span class="spinner"></span><p>Cargando usuarios…</p></div>';
    if (!usersDialog.open) usersDialog.showModal();
    try { await loadUsers(); if (usersFilter === "pendiente" && !users.some((u) => u.estado === "pendiente")) setFilter("todos"); else renderUsers(); }
    catch (e) { usersList.innerHTML = ""; usersMsg.textContent = dataError(e); }
  }
  function setFilter(f) {
    usersFilter = f;
    $("usersSeg").querySelectorAll(".seg-btn").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.f === f)));
    renderUsers();
  }
  $("adminBtn").addEventListener("click", openUsers);
  $("usersClose").addEventListener("click", () => usersDialog.close());
  $("usersRefresh").addEventListener("click", openUsers);
  $("usersSeg").addEventListener("click", (e) => { const b = e.target.closest(".seg-btn"); if (b) setFilter(b.dataset.f); });
  usersList.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const row = b.closest(".user-row"), u = users.find((x) => x.id === row.dataset.id);
    if (!u) return;
    const act = b.dataset.act, name = u.nombre || u.email;
    const changes = {
      "aprobar": { estado: "aprobado" },
      "habilitar": { estado: "aprobado" },
      "rechazar": { estado: "deshabilitado" },
      "deshabilitar": { estado: "deshabilitado", rol: "usuario" },
      "hacer-admin": { rol: "admin" },
      "quitar-admin": { rol: "usuario" }
    }[act];
    const ask = {
      "rechazar": "¿Rechazar la cuenta de " + name + "? No va a poder ingresar a la aplicación.",
      "deshabilitar": "¿Deshabilitar el acceso de " + name + "? Deja de poder ingresar la próxima vez que abra la aplicación.",
      "hacer-admin": "¿Hacer administrador a " + name + "? Va a poder aprobar, deshabilitar y nombrar administradores a otras personas."
    }[act];
    if (!changes) return;
    if (ask && window.RemitosApp && !(await window.RemitosApp.askConfirm(ask, "Confirmar", "Cancelar"))) return;
    usersMsg.textContent = "";
    row.querySelectorAll("button").forEach((x) => { x.disabled = true; });
    try {
      await withTimeout(FB.updateDoc(FB.doc(db, "usuarios", u.id), Object.assign({}, changes, { actualizado: FB.serverTimestamp() })), 15000);
      Object.assign(u, changes);
      renderUsers();
    } catch (err) {
      usersMsg.textContent = dataError(err);
      row.querySelectorAll("button").forEach((x) => { x.disabled = false; });
    }
  });

  init();
})();
