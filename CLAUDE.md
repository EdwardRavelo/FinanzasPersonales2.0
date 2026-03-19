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
- Auth: `inicializar()`, `enviarMagicLink()`, `obtenerSesion()`, `cerrarSesion()`, `escucharCambiosAuth(callback)`
- Queries: `obtenerMeses()`, `obtenerKPIs()`, `obtenerDistribucion()`, `obtenerTop10()`, `obtenerEvolucion()`, `obtenerCuotas()`, `obtenerExtracto()`
- Writes: `importarMovimientos()`, `guardarClasificaciones()`, `migrarDesdeSheets()`

`DB.setUserId(uid)` must be called immediately after auth — all query methods use the stored `userId` to scope their Supabase calls.

### Database Schema (`schema.sql`)

Three Supabase tables with RLS (`auth.uid() = user_id` on all):
- **`movimientos`** — transactions; unique on `(user_id, fecha, comercio_crudo, monto_ars, monto_usd)` to prevent duplicate imports. Key fields: `mes_periodo` (format `YYYY-MM`), `es_reintegro` (true for negative/refund amounts), `cuota_actual`/`cuota_total`.
- **`clasificaciones`** — merchant → clean name + category mapping; `clave` is `UPPERCASE(comercio_crudo)`; auto-applied retroactively on save
- **`categorias`** — per-user category list with icon + color; seeded from `CATEGORIAS_DEFAULT` defined in `build.js` (written into `config.js` at deploy time)

### Parser (`parser.js`)

Handles two bank statement formats detected by column count:
- **New format (4 cols):** Fecha y hora, Movimientos, Cuota, Monto
- **Old format (6 cols):** Nro. Tarjeta, Fecha, Establecimiento, Cuota, Importe $, Importe USD

Also parses Google Sheets CSV export for historical migration. Amounts use Argentine locale (`$9.400,00`, `USD 20,00`).

### App State (`app.js`)

Global variables (no state manager): `mesActivo`, `sessionUsuario`, `extractoTodos`, `extractoPagina`, and Chart.js instances (`chartTorta`, `chartTop`, `chartEvo`).

Dashboard initializes with `Promise.all([...])` fetching all data for the active month simultaneously.

## Key Patterns

- **Upsert with `ignoreDuplicates: true`** — re-importing the same file is safe; duplicate rows are silently skipped via the unique constraint.
- **Client-side file parsing** — XLSX files never leave the browser; parsed in-memory and bulk-inserted to Supabase.
- **Magic link auth** — passwordless; auto-detects `#access_token=...` in URL hash on page load.
- **Classification rules** — saving a merchant rule retroactively updates all `movimientos` matching that `comercio_crudo` key.

## CDN Dependencies

All loaded via `<script>` tags in `index.html` — no local install:
- `@supabase/supabase-js@2`
- `chart.js@4.4.3` + `chartjs-plugin-datalabels@2.2.0`
- `xlsx@0.18.5`
- Google Fonts: Playfair Display, DM Mono, DM Sans

Adding a new CDN source requires updating the `Content-Security-Policy` header in `vercel.json` — otherwise the browser will block it in production.
