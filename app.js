// ================================================================
// APP.JS — Orquestador principal
// Sin Google Apps Script. Usa DB.js (Supabase) + Parser.js
// ================================================================

// ----------------------------------------------------------------
// ESTADO GLOBAL
// ----------------------------------------------------------------
let mesActivo        = null;
// Mes contra el que compara el panel de ritmo. null = automático (el ciclo
// anterior, o el mes con datos más reciente si ese no se importó).
let mesComparacion   = null;
let chartTorta       = null;
let chartTop         = null;
let chartEvo         = null;
let sessionUsuario   = null;

// Estado del extracto (filtros y paginación)
let extractoTodos    = [];   // todos los movimientos del mes sin filtrar
let extractoPagina   = 1;
const EXTRACTO_POR_PAGINA = 30;

// Estado de importación pendiente de confirmación
let movimientosPendientes = null;
let mesesConDataActual    = [];

// Último payload del dashboard (para redibujar al cambiar de tema)
let datosActuales = null;

// Handle del timeout que refresca la cuenta regresiva del cierre a medianoche
let timerCierre = null;

// ----------------------------------------------------------------
// PALETA Y CONFIG GLOBAL DE CHART.JS
// ----------------------------------------------------------------
// SERIES: ocho slots categóricos en orden fijo, validados con
// scripts/validate_palette.js de la skill dataviz contra LAS SUPERFICIES DE
// ESTE PROYECTO (#080c12 y #e8eaee), no contra las de referencia. Pasan las
// seis checks en ambos modos. El orden es el mecanismo de seguridad para
// daltonismo: no se reordena ni se agregan hues.
//
// La paleta anterior (14 colores cicladores) fallaba tres checks: el verde y
// el cian eran indistinguibles hasta con visión normal (ΔE 9,4 sobre un piso
// de 15), y el oro caía bajo el piso de croma — leía gris, o sea no hacía
// trabajo de identidad. El oro sigue siendo el acento de la interfaz y el
// resalte del mes activo, pero ya no es un slot de serie.
//
// Novena categoría en adelante: se pliega a "Otros" en gris. Nunca se genera
// un color nuevo — bajo daltonismo sería idéntico a alguno de los ocho.
const SERIES_DARK  = ['#3987e5','#d95926','#199e70','#c98500','#d55181','#008300','#9085e9','#e66767'];
const SERIES_LIGHT = ['#2a78d6','#eb6834','#1baf7a','#eda100','#e87ba4','#008300','#4a3aa7','#e34948'];

let PALETTE = {
    gold:      '#c9a96e',
    goldDim:   'rgba(201,169,110,0.15)',
    cyan:      '#4fc3c3',
    green:     '#5ecf8c',
    // OJO: estos dos son la copia para Chart.js de --text-muted y --text-main
    // de styles.css y tienen que seguir siendo EL MISMO hex. Se habían
    // desincronizado: la copia de acá era más oscura y dejaba la tipografía
    // de los gráficos en 3,83:1 sobre el fondo oscuro, debajo del 4,5:1 que
    // pide el texto chico. La leyenda del donut, que es la que lleva los
    // montos, quedaba ilegible.
    textMuted: '#7d90a0',
    textMain:  '#f2f5fa',
    border:    'rgba(255,255,255,0.06)',
    // Superficie sobre la que se dibuja: es el color de los separadores de
    // 2px entre marcas. Antes estaba hardcodeado en #080c12, así que en tema
    // claro el donut dibujaba aros negros.
    surface:   '#080c12',
    series:    SERIES_DARK,
    otros:     '#8a8f98',
    // Polaridad para el ritmo: gastar menos es bueno.
    bueno:     '#0ca30c',
    malo:      '#d03b3b',
};

const PALETTES = {
    dark: {
        gold: '#c9a96e', goldDim: 'rgba(201,169,110,0.15)',
        cyan: '#4fc3c3', green: '#5ecf8c',
        textMuted: '#7d90a0', textMain: '#f2f5fa',   // == --text-muted / --text-main (oscuro)
        border: 'rgba(255,255,255,0.06)',
        tooltipBg: 'rgba(8,12,18,0.95)',
        tooltipBorder: 'rgba(201,169,110,0.3)',
        surface: '#080c12',
        series:  SERIES_DARK,
        otros:   '#8a8f98',
        bueno:   '#0ca30c',
        malo:    '#d03b3b',
    },
    light: {
        gold: '#a07028', goldDim: 'rgba(160,112,40,0.12)',
        cyan: '#1e8f8f', green: '#187340',
        textMuted: '#5c6b7d', textMain: '#172032',   // == --text-muted / --text-main (claro)
        border: 'rgba(0,0,0,0.07)',
        tooltipBg: 'rgba(26,35,50,0.95)',
        tooltipBorder: 'rgba(160,112,40,0.3)',
        surface: '#e8eaee',
        series:  SERIES_LIGHT,
        otros:   '#6b7280',
        bueno:   '#0a7a0a',
        malo:    '#b8323c',
    },
};

function aplicarTema(tema) {
    const p = PALETTES[tema] || PALETTES.dark;
    PALETTE.gold      = p.gold;
    PALETTE.goldDim   = p.goldDim;
    PALETTE.cyan      = p.cyan;
    PALETTE.green     = p.green;
    PALETTE.textMuted = p.textMuted;
    PALETTE.textMain  = p.textMain;
    PALETTE.border    = p.border;
    PALETTE.surface   = p.surface;
    PALETTE.series    = p.series;
    PALETTE.otros     = p.otros;
    PALETTE.bueno     = p.bueno;
    PALETTE.malo      = p.malo;

    Chart.defaults.color                           = p.textMuted;
    Chart.defaults.plugins.tooltip.backgroundColor = p.tooltipBg;
    Chart.defaults.plugins.tooltip.borderColor     = p.tooltipBorder;
    Chart.defaults.plugins.tooltip.titleColor      = p.gold;
    Chart.defaults.plugins.tooltip.bodyColor       = p.textMain;

    const btn = document.getElementById('btn-tema');
    if (btn) btn.textContent = tema === 'light' ? '☾' : '☀';
}

// ----------------------------------------------------------------
// MAPA DE COLOR POR CATEGORÍA — estable, no por ranking del mes
//
// El color sigue a la entidad, nunca a su puesto. Si los slots se asignaran
// por el ranking del mes elegido, cambiar de mes repintaría las categorías
// que sobreviven y el que aprendió "Supermercado es azul" quedaría colgado.
// El orden sale del gasto de TODA la historia, que no depende del mes en
// pantalla, así que filtrar no repinta nada.
//
// Hasta ocho categorías toman slot propio; de la novena en adelante se
// pliegan a "Otros" en gris. Nunca se genera un color nuevo: bajo daltonismo
// sería indistinguible de alguno de los ocho.
// ----------------------------------------------------------------
const CAT_OTROS = 'Otros';

let mapaSeries        = {};   // nombre de categoría → color de slot
let rankingCategorias = [];   // orden por gasto histórico, el que fija los slots

function construirMapaSeries(evolucion) {
    const { periodos = [], datos = {} } = evolucion || {};

    const totales = {};
    periodos.forEach(p => {
        Object.entries(datos[p] || {}).forEach(([cat, monto]) => {
            totales[cat] = (totales[cat] || 0) + monto;
        });
    });

    rankingCategorias = Object.keys(totales).sort((a, b) => totales[b] - totales[a]);

    mapaSeries = {};
    rankingCategorias.forEach((cat, i) => {
        mapaSeries[cat] = i < PALETTE.series.length ? PALETTE.series[i] : PALETTE.otros;
    });
    mapaSeries[CAT_OTROS] = PALETTE.otros;
}

function colorCategoria(nombre) {
    return mapaSeries[nombre] || PALETTE.otros;
}

// Pliega una distribución a `tope` slots + "Otros", respetando el ranking
// histórico para que el color de cada categoría no dependa del mes.
function plegarCategorias(items, tope) {
    if (items.length <= tope) return items;

    const ordenados = [...items].sort((a, b) => b.total - a.total);
    const cabeza    = ordenados.slice(0, tope - 1);
    const cola      = ordenados.slice(tope - 1);

    return [...cabeza, {
        categoria: CAT_OTROS,
        total:     cola.reduce((s, d) => s + d.total, 0),
        cuantas:   cola.length,
    }];
}

function toggleTema() {
    const html  = document.documentElement;
    const nuevo = html.dataset.theme === 'light' ? 'dark' : 'light';
    html.dataset.theme = nuevo;
    localStorage.setItem('tema', nuevo);
    const bg = nuevo === 'light' ? '#e8eaee' : '#080c12';
    document.body.style.setProperty('background-color', bg, 'important');
    aplicarTema(nuevo);
    if (datosActuales) dibujarDashboard(datosActuales);
}

Chart.defaults.font.family                   = "'DM Mono', monospace";
Chart.defaults.font.size                     = 11;
Chart.defaults.plugins.tooltip.borderWidth   = 1;
Chart.defaults.plugins.tooltip.padding       = 12;
Chart.defaults.plugins.tooltip.cornerRadius  = 8;
Chart.defaults.plugins.tooltip.titleFont     = { family:"'DM Mono',monospace", size:11, weight:'500' };
Chart.defaults.plugins.tooltip.bodyFont      = { family:"'Playfair Display',serif", size:15, weight:'700' };

// Aplicar tema guardado al inicio
aplicarTema(document.documentElement.dataset.theme || 'dark');

// ----------------------------------------------------------------
// INICIO
// ----------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
    DB.inicializar();

    // Eventos UI (antes de saber si hay sesión)
    bindEventos();

    // Escuchar cambios de auth (login / logout / magic link callback)
    // onAuthStateChange se dispara cuando:
    //   - El usuario hace click en el magic link (SIGNED_IN con token en URL)
    //   - Se restaura la sesión desde localStorage
    //   - Se cierra la sesión
    DB.escucharCambiosAuth(async (session) => {
        const eraSesionActiva = !!sessionUsuario;
        sessionUsuario = session;
        if (session) {
            DB.setUserId(session.user.id);
            // Limpiar el hash de la URL (#access_token=...) sin recargar
            if (window.location.hash.includes('access_token')) {
                history.replaceState(null, '', window.location.pathname);
            }
            mostrarApp();
            // Solo arrancar si es un login nuevo; los refrescos de token
            // (al volver a la pestaña) no deben resetear el mes activo.
            if (!eraSesionActiva) {
                await arrancarDashboard();
            }
        } else {
            mostrarLogin();
        }
    });

    // Verificar sesión existente en localStorage (carga rápida sin esperar email)
    const session = await DB.obtenerSesion();
    if (session) {
        sessionUsuario = session;
        DB.setUserId(session.user.id);
        mostrarApp();
        await arrancarDashboard();
    } else {
        // Detectar magic link en URL: implicit flow (#access_token=) o PKCE (?code=)
        const hayTokenEnUrl = window.location.hash.includes('access_token')
                           || window.location.search.includes('code=');

        if (!hayTokenEnUrl) {
            mostrarLogin();
        } else {
            // Ocultar todo mientras Supabase procesa el codigo/token
            document.getElementById('pantalla-login').style.display = 'none';
            document.getElementById('pantalla-app').style.display   = 'none';

            // Fallback: si en 10s no llega el evento de auth, mostrar login
            // (evita pantalla negra permanente si el token vencio o fallo)
            setTimeout(() => {
                if (!sessionUsuario) mostrarLogin();
            }, 10000);
        }
    }
});

// ----------------------------------------------------------------
// MOSTRAR / OCULTAR SECCIONES
// ----------------------------------------------------------------
function mostrarLogin() {
    document.getElementById('pantalla-login').style.display = 'flex';
    document.getElementById('pantalla-app').style.display   = 'none';
}

function mostrarApp() {
    document.getElementById('pantalla-login').style.display = 'none';
    document.getElementById('pantalla-app').style.display   = 'block';
    // Independiente de los datos: se dibuja aunque el usuario no tenga movimientos
    dibujarCierre();
}

// ----------------------------------------------------------------
// ARRANCAR DASHBOARD
// ----------------------------------------------------------------
async function arrancarDashboard() {
    mostrarSkeletons();

    try {
        // Verificar si tiene datos; mostrar banner de migración si no
        const tieneData = await DB.tieneData();
        const banner = document.getElementById('banner-migracion');
        if (banner) {
            banner.style.display = tieneData ? 'none' : 'flex';
        }

        if (!tieneData) {
            ocultarSkeletons();
            return;
        }

        // Cargar meses disponibles
        const meses = await DB.obtenerMeses();
        if (!meses.length) {
            ocultarSkeletons();
            return;
        }

        // Llenar selector de meses
        const selector = document.getElementById('selector-mes');
        selector.innerHTML = '';
        meses.forEach(m => {
            const opt = document.createElement('option');
            opt.value   = m;
            opt.textContent = formatearMes(m);
            selector.appendChild(opt);
        });

        // Preservar el mes que el usuario tenía seleccionado si sigue disponible;
        // si no, ir al más reciente.
        mesActivo = (mesActivo && meses.includes(mesActivo)) ? mesActivo : meses[0];
        selector.value = mesActivo;

        await cargarMes(mesActivo);

    } catch (err) {
        console.error('Error al arrancar dashboard:', err);
        mostrarError('Error al conectar con la base de datos.');
    }
}

async function cargarMes(mes) {
    mesActivo = mes;
    // El mes de comparación vuelve a automático: el elegido a mano puede ser
    // el mes que se acaba de seleccionar, o quedar sin sentido respecto de él.
    mesComparacion = null;
    mostrarSkeletons();

    try {
        const datos = await DB.obtenerDatosDashboard(mes);
        dibujarDashboard(datos);
    } catch (err) {
        console.error('Error al cargar mes:', err);
        mostrarError('Error al cargar los datos del mes.');
    }
}

// ----------------------------------------------------------------
// DIBUJAR DASHBOARD
// ----------------------------------------------------------------
function dibujarDashboard(datos) {
    datosActuales = datos;

    // Un solo mapa de color para todo el dashboard: donut, evolución, panel
    // de categoría top y los puntos del extracto. Antes había tres fuentes
    // distintas (las categorías del usuario, PALETTE.donut y una lista de
    // fallbacks dentro de dibujarEvolucion), así que la misma categoría podía
    // salir de un color en el donut y de otro en la evolución.
    construirMapaSeries(datos.evolucion);

    dibujarKPIs(datos.kpis);
    dibujarRitmo(datos.ritmo, datos.meses);
    dibujarNotasComparacion(datos.ritmo);
    dibujarDonut(datos.distribucion);
    dibujarCatTop(datos.distribucion);
    dibujarBarras(datos.top10);
    dibujarEvolucionPanel(datos.ritmoHistorico);
    dibujarCuotas(datos.cuotas);
    dibujarExtracto(datos.extracto);
}

// ----------------------------------------------------------------
// PANEL DE CIERRE — cuenta regresiva al próximo cierre del resumen
//
// No depende del mes seleccionado: siempre mira el ciclo en curso
// respecto de hoy. Se redibuja solo al cambiar el día, sin recargar.
// ----------------------------------------------------------------
function programarActualizacionCierre() {
    if (timerCierre) clearTimeout(timerCierre);

    // La cuenta está en días, así que sólo cambia a medianoche: en vez de un
    // interval corriendo todo el tiempo, se apunta un único timeout al primer
    // segundo del día siguiente (hora local, que es la que ve el usuario).
    const ahora     = new Date();
    const medianoche = new Date(
        ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + 1, 0, 0, 5
    );

    timerCierre = setTimeout(dibujarCierre, medianoche - ahora);
}

function dibujarCierre() {
    const panel = document.querySelector('.panel-cierre');
    if (!panel || typeof Ciclos === 'undefined') return;

    // Reprograma en cada dibujo: al dispararse a medianoche, esta misma
    // llamada deja armado el timeout del día siguiente.
    programarActualizacionCierre();

    // cierreVigente() y no proximoCierre(): el día del cierre hay que mostrar
    // el de hoy, o la cuenta salta de 1 a 28 sin pasar por "cierra hoy".
    const cierre = Ciclos.cierreVigente();
    const dias   = Ciclos.diasHastaCierre(cierre);
    const rango  = Ciclos.rangoDe(cierre);
    const vence  = Ciclos.vencimientoDe(cierre);

    document.getElementById('cierre-dias').textContent = dias;
    document.getElementById('cierre-dias-sub').textContent =
        dias === 0 ? 'el resumen cierra hoy'
      : dias === 1 ? 'día para el cierre'
      : 'días para el cierre';

    document.getElementById('cierre-fecha').textContent = Ciclos.formatearFecha(cierre);

    // El ciclo es [desde, hasta): el último día facturado es el previo al cierre
    const ultimoDia = new Date(Date.parse(rango.hasta) - 86400000).toISOString().slice(0, 10);
    document.getElementById('cierre-rango').textContent =
        `ciclo ${Ciclos.formatearCorta(rango.desde)} → ${Ciclos.formatearCorta(ultimoDia)}`;

    document.getElementById('cierre-vence').textContent =
        vence ? `vence ${Ciclos.formatearCorta(vence)}` : '';

    const pct = Math.round(Ciclos.progresoCiclo(cierre) * 100);
    document.getElementById('cierre-barra').style.width = `${pct}%`;
    document.getElementById('cierre-barra-track').setAttribute('aria-valuenow', pct);

    panel.classList.toggle('es-inminente', dias <= 3);
}

// ----------------------------------------------------------------
// PANEL DE RITMO — ¿estoy gastando más o menos que el mes pasado?
//
// La comparación es a la MISMA ALTURA del ciclo (mismo día), no mes
// calendario contra mes calendario, y sólo sobre consumo del ciclo:
// ver obtenerRitmo() en db.js. A diferencia del panel de cierre, este
// sí depende del mes seleccionado, así que se dibuja desde
// dibujarDashboard() y cambia al cambiar de mes en el selector.
// ----------------------------------------------------------------
function dibujarRitmo(ritmo, meses = []) {
    const panel = document.getElementById('panel-ritmo');
    if (!panel) return;

    // Sin ningún mes anterior importado no hay con qué comparar: se esconde
    // el panel en lugar de cantar un −100% contra un mes vacío.
    if (!ritmo || !ritmo.hayComparacion) {
        panel.style.display = 'none';
        return;
    }
    panel.style.display = '';

    poblarSelectorRitmo(meses, ritmo.mesComparacion);

    const menos = ritmo.delta < 0;
    panel.classList.toggle('es-menos',  menos);
    panel.classList.toggle('es-mas',   !menos);

    // pct viene null cuando el ciclo anterior no tuvo consumo en el tramo:
    // sería una división por cero, así que se informa sólo el monto.
    document.getElementById('ritmo-pct').textContent =
        ritmo.pct === null ? (menos ? '▼' : '▲')
                           : `${menos ? '▼' : '▲'} ${formatPct(Math.abs(ritmo.pct))}`;

    // Se nombra el mes en vez de decir "el mes pasado": con el selector la
    // base puede ser cualquiera, y quedaría mintiendo.
    document.getElementById('ritmo-pct-sub').textContent =
        `${menos ? 'menos' : 'más'} que ${formatearMes(ritmo.mesComparacion)}`;

    document.getElementById('ritmo-monto').textContent =
        `${formatARS(Math.abs(ritmo.delta))} ${menos ? 'menos' : 'más'}`;

    // El ciclo en curso va en presente ("llevás"); uno ya cerrado, en pasado.
    document.getElementById('ritmo-detalle').textContent = ritmo.enCurso
        ? `Llevás ${formatARS(ritmo.actual)} en este ciclo, contra ` +
          `${formatARS(ritmo.anterior)} de ${formatearMes(ritmo.mesComparacion)} en el mismo tramo.`
        : `Gastaste ${formatARS(ritmo.actual)} en ${formatearMes(ritmo.mesPeriodo)}, contra ` +
          `${formatARS(ritmo.anterior)} de ${formatearMes(ritmo.mesComparacion)}, ciclo completo.`;

    document.getElementById('ritmo-rango').textContent = ritmo.enCurso
        ? `día ${ritmo.dia} de ${ritmo.diasCiclo}`
        : `ciclo completo · ${ritmo.diasCiclo} días`;
}

// ----------------------------------------------------------------
// NOTAS DE COMPARACIÓN BAJO LOS KPI DE USD Y DE MOVIMIENTOS
//
// Misma lógica que el panel de ritmo y contra el mismo mes que elija su
// selector: consumo del ciclo hasta el mismo día, sin cuotas arrastradas
// ni créditos. Por eso el conteo de movimientos de la nota no coincide con
// el número grande del KPI, que cuenta todas las filas del mes — son dos
// preguntas distintas y el `title` lo aclara al pasar el mouse.
// ----------------------------------------------------------------
function dibujarNotasComparacion(ritmo) {
    const pintar = (id, v, formato, sufijo) => {
        const el = document.getElementById(id);
        if (!el) return;

        el.classList.remove('es-menos', 'es-mas');

        // Sin mes de comparación no hay nada que decir: se vacía y el hueco
        // colapsa solo.
        if (!ritmo || !ritmo.hayComparacion || !v || v.delta === undefined) {
            el.textContent = '';
            el.removeAttribute('title');
            return;
        }

        const menos = v.delta < 0;
        el.classList.add(menos ? 'es-menos' : 'es-mas');

        const flecha = menos ? '▼' : '▲';
        const cifra  = v.pct === null
            ? formato(Math.abs(v.delta))
            : `${formatPct(Math.abs(v.pct))} · ${formato(Math.abs(v.delta))}`;

        el.textContent = `${flecha} ${cifra} vs ${formatearMes(ritmo.mesComparacion)}`;
        el.title = ritmo.enCurso
            ? `${formato(v.actual)} en este ciclo contra ${formato(v.anterior)} de ` +
              `${formatearMes(ritmo.mesComparacion)} al mismo día (${ritmo.dia} de ${ritmo.diasCiclo}). ` +
              `${sufijo}`
            : `${formato(v.actual)} contra ${formato(v.anterior)}, ciclos completos. ${sufijo}`;
    };

    pintar('val-usd-nota', ritmo?.usd,
        n => `u$s ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        'Sólo consumo del ciclo, sin cuotas ni créditos.');

    pintar('val-mov-nota', ritmo?.movimientos,
        n => `${Math.round(n)} mov.`,
        'Cuenta sólo movimientos del ciclo, por eso no coincide con el total de arriba.');
}

// Llena el selector con los meses que tienen datos, salvo el que se está
// mirando. Se repuebla en cada dibujo porque la lista cambia al importar.
function poblarSelectorRitmo(meses, mesElegido) {
    const sel = document.getElementById('ritmo-vs');
    if (!sel) return;

    const opciones = (meses || []).filter(m => m !== mesActivo);
    sel.innerHTML = '';

    opciones.forEach(m => {
        const op = document.createElement('option');
        op.value = m;
        // El mes que resolvió el modo automático se marca, así se ve que
        // es el ciclo anterior y no una elección del usuario.
        op.textContent = `vs ${formatearMes(m)}`;
        sel.appendChild(op);
    });

    sel.value = mesElegido || '';
    sel.disabled = opciones.length < 2;
}

// Cambiar el mes de comparación sólo recalcula este panel: el resto del
// dashboard depende del mes activo, que no se movió.
async function cambiarMesComparacion(mes) {
    mesComparacion = mes || null;
    if (!mesActivo) return;

    try {
        const ritmo = await DB.obtenerRitmo(mesActivo, mesComparacion);
        dibujarRitmo(ritmo, datosActuales?.meses || []);
        // Las notas de USD y de movimientos comparan contra el mismo mes,
        // así que se mueven con el selector.
        dibujarNotasComparacion(ritmo);
        if (datosActuales) datosActuales.ritmo = ritmo;
    } catch (err) {
        console.error('Error al comparar meses:', err);
        mostrarError('No se pudo comparar contra ese mes.');
    }
}

// ----------------------------------------------------------------
// KPIs
// ----------------------------------------------------------------
function dibujarKPIs(kpis) {
    // Los KPIs muestran el NETO: los créditos ya vienen restados, porque lo
    // que importa es el número que se paga. El banco en cambio informa el
    // consumo bruto en su "En pesos", así que las dos cifras no coinciden
    // aunque los datos sean los mismos.
    const netoUSD = kpis.netoUSD != null ? kpis.netoUSD : kpis.totalUSD;

    document.getElementById('val-total').textContent =
        formatARS(kpis.netoARS != null ? kpis.netoARS : kpis.totalARS);
    document.getElementById('val-total-usd').textContent =
        netoUSD > 0 ? `u$s ${netoUSD.toFixed(2)}` : '—';
    document.getElementById('val-movimientos').textContent =
        kpis.cantidadMovimientos;

    // La nota reusa el hueco que dejó la línea de créditos (ya estilado y
    // colapsable vía .nota-kpi:not(:empty), así que no altera el layout).
    // Muestra de qué está hecho el total: cuánto es arrastre de cuotas
    // viejas y cuánto se consumió en el ciclo — en un resumen típico las
    // cuotas son la mayor parte, y eso no se veía en ningún panel.
    const nota = document.getElementById('val-creditos');
    if (nota) {
        const cuotas = kpis.cuotasARS || 0;
        const ciclo  = kpis.cicloARS  || 0;
        const bruto  = cuotas + ciclo;
        if (cuotas > 0 && bruto > 0) {
            const pct = Math.round(cuotas / bruto * 100);
            nota.textContent =
                `cuotas ${formatARS(cuotas)} (${pct}%) · ciclo ${formatARS(ciclo)}`;
        } else {
            nota.textContent = '';
        }
    }
}

// ----------------------------------------------------------------
// GRÁFICO DONUT — Distribución por categoría
// ----------------------------------------------------------------
function dibujarDonut(distribucion) {
    // Parte-sobre-el-total se lee de un vistazo hasta ~6 gajos; más allá los
    // adyacentes se confunden y el gráfico deja de responder nada. El resto
    // se pliega a "Otros", que el tooltip desglosa en cuántas categorías son.
    const items  = plegarCategorias(distribucion || [], 6);
    const labels = items.map(d => d.categoria);
    const values = items.map(d => d.total);
    const total  = values.reduce((a, b) => a + b, 0);
    const colores = labels.map(colorCategoria);

    if (chartTorta) chartTorta.destroy();

    const pluginTextoCenter = {
        id: 'textoCenter',
        afterDraw(chart) {
            const { ctx, chartArea: { width, height, left, top } } = chart;
            const cx = left + width  / 2;
            const cy = top  + height / 2;
            ctx.save();
            // Misma sans que el resto: una serif acá lee como decoración
            // fuera de marca, y además el número grande va con cifras
            // proporcionales (tabular-nums afloja los dígitos a este tamaño).
            ctx.font         = `600 17px 'Space Grotesk', system-ui, sans-serif`;
            ctx.fillStyle    = PALETTE.textMain;
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(formatARS(total), cx, cy - 7);
            ctx.font      = `400 9px 'DM Mono', monospace`;
            ctx.fillStyle = PALETTE.textMuted;
            ctx.fillText('TOTAL', cx, cy + 12);
            ctx.restore();
        }
    };

    chartTorta = new Chart(document.getElementById('grafico-torta'), {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data:                 values,
                backgroundColor:      colores,
                hoverBackgroundColor: colores,
                // El separador entre gajos es la superficie, no un borde: un
                // trazo alrededor de la marca agrega tinta que no es dato.
                // Iba hardcodeado en #080c12, así que en tema claro el donut
                // dibujaba aros negros; ahora sigue al tema.
                borderWidth:      2,
                borderColor:      PALETTE.surface,
                hoverBorderWidth: 2,
                hoverBorderColor: PALETTE.surface,
                hoverOffset:      10,
                spacing:          2,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '72%',
            animation: { duration: 900, easing: 'easeInOutQuart' },
            plugins: {
                legend: {
                    position: 'right',
                    labels: {
                        boxWidth: 8, boxHeight: 8, borderRadius: 2,
                        usePointStyle: true, pointStyle: 'rect',
                        padding: 12,
                        // El texto va con tinta, nunca con el color de la
                        // serie: el swatch al lado es el que da identidad.
                        color: PALETTE.textMuted,
                        font: { size: 11, family: "'DM Mono',monospace" },
                        // En tema claro cuatro de los ocho slots quedan bajo
                        // 3:1 contra la superficie. La skill lo permite sólo
                        // si el valor se puede leer por otro canal: la leyenda
                        // lleva el monto, así que nada depende del color.
                        // OJO: `fontColor` es obligatorio acá. Chart.js v4 lo
                        // usa DIRECTO como fillStyle del texto y NO cae de
                        // vuelta a labels.color cuando falta: sin él el
                        // fillStyle queda sin definir y la leyenda se dibuja
                        // en negro sobre el fondo oscuro, ilegible. El color
                        // de la serie lo lleva el punto de al lado, nunca la
                        // tipografía.
                        generateLabels(chart) {
                            const ds = chart.data.datasets[0];
                            return chart.data.labels.map((l, i) => ({
                                text: `${l}  ${formatARS(ds.data[i], true)}`,
                                fillStyle: ds.backgroundColor[i],
                                strokeStyle: ds.backgroundColor[i],
                                fontColor: PALETTE.textMuted,
                                lineWidth: 0,
                                index: i,
                            }));
                        },
                    }
                },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const pct = total > 0 ? (ctx.raw / total) * 100 : 0;
                            return ` ${ctx.label}: ${formatARS(ctx.raw)} (${formatPct(pct)})`;
                        },
                        afterLabel: ctx => {
                            const it = items[ctx.dataIndex];
                            return it?.cuantas ? `  ${it.cuantas} categorías agrupadas` : '';
                        },
                    }
                }
            }
        },
        plugins: [pluginTextoCenter]
    });
}

// ----------------------------------------------------------------
// ----------------------------------------------------------------
// CATEGORÍA TOP DEL MES
// ----------------------------------------------------------------
function dibujarCatTop(distribucion) {
    const dotEl    = document.getElementById('cat-top-dot');
    const nombreEl = document.getElementById('cat-top-nombre');
    const montoEl  = document.getElementById('cat-top-monto');
    const pctEl    = document.getElementById('cat-top-pct');
    if (!dotEl) return;

    if (!distribucion || !distribucion.length) {
        nombreEl.textContent = '—';
        montoEl.textContent  = '—';
        pctEl.textContent    = '—';
        return;
    }

    const sorted = [...distribucion].sort((a, b) => b.total - a.total);
    const top    = sorted[0];
    const total  = distribucion.reduce((s, d) => s + d.total, 0);
    const pct    = total > 0 ? Math.round((top.total / total) * 100) : 0;
    const color  = colorCategoria(top.categoria);

    dotEl.style.background   = color;
    nombreEl.textContent     = top.categoria;
    montoEl.textContent      = formatARS(top.total);
    montoEl.style.color      = color;
    pctEl.textContent        = `${pct}% del total del mes`;
}

// TOP 10 COMERCIOS — lista compacta en panel + gráfico en modal
// ----------------------------------------------------------------
let top10Data = [];

function dibujarBarras(top10) {
    top10Data = top10 || [];

    const lista = document.getElementById('lista-top5');
    if (!lista) return;
    lista.innerHTML = '';

    const items = top10Data.slice(0, 5);
    if (!items.length) {
        lista.innerHTML = '<li class="tabla-vacia">Sin datos</li>';
        return;
    }
    items.forEach((item, i) => {
        const li = document.createElement('li');
        li.className = 'top5-item';
        li.innerHTML = `
            <span class="top5-rank">${i + 1}</span>
            <span class="top5-nombre">${item.comercio}</span>
            <span class="top5-monto">${formatARS(item.total)}</span>
        `;
        lista.appendChild(li);
    });
}

function dibujarBarrasModal() {
    const top10 = top10Data;
    if (!top10.length) return;

    const labels = top10.map(t => t.comercio);
    const values = top10.map(t => t.total);
    const maxVal = Math.max(...values, 1);

    if (chartTop) chartTop.destroy();

    chartTop = new Chart(document.getElementById('grafico-top'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data:            values,
                backgroundColor: 'rgba(201,169,110,0.25)',
                borderColor:     'rgba(201,169,110,0.65)',
                borderWidth:     { top: 0, right: 0, bottom: 0, left: 2 },
                borderSkipped:   false,
                borderRadius:    { topRight: 3, bottomRight: 3, topLeft: 0, bottomLeft: 0 },
                barThickness:    14,
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            layout: { padding: { right: 80 } },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: ctx => ctx[0].label,
                        label: ctx => ` ${formatARS(ctx.raw)}`,
                    }
                },
                datalabels: {
                    anchor: 'end', align: 'end',
                    color: PALETTE.textMuted,
                    font: { size: 11, family: "'DM Mono',monospace" },
                    formatter: val => formatARS(val),
                    offset: 4,
                }
            },
            scales: {
                x: { display: false, grid: { display: false }, max: maxVal * 1.4 },
                y: {
                    grid: { display: false },
                    border: { display: false },
                    ticks: { color: PALETTE.textMuted, font: { size: 12, family: "'DM Mono',monospace" } }
                }
            }
        },
        plugins: [ChartDataLabels]
    });
}

// ----------------------------------------------------------------
// GRÁFICO BARRAS APILADAS — Evolución histórica por categoría
// ----------------------------------------------------------------
// Arma labels, datasets y el acceso a valores del stack. Lo usan el panel y
// el modal, así que la composición de la serie se define una sola vez.
function datosEvolucion(evolucion, tope = PALETTE.series.length) {
    const { periodos = [], datos = {} } = evolucion || {};
    if (!periodos.length) return null;

    const labels = periodos.map(p => formatearMes(p));

    // `tope - 1` categorías con slot propio + "Otros". El orden sale del
    // ranking histórico (construirMapaSeries), no del mes en pantalla, así
    // que las barras no se repintan al cambiar de mes; las más grandes van
    // abajo. El panel usa un tope más bajo que el modal: ocho segmentos con
    // sus huecos, en 130px de alto, leen como código de barras.
    const conDatos     = rankingCategorias.filter(c => periodos.some(p => datos[p]?.[c]));
    const conSlot      = conDatos.slice(0, tope - 1);
    const agrupadas    = conDatos.slice(tope - 1);
    const catOrdenadas = agrupadas.length ? [...conSlot, CAT_OTROS] : conSlot;

    const valorDe = (p, cat) => cat === CAT_OTROS
        ? agrupadas.reduce((s, c) => s + (datos[p]?.[c] || 0), 0)
        : (datos[p]?.[cat] || 0);

    const datasets = catOrdenadas.map((cat, idx) => {
        const color = colorCategoria(cat);
        const isTop = idx === catOrdenadas.length - 1;
        return {
            label:           cat,
            data:            periodos.map(p => valorDe(p, cat)),
            backgroundColor: color,
            // El separador entre segmentos es un hueco de 2px del color de la
            // superficie, no un borde alrededor de la marca: un trazo suma
            // tinta que no es dato. Mismo ancho en todo el stack.
            borderColor:     PALETTE.surface,
            borderWidth:     { top: 2, right: 0, bottom: 0, left: 0 },
            borderSkipped:   false,
            borderRadius:    isTop ? { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 } : 0,
            // Marca fina: la barra nunca llena la banda, el sobrante es aire.
            maxBarThickness: 24,
        };
    });

    return { labels, datasets, periodos, catOrdenadas, valorDe };
}

// ----------------------------------------------------------------
// GRÁFICO DE RITMO — cada ciclo medido a la misma altura que el actual
//
// Es la vista principal de la evolución: compara peras con peras. Graficar
// el total cerrado de los meses viejos contra un mes que va por la mitad
// sería la comparación tramposa que este gráfico existe para evitar.
//
// Forma: énfasis + polaridad. El mes que se está mirando es el sujeto y va
// en oro; los demás son contexto y toman el signo de la diferencia. La línea
// de referencia al nivel actual es lo que deja ver de un vistazo quién quedó
// arriba y quién abajo — va punteada a propósito, porque es un umbral; la
// grilla, que no lo es, queda en hairline sólida.
//
// Lo comparten el panel y el modal: misma lectura, distinto tamaño.
// ----------------------------------------------------------------
function construirChartRitmo(canvasId, rh, { compacto = false } = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const { meses, dia, base } = rh;
    const labels  = meses.map(m => formatearMes(m.mes));
    const valores = meses.map(m => m.total);

    // Verde = en aquel ciclo se gastaba MÁS que ahora (venís gastando menos).
    // Rojo = se gastaba menos. Oro = el mes que estás mirando.
    const colores = meses.map(m =>
        m.esActivo ? PALETTE.gold : (m.delta < 0 ? PALETTE.bueno : PALETTE.malo));

    const lineaBase = {
        id: 'lineaBase',
        afterDatasetsDraw(chart) {
            const { ctx, chartArea, scales } = chart;
            const y = scales.y.getPixelForValue(base);
            if (!isFinite(y)) return;
            ctx.save();
            ctx.setLineDash([5, 4]);
            ctx.lineWidth   = 1.5;
            ctx.strokeStyle = PALETTE.gold;
            ctx.beginPath();
            ctx.moveTo(chartArea.left, y);
            ctx.lineTo(chartArea.right, y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
            // El rótulo de la línea NO va sobre el canvas: se pisaba con la
            // etiqueta de variación de la última barra, que cae justo ahí
            // cuando ese mes anda cerca del nivel actual. Lo dice la nota de
            // arriba, que no puede chocarse con nada.
        },
    };

    return new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                label: `Consumo a día ${dia}`,
                data: valores,
                backgroundColor: colores,
                borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
                borderSkipped: false,
                maxBarThickness: compacto ? 22 : 34,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 600, easing: 'easeOutQuart' },
            layout: { padding: { top: compacto ? 20 : 28 } },  // aire para las etiquetas
            interaction: { mode: 'index', intersect: false },
            plugins: {
                // Una sola serie: el título ya dice qué se grafica, así que
                // una caja de leyenda con un swatch sólo gastaría lugar.
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: items => items[0]?.label ?? '',
                        label: item  => ` ${formatARS(item.raw)}`,
                        afterLabel: item => {
                            const m = meses[item.dataIndex];
                            if (m.esActivo)       return '  ← mes que estás mirando';
                            if (m.pct === null)   return '  sin base para comparar';
                            const signo = m.delta < 0 ? 'menos' : 'más';
                            return `  ahora gastás ${formatARS(Math.abs(m.delta))} ${signo} (${formatPct(Math.abs(m.pct))})`;
                        },
                    },
                },
                // Etiquetar todas las barras es correcto acá: la variación ES
                // la historia del gráfico, no un adorno sobre otra medida.
                // Usan los tokens de delta, no el color de la marca.
                datalabels: {
                    display: ctx => !meses[ctx.dataIndex].esActivo && meses[ctx.dataIndex].pct !== null,
                    anchor: 'end',
                    align: 'end',
                    offset: 2,
                    color: ctx => meses[ctx.dataIndex].delta < 0 ? PALETTE.bueno : PALETTE.malo,
                    font: { size: compacto ? 9 : 11, family: "'DM Mono', monospace", weight: '500' },
                    formatter: (_v, ctx) => {
                        const m = meses[ctx.dataIndex];
                        return `${m.delta < 0 ? '▼' : '▲'} ${formatPct(Math.abs(m.pct))}`;
                    },
                },
            },
            scales: {
                x: { grid: { display: false }, border: { display: false },
                     ticks: { color: PALETTE.textMuted, font: { size: compacto ? 10 : 11 } } },
                y: { beginAtZero: true, grid: { color: PALETTE.border }, border: { display: false },
                     ticks: { color: PALETTE.textMuted, font: { size: compacto ? 10 : 11 },
                              callback: v => formatARS(v, true),
                              maxTicksLimit: compacto ? 4 : 6 } },
            },
        },
        plugins: [lineaBase, ChartDataLabels],
    });
}

// Panel del bento. Muestra los últimos seis ciclos: con diez, las etiquetas
// de variación se pisan entre sí en 130px de alto. El modal tiene la historia
// completa, y el botón del panel lleva ahí.
function dibujarEvolucionPanel(rh) {
    if (chartEvo) { chartEvo.destroy(); chartEvo = null; }

    const nota = document.getElementById('evo-panel-nota');
    if (!rh || !rh.meses?.length) {
        if (nota) nota.textContent = '';
        return;
    }

    if (nota) {
        nota.textContent = rh.enCurso
            ? `día ${rh.dia} de ${rh.diasCiclo}`
            : `ciclo completo`;
    }

    chartEvo = construirChartRitmo('grafico-evolucion',
        { ...rh, meses: rh.meses.slice(-6) }, { compacto: true });
}

// ----------------------------------------------------------------
// MODAL DE EVOLUCIÓN — dos vistas, nunca mezcladas
//
// "Por categoría" es el stack de siempre, en grande. "Ritmo" responde otra
// pregunta: cuánto llevaba cada ciclo A LA MISMA ALTURA que el actual. Son
// magnitudes distintas (total cerrado vs. parcial comparable), así que van
// en vistas separadas y no en dos ejes del mismo gráfico — un doble eje
// inventa una relación que los datos no tienen.
// ----------------------------------------------------------------
let chartEvoModal  = null;
// El ritmo es la vista principal: el modal abre ahí y el stack por categoría
// queda como segunda lectura.
let vistaEvolucion = 'ritmo';

function abrirEvolucion() {
    const modal = document.getElementById('modal-evolucion');
    if (!modal || !datosActuales) return;
    modal.style.display = 'flex';
    renderVistaEvolucion();
}

function cerrarEvolucion() {
    const modal = document.getElementById('modal-evolucion');
    if (modal) modal.style.display = 'none';
    if (chartEvoModal) { chartEvoModal.destroy(); chartEvoModal = null; }
}

function cambiarVistaEvolucion(vista) {
    vistaEvolucion = vista;
    document.getElementById('evo-tab-categoria')?.setAttribute('aria-selected', String(vista === 'categoria'));
    document.getElementById('evo-tab-ritmo')?.setAttribute('aria-selected',     String(vista === 'ritmo'));
    renderVistaEvolucion();
}

function renderVistaEvolucion() {
    if (chartEvoModal) { chartEvoModal.destroy(); chartEvoModal = null; }
    if (vistaEvolucion === 'ritmo') dibujarEvoRitmo();
    else                            dibujarEvoCategorias();
}

// — Vista secundaria: el stack por categoría, en grande —
function dibujarEvoCategorias() {
    const d = datosEvolucion(datosActuales?.evolucion);
    if (!d) return;
    const { labels, datasets, periodos, catOrdenadas, valorDe } = d;

    document.getElementById('evo-nota').textContent =
        'Total facturado por mes, apilado por categoría. Incluye cuotas arrastradas.';

    chartEvoModal = new Chart(document.getElementById('grafico-evo-modal').getContext('2d'), {
        type: 'bar',
        data: { labels, datasets: datasets.map(ds => ({ ...ds, maxBarThickness: 34 })) },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    display: true, position: 'bottom',
                    labels: {
                        color: PALETTE.textMuted, font: { size: 11, family: 'DM Sans' },
                        boxWidth: 8, boxHeight: 8, borderRadius: 3, padding: 12, useBorderRadius: true,
                    },
                },
                tooltip: {
                    callbacks: {
                        label:  item => ` ${item.dataset.label}  ${formatARS(item.raw)}`,
                        footer: items => {
                            const i = items[0]?.dataIndex;
                            if (i === undefined) return '';
                            const t = catOrdenadas.reduce((s, c) => s + valorDe(periodos[i], c), 0);
                            return `Total  ${formatARS(t)}`;
                        },
                    },
                },
                datalabels: { display: false },
            },
            scales: {
                x: { stacked: true, grid: { display: false }, border: { display: false },
                     ticks: { color: PALETTE.textMuted, font: { size: 11 } } },
                y: { stacked: true, grid: { color: PALETTE.border }, border: { display: false },
                     ticks: { color: PALETTE.textMuted, font: { size: 11 },
                              callback: v => formatARS(v, true), maxTicksLimit: 6 } },
            },
        },
    });

    tablaEvolucion(periodos, catOrdenadas, valorDe);
}

// — Vista principal: el ritmo, cada ciclo medido a la misma altura —
function dibujarEvoRitmo() {
    const nota = document.getElementById('evo-nota');
    const rh   = datosActuales?.ritmoHistorico;

    if (!rh || !rh.meses?.length) {
        nota.textContent = 'No hay datos suficientes para comparar ciclos.';
        document.getElementById('evo-tabla-wrap').innerHTML = '';
        return;
    }

    const encabezado = rh.enCurso
        ? `Cuánto llevaba gastado cada ciclo a su día ${rh.dia} de ${rh.diasCiclo}, que es la altura en la que está ${formatearMes(rh.mesActivo)} hoy.`
        : `Consumo de cada ciclo completo (${rh.diasCiclo} días).`;

    nota.textContent = `${encabezado} La línea punteada marca ${formatearMes(rh.mesActivo)}: ` +
        `${formatARS(rh.base)}. Sólo consumo del ciclo: sin cuotas arrastradas ni créditos.`;

    chartEvoModal = construirChartRitmo('grafico-evo-modal', rh, { compacto: false });
    tablaRitmo(rh.meses);
}

// — Gemelos en tabla —
function tablaEvolucion(periodos, cats, valorDe) {
    const filas = periodos.map((p, i) => {
        const total = cats.reduce((s, c) => s + valorDe(p, c), 0);
        return `<tr><td>${formatearMes(p)}</td><td class="num">${formatARS(total)}</td></tr>`;
    }).join('');

    document.getElementById('evo-tabla-wrap').innerHTML = `
        <table class="tabla-elegante evo-tabla">
          <thead><tr><th>Mes</th><th class="num">Total facturado</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>`;
}

function tablaRitmo(meses) {
    const filas = meses.map(m => {
        const variacion = m.esActivo ? '—'
            : m.pct === null ? 's/base'
            : `${m.delta < 0 ? '−' : '+'}${formatPct(Math.abs(m.pct))}`;
        const clase = m.esActivo ? ' class="evo-fila-activa"' : '';
        return `<tr${clase}>
            <td>${formatearMes(m.mes)}</td>
            <td class="num">${formatARS(m.total)}</td>
            <td class="num">${variacion}</td>
        </tr>`;
    }).join('');

    document.getElementById('evo-tabla-wrap').innerHTML = `
        <table class="tabla-elegante evo-tabla">
          <thead><tr>
            <th>Mes</th><th class="num">Consumo al mismo día</th><th class="num">Variación de hoy</th>
          </tr></thead>
          <tbody>${filas}</tbody>
        </table>`;
}

// ----------------------------------------------------------------
// TABLA CUOTAS
// ----------------------------------------------------------------
function dibujarCuotas(cuotas) {
    // — Panel resumen —
    const totalEl = document.getElementById('cuotas-total-display');
    const cantEl  = document.getElementById('cuotas-cantidad-display');

    if (!cuotas.length) {
        if (totalEl) totalEl.textContent = '—';
        if (cantEl)  cantEl.textContent  = 'sin cuotas este mes';
    } else {
        const total    = cuotas.reduce((s, c) => s + c.monto, 0);
        const comercios = new Set(cuotas.map(c => c.comercio)).size;
        if (totalEl) totalEl.textContent = formatARS(total);
        if (cantEl)  cantEl.textContent  = `${comercios} comercio${comercios !== 1 ? 's' : ''} con cuotas`;
    }

    // — Modal tabla —
    const tbody = document.getElementById('cuerpo-cuotas');
    const tfoot = document.getElementById('pie-cuotas');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (tfoot) tfoot.innerHTML = '';

    if (!cuotas.length) {
        tbody.innerHTML = `<tr><td colspan="3" class="tabla-vacia">Sin cuotas pendientes este mes</td></tr>`;
        return;
    }

    let total = 0;
    cuotas.forEach(item => {
        total += item.monto;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="comercio-col">${item.comercio}</td>
            <td style="text-align:center;"><span class="cuota-badge">${item.cuota}</span></td>
            <td class="monto-tabla">${formatARS(item.monto)}</td>
        `;
        tbody.appendChild(tr);
    });

    if (tfoot) {
        tfoot.innerHTML = `
            <tr class="cuotas-total-row">
                <td colspan="2" class="cuotas-total-label">Total cuotas</td>
                <td class="monto-tabla cuotas-total-valor">${formatARS(total)}</td>
            </tr>
        `;
    }
}

// ----------------------------------------------------------------
// TABLA EXTRACTO DEL MES — con búsqueda, filtro y paginación
// ----------------------------------------------------------------
function dibujarExtracto(extracto) {
    // Guardar todos los movimientos para el filtrado posterior
    extractoTodos  = extracto;
    extractoPagina = 1;

    // Poblar el select de categorías
    poblarFiltroCategoriasExtracto(extracto);

    // Renderizar con los filtros actuales (vacíos al inicio)
    renderizarExtractoFiltrado();
}

function poblarFiltroCategoriasExtracto(extracto) {
    const select = document.getElementById('extracto-filtro-cat');
    if (!select) return;

    // Recolectar categorías únicas presentes en el extracto
    const cats = [...new Set(
        extracto.map(m => m.categoria || 'A Clasificar')
    )].sort();

    select.innerHTML = `<option value="">Todas las categorías</option>`;
    cats.forEach(cat => {
        const opt = document.createElement('option');
        opt.value       = cat;
        opt.textContent = cat;
        select.appendChild(opt);
    });
}

function renderizarExtractoFiltrado() {
    const tbody   = document.getElementById('cuerpo-extracto');
    const paginEl = document.getElementById('extracto-paginacion');
    const contador = document.getElementById('extracto-contador');
    if (!tbody) return;

    // Leer filtros actuales
    const textoBuscar  = (document.getElementById('extracto-buscar')?.value || '').trim().toLowerCase();
    const catFiltro    = (document.getElementById('extracto-filtro-cat')?.value || '');

    // Separar gastos y reintegros, mantener orden cronológico
    const gastos     = extractoTodos.filter(m => !m.es_reintegro);
    const reintegros = extractoTodos.filter(m =>  m.es_reintegro);
    let filtrados    = [...gastos, ...reintegros];

    // Aplicar filtro de texto
    if (textoBuscar) {
        filtrados = filtrados.filter(m => {
            const nombre = (m.comercio || m.comercio_crudo || '').toLowerCase();
            return nombre.includes(textoBuscar);
        });
    }

    // Aplicar filtro de categoría
    if (catFiltro) {
        filtrados = filtrados.filter(m =>
            (m.categoria || 'A Clasificar') === catFiltro
        );
    }

    // Actualizar contador
    if (contador) {
        contador.textContent = filtrados.length === extractoTodos.length
            ? `${filtrados.length} movimientos`
            : `${filtrados.length} de ${extractoTodos.length}`;
    }

    // Paginación
    const totalPaginas = Math.max(1, Math.ceil(filtrados.length / EXTRACTO_POR_PAGINA));
    if (extractoPagina > totalPaginas) extractoPagina = totalPaginas;

    const inicio  = (extractoPagina - 1) * EXTRACTO_POR_PAGINA;
    const pagina  = filtrados.slice(inicio, inicio + EXTRACTO_POR_PAGINA);

    // Renderizar filas
    tbody.innerHTML = '';

    if (!pagina.length) {
        tbody.innerHTML = `<tr><td colspan="5" class="tabla-vacia">${
            filtrados.length === 0 && extractoTodos.length > 0
                ? 'No hay movimientos que coincidan con el filtro'
                : 'Sin movimientos este mes'
        }</td></tr>`;
    } else {
        pagina.forEach(mov => {
            const nombre    = mov.comercio || mov.comercio_crudo;
            const categoria = mov.categoria || 'A Clasificar';
            const colorCat  = colorCategoria(categoria);

            const montoARS = mov.monto_ars !== null
                ? `<span class="${mov.es_reintegro ? 'monto-reintegro' : 'monto-tabla'}">${formatARS(mov.monto_ars)}</span>`
                : `<span style="color:var(--text-dim)">—</span>`;

            const montoUSD = mov.monto_usd !== null
                ? `<span class="monto-usd">u$s ${parseFloat(mov.monto_usd).toFixed(2)}</span>`
                : `<span style="color:var(--text-dim)">—</span>`;

            let cuotaInfo = '';
            if (mov.cuota_actual && mov.cuota_total) {
                cuotaInfo = ` <span class="cuota-badge">${mov.cuota_actual}/${mov.cuota_total}</span>`;
            }

            const tr = document.createElement('tr');
            if (mov.es_reintegro) tr.classList.add('fila-reintegro');

            tr.innerHTML = `
                <td class="fecha-col">${formatFecha(mov.fecha)}</td>
                <td class="comercio-col">${nombre}${cuotaInfo}</td>
                <td><span class="categoria-tag" style="--cat-color:${colorCat}">${categoria}</span></td>
                <td style="text-align:right;">${montoARS}</td>
                <td style="text-align:right;">${montoUSD}</td>
            `;
            tbody.appendChild(tr);
        });
    }

    // Renderizar paginación
    if (paginEl) {
        paginEl.innerHTML = '';
        if (totalPaginas > 1) {
            renderizarPaginacion(paginEl, extractoPagina, totalPaginas);
        }
    }
}

function renderizarPaginacion(contenedor, paginaActual, totalPaginas) {
    const crearBtn = (texto, pagina, esActivo = false, deshabilitado = false) => {
        const btn = document.createElement('button');
        btn.textContent = texto;
        btn.className   = `pag-btn${esActivo ? ' activo' : ''}`;
        btn.disabled    = deshabilitado;
        if (!deshabilitado && !esActivo) {
            btn.addEventListener('click', () => {
                extractoPagina = pagina;
                renderizarExtractoFiltrado();
                // Hacer scroll suave hacia la tabla
                document.getElementById('cuerpo-extracto')
                    ?.closest('.bento-caja')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
        }
        return btn;
    };

    // Botón anterior
    contenedor.appendChild(crearBtn('←', paginaActual - 1, false, paginaActual === 1));

    // Páginas (ventana de 5 páginas centrada en la actual)
    const VENTANA = 5;
    let inicio = Math.max(1, paginaActual - Math.floor(VENTANA / 2));
    let fin    = Math.min(totalPaginas, inicio + VENTANA - 1);
    if (fin - inicio + 1 < VENTANA) inicio = Math.max(1, fin - VENTANA + 1);

    if (inicio > 1) {
        contenedor.appendChild(crearBtn('1', 1));
        if (inicio > 2) {
            const sep = document.createElement('span');
            sep.className   = 'pag-info';
            sep.textContent = '…';
            contenedor.appendChild(sep);
        }
    }

    for (let p = inicio; p <= fin; p++) {
        contenedor.appendChild(crearBtn(String(p), p, p === paginaActual));
    }

    if (fin < totalPaginas) {
        if (fin < totalPaginas - 1) {
            const sep = document.createElement('span');
            sep.className   = 'pag-info';
            sep.textContent = '…';
            contenedor.appendChild(sep);
        }
        contenedor.appendChild(crearBtn(String(totalPaginas), totalPaginas));
    }

    // Botón siguiente
    contenedor.appendChild(crearBtn('→', paginaActual + 1, false, paginaActual === totalPaginas));

    // Info de página
    const info = document.createElement('span');
    info.className   = 'pag-info';
    info.textContent = `Pág ${paginaActual}/${totalPaginas}`;
    contenedor.appendChild(info);
}

// ----------------------------------------------------------------
// EVENTOS DE UI
// ----------------------------------------------------------------
function bindEventos() {
    // Login con Google
    document.getElementById('btn-google')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-google');
        btn.disabled = true;
        btn.textContent = 'Redirigiendo...';
        try {
            await DB.loginConGoogle();
        } catch (err) {
            btn.disabled = false;
            btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" fill="#34A853"/><path d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.962L3.964 6.294C4.672 4.167 6.656 3.58 9 3.58z" fill="#EA4335"/></svg> Continuar con Google`;
            document.getElementById('login-mensaje').textContent = `Error: ${err.message}`;
        }
    });

    // Login form
    document.getElementById('form-login')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email  = document.getElementById('input-email').value.trim();
        const btn    = document.getElementById('btn-login');
        const msg    = document.getElementById('login-mensaje');

        if (!email) return;

        btn.disabled     = true;
        btn.textContent  = 'Enviando...';
        msg.textContent  = '';

        try {
            await DB.enviarMagicLink(email);
            msg.textContent = '¡Link enviado! Revisá tu email y hacé click en el enlace.';
            msg.className   = 'login-success';
        } catch (err) {
            msg.textContent = `Error: ${err.message}`;
            msg.className   = 'login-error';
            btn.disabled    = false;
            btn.textContent = 'Enviar link de acceso';
        }
    });

    // Selector de mes
    document.getElementById('selector-mes')?.addEventListener('change', (e) => {
        cargarMes(e.target.value);
    });

    // Selector del mes contra el que compara el panel de ritmo
    document.getElementById('ritmo-vs')?.addEventListener('change', (e) => {
        cambiarMesComparacion(e.target.value);
    });

    // Modal de evolución histórica
    document.getElementById('btn-ver-evolucion')?.addEventListener('click', abrirEvolucion);
    document.getElementById('btn-cerrar-evolucion')?.addEventListener('click', cerrarEvolucion);
    document.getElementById('evo-tab-categoria')?.addEventListener('click', () => cambiarVistaEvolucion('categoria'));
    document.getElementById('evo-tab-ritmo')?.addEventListener('click',     () => cambiarVistaEvolucion('ritmo'));
    document.getElementById('modal-evolucion')?.addEventListener('click', (e) => {
        if (e.target.id === 'modal-evolucion') cerrarEvolucion();
    });

    // Botón subir archivo
    document.getElementById('btn-subir')?.addEventListener('click', () => {
        document.getElementById('input-archivo').click();
    });

    // Input file
    document.getElementById('input-archivo')?.addEventListener('change', manejarSubidaArchivo);

    // Botón clasificar
    document.getElementById('btn-clasificar')?.addEventListener('click', abrirModalClasificar);

    // Botón migrar desde Sheets
    document.getElementById('btn-migrar')?.addEventListener('click', ejecutarMigracion);

    // Botón de tema
    document.getElementById('btn-tema')?.addEventListener('click', toggleTema);

    // Botón cerrar sesión
    document.getElementById('btn-logout')?.addEventListener('click', async () => {
        await DB.cerrarSesion();
    });

    // Extracto — búsqueda en tiempo real
    document.getElementById('extracto-buscar')?.addEventListener('input', () => {
        extractoPagina = 1;
        renderizarExtractoFiltrado();
    });

    // Extracto — filtro por categoría
    document.getElementById('extracto-filtro-cat')?.addEventListener('change', () => {
        extractoPagina = 1;
        renderizarExtractoFiltrado();
    });

    // Modal extracto — abrir / cerrar
    document.getElementById('btn-ver-extracto')?.addEventListener('click', abrirExtracto);
    document.getElementById('btn-cerrar-extracto')?.addEventListener('click', cerrarExtracto);
    document.getElementById('modal-extracto')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) cerrarExtracto();
    });

    // Modal top 10 — abrir / cerrar
    document.getElementById('btn-ver-top10')?.addEventListener('click', abrirTop10);
    document.getElementById('btn-cerrar-top10')?.addEventListener('click', cerrarTop10);
    document.getElementById('modal-top10')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) cerrarTop10();
    });

    // Modal cuotas — abrir / cerrar
    document.getElementById('btn-ver-cuotas')?.addEventListener('click', abrirCuotas);
    document.getElementById('btn-cerrar-cuotas')?.addEventListener('click', cerrarCuotas);
    document.getElementById('modal-cuotas')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) cerrarCuotas();
    });

    // Los timeouts no son confiables como única fuente para la cuenta de días:
    // si la máquina se suspende o el navegador throttlea la pestaña en segundo
    // plano, el de medianoche puede dispararse tarde. Al volver a primer plano
    // se recalcula, y eso además reprograma el siguiente.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) dibujarCierre();
    });

    // ESC cierra modales
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (document.getElementById('modal-extracto')?.style.display === 'flex') {
            cerrarExtracto();
        } else if (document.getElementById('modal-top10')?.style.display === 'flex') {
            cerrarTop10();
        } else if (document.getElementById('modal-cuotas')?.style.display === 'flex') {
            cerrarCuotas();
        } else if (document.getElementById('modal-evolucion')?.style.display === 'flex') {
            cerrarEvolucion();
        } else if (document.getElementById('modal-clasificar')?.style.display === 'flex') {
            cerrarModal();
        }
    });
}

function abrirTop10() {
    document.getElementById('modal-top10').style.display = 'flex';
    dibujarBarrasModal();
}

function cerrarTop10() {
    document.getElementById('modal-top10').style.display = 'none';
}

function abrirCuotas() {
    document.getElementById('modal-cuotas').style.display = 'flex';
}

function cerrarCuotas() {
    document.getElementById('modal-cuotas').style.display = 'none';
}

function abrirExtracto() {
    document.getElementById('modal-extracto').style.display = 'flex';
}

function cerrarExtracto() {
    document.getElementById('modal-extracto').style.display = 'none';
}

// ----------------------------------------------------------------
// SUBIDA DE ARCHIVO — paso 1: parsear y mostrar confirmación
// ----------------------------------------------------------------
async function manejarSubidaArchivo(evento) {
    const file = evento.target.files[0];
    if (!file) return;

    evento.target.value = ''; // reset para permitir reseleccionar el mismo archivo

    const boton = document.getElementById('btn-subir');
    boton.textContent = 'Procesando...';
    boton.disabled    = true;

    try {
        const movimientos = await Parser.parsearArchivo(file);

        if (!movimientos.length) {
            alert('No se encontraron movimientos válidos en el archivo.');
            boton.textContent = 'Subir Resumen';
            boton.disabled    = false;
            return;
        }

        movimientosPendientes = movimientos;
        mesesConDataActual    = await DB.obtenerMeses();
        mostrarConfirmacionImport(movimientos[0].mes_periodo);
        // El botón queda deshabilitado hasta que se confirme o cancele

    } catch (err) {
        console.error('Error al leer el archivo:', err);
        alert(`Error al leer el archivo: ${err.message}`);
        boton.textContent = 'Subir Resumen';
        boton.disabled    = false;
    }
}

// ----------------------------------------------------------------
// SUBIDA DE ARCHIVO — paso 2: modal de confirmación
// ----------------------------------------------------------------
function mostrarConfirmacionImport(mesDetectado) {
    const input    = document.getElementById('import-select-mes');
    const cantidad = document.getElementById('import-cantidad');

    input.value = mesDetectado;
    cantidad.textContent = movimientosPendientes.length;

    actualizarAdvertenciaImport();
    input.oninput = actualizarAdvertenciaImport;

    document.getElementById('modal-confirmar-import').style.display = 'flex';
}

function actualizarAdvertenciaImport() {
    const mesSel     = document.getElementById('import-select-mes').value;
    const adv        = document.getElementById('import-advertencia');
    if (mesesConDataActual.includes(mesSel)) {
        adv.querySelector('.import-adv-mes').textContent = formatearMes(mesSel);
        adv.style.display = 'flex';
    } else {
        adv.style.display = 'none';
    }

    // Aviso extra si el mes destino abarca dos cierres de tarjeta
    const col = document.getElementById('import-colision');
    if (col && typeof Ciclos !== 'undefined' && mesSel) {
        const cierre  = Ciclos.cierreDe(`${mesSel}-15`);
        const colision = cierre && Ciclos.hayColision(cierre);
        if (colision) {
            document.getElementById('import-colision-mes').textContent = formatearMes(mesSel);
        }
        col.style.display = colision ? 'flex' : 'none';
    }
}

async function confirmarImportacion() {
    const mesSeleccionado = document.getElementById('import-select-mes').value;
    const btnConfirmar    = document.getElementById('btn-confirmar-import');

    btnConfirmar.disabled     = true;
    btnConfirmar.textContent  = 'Importando...';

    try {
        movimientosPendientes.forEach(m => { m.mes_periodo = mesSeleccionado; });

        const resultado = await DB.importarMovimientos(movimientosPendientes);

        cancelarImportacion();

        document.getElementById('banner-migracion')?.style.setProperty('display', 'none');
        await arrancarDashboard();

    } catch (err) {
        console.error('Error al importar:', err);
        alert(`Error al importar el archivo: ${err.message}`);
        btnConfirmar.disabled    = false;
        btnConfirmar.textContent = 'Importar';
    }
}

function cancelarImportacion() {
    movimientosPendientes = null;
    mesesConDataActual    = [];
    document.getElementById('modal-confirmar-import').style.display = 'none';
    const boton = document.getElementById('btn-subir');
    boton.textContent = 'Subir Resumen';
    boton.disabled    = false;
}

// ----------------------------------------------------------------
// MODAL DE CLASIFICACIÓN
// ----------------------------------------------------------------
async function abrirModalClasificar() {
    const overlay   = document.getElementById('modal-clasificar');
    const contenedor = document.getElementById('contenido-modal');
    overlay.style.display = 'flex';

    contenedor.innerHTML = `<p class="modal-cargando">Escaneando comercios sin clasificar...</p>`;

    try {
        const [pendientes, categorias] = await Promise.all([
            DB.obtenerPendientes(),
            DB.obtenerCategorias(),
        ]);

        if (!pendientes.length) {
            contenedor.innerHTML = `
                <p style="text-align:center; font-family:var(--font-display);
                   font-size:1.3rem; color:var(--green); padding:32px 0;">
                    Todo clasificado — sin pendientes.
                </p>`;
            return;
        }

        let opcionesCat = `<option value="">— Seleccionar —</option>`;
        categorias.forEach(cat => {
            const nombre = cat.nombre ?? cat;
            opcionesCat += `<option value="${nombre}">${nombre}</option>`;
        });

        let html = `
            <table class="tabla-elegante" id="tabla-pendientes">
                <thead>
                    <tr>
                        <th>Nombre Original</th>
                        <th>Nombre Limpio</th>
                        <th>Categoría</th>
                    </tr>
                </thead>
                <tbody>`;

        pendientes.forEach(item => {
            html += `
                <tr data-cruda="${item.cruda}">
                    <td class="fecha-col" style="max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
                        title="${item.cruda}">${item.cruda}</td>
                    <td><input type="text" class="input-sugerencia" value="${item.limpia}"></td>
                    <td><select class="select-categoria">${opcionesCat}</select></td>
                </tr>`;
        });

        html += `</tbody></table>
            <button id="btn-guardar-clasif" class="btn-accion"
                    style="width:100%; margin-top:20px;">
                Guardar Clasificaciones
            </button>`;

        contenedor.innerHTML = html;
        document.getElementById('btn-guardar-clasif').addEventListener('click', guardarClasificaciones);

    } catch (err) {
        contenedor.innerHTML = `<p style="color:var(--red); text-align:center; padding:24px;">
            Error: ${err.message}</p>`;
    }
}

function cerrarModal() {
    document.getElementById('modal-clasificar').style.display = 'none';
}

async function guardarClasificaciones() {
    const filas  = document.querySelectorAll('#tabla-pendientes tbody tr');
    const reglas = [];

    filas.forEach(fila => {
        const clave        = fila.dataset.cruda;
        const nombreLimpio = fila.querySelector('.input-sugerencia').value.trim();
        const categoria    = fila.querySelector('.select-categoria').value;
        if (categoria && nombreLimpio) {
            reglas.push({ clave, nombreLimpio, categoria });
        }
    });

    if (!reglas.length) {
        alert('No hay clasificaciones para guardar.');
        return;
    }

    const boton = document.getElementById('btn-guardar-clasif');
    boton.textContent = 'Guardando...';
    boton.disabled    = true;

    try {
        await DB.guardarVariasClasificaciones(reglas);
        alert(`✅ ${reglas.length} clasificaciones guardadas.`);
        cerrarModal();
        await cargarMes(mesActivo);
    } catch (err) {
        alert(`Error al guardar: ${err.message}`);
        boton.textContent = 'Guardar Clasificaciones';
        boton.disabled    = false;
    }
}

// ----------------------------------------------------------------
// MIGRACIÓN DESDE GOOGLE SHEETS
// ----------------------------------------------------------------
async function ejecutarMigracion() {
    const btn         = document.getElementById('btn-migrar');
    const msg         = document.getElementById('migracion-estado');
    const progresoWrap = document.getElementById('migracion-progreso-wrap');
    const barra       = document.getElementById('migracion-barra');

    btn.disabled    = true;
    btn.textContent = 'Migrando...';

    // Mostrar barra de progreso
    if (progresoWrap) progresoWrap.style.display = 'block';
    if (barra) barra.style.width = '5%';

    const actualizarProgreso = (texto) => {
        if (msg) msg.textContent = texto;

        // Parsear porcentaje del texto si viene como "Importando... 45%"
        const match = texto.match(/(\d+)%/);
        if (match && barra) {
            barra.style.width = `${match[1]}%`;
        } else if (texto.includes('Descargando') && barra) {
            barra.style.width = '10%';
        } else if (texto.includes('Procesando') && barra) {
            barra.style.width = '25%';
        } else if (texto.includes('Importando') && !match && barra) {
            barra.style.width = '35%';
        } else if (texto.includes('completada') && barra) {
            barra.style.width = '100%';
        }
    };

    try {
        const resultado = await DB.migrarDesdeSheets(actualizarProgreso);

        if (barra) barra.style.width = '100%';
        if (msg) msg.textContent =
            `Migración exitosa: ${resultado.insertados} movimientos importados, ` +
            `${resultado.clasificaciones} reglas de clasificación recuperadas.`;

        // Esperar un momento para mostrar el 100% antes de ocultar
        await new Promise(r => setTimeout(r, 1200));

        document.getElementById('banner-migracion').style.display = 'none';
        await arrancarDashboard();

    } catch (err) {
        console.error('Error en migración:', err);
        if (barra) { barra.style.width = '0%'; barra.style.background = 'var(--red)'; }
        if (msg) msg.textContent = `Error: ${err.message}`;
        btn.disabled    = false;
        btn.textContent = 'Migrar desde Google Sheets';
    }
}

// ----------------------------------------------------------------
// UTILIDADES
// ----------------------------------------------------------------
function formatARS(valor, abreviado = false) {
    if (valor === null || valor === undefined) return '—';
    const n = parseFloat(valor);
    if (isNaN(n)) return '—';
    if (abreviado) {
        if (Math.abs(n) >= 1_000_000) return `$${(n/1_000_000).toFixed(1)}M`;
        if (Math.abs(n) >= 1_000)     return `$${(n/1_000).toFixed(0)}k`;
        return `$${n}`;
    }
    return '$ ' + n.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// 23.42 → '23,4%'. Arriba de 100% la decimal es ruido, se recorta.
function formatPct(valor) {
    const dec = Math.abs(valor) >= 100 ? 0 : 1;
    return valor.toLocaleString('es-AR', {
        minimumFractionDigits: dec, maximumFractionDigits: dec,
    }) + '%';
}

function formatearMes(periodo) {
    const [y, m] = periodo.split('-');
    const meses  = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
    return `${meses[parseInt(m, 10) - 1]} ${y}`;
}

function formatFecha(fechaISO) {
    // '2026-03-14' → '14/03'
    if (!fechaISO) return '';
    const [, m, d] = fechaISO.split('-');
    return `${d}/${m}`;
}

function mostrarSkeletons() {
    const skel = (cls) => `<span class="skeleton ${cls}"></span>`;
    ['val-total', 'val-total-usd', 'val-movimientos'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = skel('skeleton-kpi');
    });
}

function ocultarSkeletons() {
    document.getElementById('val-total').textContent       = '—';
    document.getElementById('val-total-usd').textContent   = '—';
    document.getElementById('val-movimientos').textContent = '0';
}

function mostrarError(msg) {
    console.error(msg);
    document.getElementById('val-total').textContent = 'Error';
}
