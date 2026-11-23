# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

This is a static PWA called "Escáner de remitos", built for LAG Panificados SRL, a small bakery in Argentina. It does three things:

- **Remitos tab:** scans delivery notes (remitos) with the camera, CamScanner-style (crop + enhance). Each scanned batch is saved as a "PDF guardado" (lote) in the user's account. The reception table (quantities per product + OC) is filled in later, possibly from another device. Only then is the PDF built and sent to Google Drive and a Gmail draft.
- **Facturación tab:** builds billing tables from purchase orders (OC) and the monthly Excel of deliveries ("Despachos").
- **Billing progress:** tracks what percentage of each OC is already invoiced.

Technical constraints:

- Plain vanilla JavaScript. No framework, no `package.json`, no build step, no external runtime libraries.
- The PDF writer, xlsx/zip reader, PDF text extractor and PDF decryption are all hand-written.
- Hosted on GitHub Pages from the repo root.
- The owner used to deploy by uploading files through the GitHub web UI, which is why history is mostly "Add files via upload" commits. Since v8.3 the owner asked Claude to commit directly to `main` ("trabajarás directamente sobre GitHub"); Pages publishes from `main`.

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

For browser end-to-end checks, use Playwright against the local server. The committed `firebase-config.js` points at the real project, so for tests serve a copy of the site where:

- `firebase-config.js` uses a `demo-*` projectId;
- `firebase-sdk.js` is a test build whose `initializeAuth`/`getFirestore` wrappers call `connectAuthEmulator`/`connectFirestoreEmulator`.

Then run the Firebase emulators (auth on 9099, firestore on 8080) with `firestore.rules`. Test rules with `@firebase/rules-unit-testing`.

## Architecture

### Script loading and globals

`index.html` loads every script with plain `<script>` tags, in dependency order. Modules talk only through `window` globals, so a new file must:

- get a `<script>` tag in the right position in `index.html`;
- be added to `FILES` in `sw.js`.

There are two kinds of modules.

- **Pure, DOM-free modules**, wrapped as `(function (root) { ... })(typeof self !== "undefined" ? self : this)`:
  - Ending: `if (typeof module === "object" && module.exports) module.exports = api; else root.X = api;`
  - Global names: `Crop`, `Enhance`, `Period`, `PdfCrypt`, `PdfText`, `OcParse`, `FactParse`, `Xlsx`, `Despachos`, `buildPdf`, `Lectura`.
  - Dependencies between them use `require` in Node and `root.X` in the browser. For example, `despachos.js` and `factparse.js` depend on `OcParse`.
- **UI controllers**, as arrow IIFEs that touch the DOM:
  - `scanner.js` owns the Remitos tab: camera, capture, crop, enhance, the current batch of thumbnails, settings, the bridge call and PDF assembly. It exposes `window.RemitosApp`: `settings()`, `pages()`, `catalog()`, `setActive(on)`, `askConfirm`, `showMessage`, `setStatus`, `bridgeReady`, `sendToBridge`, `makePdf`, `downloadBlob`.
  - `lotes.js` owns the "PDF guardados" side panel and the lote dialog (photo viewer + reception table + send/download/delete). It exposes `window.Lotes.saveBatch`, which `scanner.js` calls from "Guardar PDF".
  - `oc.js` is the Facturación tab and is independent of the Remitos tab. Switching to it turns off the camera through `setActive(false)`.

### Generated data files

`logo-pdf.js` (`window.LOGO_PDF`, a JPEG in base64) is single-line generated data. Don't open it whole or edit it by hand.

`firebase-sdk.js` is a vendored esbuild bundle; see Authentication.

### Saved PDFs / lotes (v8.3)

`lotes-store.js` (`window.LotesStore`) stores each scanned batch.

- **Local first.** It writes to IndexedDB (`lag-remitos`, stores `lotes` and `fotos`), then uploads to Firestore and deletes the local copy. An upload that fails stays local with `pendiente: true`. It is retried on `online`, on list refresh and on unlock.
- **Firestore layout:**
  - `usuarios/{uid}/lotes/{id}` holds the meta fields (whitelisted in `firestore.rules` → `validLote`).
  - `usuarios/{uid}/lotes/{id}/partes/{page-chunk}` holds the JPEG bytes as `Bytes`, in chunks of 900 KB.
  - Photos go in Firestore because Firebase Storage needs the paid Blaze plan since 2026, and the free plan is a hard requirement. The quota is 1 GiB total, and sent lotes auto-delete after 15 days.
- **Lote fields:**
  - `estado`: `pendiente` → `lista` (OC + at least one quantity) → `enviado`.
  - `tabla`: `{ oc, valores: [{nombre, texto}], extras: [{nombre, texto}] }`.
  - `periodo`: the object returned by `Period.forDate`, recomputed from `creado` when the mode changes.
- Without a signed-in, approved account (unconfigured Firebase), lotes stay local only.

The automatic handwriting reader (v8.0–8.2: `lector.js`, `digits-core.js`, `digits-model.js`, `rl.js`) was removed in v8.3 at the owner's request. It is in git history before the v8.3 commit if it is ever needed.

### Reading quantities with the iPhone (v8.4)

Web pages can't call iOS Live Text, so an iOS Shortcut named **"LAG Cantidades"** acts as the bridge. The owner builds it once by hand; the steps are in the in-app help dialog `#lecHelpDialog`. It takes Share Sheet images, runs "Extract Text from Image" and copies the result to the clipboard.

1. In the lote dialog, `lotes.js` builds a "hoja de lectura" (`analyzePage`/`buildSheet`). The page is decoded and downscaled to a 1000 px-wide grayscale image, then analyzed:
   - **LAG remito form (v8.5, mode `fila`).** It has a CANTIDAD column and a DETALLE column with the 18 products pre-printed in `Lectura.FILAS_REMITO` order, followed by one blank row: 19 body rows in total. `Lectura.findTable` handles this case:
     1. It finds the long vertical CANTIDAD/DETALLE separator (tilt-tolerant search).
     2. It measures the horizontal-line tilt separately from the vertical one, because CamScanner pages are slightly sheared.
     3. It finds the dotted row lines as coverage peaks, using a lighter threshold than for text.
     4. It anchors on the solid table bottom and estimates the row height from the autocorrelation of the line profile.
     5. It snaps the 19-row grid to the peaks.
     6. It rejects other forms when fewer than 9 boundaries snap or too many lines fall off-grid.

     Only CANTIDAD cells that have ink in the middle band are cropped. People write sitting on the lower line, so the crop gets extra bottom padding. Each crop is labelled `Fnn =`, and row k maps to product k.
   - **Any other table (mode `renglon`).** `Lectura.findRows` produces full-width rows labelled `Rnn =`, and the product is matched by description.
   - **No table found.** The whole page is added as `HOJA n COMPLETA`.

   Tested against 15 real remito photos; they are not in the repo, so ask the owner for samples if needed.
2. It shares that image via `navigator.share({ files })` with only files, so the Shortcut receives a pure image input.
3. "Pegar lectura" calls `navigator.clipboard.readText()`, with a textarea fallback.
4. `Lectura.parse` handles labels split across lines, fixes confusable characters (`l2O` → 120) and skips "OC ####" notes.
5. `Lectura.match` fuzzy-matches each description to the catalog. Learned aliases are stored in localStorage `lecturaAlias`.
6. The sums go into the table as `a+b`. The reading is saved in `tabla.leido = { fecha, filas: [{h, r, q, d, p}], aplicados }`, so no rules change was needed. Applied inputs get the `.leido` highlight.

This is gated to iOS with Web Share file support (`LEC_OK`). On other devices only the saved reading is shown, for review. After "Guardar PDF", `Lotes.offerReading` asks to read right away; the `settings.lecturaPreguntar` setting turns that off. In tests, mock `navigator.share`/`canShare`/`clipboard` and use the iPhone device profile.

### Persistence

All app data is per device in `localStorage`. The main keys are:

- `settings`, which includes `bridgeUrl`, `bridgeKey`, `catalog`, `periodMode` and `filterMode`. It is per device, so the bridge must be configured on every device that sends.
- `ocData`, `ocAliases`, `ocClientAliases`, `facCache`.

Server-side data is the user accounts plus each user's lotes (see above and below).

### Google "puente" (bridge)

This is a Google Apps Script web app that is **not in this repo**. Its instructions file, `puente-google/INSTRUCCIONES-PUENTE.txt`, lives with the owner.

- Requests are POSTs with `Content-Type: text/plain` (to avoid a CORS preflight) and a JSON body `{ key, action, ... }`.
- Actions used by `oc.js`: `list`, `files`, `facturas`.
- `scanner.js` (`sendToBridge`, called from `lotes.js`) uploads the PDF and creates the Gmail draft.
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
- `LAGAuth.cloud()` returns `{ db, uid }` only for a signed-in, approved account; `lotes-store.js` uses it.
- `firestore.rules` is the security boundary. It whitelists exactly which fields each party may create or update. Any new field or write in `auth.js` or `lotes-store.js` must be matched in the rules, otherwise it fails with `permission-denied`. Every rules change must be re-published by the owner in the console, so call it out in the release notes.
  - Test rule changes with the Firestore emulator and `@firebase/rules-unit-testing`.
  - The owner publishes rules by pasting the file into the console (INSTRUCCIONES-USUARIOS.txt, step 5).
- `firebase-config.js` is intentionally left with empty strings in the repo. The owner fills it in. The values are public identifiers, not secrets.
- `firebase-sdk.js` is a bundle of firebase@13.2.0 that exposes `window.LAGFirebase`. Don't edit it. To add an SDK function, rebuild it in a scratch directory from an `entry.js` that re-exports the needed names:
  - `firebase/app`: `initializeApp`.
  - `firebase/auth`: `initializeAuth`, `indexedDBLocalPersistence`, `browserLocalPersistence`, `onAuthStateChanged`, `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, `sendPasswordResetEmail`, `updateProfile`, `signOut`.
  - `firebase/firestore/lite`: `getFirestore`, `doc`, `getDoc`, `setDoc`, `updateDoc`, `deleteDoc`, `writeBatch`, `collection`, `getDocs`, `serverTimestamp`, `Bytes`.

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
