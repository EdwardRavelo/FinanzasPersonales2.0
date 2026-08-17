# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Personal finance dashboard — a static vanilla JS SPA backed by Supabase (PostgreSQL + Auth). No npm, no framework, no build step locally. Deployed to Vercel where `build.js` runs to generate `config.js` from environment variables.

## Local Development

Serve over HTTP — **not** `file://`. Both login paths (`loginConGoogle()`, `enviarMagicLink()` in `db.js`) pass `window.location.origin` as the redirect target, and `file://` produces an invalid origin that Supabase rejects. There is no npm install; use any static server:

```bash
npx serve -l 3000    # then open http://localhost:3000/
```

The origin must also be whitelisted once in Supabase → Authentication → URL Configuration → Redirect URLs (`http://localhost:3000` and `http://localhost:3000/**`). That covers magic link; the Google button additionally needs the origin registered in Google Cloud Console, so magic link is the easier local login.

`config.js` is gitignored; you need a local copy with valid Supabase credentials:

```javascript
// config.js (create manually, never commit)
const SUPABASE_URL  = '...';
const SUPABASE_ANON = '...';
const SHEETS_MIGRATION_URL = '...'; // optional CSV export URL
const CATEGORIAS_DEFAULT = [ /* copy the array verbatim from build.js */ ];
```

`CATEGORIAS_DEFAULT` is not optional locally — `obtenerColorCategoria()` (`app.js`) and `sincronizarCategorias()` (`db.js`) both read it. `SUPABASE_ANON` is the publishable/anon key (public by design, protected by RLS), never the `service_role` key.

The database schema is **not** applied automatically. Paste the full `schema.sql` into the Supabase Dashboard → SQL Editor once to create the three tables, RLS policies, and the `movimientos_unique_idx` partial index. The seed comments at the bottom of `schema.sql` include the migration to drop the old `UNIQUE` constraint if upgrading an existing instance.

## Testing / Verifying Changes

There is **no test suite, no linter, and no `package.json`** — nothing to build or run. UI changes are verified by reloading the static server; parser changes are verified by running `parser.js` headless under Node.

`parser.js` is a bare IIFE (`const Parser = (() => {…})()`) with no `module.exports`, so load it by eval'ing the source and shimming the browser globals it reaches for. Verified working:

```javascript
// harness.js — run OUTSIDE the repo (scratchpad), it needs `npm i xlsx`
const fs = require('fs'), path = require('path');
const REPO = '<path to repo>';

global.XLSX = require('xlsx');                       // needed for the XLSX path
global.FileReader = class {                          // parsearArchivo() uses FileReader
  readAsArrayBuffer(file) {
    const b = fs.readFileSync(file._path);
    this.onload({ target: { result: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } });
  }
};

const Parser = eval(fs.readFileSync(path.join(REPO, 'parser.js'), 'utf8') + ';Parser');
// parsearArchivo() only touches .name / .type / (PDF) .arrayBuffer() on the file object
Parser.parsearArchivo({ name: 'x.xlsx', type: '', _path: 'C:/…/statement.xlsx' })
      .then(m => console.log(m.length, m.reduce((a, r) => a + (r.monto_ars || 0), 0)));
```

`parsearCSVSheets(csvText)` and `normalizarCategoria(raw)` are pure string functions — testable with the eval alone, no `npm i`. The PDF path needs `global.pdfjsLib` (`pdfjs-dist@3.11.174` legacy build) and a file object exposing `arrayBuffer()`; it never calls `FileReader`.

Keep throwaway harnesses and their `node_modules/` **out of the repo** — `.gitignore` covers only `config.js`, `.vercel/`, editor and OS files, so anything installed at the repo root shows up as untracked noise.

Two debugging gotchas worth knowing before chasing a parser bug:
- **Rows are dropped silently.** `parsearArchivo()` filters out anything without a `fecha` or any amount, and `parsearFecha()` accepts *only* `DD/MM/YY(YY)` (anchored — a value carrying a time component like `15/08/2026 10:30` returns `null` despite the column being headed "Fecha y hora"). A file that parses to zero rows usually means a format change, not an empty file.
- Reconcile totals against the **statement**, not the rolling XLSX feed — see Key Patterns below.

## Deployment

Push to `main` → Vercel auto-deploys. The build command is `node build.js`, which reads env vars (`SUPABASE_URL`, `SUPABASE_ANON`, `SHEETS_MIGRATION_URL`) and writes `config.js` to the output.

## Architecture

**Script load order** (defined in `index.html`):
1. `config.js` — Supabase credentials (auto-generated at deploy time)
2. `ciclos.js` — Billing-cycle calendar (IIFE, exposes `Ciclos`); must precede `parser.js`, which reads it
3. `parser.js` — Client-side XLSX/CSV/PDF parsing (IIFE, exposes `Parser`)
4. `db.js` — Supabase client + all query functions (IIFE, exposes `DB`)
5. `app.js` — UI orchestration, DOM manipulation, Chart.js rendering

**All code is in Spanish** (variable names, comments, UI text).

### DB Layer (`db.js`)

Single `DB` module with methods for:
- Auth: `inicializar()`, `loginConGoogle()`, `enviarMagicLink()`, `obtenerSesion()`, `cerrarSesion()`, `escucharCambiosAuth(callback)`
- Queries: `obtenerMeses()`, `obtenerDatosDashboard()`, `obtenerPendientes()`, `obtenerCategorias()`, `obtenerTodasClasificaciones()`
- Writes: `importarMovimientos()`, `guardarClasificacion()`, `guardarVariasClasificaciones()`, `sincronizarCategorias()`, `migrarDesdeSheets()`
- Utils: `tieneData()` — checks if the user has any data (used to show/hide the first-run onboarding banner `#banner-migracion`)

`DB.setUserId(uid)` must be called immediately after auth — all query methods use the stored `userId` to scope their Supabase calls.

`obtenerDatosDashboard(mes)` fetches everything in a single `Promise.all`: KPIs, donut distribution, top-10 merchants, historical evolution, installments, full statement, and categories.

**Credits/refunds are excluded from every aggregate.** `obtenerKPIs()` splits movements in two: anything with `es_reintegro`, a negative `monto_ars`, or a negative `monto_usd` goes to `creditosARS`/`creditosUSD`; everything else to `totalARS`/`totalUSD`. `totalARS` is therefore *consumption only*, matching the shape of the bank's "En pesos" figure, which likewise does not net out credits. `netoARS` (= total + créditos, since credits are negative) and `netoUSD` are what actually gets paid.

**The KPIs display the net, not the gross.** `dibujarKPIs()` renders `netoARS` / `netoUSD`; the credits sub-line under the ARS KPI was removed at the user's request — it put a second competing number next to the total without saying anything actionable. Consequence: **the big KPI number is intentionally not the bank's "En pesos" figure.** Comparing them will always show a gap, made of the credits plus whatever is still *Compra en proceso*. Use `totalARS` when reconciling against a statement's `TOTAL CONSUMOS`.

**`#val-creditos` now carries the installment split** (`cuotas $X (N%) · ciclo $Y`) — the freed sub-line was reused instead of adding a panel, so the layout is untouched: `.nota-kpi:not(:empty)` already collapses the slot when the string is empty, which is what happens for a month with no carried installments, an empty month, or a stale payload lacking the new fields. `obtenerKPIs()` computes it by splitting consumption on **`cuota_actual > 1`** (an installment from an earlier cycle) versus everything else, which counts a `1/N` purchase in the cycle where it was actually made. It's the dashboard's answer to "why is the total so high": on the verified August data, 65% of the gross (1.175.347,71 of 1.802.672,62) is carry-over, and a *single* `C.3/3` line accounts for 59% of it.

`obtenerDistribucion()`, `obtenerTop10()`, and `obtenerEvolucion()` also filter `es_reintegro = false` so refunds don't distort category/merchant breakdowns (`obtenerEvolucion()` additionally requires `monto_ars > 0`). USD amounts are omitted from the donut and top-10 (ARS-only).

`obtenerPendientes()` returns unique `comercio_crudo` entries where `categoria IS NULL` — used to populate the classification UI. Each entry includes a `limpia` field generated by `limpiarNombreComercio()`.

`guardarVariasClasificaciones()` runs sequentially (`for...of` + `await`), not in parallel — each call to `guardarClasificacion()` does a classification upsert plus a bulk update on `movimientos`.

`migrarDesdeSheets()` inserts historical movements in batches of 500 with `ignoreDuplicates: true` (maps to `ON CONFLICT DO NOTHING` on the unique index). **This path is currently dormant:** the button and progress bar `ejecutarMigracion()` (in `app.js`) targets are no longer present in `index.html`, so it isn't reachable from the UI — the `?.` guards keep it from erroring. The code remains intact if the migration UI is re-added.

### Database Schema (`schema.sql`)

Three Supabase tables with RLS (`auth.uid() = user_id` on all):
- **`movimientos`** — transactions. Unique on `(user_id, mes_periodo, fecha, comercio_crudo, COALESCE(monto_ars,''), COALESCE(monto_usd,''), COALESCE(cuota_actual,0))` via a partial index (not a UNIQUE constraint — PostgreSQL's `NULL != NULL` in constraints would allow duplicates otherwise). Key fields: `mes_periodo` (format `YYYY-MM`), `es_reintegro` (true for refunds), `cuota_actual`/`cuota_total`.
- **`clasificaciones`** — merchant → clean name + category mapping; `clave` is `UPPERCASE(comercio_crudo)`; auto-applied retroactively on save
- **`categorias`** — per-user category list with icon + color; seeded from `CATEGORIAS_DEFAULT` defined in `build.js` (written into `config.js` at deploy time)

### Billing Cycles (`ciclos.js`)

**The statement does not close at month end.** It closes **every 28 days, always on a Thursday** — confirmed by the cover page of a real resumen, which prints three dates explicitly: `CIERRE ANTERIOR 02-Jul-26`, `CIERRE ACTUAL 30-Jul-26`, `PRÓXIMO CIERRE 27-Ago-26`. Both gaps are 28 days, so it is *not* "the last Thursday of the month" (02-Jul was the first). `ANCLA_UTC` (30-Jul-2026) plus `DIAS_CICLO = 28` generates the whole calendar; everything is computed in UTC so DST can't shift a boundary.

**A cycle is `[cierre_previo, cierre)`** — the closing day itself belongs to the *next* cycle. Verified against both documents: the statement that closed 30-Jul lists movements from 25 and 28 July but none from the 30th, and the "Últimos Movimientos" feed for the new cycle starts exactly on 30-Jul.

`periodoDe(fecha)` returns the `mes_periodo` for a movement: **the calendar month holding the majority of its cycle's days**, not the month of the closing date. Using the closing month would label the 04-Jun→02-Jul cycle as `2026-07` and collide with 02-Jul→30-Jul. The majority can never tie, because the range is half-open and 28 is even. This rule reproduces the `mes_periodo` values already stored, so it needed no data migration.

**13 cycles per year against 12 months means collisions are unavoidable.** `hayColision(cierre)` flags them; the first is **December 2026** (the cycles closing 17-Dec-2026 and 14-Jan-2027 both land in `2026-12`), then roughly one a year. This matters because import replaces the whole month, so importing one of those two statements would wipe the other — `actualizarAdvertenciaImport()` shows the `#import-colision` warning for exactly that case. The real fix is keying by closing date instead of `YYYY-MM`, which would require migrating stored rows.

Due dates are **not** derived: the bank uses no fixed offset (02-Jul→13-Jul is 11 days, 30-Jul→07-Ago is 8, 27-Ago→07-Sep is 11). `VENCIMIENTOS` holds only the ones a statement confirmed, and `vencimientoDe()` returns `null` otherwise so the UI omits it rather than inventing a payment date.

### Parser (`parser.js`)

Public entry point: `Parser.parsearArchivo(file)` — dispatches to XLSX or PDF based on file extension/type.

Handles three bank statement formats:
- **New XLSX format (4 cols):** Fecha y hora, Movimientos, Cuota, Monto
- **Old XLSX format (6 cols):** Nro. Tarjeta, Fecha, Establecimiento, Cuota, Importe $, Importe USD — detected by presence of `"Nro. Tarjeta"` in the first 5 rows
- **PDF format (BBVA Visa):** Each transaction line starts with `DD-Mon-YY`, followed by description, a 6-digit voucher number, and amount(s). Parsed using PDF.js (must be loaded in the page). Installments are embedded in the description as `C.XX/YY`. USD transactions are marked with `"USD"` in the description.

**Signs are preserved throughout the PDF path.** Amounts used to be stored via `Math.abs()` with the sign kept only in the `es_reintegro` flag, which made a refund *add* to the total instead of subtracting — a 2× error per refund. Do not reintroduce `Math.abs()` there.

**Not every PDF line has a voucher.** Taxes, perceptions and credits are laid out as `DESC [rate%]( base ) importe` — e.g. `IIBB PERCEP-CABA 2,00%( 7749,28) 154,98` or `CR.RG 5617 30% M -8.147,80`. `parsearCargoSinCuponPDF()` handles these: it takes the **last** amount on the line (the earlier ones are the rate and the taxable base), strips the parenthetical and rate to derive the merchant key, and **only accepts the row if the resulting name matches `PATRONES_CARGOS_BANCARIOS` or `PATRONES_CREDITO_BANCARIO`**. That guard is what keeps the statement's legal boilerplate — which is full of lines ending in numbers — from being imported as movements. Adding a new charge type means adding its pattern, or the line is silently dropped.

**Page 1 is scanned too.** It's the cover/summary, but the bank lists credits there that never reappear in the detail pages (a real statement had `CR.RG 5617 30% M -8.147,80` only on page 1). Rows from page 1 are kept only when `categoria === 'Cargos Bancarios'`; the summary/total lines fail the guard above and drop out on their own. Charge rows are deduplicated on `fecha|comercio_crudo|monto_ars` because they have no voucher to distinguish them — ordinary purchases are *not* deduplicated, since the same merchant and amount can legitimately repeat on one day (each has its own voucher).

**`USD` can be glued to the preceding token.** The PDF renders `ANTHROPIC* CLAUD in1TomsYBUSD 20,00`, where `\bUSD\b` fails to match and the USD amount was booked as pesos. Detection is `\bUSD\b` **or** `USD <amount>` at the end of the description. Fixing this made the USD total reconcile exactly against a real statement (28,71).

Also parses Google Sheets CSV export for historical migration (`parsearCSVSheets`). Amounts use Argentine locale (`$9.400,00`, `USD 20,00`).

`normalizarMesPeriodo(filas)` is called after every parse: it sets `mes_periodo` on all rows to a single billing month, so installments (whose `fecha` is the original purchase date) land in the billing month rather than the month of purchase. It derives that month from `Ciclos.periodoDe()` applied to the **most recent** `fecha` in the file — the most recent rather than the modal month, because old installments drag in dates from previous months. When `Ciclos` is undefined (parser loaded in a headless harness) it falls back to the previous behaviour, the most frequent month.

**The bank's total excludes "Compra en proceso"; ours includes it.** Unsettled purchases are shown in the web/app listing tagged *Compra en proceso* and are left **out** of the "En pesos" figure until they settle. Reconciled to the cent on a real pair: export (14) sums 1.802.672,62 while the app showed 1.773.620,67, and the difference (29.051,95) was exactly the three tagged rows. **The XLSX does not carry the tag** — 4 columns, no "proceso"/"pendiente" text anywhere, so `CASA TELMA $22.900,00` in-process is byte-identical to a settled row. This gap is therefore **irreducible from the XLSX**: during the open cycle the dashboard will always read higher than the bank by whatever is in flight. Reconcile against the closed statement PDF instead, where nothing is in process.

Independently of that, the bank uses `CONSUMO EN PESOS` / `CONSUMO EN DOLARES` as a **placeholder merchant name** for recent transactions and swaps in the real merchant days later (same amount). `PATRONES_IGNORAR` does not filter them, so they can get stored — and a classification rule saved against `CONSUMO EN PESOS` would then apply retroactively to unrelated purchases, since rules key on `comercio_crudo`.

Three filter lists applied during parsing:
- `PATRONES_CARGOS_BANCARIOS` — rows matching these patterns are imported as category `"Cargos Bancarios"` (e.g., `IMP DE SELLOS`, `DB IVA`, `PERCEPCIÓN AFIP`)
- `PATRONES_CREDITO_BANCARIO` — subset of the above that are credits (devolutions); imported with a negative amount so the dashboard total matches the bank statement
- `PATRONES_IGNORAR` — rows matching these are dropped entirely (e.g., `SU PAGO EN PESOS`, `Total Tarjeta`)

### App State (`app.js`)

Global variables (no state manager): `mesActivo`, `sessionUsuario`, `extractoTodos`, `extractoPagina` (pagination at 30 rows/page), Chart.js instances (`chartTorta`, `chartTop`, `chartEvo`), `top10Data` (stashed by `dibujarBarras()` so the modal can build its chart later), import state (`movimientosPendientes`, `mesesConDataActual`), and `datosActuales` (last fetched dashboard payload — stored so `toggleTema()` can re-render all charts with new theme colors without re-fetching).

On load: `bindEventos()` runs first, then `DB.escucharCambiosAuth()` is subscribed, then an existing Supabase session is looked up in localStorage; if none, `?code=` (PKCE) or `#access_token=` (implicit) in the URL is checked before showing the login screen. A 10-second timeout prevents a permanent black screen if the token is expired.

**The auth callback is re-entrant and must stay guarded.** `escucharCambiosAuth` fires on token refresh too (e.g. returning to the tab), not just on login. It captures `eraSesionActiva = !!sessionUsuario` and calls `arrancarDashboard()` only on a genuine new login — without that guard a background refresh would reset `mesActivo` to the newest month while the user is browsing an older one.

`dibujarDashboard(datos)` is the single entry point for rendering: it builds a shared `colorMap` (category name → hex color) from `datos.categorias` and passes it to every chart so colors stay consistent across the donut, bar chart, and stacked evolution chart.

Each of the three Chart.js instances is a module-level global; every render destroys the old instance before creating a new one (`if (chartX) chartX.destroy()`). `chartTorta` (donut) and `chartEvo` (stacked evolution bars) are drawn by `dibujarDashboard`; `chartTop` is built lazily by `dibujarBarrasModal()` only when the Top-10 modal opens (the panel itself just shows a top-5 `<ol>`). The donut carries an inline plugin `pluginTextoCenter` that paints the month total in the hole; the bar charts use the `ChartDataLabels` plugin for value labels.

`PALETTE` in `app.js` is a **mutable** object holding the active theme's shared colors (`gold`, `cyan`, `green`, `textMuted`, `textMain`, `border`, and the `donut` array); it also seeds `Chart.defaults` (tooltip style, font family).

**Light/dark theming** (not backed by the DB): `PALETTES.dark` / `PALETTES.light` hold the two color sets. `aplicarTema(tema)` copies the chosen set into `PALETTE` and updates `Chart.defaults`; `toggleTema()` flips `documentElement.dataset.theme`, persists it to `localStorage['tema']`, and re-renders via `dibujarDashboard(datosActuales)`. The initial theme is applied by an inline IIFE at the **top of `<body>`** in `index.html` (the first thing after the opening tag, so it runs before any content paints) which reads `localStorage['tema']` and stamps both `dataset.theme` and the `!important` background on `documentElement` and `body`.

`dibujarCierre()` fills the `.panel-cierre` countdown (days to the next closing, cycle range, progress bar, due date when known). It is called from `mostrarApp()`, **not** from `dibujarDashboard()`, because it depends on today's date rather than the selected month — and so it still renders for a user with no movements at all. It adds `.es-inminente` at ≤3 days, which recolors the number and bar to `--red`.

`mostrarSkeletons()` / `ocultarSkeletons()` bracket `arrancarDashboard()`. Both early-exit paths (no data at all → `#banner-migracion`, or data but no months) must call `ocultarSkeletons()` or the placeholders stay on screen forever.

Formatting utilities live at the bottom of `app.js`: `formatARS(n, abreviado)` (Argentine peso locale; `abreviado` yields `$1.2M` / `$40k` for axis ticks), `formatFecha(iso)`, `formatearMes(yyyy-mm)`. `obtenerColorCategoria(nombre)` resolves a category's hex color from `CATEGORIAS_DEFAULT` (in `config.js`), case-insensitively, falling back to `#475569` — note it does **not** read the per-user `categorias` table, unlike the `colorMap` the charts build from `datos.categorias`.

Most DOM event wiring happens in `bindEventos()`, called once on `DOMContentLoaded` before session resolution. The exception: four inline `onclick=` attributes in `index.html` (`cerrarModal()`, `cancelarImportacion()` ×2, `confirmarImportacion()`) — **those four functions must stay global in `app.js`**; there is no bundler or module scope, and the CSP's `script-src 'unsafe-inline'` is what keeps them working.

**`index.html` also carries three inline `<script>` blocks**, all dependent on `'unsafe-inline'` and none of them part of `app.js`: the CDN tags in `<head>`, the theme bootstrap at the top of `<body>`, and the cursor-spotlight IIFE after the `app.js` tag (see Styling). The last two are deliberately self-contained — they must keep working before/without `app.js`.

The extracto table supports live filtering via a text search input and a category dropdown — both filter `extractoTodos` client-side and call `renderizarExtractoFiltrado()`, which also handles the 30-row pagination.

### Styling (`styles.css`)

Single stylesheet, no preprocessor. The design system is "Ethereal Glass": translucent surfaces over a dark base, gold as the single accent.

**Theming is token-based and dark-first.** `:root` defines the full dark palette (backgrounds, `--glass*` layers, `--text-*`, accents `--gold`/`--cyan`/`--green`/`--red`, `--font-*`, radii `--r-sm`→`--r-pill`, easings, shadows); `[data-theme="light"]` re-declares only the values that change. There is no `prefers-color-scheme` block — the theme comes solely from `documentElement.dataset.theme`, set by the inline bootstrap at the top of `<body>` and flipped by `toggleTema()`.

**Theme colors are duplicated between CSS and JS and must be edited together.** `PALETTES.dark` / `PALETTES.light` in `app.js` hold Chart.js copies of the same accent and text colors as the CSS custom properties (Chart.js paints to canvas and can't read CSS variables). Changing `--gold` in `styles.css` without changing `PALETTES.*.gold` leaves the charts off-palette. `toggleTema()` also writes an `!important` inline `background-color` on `<body>` with hardcoded hex values (`#e8eaee` / `#080c12`) that mirror `--bg-base` — a third copy of the same two colors.

**Decorative layers:** `.fondo-luces` (slow-breathing radial orbs via `::before`/`::after`) and `.grain` (fixed film-grain overlay) sit behind the app; both are `pointer-events: none`. `.tarjeta` / `.bento-caja` carry a radial gold spotlight driven by `--spot`, which is `transparent` until `:hover`. Its center reads `--mx`/`--my` (fallback `50% / -10%`), and **those are set by a real mouse-tracking IIFE** — the last inline `<script>` in `index.html`, which binds a `pointermove` listener to every `.tarjeta, .bento-caja` and guards re-binding with `dataset.spot`. It is intentionally independent of `app.js`; new glass panels created **after** load (modal content, re-rendered rows) are never bound, so they only get the static fallback position.

Breakpoints are max-width (`920px`, `640px`, `480px`) with one min-width `1440px` tier for large displays. The closing `prefers-reduced-motion: reduce` block is a blanket `*` reset (plus an explicit `animation: none` on the orbs), so new animated elements are covered automatically.

## Key Patterns

- **The two source documents are not equivalent.** The `Últimos movimientos` XLSX is a *rolling feed* of recent transactions, not a closed billing period — its total moves every time it's re-exported, and it will never equal a statement total. The `Statements.pdf` resumen is the closed period and carries the bank's official figures. When reconciling a discrepancy, always check *which* document a number came from and *when* it was exported before assuming a bug.
- **Statement reconciliation identity** (verified against a real resumen): `TOTAL CONSUMOS (summed over every card section) + impuestos/percepciones − créditos = TOTAL A PAGAR` on the cover page. A statement can contain **more than one card section**, each with its own `TOTAL CONSUMOS` line — summing only the first one will silently under-count. Use this identity to validate parser changes; it closed to the cent.
- **Import replaces the full month** — `importarMovimientos()` deletes all existing rows for the affected `mes_periodo` before re-inserting. The XLSX is the source of truth for that month; historical months are untouched.
- **Import confirmation flow** — after parsing, `movimientosPendientes` holds the result until the user confirms; only then is `DB.importarMovimientos()` called.
- **Client-side file parsing** — XLSX and PDF files never leave the browser; parsed in-memory and bulk-inserted to Supabase.
- **Auth** — Google OAuth is the primary login; Magic Link (email OTP) is the secondary option. Both use PKCE flow to prevent email-scanner token consumption.
- **Classification rules** — saving a merchant rule retroactively updates all `movimientos` matching that `comercio_crudo` key.

## CDN Dependencies

All loaded via `<script>` tags in `index.html` — no local install:
- `@supabase/supabase-js@2`
- `chart.js@4.4.3` + `chartjs-plugin-datalabels@2.2.0`
- `xlsx@0.18.5`
- `pdfjs-dist@3.11.174` (legacy build; worker loaded from same CDN via `pdfjsLib.GlobalWorkerOptions.workerSrc`)
- Google Fonts: Space Grotesk (display/UI), DM Sans (body), DM Mono (data/numbers), Playfair Display (kept **only** because the Chart.js canvas in `app.js` references it for the donut center total and tooltip values)

Adding a new CDN source requires updating the `Content-Security-Policy` header in `vercel.json` — otherwise the browser will block it in production. The current policy allows scripts from `cdn.jsdelivr.net` and `fonts.googleapis.com` (plus `'self'` and `'unsafe-inline'`), styles from `fonts.googleapis.com` / `fonts.gstatic.com`, fonts from `fonts.gstatic.com`, `connect-src` to `*.supabase.co` / `docs.google.com` / `*.googleusercontent.com`, `img-src 'self' data:` (no remote images — the favicon is an inline SVG data URI for this reason), and `worker-src 'self' blob: https://cdn.jsdelivr.net` for the PDF.js worker. `vercel.json` also sets `X-Frame-Options: DENY`, `nosniff`, and `must-revalidate` on `.js`/`.css`/`.html` so a deploy is picked up immediately.

## Design Skills

The same bundle of 13 vendored UI/design skills (`minimalist-ui`, `high-end-visual-design`, `redesign-existing-projects`, …) exists **twice**: in `.agents/skills/` and in `.claude/skills/`. The `.claude/skills/` copy is the live one — those are the project skills Claude Code actually loads; `.agents/skills/` is the vendored bundle as installed. The two trees are currently byte-identical, so keep them in sync or delete one deliberately.

Neither directory is in the repo: both are excluded via `.git/info/exclude` (not `.gitignore`), which is **machine-local and not pushed** — a fresh clone has no skills and no `.claude/settings.local.json`, and the exclusion has to be recreated by hand. Either way they are reference material for design work on this dashboard, not part of the app; nothing in the shipped code loads them.
