# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Personal finance dashboard — a static vanilla JS SPA backed by Supabase (PostgreSQL + Auth). No npm, no framework, no build step locally. Deployed to Vercel where `build.js` runs to generate `config.js` from environment variables.

## Local Development

Open `index.html` directly in a browser — no dev server needed. `config.js` is gitignored; you need a local copy with valid Supabase credentials:

```javascript
// config.js (create manually, never commit)
const SUPABASE_URL  = '...';
const SUPABASE_ANON = '...';
const SHEETS_MIGRATION_URL = '...'; // optional CSV export URL
```

## Deployment

Push to `main` → Vercel auto-deploys. The build command is `node build.js`, which reads env vars (`SUPABASE_URL`, `SUPABASE_ANON`, `SHEETS_MIGRATION_URL`) and writes `config.js` to the output.

## Architecture

**Script load order** (defined in `index.html`):
1. `config.js` — Supabase credentials (auto-generated at deploy time)
2. `parser.js` — Client-side XLSX/CSV parsing (IIFE, exposes `Parser`)
3. `db.js` — Supabase client + all query functions (IIFE, exposes `DB`)
4. `app.js` — UI orchestration, DOM manipulation, Chart.js rendering

**All code is in Spanish** (variable names, comments, UI text).

### DB Layer (`db.js`)

Single `DB` module with methods for:
- Auth: `inicializar()`, `loginConGoogle()`, `enviarMagicLink()`, `obtenerSesion()`, `cerrarSesion()`, `escucharCambiosAuth(callback)`
- Queries: `obtenerMeses()`, `obtenerDatosDashboard()`, `obtenerExtracto()`, `obtenerPendientes()`, `obtenerCategorias()`
- Writes: `importarMovimientos()`, `guardarClasificacion()`, `guardarVariasClasificaciones()`, `sincronizarCategorias()`, `migrarDesdeSheets()`
- Utils: `tieneData()` — checks if the user has any data (used to show/hide the migration banner)

`DB.setUserId(uid)` must be called immediately after auth — all query methods use the stored `userId` to scope their Supabase calls.

### Database Schema (`schema.sql`)

Three Supabase tables with RLS (`auth.uid() = user_id` on all):
- **`movimientos`** — transactions. Unique on `(user_id, mes_periodo, fecha, comercio_crudo, COALESCE(monto_ars,''), COALESCE(monto_usd,''), COALESCE(cuota_actual,0))` via a partial index (not a UNIQUE constraint — PostgreSQL's `NULL != NULL` in constraints would allow duplicates otherwise). Key fields: `mes_periodo` (format `YYYY-MM`), `es_reintegro` (true for refunds), `cuota_actual`/`cuota_total`.
- **`clasificaciones`** — merchant → clean name + category mapping; `clave` is `UPPERCASE(comercio_crudo)`; auto-applied retroactively on save
- **`categorias`** — per-user category list with icon + color; seeded from `CATEGORIAS_DEFAULT` defined in `build.js` (written into `config.js` at deploy time)

### Parser (`parser.js`)

Handles two bank statement formats detected by column count:
- **New format (4 cols):** Fecha y hora, Movimientos, Cuota, Monto
- **Old format (6 cols):** Nro. Tarjeta, Fecha, Establecimiento, Cuota, Importe $, Importe USD

Also parses Google Sheets CSV export for historical migration. Amounts use Argentine locale (`$9.400,00`, `USD 20,00`).

Two filter lists applied during parsing:
- `PATRONES_CARGOS_BANCARIOS` — rows matching these patterns are imported as category `"Cargos Bancarios"` (e.g., `IMP DE SELLOS`, `DB IVA`, `PERCEPCIÓN AFIP`)
- `PATRONES_IGNORAR` — rows matching these are dropped entirely (e.g., `SU PAGO EN PESOS`, `Total Tarjeta`)

### App State (`app.js`)

Global variables (no state manager): `mesActivo`, `sessionUsuario`, `extractoTodos`, `extractoPagina`, and Chart.js instances (`chartTorta`, `chartTop`, `chartEvo`).

On load: checks for an existing Supabase session in localStorage first; if none, checks for `?code=` (PKCE) or `#access_token=` (implicit) in the URL before showing the login screen. A 10-second timeout prevents a permanent black screen if the token is expired.

Dashboard initializes with `Promise.all([...])` fetching all data for the active month simultaneously.

## Key Patterns

- **Import replaces the full month** — `importarMovimientos()` deletes all existing rows for the affected `mes_periodo` before re-inserting. The XLSX is the source of truth for that month; historical months are untouched.
- **Client-side file parsing** — XLSX files never leave the browser; parsed in-memory and bulk-inserted to Supabase.
- **Auth** — Google OAuth is the primary login; Magic Link (email OTP) is the secondary option. Both use PKCE flow to prevent email-scanner token consumption.
- **Classification rules** — saving a merchant rule retroactively updates all `movimientos` matching that `comercio_crudo` key.

## CDN Dependencies

All loaded via `<script>` tags in `index.html` — no local install:
- `@supabase/supabase-js@2`
- `chart.js@4.4.3` + `chartjs-plugin-datalabels@2.2.0`
- `xlsx@0.18.5`
- Google Fonts: Playfair Display, DM Mono, DM Sans

Adding a new CDN source requires updating the `Content-Security-Policy` header in `vercel.json` — otherwise the browser will block it in production.
