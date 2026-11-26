# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

This is a static PWA called "Facturación LAG" (formerly "Escáner de remitos"), built for LAG Panificados SRL, a small bakery in Argentina. Since v9.0 it is one main screen (Inicio) with three buttons and the list of every purchase order (OC) found in Google Drive. It bills two clients:

- **Cook Master:** several OCs per month (one per site: CC, CS/Penal, La Plata, UP 59, UP 60, Alcaidía, others), billed per quincena (one remito per day: 15 or 16). One monthly "Despachos" Excel.
- **Grupo L:** one OC per month (SAP format), billed per week; one "PEDIDO SEMANAL" Excel per week with 3 products.

The three buttons:

1. **Remitos:** pick OC + period from the Drive list, scan the remitos (CamScanner-style crop + enhance), "Guardar remitos" saves a lote. In the lote dialog the reception grid has an **Excel** column (despachos for that product and period). "Confirmar y guardar en Drive" compares remitos vs. Excel: if equal, builds the PDF (remitos + table) and uploads it to `Mi unidad/OC-<año>/<Cliente>/OC-<n>`; if not, the scanned table is not confirmed and the user enters the real despachos table, which goes into the PDF instead.
2. **Facturas:** billing table per OC + period (quantities from the confirmed table, prices/IVA from the OC). The user uploads the ARCA invoice PDF; the app parses it, checks it against the table, saves it in the OC folder and appends a row to the "Facturación" Google Sheet (Grupo L → 1st sheet, Cook Master → 2nd sheet). Grupo L: send by WhatsApp (Web Share). Cook Master: choose «Portal» or «Mail».
3. **Enviar mails:** progress table of every OC + period; sends the Cook Master mails (Portal: remitos PDF; Mail: remitos + invoice) and then fills "REMITOS ENV" and "FC (MAIL O PORTAL)" in the sheet.

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
  - Global names: `Crop`, `Enhance`, `Period`, `PdfCrypt`, `PdfText`, `OcParse`, `FactParse`, `Xlsx`, `Despachos`, `GrupoL`, `Flujo`, `buildPdf`.
  - Dependencies between them use `require` in Node and `root.X` in the browser.
  - `flujo.js` is the billing logic: units (OC + period), `despachos()`, `qtyByItem`, `compare`, `billing`, `quantities`, `descripcion` (sheet text), `filaPlanilla`, `progress`. Test it in Node with real files.
- **UI controllers**, as arrow IIFEs that touch the DOM:
  - `app.js` (`window.App`): settings (localStorage `settings`), hash navigation (`#inicio`, `#remitos`, `#facturas`, `#mails`; `App.go(view, {unit})`), `askConfirm`/`showMessage`/`toast`, an event bus (`App.on/emit`: `unlock`, `view`, `datos`, `lotes`, `settings`, `drive:*`). It starts everything on `DOMContentLoaded` + `LAGAuth.onUnlock`.
  - `drive.js`: `window.Puente.call({action, ...})` (the bridge) and `window.Datos` (Drive scan of the previous, current and next month; OC records, Cook Master workbooks, Grupo L weeklies; `Datos.units()` builds the units with progress). Downloaded files are cached in IndexedDB `lag-drive`; the scan result in localStorage `datosDrive`.
  - `unidades-store.js` (`window.UnidadesStore`): per-unit state (`confirmacion`, `remitos`, `tablaReal`, `pdf`, `factura`, `envio`, `planilla`, `mail`, `wpp`). Local copy + Firestore `usuarios/{uid}/unidades/{key}`. Key = `cliente|oc|YYYY-MM-DD_YYYY-MM-DD`.
  - `scanner.js` (`window.RemitosApp`): camera, capture, crop, enhance, thumbnails, unit selector, "Guardar remitos", `makePdf`. The camera only runs in the Remitos view (`setActive`).
  - `lotes.js` (`window.Lotes`): saved lotes list + lote dialog (photo viewer, grid with Excel column, compare, diff dialog, upload). `items()`, `recepcionOf()`, `open(id)`, `saveBatch(shots, periodo, onProgress, {oc, cliente})`.
  - `facturas.js`, `mails.js`, `inicio.js`: the three views.

### Paper crop and filters (v8.7, CamScanner-style)

`crop.js` (`window.Crop`) finds and straightens the sheet. The owner's rule: the frame is ALWAYS a rectangle (seen in perspective), never an arbitrary polygon. When in doubt, don't crop: a distorted crop is the worst outcome.

- `detectPaper(img)` runs on a ≤480 px copy (live loop every 400 ms and once per capture). It finds Sobel edges, then a Hough transform with polarity (each line remembers its bright side), and pairs near-parallel lines into quads. Corners are line intersections, so a finger or shadow on a corner does not matter.
  - `houghLines` marks printed lines as `thin`: two opposite-polarity edges ≤ 4.5 px apart with the same brightness on both outer sides. They are kept out of the strict search, so form rules don't crowd out the paper edge.
  - Shape check `sheetShape`:
    - convex, angles 60–120°, opposite sides ratio ≥ 0.55;
    - `sheet3D` (Zhang–He with f = 0.75·max side): the reconstructed sheet must have 90° ± 8° corners and a short/long ratio ≥ 0.55. Real sheets give ≤ 7° even at a 35° tilt. A fold edge or a header strip fails this.
  - Each side needs a bright-inside/dark-outside step along ≥ 40 % of it, and its outside band (70th percentile) darker than the inside paper by ≥ 10. This rejects printed table lines, already-cropped scans and photos without paper.
  - Image borders count as sides (sheet bigger than the frame), at most 2, and then the quad must cover ≥ 40 % of the frame. Corners may fall up to 10 % outside the frame; `warp` fills that part with white.
  - If the strict search finds nothing, `detectRelaxed` runs. It is meant for white paper on a white table, where the edge is only a shadow line or the table is brighter than the paper. Polarity is ignored. The sheet orientation comes from the form lines. For each side it takes the outermost aligned line whose outside band has no text, otherwise the image border. It returns `relaxed: true`. Then `process(..., { relaxed })` skips `refineQuad` and grows the quad by 0.6 %.
- `process(img, quad, maxSide, opts)` runs on the full-res photo:
  - `refineQuad` re-measures each side with perpendicular profiles and picks the continuous edge with RANSAC (text strokes are rejected). It fits a line or a quadratic (curved sheet), intersects them in 2 passes and insets ~0.2 %.
  - `aspectRatio` snaps to remito 0.83 ±9 %, A4 or oficio.
  - `warp` applies the homography plus a boundary-blend dewarp of curved edges.
- Test data:
  - Real remito photos: the owner's Google Drive has iPhone photos (`IMG_0xxx.JPG`, 4284×5712, EXIF-rotated). Find them with the Google Drive connector (`search_files` with `mimeType contains 'image/'` or `fullText contains 'remito'`). `download_file_content` saves the full-res file under the session's `tool-results` folder. Typical conditions: a close-up of a talonario page that fills the frame, the folded copy over the top-left corner, a white table, binder holes.
  - A synthetic bench of Python-generated scenes with ground-truth corners, run in Playwright. It lived in the session scratchpad, not in the repo.

`enhance.js` (`window.Enhance.apply(img, mode)`, modes `mejorado` | `gris` | `documento` | `color`):

- `mejorado` is `provenEnhance`, the v8.6 algorithm unchanged, followed by a chroma cleanup.
  - `provenEnhance`: per-channel illumination map (70th percentile, dilated), levels and sharpening.
  - Chroma cleanup: chroma is blurred, zeroed on paper and boosted 1.35× on ink. Green is recomputed so luma (77·R + 150·G + 29·B) is exactly unchanged.
  - Why the v8.6 core was kept: the old quantity reader (`Lectura.findTable`, removed in v8.8) was very sensitive to the contrast of the dotted rows. A new tone curve and denoise lost tables on real photos.
- `gris` is the luma of `provenEnhance`, so it reads the same as `mejorado`.
- `documento` runs `flatten`, an edge-preserving denoise, then Sauvola (k = 0.2) with a short ramp, floored by a gray tone curve.
  - `flatten`: per-channel background map (85th percentile, content blocks inpainted) and division.
  - Keep `mejorado` as the default.

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
  - `estado`: `pendiente` → `lista` (OC + at least one valid quantity, no bad cells) → `enviado`. Editing a sent lote's table sets it back to `lista`/`pendiente`.
  - `tabla` (v8.8): `{ oc, remitos, filas: [{nombre, cant: [text per remito]}], valores: [{nombre, texto: total}], extras: [] }`.
    - `valores` carries the per-product totals, the format v8.3–8.7 read.
    - Lotes saved before v8.8 have only `valores`/`extras`. `toWork` loads each old total into the Remito 1 column.
    - `tabla.oc` and `tabla.cliente` (v9.0) are set at save time from the unit chosen in the scanner.
    - `firestore.rules` only checks `tabla is map`, so the table format can change without a rules change. No arrays directly inside arrays: Firestore rejects them.
  - `periodo`: a `Period` object (`{mode, from, to, year, month, label}` plus `toMonth/toYear` when it crosses months, e.g. a Grupo L week). Set from the unit; the lote dialog lets the user pick another period of the same OC.
  - `estado: "enviado"` now means "PDF saved in Drive". The flow state that must outlive the 15-day cleanup lives in `unidades` (see Persistence).
- Without a signed-in, approved account (unconfigured Firebase), lotes stay local only.

The automatic handwriting reader (v8.0–8.2: `lector.js`, `digits-core.js`, `digits-model.js`, `rl.js`) was removed in v8.3 at the owner's request. It is in git history before the v8.3 commit if it is ever needed.

### Reception table (v8.8)

The lote dialog in `lotes.js` holds the reception grid, `table#lotGrid` (`.xl`), built by `buildGrid`.

- **In memory:** `work = { oc, n, rows: [{nombre, cat, cant[]}] }`.
  - `n` is the number of remitos (photos), which is also the number of columns.
  - Catalog rows come first (from the settings catalog). Then come extra rows, which have an editable name and a remove button.
- **Sticky parts:** the header, the N°/Producto columns and the Total column stay fixed while the grid scrolls.
- **Keyboard (Excel-like):**
  - Enter moves down. At the bottom of a column it wraps to the top of the next remito.
  - Shift+Enter moves up. Arrows move between cells (←/→ only when the caret is at the edge or everything is selected).
  - F2 edits in place, and Esc reverts the cell. Focusing a cell selects its content (fine pointers only).
- **Paste:** a pasted TSV block (copied from Excel) fills the grid from the focused cell.
- **Copiar:** copies a TSV with `Producto` plus one column per remito, and no total. That is the format Facturación's "Entregas" paste box expects (`OcParse.parsePasted` sums every number in a row, so a total column would double-count).
- **Photo link:** focusing a cell in column c shows photo c in the viewer (`show(c)` → `markCol`).
- **Autosave:** each edit runs `scheduleSave()`, a 1.2 s debounce, then `flushSave()`.
  - `flushSave` runs `S.update(cur, { tabla, periodo, estado })` and serializes the saves.
  - Saves are flushed on close, on `visibilitychange`, and before "Guardar PDF". There is no "Guardar tabla" button.
- **Cells:** each cell takes a number or a sum (`parseQty`: `12`, `12,5`, `1.250`, `120+35`). Invalid cells turn red, the total shows `?`, and "Guardar PDF" refuses to continue.
- **Rows:** with the OC known (from Drive), one row per OC product (`OcParse.shortName`), sorted by the LAG remito catalog order; otherwise the settings catalog.
- **Excel column (v9.0):** despachos for the lote's OC and period (`Flujo.despachos` + `qtyByItem`), green when equal to the row total (`Flujo.TOL`), red with the difference otherwise.
- **"Confirmar y guardar en Drive" (`sendCurrent` → `finish`):**
  1. Validate the cells and flush the autosave; warn if the Cook Master remito count ≠ days of the period.
  2. Compare with the Excel. Different → `#diffDialog` asks for the real despachos table (`confirmacion: "real"`). No Excel yet → confirm and save (`"sin-excel"`).
  3. Build the PDF (`R().makePdf`, with `{title, note}` for the real table), `Puente.call({action: "subir", tipo: "remitos"})`.
  4. `UnidadesStore.update(key, {confirmacion, remitos, tablaReal, despachos, pdf})` and mark the lote `enviado`.

  Without a bridge on the device, it offers to download the PDF instead.
- **PDF table** (`pdf.js` `layoutTable`): columns Producto | Rem. 1 … | Total.
  - It goes landscape from 5 remitos.
  - With more than 14 remitos it falls back to totals only.

The iPhone Shortcut / Live Text quantity reader (v8.4–8.7: `lectura.js`, the "hoja de lectura", `tabla.leido`, `settings.lecturaPreguntar`, localStorage `lecturaAlias`) was removed in v8.8 at the owner's request, because it only read the first photo. It is in git history before the v8.8 commit. `scanner.js` `loadSettings` deletes the leftover keys.

### Persistence

Per device, in `localStorage`:

- `settings`: `bridgeUrl`, `bridgeKey`, `catalog`, `periodMode`, `filterMode`, `autoCrop`, `hiRes`, `oc` (manual OC), `unidad` (selected unit in Remitos), `mailModo` (`enviar` | `borrador`), `wppNumero`. Keep these key names: devices already have the bridge configured.
- `datosDrive` (Drive scan), `ocAjustes` (per-OC sede, Excel sheet, IVA overrides), `ocAliases` (Excel/remito product name → OC product), `ocClientAliases` (delivery place → sede), `unidades` (local copy of unit states), `factSel`.
- IndexedDB `lag-drive` (downloaded OC/Excel bytes) and `lag-remitos` (lotes not yet uploaded).

Server-side: the user accounts, each user's lotes and each user's `unidades`. Shared truth lives in Drive and the Facturación sheet.

### Google "puente" (bridge) — `puente-google/Codigo.gs` (v5)

A Google Apps Script web app, now kept in this repo (`puente-google/`, not cached by the SW). The owner pastes it into script.google.com, sets `const CLAVE`, runs `autorizar()` once and deploys a "Nueva versión" (INSTRUCCIONES-PUENTE.txt).

- Requests are POSTs with `Content-Type: text/plain` (to avoid a CORS preflight) and a JSON body `{ key, action, ... }`. GET `?key=` is the connection test.
- Actions: `escanear` (`Compartido conmigo/Facturacion/<MES>/<Cliente>` listings; folder names have trailing spaces, compare with `norm`), `files` (base64; only files under Facturacion or root `OC-<año>`), `carpetas` (contents of the new and the legacy `OC-<año>/<MES>/OC-<n>` folders), `subir` (`OC-<año>/<Cliente>/OC-<n>`; never deletes: remitos get " (2)", an invoice with the same name is reused), `planillaAgregar`, `planillaMarcar`, `enviarMail` (only to `CONFIG.destinatarios`).
- The Facturación file is a **Google Sheet** in the Facturacion folder (not an .xlsx). 1st sheet = Grupo L, 2nd = Cook Master (by position; names are not in the repo). Columns are found by header text (`Nº FACT`, `TIPO FACT`, `DESCRIPCIÓN`, `SUBTOTAL`, `IVA`, `FINAL`, `REMITOS ENV`, `FC (MAIL O PORTAL)`, `ESTADO`; the date column has a blank header). Each month is a block closed by a row with the month name in column A and `=SUM(G..:G..)` totals. `planillaAgregar` writes into the first free row of the block whose dates have the right year, or `insertCells` on A:O only (a side table lives from column Q/R) and fixes the `SUM` end, or creates a new month block. It refuses duplicates (same Nº, tipo and total). Never delete or rewrite existing rows.
- Invoice "TIPO FACT" codes: 001 → `A`, 201 → `eA`, 003 → `NC FC<n>`, 203 → `NC eA<n>` (n = associated invoice), see `FactParse.planillaTipo`.
- Test `planillaAgregar` in Node with a mocked `SpreadsheetApp` (vm context); test the app with Playwright routing `https://script.google.com/**` to a mock bridge.
- If you change the payload or an action, the owner must redeploy the bridge. Say so explicitly in the release notes.

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

- `APP_VERSION` in `app.js`.
- `#verTag`, `#verLabel` and `.auth-ver` in `index.html`.
- `VERSION` in `sw.js`, as `remitos-vX.Y.Z`. This also invalidates old caches.

Then add a "NOVEDADES vX.Y" block at the top of `LEEME-PUBLICAR.txt`. It should explain the change in plain Spanish and list which files are **new** and which **changed**, because the owner uploads exactly those files by hand.

Home-screen icons live in `icons/`. The manifest declares `any` and `maskable` icons at 192 and 512 px. iOS uses `apple-touch-icon.png` (180 px, opaque).
