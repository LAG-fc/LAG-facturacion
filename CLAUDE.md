# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

This is a static PWA called "Escáner de remitos", built for LAG Panificados SRL, a small bakery in Argentina. It does three things:

- **Remitos tab:** scans delivery notes (remitos) with the camera and reads them offline. It builds a PDF with a reception table and sends the PDF to Google Drive and Gmail.
- **Facturación tab:** builds billing tables from purchase orders (OC) and the monthly Excel of deliveries ("Despachos").
- **Billing progress:** tracks what percentage of each OC is already invoiced.

Technical constraints:

- Plain vanilla JavaScript. No framework, no `package.json`, no build step, no external runtime libraries.
- The PDF writer, xlsx/zip reader, PDF text extractor, PDF decryption and the digit recognizer are all hand-written.
- Hosted on GitHub Pages from the repo root.
- The owner deploys by uploading files through the GitHub web UI. That is why history is mostly "Add files via upload" commits.

Everything user-facing is in Rioplatense Spanish with voseo ("tocá", "revisá"): UI text, error messages, code comments and the `.txt` docs. Keep it that way. The owner is not a developer, so instructions must be click-by-click.

## Running and testing

There are no lint, build or test commands in the repo.

Serve the folder locally. The camera needs `localhost` or HTTPS.

```bash
python3 -m http.server 8000
```

The pure modules (UMD pattern, see below) load directly in Node, which is how to unit-test parsing and recognition logic:

```bash
node -e 'const P=require("./period.js"); console.log(P.forDate("quincenal", new Date(2026,10,20)))'
```

For browser end-to-end checks, use Playwright against the local server. If `firebase-config.js` is empty, auth stops at the "Falta activar el registro de usuarios" view; click "Continuar sin iniciar sesión" to reach the app.

## Architecture

### Script loading and globals

`index.html` loads every script with plain `<script>` tags, in dependency order. Modules talk only through `window` globals, so a new file must:

- get a `<script>` tag in the right position in `index.html`;
- be added to `FILES` in `sw.js`.

There are two kinds of modules.

- **Pure, DOM-free modules**, wrapped as `(function (root) { ... })(typeof self !== "undefined" ? self : this)`:
  - Ending: `if (typeof module === "object" && module.exports) module.exports = api; else root.X = api;`
  - Global names: `Crop`, `Enhance`, `Period`, `PdfCrypt`, `PdfText`, `OcParse`, `FactParse`, `Xlsx`, `Despachos`, `buildPdf`, `DigitsCore`, `RemitoRL`.
  - Dependencies between them use `require` in Node and `root.X` in the browser. For example, `despachos.js` and `factparse.js` depend on `OcParse`.
- **UI controllers**, as arrow IIFEs that touch the DOM:
  - `scanner.js` owns the Remitos tab: camera, capture, crop, enhance, thumbnails, totals dialog, PDF, settings. It exposes `window.RemitosApp`, which includes `settings()`, `pages()`, `setActive(on)` and `askConfirm`.
  - `lector.js` attaches the automatic reader to `RemitosApp` and needs `DigitsCore` and `RemitoRL`.
  - `oc.js` is the Facturación tab and is independent of the Remitos tab. Switching to it turns off the camera through `setActive(false)`.

### Generated data files

`digits-model.js` (`self.DigitsModelData`, neural-net weights in base64) and `logo-pdf.js` (`window.LOGO_PDF`, a JPEG in base64) are single-line generated data. Don't open them whole or edit them by hand.

`firebase-sdk.js` is a vendored esbuild bundle; see Authentication.

### Reader pipeline (v8)

`digits-core.js` works in these steps:

1. Binarize with several strategies.
2. Segment characters.
3. Classify them with a small MLP.
4. Decode against the values that are plausible given context: the month's Despachos Excel and the loaded OCs.

`rl.js` learns from what the user confirms:

- A per-strategy Beta bandit.
- Retraining of the last layer from a replay buffer.
- Confidence calibration.

Its state is stored in localStorage under `rlV8`. Since v8.1 only client, OC and quantities are read. Date and remito number are not.

### Persistence

All app data is per device in `localStorage`. The main keys are:

- `settings`, which includes `bridgeUrl`, `bridgeKey`, `catalog`, `zones`, `periodMode` and `lector`.
- `totals`, `ocData`, `ocAliases`, `ocClientAliases`, `facCache`, `despDia` and `rlV8`.

The only server-side data is the user accounts (see below).

### Google "puente" (bridge)

This is a Google Apps Script web app that is **not in this repo**. Its instructions file, `puente-google/INSTRUCCIONES-PUENTE.txt`, lives with the owner.

- Requests are POSTs with `Content-Type: text/plain` (to avoid a CORS preflight) and a JSON body `{ key, action, ... }`.
- Actions used by `oc.js`: `list`, `files`, `facturas`.
- `scanner.js` uploads the PDF and creates the Gmail draft.
- The URL must match `https://script.google(usercontent).com/`.
- If you change the payload, the owner must redeploy the bridge. Say so explicitly in the release notes.

### Authentication (v8.2)

- `auth.js` gates the whole app. `<body class="auth-locked">` hides everything except `#authScreen`.
- Unlocking calls the `LAGAuth.onUnlock` callbacks. `scanner.js` starts the camera only there, so no camera prompt appears before login.
- The backend is Firebase on the free Spark plan:
  - Auth with email and password.
  - Firestore **lite**, collection `usuarios/{uid}` with fields `nombre`, `email`, `estado` (`pendiente` | `aprobado` | `deshabilitado`), `rol` (`usuario` | `admin`), `creado`, `ultimoIngreso` and `actualizado`.
- New accounts start as `pendiente`/`usuario`. Admins approve them in the "Administrar usuarios" dialog. The first admin is set by hand in the Firebase console.
- The profile is cached in localStorage `authPerfil`, so a device that already has a session opens the app offline.
- `firestore.rules` is the security boundary. It whitelists exactly which fields each party may create or update. Any new field or write in `auth.js` must be matched in the rules, otherwise it fails with `permission-denied`.
  - Test rule changes with the Firestore emulator and `@firebase/rules-unit-testing`.
  - The owner publishes rules by pasting the file into the console (INSTRUCCIONES-USUARIOS.txt, step 5).
- `firebase-config.js` is intentionally left with empty strings in the repo. The owner fills it in. The values are public identifiers, not secrets.
- `firebase-sdk.js` is a bundle of firebase@13.2.0 that exposes `window.LAGFirebase`. Don't edit it. To add an SDK function, rebuild it in a scratch directory from an `entry.js` that re-exports the needed names:
  - `firebase/app`: `initializeApp`.
  - `firebase/auth`: `initializeAuth`, `indexedDBLocalPersistence`, `browserLocalPersistence`, `onAuthStateChanged`, `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, `sendPasswordResetEmail`, `updateProfile`, `signOut`.
  - `firebase/firestore/lite`: `getFirestore`, `doc`, `getDoc`, `setDoc`, `updateDoc`, `collection`, `getDocs`, `serverTimestamp`.

  Pin the versions, and keep the license header comment at the top of the output file. Pinning avoids a duplicated `@firebase/app`, which causes "Component auth has not been registered yet".

  ```bash
  npm i firebase@13.2.0 esbuild@0.25.10
  ```

  ```bash
  npx esbuild entry.js --bundle --minify --format=iife --global-name=LAGFirebase --target=es2018 --legal-comments=none --outfile=firebase-sdk.js
  ```

### Service worker

`sw.js` is **network-first** and falls back to the cache. `install` runs `cache.addAll(FILES)`, so a missing file in `FILES` makes the whole install fail and the app won't work offline. This already happened once with the missing `icons/` folder.

## Releasing a version

Each change ships as a version number. Bump it in all of these places together:

- `APP_VERSION` in `scanner.js`.
- `#verTag`, `#verLabel` and `.auth-ver` in `index.html`.
- `VERSION` in `sw.js`, as `remitos-vX.Y.Z`. This also invalidates old caches.

Then add a "NOVEDADES vX.Y" block at the top of `LEEME-PUBLICAR.txt`. It should explain the change in plain Spanish and list which files are **new** and which **changed**, because the owner uploads exactly those files by hand.

Home-screen icons live in `icons/`. The manifest declares `any` and `maskable` icons at 192 and 512 px. iOS uses `apple-touch-icon.png` (180 px, opaque).
