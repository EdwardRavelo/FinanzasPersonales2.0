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

**The symptom when it is missing is not an error — it is a redirect to production.** Both login paths pass `window.location.origin` as `redirectTo`; when that origin is not on the allow-list Supabase silently ignores it and falls back to the project's Site URL, so signing in at `localhost:3000` lands you on the deployed app, looking at production data and wondering why your change isn't there. Nothing in the console says so. If local review appears to "not pick up" a change, check the address bar before the code.

`config.js` is gitignored; you need a local copy with valid Supabase credentials:

```javascript
// config.js (create manually, never commit)
const SUPABASE_URL  = '...';
const SUPABASE_ANON = '...';
const SHEETS_MIGRATION_URL = '...'; // optional CSV export URL
const CATEGORIAS_DEFAULT = [ /* copy the array verbatim from build.js */ ];
```

`CATEGORIAS_DEFAULT` used to be load-bearing for chart colours; it no longer is (see *DB Layer*). Its only remaining reader is `sincronizarCategorias()` in `db.js`, so a local `config.js` without it still renders a full dashboard — you just can't seed the category list. Keep it anyway: it costs nothing and the seeding path needs it. `SUPABASE_ANON` is the publishable/anon key (public by design, protected by RLS), never the `service_role` key.

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

**`ciclos.js` tests the same way and needs no shims at all** — it is a bare IIFE over pure date arithmetic, so `eval(fs.readFileSync('ciclos.js','utf8') + ';Ciclos')` gives you the whole calendar. This is the cheapest way to check anything cycle-related (the inverse `cierreDePeriodo()`, day-of-cycle cut-offs, collision months) before touching the UI. One trap: **`Ciclos` anchors "today" on the local date, not UTC.** With UTC−3 the two differ for three hours a day, so a harness that compares against `new Date().toISOString()` fails overnight — build the expected date from `getFullYear/getMonth/getDate` the way `hoyUTC()` does.

Keep throwaway harnesses and their `node_modules/` **out of the repo** — `.gitignore` covers only `config.js`, `.vercel/`, editor and OS files, so anything installed at the repo root shows up as untracked noise.

**Charts are verified in the browser, and twice by reading pixels rather than options.** A canvas bug can leave the Chart.js config reporting exactly what you intended while the canvas shows something else — the donut legend once had `labels.color: '#7d90a0'` in its options and painted the text pure black. `getImageData()` over the region and a tally of the colours settles it in one call. The layout half has no validator either: label collisions and clipped axes only appear by looking, which is the last step of the `dataviz` skill's procedure and the one that is easy to skip.

Two debugging gotchas worth knowing before chasing a parser bug:
- **Rows are dropped silently.** `parsearArchivo()` filters out anything without a `fecha` or any amount, and `parsearFecha()` accepts *only* `DD/MM/YY(YY)` (anchored — a value carrying a time component like `15/08/2026 10:30` returns `null` despite the column being headed "Fecha y hora"). A file that parses to zero rows usually means a format change, not an empty file.
- Reconcile totals against the **statement**, not the rolling XLSX feed — see *Reconciling with the Bank* below.

## Deployment

Push to `main` → Vercel auto-deploys. The build command is `node build.js`, which reads env vars (`SUPABASE_URL`, `SUPABASE_ANON`, `SHEETS_MIGRATION_URL`) and writes `config.js` to the output. Commit messages follow the existing history: Spanish, with conventional-commit prefixes (`feat:` / `fix:`).

## Architecture

**Script load order** (defined in `index.html`):
1. `config.js` — Supabase credentials (auto-generated at deploy time)
2. `ciclos.js` — Billing-cycle calendar (IIFE, exposes `Ciclos`); must precede `parser.js`, which reads it
3. `parser.js` — Client-side XLSX/CSV/PDF parsing (IIFE, exposes `Parser`)
4. `db.js` — Supabase client + all query functions (IIFE, exposes `DB`)
5. `app.js` — UI orchestration, DOM manipulation, Chart.js rendering

**All code is in Spanish** (variable names, comments, UI text).

### DB Layer (`db.js`)

Single `DB` module — but the exported surface is narrower than the function list. Most query helpers are private and only reachable through `obtenerDatosDashboard()`:
- Auth: `inicializar()`, `loginConGoogle()`, `enviarMagicLink()`, `obtenerSesion()`, `cerrarSesion()`, `escucharCambiosAuth(callback)`
- Queries: `obtenerMeses()`, `obtenerDatosDashboard()`, `obtenerExtracto()`, `obtenerRitmo()`, `obtenerRitmoHistorico()`, `obtenerPendientes()`, `obtenerCategorias()`
- Writes: `importarMovimientos()`, `guardarClasificacion()`, `guardarVariasClasificaciones()`, `sincronizarCategorias()`, `migrarDesdeSheets()`
- Utils: `setUserId()`, `getClient()`, `tieneData()` — the last checks if the user has any data (used to show/hide the first-run onboarding banner `#banner-migracion`)
- **Private, never returned:** `obtenerKPIs()`, `obtenerDistribucion()`, `obtenerTop10()`, `obtenerEvolucion()`, `obtenerCuotas()`, `limpiarNombreComercio()` and `obtenerTodasClasificaciones()` — the last is what `importarMovimientos()` uses to re-apply saved classification rules to freshly imported rows.

Five exported names are never called from `app.js`: `getClient()` (an escape hatch for console work), `obtenerExtracto()` and `obtenerRitmoHistorico()` (the dashboard payload already carries both results), `guardarClasificacion()` (the UI always saves in bulk) and `sincronizarCategorias()` — see below.

`DB.setUserId(uid)` must be called immediately after auth — all query methods use the stored `userId` to scope their Supabase calls.

`obtenerDatosDashboard(mes)` fetches everything in a single `Promise.all`: the month list, KPIs, donut distribution, top-10 merchants, historical evolution, installments, full statement, categories, and both ritmo queries. Two of those (`obtenerEvolucion()` and `obtenerRitmoHistorico()`) scan the user's whole history — fine for a personal dashboard of a dozen months, but they are the first thing to move behind an aggregate view if it ever grows.

**Credits/refunds are excluded from every aggregate.** `obtenerKPIs()` splits movements in two: anything with `es_reintegro`, a negative `monto_ars`, or a negative `monto_usd` goes to `creditosARS`/`creditosUSD`; everything else to `totalARS`/`totalUSD`. `totalARS` is therefore *consumption only*, matching the shape of the bank's "En pesos" figure, which likewise does not net out credits. `netoARS` (= total + créditos, since credits are negative) and `netoUSD` are what actually gets paid.

**The KPIs display the net, not the gross.** `dibujarKPIs()` renders `netoARS` / `netoUSD`; the credits sub-line under the ARS KPI was removed at the user's request — it put a second competing number next to the total without saying anything actionable. Consequence: **the big KPI number is intentionally not the bank's "En pesos" figure.** Comparing them will always show a gap, made of the credits plus whatever is still *Compra en proceso*. Use `totalARS` when reconciling against a statement's `TOTAL CONSUMOS`.

**`#val-creditos` now carries the installment split** (`cuotas $X (N%) · ciclo $Y`) — the freed sub-line was reused instead of adding a panel, so the layout is untouched: `.nota-kpi:not(:empty)` already collapses the slot when the string is empty, which is what happens for a month with no carried installments, an empty month, or a stale payload lacking the new fields. `obtenerKPIs()` computes it by splitting consumption on **`cuota_actual > 1`** (an installment from an earlier cycle) versus everything else, which counts a `1/N` purchase in the cycle where it was actually made. It's the dashboard's answer to "why is the total so high": on the verified August data, 65% of the gross (1.175.347,71 of 1.802.672,62) is carry-over, and a *single* `C.3/3` line accounts for 59% of it.

`obtenerDistribucion()`, `obtenerTop10()`, and `obtenerEvolucion()` also filter `es_reintegro = false` so refunds don't distort category/merchant breakdowns (`obtenerEvolucion()` additionally requires `monto_ars > 0`). USD amounts are omitted from the donut and top-10 (ARS-only).

**`obtenerRitmo(mes, mesComparacion)` compares cycles at the same point, not calendar months.** It answers "am I spending more or less than last month": it takes the day of the cycle today falls on (`Ciclos.diaDelCiclo()`) and sums the first N days of this cycle against the first N days of the previous one, both cut with `Ciclos.corteDelCiclo()`. **Carried installments (`cuota_actual > 1`) are included, in full, in the month that bills them** — they used to be excluded as "a fixed weight from old purchases", and the user rejected that: a month heavy with installments (August, 11 of them) read as cheaper than one with few. Their `fecha` is the original purchase date, so they skip the day cut-off and the lower bound entirely. Caveat: the bank posts a new cycle's installments progressively, so early in a cycle the active month may carry fewer of them than its baseline. What it still leaves out: credits (as everywhere else), and non-installment rows dated on or after the cutoff **or before the cycle's own start** — that lower bound is what kept a month that had mistakenly stored earlier cycles' rows from counting them all as its first days (October at day 3 read +2687% before it). Rows are compared as `'YYYY-MM-DD'` strings, which order like dates without building a `Date` per row.

**The baseline is any month, not only the previous one.** Without `mesComparacion` it defaults to the immediately preceding cycle, taken from the **cycle calendar rather than the list of months with data**. If that cycle was never imported the function falls back — once, guarded by `!mesComparacion` so it can't recurse twice — to the most recent month that *does* have data, so the panel keeps working instead of vanishing exactly when there is still something to compare. Passing `mesComparacion` explicitly (September against June, say) compares those two cycles at the same day. The month cut is always taken from the **active** month's cycle: comparing an in-progress September at day 19 against a closed June still measures June's first 19 days.

**A third argument, `modo`, switches the yardstick.** `'dia'` (default) is the same-day cut above; `'total'` measures the baseline over its **whole** cycle while the active month is still cut at today — "how much of all of September have I already spent". The choice is the `modoRitmo` global in `app.js`, toggled by the `#ritmo-modo-dia` / `#ritmo-modo-total` buttons (`cambiarModoRitmo()`), persisted in `localStorage['modoRitmo']`, and **not** reset by `cargarMes()` — it is a reading preference, unlike `mesComparacion`. It flows through `obtenerDatosDashboard(mes, modoRitmo)` and drives the panel and both KPI notes (`que en todo agosto`). The toggle shows on **every** month. With the active month closed, `'total'` compares both cycles in full, and `'dia'` cuts both at the day the **running** cycle is on today (`diaDelCiclo(cierreVigente())`) — "al día 3, septiembre llevaba…" — so the two modes never collapse into the same number; the panel and notes then say `Al día N, …`. On a closing day that day is the full cycle length and `'dia'` is full too. The ritmo *chart* is always same-day at the active month's own day.

`obtenerRitmo()` measures **three** things over the same window and with the same filter — pesos, dólares and a movement count — so the percentage means the same thing wherever it appears. The ARS figures stay flat on the object (`actual` / `anterior` / `delta` / `pct`) because the ritmo panel was written against them; the other two arrive as `usd` and `movimientos` sub-objects and feed `dibujarNotasComparacion()`, which fills the `.nota-kpi` line under the USD and movement KPIs and follows the same `#ritmo-vs` month selector. **Each note is a sentence with its baseline in parentheses** — `Vas gastando 24% más que en agosto (u$s 59,11)`, `Tuviste 12% más movimientos que en agosto (52)`. Earlier passes tried compact notation (`▲ 24,1% vs Ago`, then `▲ 24,1% · 54 vs 52 mov · Ago 2026`); both read as something to decode. The parenthetical is the **comparison month's** figure, not the current one, and it is on the page rather than in a tooltip — the notes carried `title` attributes for one revision and were dropped as unprofessional. Consequence to keep in mind: the caveat they held (the note's movement count is cycle movements up to the cut-off, so it will not reconcile against the KPI's whole-month count above it) is no longer stated anywhere in the UI. The non-breaking space in `'u$s '` keeps the unit and the amount on one line when a long sentence wraps. Rules that keep it readable: the percentage is rounded to a whole number; under 1% it says "prácticamente lo mismo" rather than "0%"; a zero base becomes "En febrero no hubo consumo para comparar" instead of a division; and the verb follows the cycle ("Vas gastando" while it is open, "Gastaste" once closed).

Month names come from `formatearMesNombre(periodo, referencia)` — `agosto`, and `diciembre de 2025` when the year differs from the month being viewed. **Everything the user reads uses it**, the `#ritmo-vs` dropdown included: a control reading `vs Ago 2026` beside prose reading `agosto` looks like two different things. `formatearMes()` (`Ago 2026`) stays for chart axes, where the short form earns its place.

The note's count still won't match its KPI mid-cycle: it counts the month's installments plus the non-installment rows up to the cut-off, while the KPI counts every row of the month (credits included). In `'total'` mode on a closed month the two only differ by the credits.

`hayComparacion` false → `dibujarRitmo()` hides the panel rather than reporting a −100% against an empty month. A closed active month compares both cycles in full in `'total'` mode, cut at today's running-cycle day in `'dia'` mode, and `enCurso` flips the panel's wording to the past tense. `pct` is `null` when the baseline cycle had no consumption in the stretch — the UI then shows only the arrow and the amount instead of dividing by zero. It is the one panel query **exported on `DB`**, because changing the baseline only needs to recompute this panel, not the whole dashboard payload.

`obtenerPendientes()` returns one entry per `comercio_crudo` where `categoria IS NULL` — used to populate the classification UI — with `limpia` (from `limpiarNombreComercio()`), the summed `ars` / `usd` of those unclassified rows and their `cantidad`, sorted by `ars` descending. The modal shows the sum in a *Monto* column (plus `N movimientos` when there is more than one), because a rule recategorises every row of that merchant, not one purchase.

`guardarVariasClasificaciones()` runs sequentially (`for...of` + `await`), not in parallel — each call to `guardarClasificacion()` does a classification upsert plus a bulk update on `movimientos`.

`migrarDesdeSheets()` inserts historical movements in batches of 500 with `ignoreDuplicates: true` (maps to `ON CONFLICT DO NOTHING` on the unique index). **This path is currently dormant:** the button and progress bar `ejecutarMigracion()` (in `app.js`) targets are no longer present in `index.html`, so it isn't reachable from the UI — the `?.` guards keep it from erroring. The code remains intact if the migration UI is re-added.

**Nothing seeds the `categorias` table in the current UI.** `sincronizarCategorias()` is its only writer, and its only caller is `migrarDesdeSheets()` — the dormant path above. `schema.sql` has no `INSERT` for it either; its comment claiming the categories are created from the app on first classification is stale. To seed: call `DB.sincronizarCategorias()` once from the console while logged in, or insert the `CATEGORIAS_DEFAULT` rows by hand.

The **consequence changed with the chart redesign** and the old note here was wrong for a while. Chart colour no longer comes from this table at all — `construirMapaSeries()` derives it from the movements in `datos.evolucion` — so an empty `categorias` renders a perfectly coloured dashboard. What actually breaks is the **classification modal**: `abrirModalClasificar()` is the only remaining consumer, and with no rows its category dropdown comes up empty, so merchants can't be classified. Worth knowing: `obtenerCategorias()` is still inside `obtenerDatosDashboard()`'s `Promise.all` and **nothing reads `datos.categorias`** any more — a query per dashboard load that could be dropped.

### Database Schema (`schema.sql`)

Three Supabase tables with RLS (`auth.uid() = user_id` on all):
- **`movimientos`** — transactions. Unique on `(user_id, mes_periodo, fecha, comercio_crudo, COALESCE(monto_ars,''), COALESCE(monto_usd,''), COALESCE(cuota_actual,0), ocurrencia)` via a partial index (not a UNIQUE constraint — PostgreSQL's `NULL != NULL` in constraints would allow duplicates otherwise). Key fields: `mes_periodo` (format `YYYY-MM`), `es_reintegro` (true for refunds), `cuota_actual`/`cuota_total`, and `ocurrencia` (1, 2, … among rows identical on everything else within one file — set by the parser's `numerarRepetidas()`). Without `ocurrencia` two genuinely separate purchases (September 2026: two `MERCADOLIBRE C.01/06` of 4.466,27 on 25-Sep, one cancelled and refunded, one confirmed; the PDF tells them apart by voucher, the XLSX can't) violated the index, and since `importarMovimientos()` deletes the month **before** inserting, a failed insert leaves that month empty. The column must exist in the database before a parser that sends it is deployed — the migration is in `schema.sql`.
- **`clasificaciones`** — merchant → clean name + category mapping; `clave` is `UPPERCASE(comercio_crudo)`; auto-applied retroactively on save
- **`categorias`** — per-user category list with icon + color; seeded from `CATEGORIAS_DEFAULT` defined in `build.js` (written into `config.js` at deploy time)

### Billing Cycles (`ciclos.js`)

**The statement closes once a month, on the first Thursday on or after the 27th** — not at month end and *not* every 28 days. Confirmed closings: `02-Jul-26` (June's statement; the 27th was a Saturday), `30-Jul-26`, `27-Ago-26`, and `01-Oct-26` (September's; the 27th was a Sunday). Cycles are therefore **28 or 35 days** long. The bank's *Resumen Anual* export corroborates it: exactly one statement per month, twelve a year.

**This was wrong for a while and is worth remembering.** The first three closings were 28 days apart, so `ciclos.js` assumed a fixed 28-day cadence from an anchor. That put September's closing on 24-Sep: the feed was split into a phantom `2026-10` month (every row from 24-Sep on), the countdown read 22-Oct, and a "collision" was predicted for December 2026 that never exists. The bank's app said 01-Oct. If a closing ever disagrees with the bank again, check `CIERRES_CONFIRMADOS` first.

`CIERRES_CONFIRMADOS` (month → closing date) overrides the rule — a holiday could shift a closing, and each statement that prints a date should be added there. Everything is computed in UTC so DST can't shift a boundary. Closings before June 2026 are the rule's estimate; no statement confirms them.

**A cycle is `[cierre_previo, cierre)`** — the closing day itself belongs to the *next* cycle. Verified against both documents: the statement that closed 30-Jul lists movements from 25 and 28 July but none from the 30th, and the "Últimos Movimientos" feed for the new cycle starts exactly on 30-Jul. **It is an approximation**: the cut is at some *hour* of the closing day. The statement that closed 01-Oct carries a `SUBE` from 01-Oct and every closing-day tax dated 01-Oct, while the feed kept other 01-Oct purchases in the new cycle. That is why a PDF import doesn't split by date (see *Parser*).

`mes_periodo` is **the month of the statement**: `cierreDePeriodo('2026-06')` is `2026-07-02`. `periodoDe(fecha)` is its inverse — only the date's own month and its two neighbours need checking, because a closing always lands between the 27th and the 2nd of the next month. One cycle per month means no collisions and no `hayColision()` (removed, with the `#import-colision` warning). The labels match the ones already stored for June–August, so no migration was needed.

`diasDelCiclo(cierre)` gives a cycle's length (28 or 35) and replaces the old `DIAS_CICLO` constant everywhere. `diaDelCiclo(cierre)` gives the 1-based day as of today (the cycle's length once it has closed), and `corteDelCiclo(cierre, dia)` the exclusive date `dia` days into it, **capped at the cycle's own closing** — day 33 of a 35-day cycle against a 28-day baseline takes the whole baseline instead of spilling into the next one. `obtenerRitmoHistorico()` compares complete cycles when the active month is closed, rather than cutting all of them at the active one's length.

Due dates are **not** derived: the bank uses no fixed offset (02-Jul→13-Jul is 11 days, 30-Jul→07-Ago is 8, 27-Ago→07-Sep is 11). `VENCIMIENTOS` holds only the ones a statement confirmed, and `vencimientoDe()` returns `null` otherwise so the UI omits it rather than inventing a payment date.

### Parser (`parser.js`)

Public entry point: `Parser.parsearArchivo(file)` — dispatches to XLSX or PDF based on file extension/type.

Handles three bank statement formats:
- **New XLSX format (4 cols):** Fecha y hora, Movimientos, Cuota, Monto
- **Old XLSX format (6 cols):** Nro. Tarjeta, Fecha, Establecimiento, Cuota, Importe $, Importe USD — detected by presence of `"Nro. Tarjeta"` in the first 5 rows
- **PDF format (BBVA Visa):** Each transaction line starts with `DD-Mon-YY`, followed by description, a 6-digit voucher number, and amount(s). Parsed using PDF.js (must be loaded in the page). Installments are embedded in the description as `C.XX/YY`. USD transactions are marked with `"USD"` in the description.

**Signs are preserved throughout the PDF path.** Amounts used to be stored via `Math.abs()` with the sign kept only in the `es_reintegro` flag, which made a refund *add* to the total instead of subtracting — a 2× error per refund. Do not reintroduce `Math.abs()` there.

**Not every PDF line has a voucher.** Taxes, perceptions and credits are laid out as `DESC [rate%]( base ) importe` — e.g. `IIBB PERCEP-CABA 2,00%( 7749,28) 154,98` or `CR.RG 5617 30% M -8.147,80`. `parsearCargoSinCuponPDF()` handles these: it takes the **last** amount on the line (the earlier ones are the rate and the taxable base), strips the parenthetical and rate to derive the merchant key, and **only accepts the row if the resulting name matches `PATRONES_CARGOS_BANCARIOS` or `PATRONES_CREDITO_BANCARIO`**. That guard is what keeps the statement's legal boilerplate — which is full of lines ending in numbers — from being imported as movements. Adding a new charge type means adding its pattern, or the line is silently dropped — which is how a 150.000 `ADELANTO TRANSFERENCIA` and its interest went missing from the September 2026 statement. A cash advance is accepted through `PATRONES_SIN_CUPON_SIN_CATEGORIA` and imported **uncategorised** (it's money spent, not a bank fee); its interest is a `Cargos Bancarios` pattern. The merchant key strips every amount, the parenthetical base (sometimes unclosed) and any trailing rate/`%`/`$`, so `DB IVA $ 21% 2.182,19 458,26` keys as `DB IVA`, not with a number that changes monthly. A **voucher is six digits *not* followed by `,dd`** — `DB.RG 5617 30% ( 129749,01 ) 38.924,70` used to take its taxable base as a voucher.

**A barcode can share a row's line.** Some pages print a barcode glyph run (`Ëilm~l£gÌ`) at the same height as a transaction; the ±2 Y grouping merges them, the date stops being first, and the row was dropped silently. `FECHA_RE` allows one leading token that doesn't start with a digit.

**A PDF is one closed cycle, so all its rows go to one month.** `normalizarMesPeriodo(filas, { unSoloCiclo: true })` sends every row to the principal cycle; without it, the closing-day taxes and purchases dated the closing day went to the *next* month — and the import, which replaces every month in the file, wiped that month's feed data with them. Verified: the 01-Oct-26 statement parses to exactly `SALDO ACTUAL` 1.627.450,64 / u$s 85,53, all in `2026-09`.

**Page 1 is scanned too.** It's the cover/summary, but the bank lists credits there that never reappear in the detail pages (a real statement had `CR.RG 5617 30% M -8.147,80` only on page 1). Rows from page 1 are kept only when `categoria === 'Cargos Bancarios'`; the summary/total lines fail the guard above and drop out on their own. Charge rows are deduplicated on `fecha|comercio_crudo|monto_ars` because they have no voucher to distinguish them — ordinary purchases are *not* deduplicated, since the same merchant and amount can legitimately repeat on one day (each has its own voucher).

**`USD` can be glued to the preceding token.** The PDF renders `ANTHROPIC* CLAUD in1TomsYBUSD 20,00`, where `\bUSD\b` fails to match and the USD amount was booked as pesos. Detection is `\bUSD\b` **or** `USD <amount>` at the end of the description. Fixing this made the USD total reconcile exactly against a real statement (28,71).

Also parses Google Sheets CSV export for historical migration (`parsearCSVSheets`). Amounts use Argentine locale (`$9.400,00`, `USD 20,00`).

`normalizarMesPeriodo(filas)` is called after every parse and assigns `mes_periodo` **per row**, because one file can hold two cycles: the `Últimos movimientos` feed can keep showing the just-closed cycle alongside the new cycle's first days (the 26-Sep example once cited here was the 28-day bug, not a real straddle — that file is a single cycle). The old rule — label the whole file with the cycle of its most recent `fecha` — filed the entire closed month under the new one. Now: the file's **principal** cycle is the one with the most non-installment, non-zero rows; a row in that cycle or a later one goes to its own cycle; a row dated *before* the principal (a late posting) and every carried installment (`cuota_actual > 1`, whose `fecha` is the original purchase date) go to the principal. The installment rule was checked against the feeds: while the old cycle is still listed, the installments shown are that statement's (`C.17/18` in September, after August billed `C.16/18`). When `Ciclos` is undefined (headless harness) it falls back to the most frequent month.

The import modal follows suit: with a single month it offers the `<input type="month">` override as before; with two it hides it and lists `#import-desglose` (month · rows · replaces or new), and `confirmarImportacion()` leaves the parser's labels alone.

**Placeholder merchant names.** The bank uses `CONSUMO EN PESOS` / `CONSUMO EN DOLARES` as a **placeholder merchant name** for recent transactions and swaps in the real merchant days later (same amount). `PATRONES_IGNORAR` does not filter them, so they can get stored — and a classification rule saved against `CONSUMO EN PESOS` would then apply retroactively to unrelated purchases, since rules key on `comercio_crudo`.

Three filter lists applied during parsing:
- `PATRONES_CARGOS_BANCARIOS` — rows matching these patterns are imported as category `"Cargos Bancarios"` (e.g., `IMP DE SELLOS`, `DB IVA`, `PERCEPCIÓN AFIP`)
- `PATRONES_CREDITO_BANCARIO` — subset of the above that are credits (devolutions); imported with a negative amount so the dashboard total matches the bank statement
- `PATRONES_IGNORAR` — rows matching these are dropped entirely (e.g., `SU PAGO EN PESOS`, `Total Tarjeta`)

### App State (`app.js`)

Global variables, no state manager:

| Global | Holds |
|---|---|
| `mesActivo` | the month every panel is drawn for — the header selector sets it |
| `mesComparacion` | baseline month for the ritmo comparisons; `null` = automatic. `cargarMes()` resets it |
| `sessionUsuario` | the Supabase session; also the "was there already a session" flag for the auth guard |
| `datosActuales` | last dashboard payload. `toggleTema()` re-renders every chart from it without re-fetching, and the evolution modal reads it instead of querying |
| `mapaSeries` / `rankingCategorias` | category → slot colour, and the all-time ranking that assigns the slots |
| `chartTorta` · `chartTop` · `chartEvo` · `chartEvoModal` | the four Chart.js instances |
| `top10Data` | stashed by `dibujarBarras()` so the Top-10 modal can build its chart later |
| `vistaEvolucion` | which tab the evolution modal is on; defaults to `'ritmo'` |
| `extractoTodos` / `extractoPagina` | statement rows and the 30-per-page cursor |
| `movimientosPendientes` / `mesesConDataActual` | import awaiting confirmation |
| `timerCierre` | handle of the midnight timeout that refreshes the countdown |

On load: `bindEventos()` runs first, then `DB.escucharCambiosAuth()` is subscribed, then an existing Supabase session is looked up in localStorage; if none, `?code=` (PKCE) or `#access_token=` (implicit) in the URL is checked before showing the login screen. A 10-second timeout prevents a permanent black screen if the token is expired.

**The auth callback is re-entrant and must stay guarded.** `escucharCambiosAuth` fires on token refresh too (e.g. returning to the tab), not just on login. It captures `eraSesionActiva = !!sessionUsuario` and calls `arrancarDashboard()` only on a genuine new login — without that guard a background refresh would reset `mesActivo` to the newest month while the user is browsing an older one.

`dibujarDashboard(datos)` is the single entry point for rendering. It calls `construirMapaSeries(datos.evolucion)` first, which is what every chart then reads through `colorCategoria(nombre)`.

**Series color is assigned from a validated 8-slot palette, and it follows the entity rather than the rank.** `SERIES_DARK` / `SERIES_LIGHT` in `app.js` are checked with the `dataviz` skill's `scripts/validate_palette.js` **against this project's own surfaces** (`#080c12` / `#e8eaee`, not the skill's defaults) and pass all six checks in both modes. Do not add, reorder, or hand-pick a hue: the slot order *is* the colorblind-safety mechanism, and any change must be re-validated. The palette this replaced was 14 colors cycled, and failed three checks — most seriously `#5ecf8c`↔`#4fc3c3` (the greens that sat adjacent in the donut) at normal-vision ΔE 9.4 against a floor of 15, plus `--gold` below the chroma floor, i.e. reading as gray and doing no identity work. Gold stays the UI accent and the active-month highlight; it is no longer a series slot.

`construirMapaSeries()` ranks categories by **all-time** spend (from `datos.evolucion`, which covers every period) and hands out slots in that order, so switching months never repaints a surviving category. The 9th category onward folds into `Otros` in gray — never a generated 9th hue, which under CVD would be indistinguishable from one of the eight. `plegarCategorias(items, tope)` does the folding for a single distribution. This also collapsed **three** competing colour sources that used to coexist: the per-user `categorias` colours, a `PALETTE.donut` array, and a private `fallbacks` list inside the evolution chart's own code — so the same category could come out one colour in the donut and another in the evolution chart. `obtenerColorCategoria()` went with them, and `colorCategoria()` is now the only way any surface resolves a category to a colour.

**`PALETTE.surface` is the separator color and must track the theme.** The 2px gap between donut segments and between stacked bars is painted in the surface color — the skill's rule is that white space separates marks, never a stroke around them. It used to be hardcoded `#080c12`, so in light theme the donut drew black rings around every segment.

**The ritmo view is the primary one; the category stack is secondary.** The `area-evo` bento panel ("Ritmo por Ciclo") plots each cycle measured at **the same day** the active month is on, and `#modal-evolucion` opens on that same view, with `dibujarEvoCategorias()` (the stack) as the second tab. The two plot different measures — a closed month's full total vs. a partial, comparable one — so they stay in separate views rather than sharing two y-scales on one plot, which would invent a relationship the data doesn't have. Both modal views write a table twin (`tablaEvolucion()` / `tablaRitmo()`) beneath the chart, so no value is reachable only through a tooltip or only through color.

`construirChartRitmo(canvasId, rh, { compacto })` builds that chart for both surfaces. Form is emphasis + polarity: gold for the active month, green where that cycle was running higher than now, red where it was lower, plus a dashed gold reference line at the active month's level (dashed on purpose — it is a threshold, while gridlines stay solid hairlines). The per-bar `▼/▲ %` labels use the delta/status tokens (`PALETTE.bueno` / `PALETTE.malo`), never the mark color. Labelling *every* bar is deliberate and is the one place it's right: the variation is the chart's entire story, not an ornament on some other measure.

Two things that were fixed by looking at the render, and will come back if undone:
- **The reference line's value is in the note text, not on the canvas.** Drawn at the plot's right edge it collided with the last bar's `▼ %` label whenever that month sat near the current level — which is exactly when the reader most needs both.
- **The panel plots only the last 6 cycles** (`rh.meses.slice(-6)`); with ten, the variation labels overlap inside a 130px-tall panel. The modal carries the full history, and the panel's button goes there.

**`ChartDataLabels` is not registered globally** — every chart that wants labels passes it in its own `plugins` array, so one that forgets silently renders none.

`datosEvolucion(evolucion, tope)` still builds the stack's labels/datasets, now only for the modal (`tope` 8 = 7 categories + `Otros`).

Every render destroys the previous instance before building a new one (`if (chartX) chartX.destroy()`). `dibujarDashboard()` draws `chartTorta` (the donut) and `chartEvo` (the **ritmo** bars in the `area-evo` panel — not the category stack, which moved to the modal). The other two are lazy: `chartTop` is built by `dibujarBarrasModal()` when the Top-10 modal opens (the panel itself only shows a top-5 `<ol>`), and `chartEvoModal` by whichever evolution view is on screen. The donut carries an inline plugin `pluginTextoCenter` that paints the month total in the hole; the ritmo charts carry `lineaBase`, which draws the dashed reference line.

`PALETTE` in `app.js` is a **mutable** object holding the active theme's values: `gold`, `cyan`, `green`, `textMuted`, `textMain`, `border`, the `series` slot array, `otros` (the fold-in gray), `surface` (the colour of the gaps between marks) and the `bueno`/`malo` delta tokens. It also seeds `Chart.defaults` (tooltip style, font family, default text colour).

**Light/dark theming** (not backed by the DB): `PALETTES.dark` / `PALETTES.light` hold the two color sets. `aplicarTema(tema)` copies the chosen set into `PALETTE` and updates `Chart.defaults`; `toggleTema()` flips `documentElement.dataset.theme`, persists it to `localStorage['tema']`, and re-renders via `dibujarDashboard(datosActuales)`. The initial theme is applied by an inline IIFE at the **top of `<body>`** in `index.html` (the first thing after the opening tag, so it runs before any content paints) which reads `localStorage['tema']` and stamps both `dataset.theme` and the `!important` background on `documentElement` and `body`.

`dibujarCierre()` fills the `.panel-cierre` countdown (days to the next closing, cycle range, progress bar, due date when known). It is called from `mostrarApp()`, **not** from `dibujarDashboard()`, because it depends on today's date rather than the selected month — and so it still renders for a user with no movements at all. It adds `.es-inminente` at ≤3 days, which recolors the number and bar to `--red`.

**The countdown refreshes itself without a reload.** The figure is in whole days, so instead of a running interval `programarActualizacionCierre()` arms a single `setTimeout` at 00:00:05 local; `dibujarCierre()` calls it on every draw, so firing at midnight re-arms the next one. The handle lives in `timerCierre` and is cleared before re-arming — `mostrarApp()` can fire more than once during the auth flow, and without that the timeouts would pile up. A `visibilitychange` listener in `bindEventos()` redraws when the tab returns to the foreground, because a suspended machine or a throttled background tab can delay the midnight timeout past its mark.

`Ciclos.cierreVigente()` — not `proximoCierre()` — is what the panel renders. On the closing day itself `cierreDe()` correctly returns the *next* closing (that date belongs to the new cycle), so the count would jump 1 → 28/35 and the "cierra hoy" branch would be dead code. `cierreVigente()` returns today when `esDiaDeCierre()` is true, which keeps the day count, the date, the range and the progress bar consistent with each other.

`dibujarRitmo(ritmo, meses)` fills the `.panel-ritmo` block that sits under the closing panel (green `▼` when this cycle is running cheaper than the baseline at the same point, red `▲` when it isn't). Unlike `dibujarCierre()` it **does** depend on the selected month, so it is called from `dibujarDashboard()` and follows the month selector. Its own `#ritmo-vs` dropdown picks the baseline: `poblarSelectorRitmo()` fills it from `datos.meses` minus the active month (disabled when that leaves fewer than two), and `cambiarMesComparacion()` re-runs **only** `DB.obtenerRitmo()` and redraws the panel. The choice lives in the `mesComparacion` global and is reset to `null` (automatic) by `cargarMes()` — a hand-picked baseline can be the very month the user just switched to. The sub-label names the month (`menos que julio`) instead of saying "el mes pasado", which stops being true as soon as the baseline moves. It carries the whole empty-state policy: no previous cycle imported → the panel is hidden outright; no base for a percentage → arrow and amount only. `.panel-cierre` and `.panel-ritmo` share the glass surface rule *and* the cursor-spotlight binding (see Styling).

`dibujarNotasComparacion(ritmo)` fills the `.nota-kpi` sentence under the USD and movement KPIs from the same payload, so those follow the `#ritmo-vs` selector too — `cambiarMesComparacion()` calls it alongside `dibujarRitmo()`. See *DB Layer* for what the sentences say and why the movement count deliberately differs from the KPI above it.

`mostrarSkeletons()` / `ocultarSkeletons()` bracket `arrancarDashboard()`. Both early-exit paths (no data at all → `#banner-migracion`, or data but no months) must call `ocultarSkeletons()` or the placeholders stay on screen forever.

Formatting utilities live at the bottom of `app.js`:

| Helper | Output | Used for |
|---|---|---|
| `formatARS(n, abreviado)` | `$ 1.234.567` · `$1.2M` / `$40k` | amounts; the abbreviated form is for axis ticks |
| `formatPct(n)` | `23,4%`, `120%` past 100 | the decimal is dropped above 100, where it is noise |
| `formatearMes(p)` | `Ago 2026` | chart axes, where the short form earns its place |
| `formatearMesNombre(p, ref)` | `agosto` · `diciembre de 2025` | **everything the user reads as prose**, the `#ritmo-vs` dropdown included |
| `formatFecha(iso)` | `14/03` | statement rows |
| `colorCategoria(nombre)` | a slot hex, or the `Otros` gray | the single colour source for every chart and the statement dots |

Most DOM event wiring happens in `bindEventos()`, called once on `DOMContentLoaded` before session resolution. The exception: four inline `onclick=` attributes in `index.html` (`cerrarModal()`, `cancelarImportacion()` ×2, `confirmarImportacion()`) — **those four functions must stay global in `app.js`**; there is no bundler or module scope, and the CSP's `script-src 'unsafe-inline'` is what keeps them working.

**`index.html` also carries two inline `<script>` blocks**, both dependent on `'unsafe-inline'` and neither part of `app.js`: the theme bootstrap at the top of `<body>`, and the cursor-spotlight IIFE after the `app.js` tag (see Styling). Both are deliberately self-contained — they must keep working before/without `app.js`. (The `<script>` tags in `<head>` are external CDN loads, not inline; the PDF.js `workerSrc` is set from `parser.js`, not from the HTML.)

**Six modals, no router.** Every view lives in `index.html` and is toggled by a class; each has an `abrirX()` / `cerrarX()` pair in `app.js`, wired in `bindEventos()`:

| Modal | Opened by | Content drawn by |
|---|---|---|
| `#modal-top10` | `abrirTop10()` | `dibujarBarrasModal()` — builds `chartTop` lazily from `top10Data` |
| `#modal-cuotas` | `abrirCuotas()` | `dibujarCuotas()` → `#cuerpo-cuotas` + `#pie-cuotas` |
| `#modal-extracto` | `abrirExtracto()` | `renderizarExtractoFiltrado()` — the text search (`#extracto-buscar`) and the category dropdown (`#extracto-filtro-cat`) filter `extractoTodos` client-side and re-run it; it also owns the 30-row pagination |
| `#modal-evolucion` | `abrirEvolucion()` | `dibujarEvoRitmo()` (default) / `dibujarEvoCategorias()`, switched by `cambiarVistaEvolucion()`; both read `datosActuales`, so the modal issues no query of its own |
| `#modal-clasificar` | `abrirModalClasificar()` | `DB.obtenerPendientes()` + `DB.obtenerCategorias()`; saved by `guardarClasificaciones()` |
| `#modal-confirmar-import` | `mostrarConfirmacionImport()` | filled by `manejarSubidaArchivo()`, resolved by `confirmarImportacion()` / `cancelarImportacion()` |

**The IDs in `index.html` are a contract.** `app.js` does ~110 `getElementById` / `querySelector` lookups against roughly 60 IDs, with no data binding, no framework and no build step to catch a typo — renaming an element in the HTML breaks the JS silently at runtime, and only in the code path that touches it. `ejecutarMigracion()` is the standing example: its targets were removed from the HTML and the only symptom is a feature that quietly does nothing.

### Styling (`styles.css`)

Single stylesheet, no preprocessor. The design system is "Ethereal Glass": translucent surfaces over a dark base, gold as the single accent.

**Theming is token-based and dark-first.** `:root` defines the full dark palette (backgrounds, `--glass*` layers, `--text-*`, accents `--gold`/`--cyan`/`--green`/`--red`, `--font-*`, radii `--r-sm`→`--r-pill`, easings, shadows); `[data-theme="light"]` re-declares only the values that change. There is no `prefers-color-scheme` block — the theme comes solely from `documentElement.dataset.theme`, set by the inline bootstrap at the top of `<body>` and flipped by `toggleTema()`.

**Charts are governed by the `dataviz` skill.** Before changing any chart — colors, marks, a new chart type — load that skill and follow its procedure; the palette in particular is *computed*, not chosen: run its `scripts/validate_palette.js` against `#080c12` and `#e8eaee` and fix every FAIL before shipping. The current palette's passing run is the reason those eight hexes are what they are.

**Theme colors are duplicated between CSS and JS and must be edited together.** `PALETTES.dark` / `PALETTES.light` in `app.js` hold Chart.js copies of the same accent and text colors as the CSS custom properties (Chart.js paints to canvas and can't read CSS variables). Changing `--gold` in `styles.css` without changing `PALETTES.*.gold` leaves the charts off-palette. The base background exists in **four** places, all of which have to agree: `--bg-base`, the `!important` inline value `toggleTema()` writes on `<body>`, the theme bootstrap at the top of `<body>`, and `PALETTES.*.surface`, which Chart.js needs to paint the gaps between marks.

**This has already drifted once.** `PALETTES.*.textMuted` had fallen a few steps darker than `--text-muted`, putting every chart's axis and legend text at **3.83:1** on the dark surface and 3.95:1 on the light one — under the 4.5:1 that small text needs. The pairs that must stay identical are `textMuted` ↔ `--text-muted`, `textMain` ↔ `--text-main` and `surface` ↔ `--bg-base`. Verify rather than eyeball: `validate_palette.js` exports `contrast(a, b)`, so `contrast('#7d90a0', '#080c12')` settles it in one line. `--green`'s light step was nudged to `#187340` for the same reason — `#1a7a44` measured 4.46:1, four hundredths short.

**A custom `generateLabels` must set `fontColor` itself.** Chart.js v4 uses `legendItem.fontColor` *directly* as the text `fillStyle` and does **not** fall back to `labels.color` when it is missing — the fill is left undefined and the legend paints black, which on the dark surface is invisible. This is what actually made the donut legend unreadable, and it survived a first fix aimed at the token drift above, because the two look identical from the outside. Diagnose this class of bug by reading the pixels, not the options: `getImageData` over the legend area and count the colors — the options said `#7d90a0` while the canvas held 2473 pure-black pixels and not one of the colour it claimed.

**Decorative layers:** `.fondo-luces` (slow-breathing radial orbs via `::before`/`::after`) and `.grain` (fixed film-grain overlay) sit behind the app; both are `pointer-events: none`. `.tarjeta` / `.bento-caja` carry a radial gold spotlight driven by `--spot`, which is `transparent` until `:hover`. Its center reads `--mx`/`--my` (fallback `50% / -10%`), and **those are set by a real mouse-tracking IIFE** — the last inline `<script>` in `index.html`, which binds a `pointermove` listener to every `.tarjeta, .bento-caja, .panel-cierre, .panel-ritmo` and guards re-binding with `dataset.spot`. **A new glass panel must be added to that selector too**, or it keeps the `--spot` gradient with the fallback center and the light looks painted on instead of tracking the cursor — which is how the two wide panels shipped at first. It is intentionally independent of `app.js`; new glass panels created **after** load (modal content, re-rendered rows) are never bound, so they only get the static fallback position.

Breakpoints are max-width (`920px`, `640px`, `480px`) with one min-width `1440px` tier for large displays. The closing `prefers-reduced-motion: reduce` block is a blanket `*` reset (plus an explicit `animation: none` on the orbs), so new animated elements are covered automatically.

## Reconciling with the Bank

Every number dispute so far has come down to one of these four. Check them before assuming a parser bug.

- **The two source documents are not equivalent.** The `Últimos movimientos` XLSX is a *rolling feed* of recent transactions, not a closed billing period — its total moves every time it's re-exported, and it will never equal a statement total. The `Statements.pdf` resumen is the closed period and carries the bank's official figures. Always check *which* document a number came from and *when* it was exported.
- **Statement reconciliation identity** (verified against a real resumen): `TOTAL CONSUMOS (summed over every card section) + impuestos/percepciones − créditos = TOTAL A PAGAR` on the cover page. A statement can contain **more than one card section**, each with its own `TOTAL CONSUMOS` line — summing only the first one will silently under-count. Use this identity to validate parser changes; it closed to the cent.
- **The KPI is the net; the bank's "En pesos" is the gross.** Reconcile against `totalARS`, not the figure on screen — see *DB Layer* above for the split.
- **The bank's total excludes "Compra en proceso"; ours includes it.** Unsettled purchases are shown in the web/app listing tagged *Compra en proceso* and are left **out** of the "En pesos" figure until they settle. Reconciled to the cent on a real pair: export (14) sums 1.802.672,62 while the app showed 1.773.620,67, and the difference (29.051,95) was exactly the three tagged rows. **The XLSX does not carry the tag** — 4 columns, no "proceso"/"pendiente" text anywhere, so `CASA TELMA $22.900,00` in-process is byte-identical to a settled row. This gap is therefore **irreducible from the XLSX**: during the open cycle the dashboard will always read higher than the bank by whatever is in flight. Reconcile against the closed statement PDF instead, where nothing is in process.

## Key Patterns

- **Import replaces every month the file contains** — `importarMovimientos()` deletes all existing rows for each `mes_periodo` present in the file (usually one, two when the feed straddles a closing) before re-inserting. The XLSX is the source of truth for those months; months it doesn't contain are untouched.
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
