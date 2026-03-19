// ================================================================
// BUILD.JS — Genera config.js desde variables de entorno (Vercel)
// Se ejecuta en tiempo de build, NO en el browser.
// ================================================================

const fs = require('fs');

const url   = process.env.SUPABASE_URL;
const anon  = process.env.SUPABASE_ANON;
const sheet = process.env.SHEETS_MIGRATION_URL;

if (!url || !anon) {
    console.error('\n[build] ERROR: Faltan variables de entorno requeridas:');
    if (!url)  console.error('  - SUPABASE_URL');
    if (!anon) console.error('  - SUPABASE_ANON');
    console.error('\nDefinílas en Vercel > Settings > Environment Variables\n');
    process.exit(1);
}

const sheetUrl = sheet ||
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vTDKgLx_q4QJ_S3qZroQW29E1ORuuRRZaSyvaWm40gKoOmJNSfdXbeGYsj-1B8Z1SC8lvJON-AR6KCG/pub?gid=1001084780&single=true&output=csv';

const contenido = `// ================================================================
// CONFIG.JS — Generado automáticamente por build.js
// NO editar manualmente. Configurar en Vercel > Environment Variables.
// ================================================================

const SUPABASE_URL  = '${url}';
const SUPABASE_ANON = '${anon}';

const SHEETS_MIGRATION_URL = '${sheetUrl}';

const CATEGORIAS_DEFAULT = [
    { nombre: 'Comida',           icono: '🍔', color: '#f59e0b' },
    { nombre: 'Comida Fuera',     icono: '🍽️', color: '#f97316' },
    { nombre: 'Supermercado',     icono: '🛒', color: '#84cc16' },
    { nombre: 'Transporte',       icono: '🚌', color: '#06b6d4' },
    { nombre: 'Suscripciones',    icono: '📱', color: '#8b5cf6' },
    { nombre: 'Gimnasio',         icono: '💪', color: '#10b981' },
    { nombre: 'Ocio',             icono: '🎬', color: '#ec4899' },
    { nombre: 'Farmacia',         icono: '💊', color: '#ef4444' },
    { nombre: 'Ropa',             icono: '👕', color: '#a78bfa' },
    { nombre: 'Hogar',            icono: '🏠', color: '#d97706' },
    { nombre: 'Cuotas Pendientes',icono: '💳', color: '#64748b' },
    { nombre: 'Cargos Bancarios', icono: '🏦', color: '#94a3b8' },
    { nombre: 'Otros',            icono: '📦', color: '#475569' },
    { nombre: 'A Clasificar',     icono: '❓', color: '#334155' },
];
`;

fs.writeFileSync('config.js', contenido, 'utf8');
console.log('[build] config.js generado correctamente desde variables de entorno.');
