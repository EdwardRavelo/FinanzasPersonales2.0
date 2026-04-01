// ================================================================
// APP.JS — Orquestador principal
// Sin Google Apps Script. Usa DB.js (Supabase) + Parser.js
// ================================================================

// ----------------------------------------------------------------
// ESTADO GLOBAL
// ----------------------------------------------------------------
let mesActivo        = null;
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

// ----------------------------------------------------------------
// PALETA Y CONFIG GLOBAL DE CHART.JS
// ----------------------------------------------------------------
const PALETTE = {
    gold:      '#c9a96e',
    goldDim:   'rgba(201,169,110,0.15)',
    cyan:      '#4fc3c3',
    green:     '#5ecf8c',
    textMuted: '#5e7080',
    textMain:  '#eef2f7',
    border:    'rgba(255,255,255,0.06)',
    donut: [
        '#c9a96e','#4fc3c3','#5ecf8c','#a78bfa',
        '#fb7185','#fbbf24','#60a5fa','#34d399',
        '#f472b6','#38bdf8','#a3e635','#fb923c',
        '#e879f9','#94a3b8',
    ],
};

Chart.defaults.color                         = PALETTE.textMuted;
Chart.defaults.font.family                   = "'DM Mono', monospace";
Chart.defaults.font.size                     = 11;
Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(8,12,18,0.95)';
Chart.defaults.plugins.tooltip.borderColor   = 'rgba(201,169,110,0.3)';
Chart.defaults.plugins.tooltip.borderWidth   = 1;
Chart.defaults.plugins.tooltip.titleColor    = PALETTE.gold;
Chart.defaults.plugins.tooltip.bodyColor     = PALETTE.textMain;
Chart.defaults.plugins.tooltip.padding       = 12;
Chart.defaults.plugins.tooltip.cornerRadius  = 8;
Chart.defaults.plugins.tooltip.titleFont     = { family:"'DM Mono',monospace", size:11, weight:'500' };
Chart.defaults.plugins.tooltip.bodyFont      = { family:"'Playfair Display',serif", size:15, weight:'700' };

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
    dibujarKPIs(datos.kpis);
    dibujarDonut(datos.distribucion);
    dibujarBarras(datos.top10);
    dibujarEvolucion(datos.evolucion, datos.categorias);
    dibujarCuotas(datos.cuotas);
    dibujarExtracto(datos.extracto);
}

// ----------------------------------------------------------------
// KPIs
// ----------------------------------------------------------------
function dibujarKPIs(kpis) {
    document.getElementById('val-total').textContent =
        formatARS(kpis.totalARS);
    document.getElementById('val-total-usd').textContent =
        kpis.totalUSD > 0 ? `u$s ${kpis.totalUSD.toFixed(2)}` : '';
    document.getElementById('val-movimientos').textContent =
        `${kpis.cantidadMovimientos} movimientos`;
}

// ----------------------------------------------------------------
// GRÁFICO DONUT — Distribución por categoría
// ----------------------------------------------------------------
function dibujarDonut(distribucion) {
    const labels = distribucion.map(d => d.categoria);
    const values = distribucion.map(d => d.total);
    const total  = values.reduce((a, b) => a + b, 0);

    if (chartTorta) chartTorta.destroy();

    const pluginTextoCenter = {
        id: 'textoCenter',
        afterDraw(chart) {
            const { ctx, chartArea: { width, height, left, top } } = chart;
            const cx = left + width  / 2;
            const cy = top  + height / 2;
            ctx.save();
            ctx.font         = `700 16px 'Playfair Display', serif`;
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
                data: values,
                backgroundColor: PALETTE.donut.slice(0, labels.length),
                borderWidth: 2,
                borderColor: '#080c12',
                hoverBorderWidth: 0,
                hoverOffset: 8,
                spacing: 2,
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
                        padding: 12, color: PALETTE.textMuted,
                        font: { size: 11, family: "'DM Mono',monospace" },
                    }
                },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.label}: ${formatARS(ctx.raw)}`
                    }
                }
            }
        },
        plugins: [pluginTextoCenter]
    });
}

// ----------------------------------------------------------------
// GRÁFICO BARRAS — Top 10 comercios
// ----------------------------------------------------------------
function dibujarBarras(top10) {
    const labels = top10.map(t => t.comercio);
    const values = top10.map(t => t.total);
    const maxVal = Math.max(...values, 1);

    const colores = values.map((_, i) => {
        const alpha = 0.9 - (i / values.length) * 0.5;
        return `rgba(201,169,110,${alpha})`;
    });

    if (chartTop) chartTop.destroy();

    chartTop = new Chart(document.getElementById('grafico-top'), {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data: values,
                backgroundColor: colores,
                borderRadius: 4,
                borderSkipped: 'left',
                barThickness: 11,
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 800, easing: 'easeOutQuart' },
            layout: { padding: { right: 70 } },
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
                    font: { size: 10, family: "'DM Mono',monospace" },
                    formatter: val => formatARS(val),
                    offset: 4,
                }
            },
            scales: {
                x: { display: false, grid: { display: false }, max: maxVal * 1.35 },
                y: {
                    grid: { display: false },
                    border: { display: false },
                    ticks: {
                        color: PALETTE.textMuted,
                        font: { size: 11, family: "'DM Mono',monospace" },
                    }
                }
            }
        },
        plugins: [ChartDataLabels]
    });
}

// ----------------------------------------------------------------
// GRÁFICO BARRAS APILADAS — Evolución histórica por categoría
// ----------------------------------------------------------------
function dibujarEvolucion(evolucion, categorias = []) {
    if (chartEvo) chartEvo.destroy();

    const { periodos = [], datos = {} } = evolucion;
    if (!periodos.length) return;

    const labels = periodos.map(p => formatearMes(p));

    // Mapa nombre → color desde categorías del usuario
    const colorMap = {};
    (categorias || []).forEach(c => { colorMap[c.nombre] = c.color; });

    // Recopilar todas las categorías que aparecen en los datos
    const catSet = new Set();
    periodos.forEach(p => { Object.keys(datos[p] || {}).forEach(c => catSet.add(c)); });

    // Ordenar por gasto total descendente (las más grandes quedan abajo en el stack)
    const catOrdenadas = [...catSet].sort((a, b) => {
        const totalA = periodos.reduce((s, p) => s + (datos[p]?.[a] || 0), 0);
        const totalB = periodos.reduce((s, p) => s + (datos[p]?.[b] || 0), 0);
        return totalB - totalA;
    });

    const fallbacks = ['#6366f1','#f59e0b','#06b6d4','#ec4899','#84cc16',
                       '#f97316','#8b5cf6','#10b981','#ef4444','#a78bfa'];
    let fi = 0;
    const getColor = nombre => colorMap[nombre] || fallbacks[fi++ % fallbacks.length];

    const datasets = catOrdenadas.map((cat, idx) => {
        const color  = getColor(cat);
        const isTop  = idx === catOrdenadas.length - 1;
        const isBot  = idx === 0;
        return {
            label:                cat,
            data:                 periodos.map(p => datos[p]?.[cat] || 0),
            backgroundColor:      color + '20',
            hoverBackgroundColor: color + '50',
            borderColor:          color + 'dd',
            borderWidth:          1,
            borderSkipped:        false,
            // Redondeado arriba en el tope, abajo en la base, 3px en el resto
            borderRadius: isTop && isBot ? 4
                : isTop  ? { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 }
                : isBot  ? { topLeft: 0, topRight: 0, bottomLeft: 4, bottomRight: 4 }
                : 0,
        };
    });

    // Plugin: scale 1.05× en el segmento hovereado
    const pluginHoverScale = {
        id: 'hoverScale',
        afterDatasetsDraw(chart) {
            const active = chart.tooltip?._active;
            if (!active?.length) return;

            const { datasetIndex, index } = active[0];
            const dataset = chart.data.datasets[datasetIndex];
            const meta    = chart.getDatasetMeta(datasetIndex);
            const bar     = meta.data[index];
            if (!bar) return;

            const { ctx: c } = chart;
            const { x, y, base } = bar.getProps(['x', 'y', 'base'], true);
            const cy = (y + base) / 2;

            // Guardar el color original y subir opacidad para el redibujado escalado
            const origBg = bar.options.backgroundColor;
            bar.options.backgroundColor = dataset.hoverBackgroundColor;

            c.save();
            c.translate(x, cy);
            c.scale(1.06, 1.04);
            c.translate(-x, -cy);
            bar.draw(c);
            c.restore();

            bar.options.backgroundColor = origBg;
        },
    };

    // Plugin: halo vertical tenue en la columna activa
    const pluginColumnGlow = {
        id: 'columnGlow',
        afterDraw(chart) {
            const active = chart.tooltip?._active;
            if (!active?.length) return;
            const { ctx: c, chartArea: { top, bottom } } = chart;
            const el = active[0].element;
            const w  = el.width * 1.6;
            c.save();
            const grd = c.createLinearGradient(el.x - w, 0, el.x + w, 0);
            grd.addColorStop(0,   'rgba(255,255,255,0)');
            grd.addColorStop(0.5, 'rgba(255,255,255,0.04)');
            grd.addColorStop(1,   'rgba(255,255,255,0)');
            c.fillStyle = grd;
            c.fillRect(el.x - w / 2, top, w, bottom - top);
            c.restore();
        },
    };

    const ctx = document.getElementById('grafico-evolucion').getContext('2d');
    chartEvo = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive:          true,
            maintainAspectRatio: false,
            animation:           { duration: 600, easing: 'easeOutQuart' },
            interaction:         { mode: 'nearest', intersect: true },
            categoryPercentage:  0.52,
            barPercentage:       1.0,
            plugins: {
                legend: {
                    display:  true,
                    position: 'bottom',
                    labels: {
                        color:           PALETTE.textMuted,
                        font:            { size: 10, family: 'DM Sans' },
                        boxWidth:        8,
                        boxHeight:       8,
                        borderRadius:    3,
                        padding:         10,
                        useBorderRadius: true,
                    },
                },
                tooltip: {
                    mode:            'nearest',
                    intersect:       true,
                    backgroundColor: 'rgba(8,12,18,0.92)',
                    borderColor:     'rgba(255,255,255,0.08)',
                    borderWidth:     1,
                    padding:         { x: 14, y: 10 },
                    cornerRadius:    10,
                    displayColors:   true,
                    boxWidth:        8,
                    boxHeight:       8,
                    titleColor:      PALETTE.textMuted,
                    titleFont:       { size: 11, family: 'DM Sans' },
                    bodyColor:       PALETTE.textMain,
                    bodyFont:        { size: 13, family: 'DM Mono', weight: '500' },
                    callbacks: {
                        title:      items => items[0]?.label ?? '',
                        label:      item  => ` ${item.dataset.label}`,
                        afterLabel: item  => `  ${formatARS(item.raw)}`,
                    },
                },
                datalabels: { display: false },
            },
            scales: {
                x: {
                    stacked: true,
                    grid:    { display: false },
                    border:  { display: false },
                    ticks:   { color: PALETTE.textMuted, font: { size: 10 } },
                },
                y: {
                    stacked: true,
                    grid:    { color: PALETTE.border },
                    border:  { display: false },
                    ticks:   {
                        color:         PALETTE.textMuted,
                        font:          { size: 10 },
                        callback:      val => formatARS(val, true),
                        maxTicksLimit: 5,
                    },
                },
            },
        },
        plugins: [pluginColumnGlow, pluginHoverScale],
    });
}

// ----------------------------------------------------------------
// TABLA CUOTAS
// ----------------------------------------------------------------
function dibujarCuotas(cuotas) {
    const tbody = document.getElementById('cuerpo-cuotas');
    tbody.innerHTML = '';

    if (!cuotas.length) {
        tbody.innerHTML = `<tr><td colspan="3" class="tabla-vacia">Sin cuotas pendientes este mes</td></tr>`;
        return;
    }

    cuotas.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="comercio-col">${item.comercio}</td>
            <td style="text-align:center;"><span class="cuota-badge">${item.cuota}</span></td>
            <td class="monto-tabla">${formatARS(item.monto)}</td>
        `;
        tbody.appendChild(tr);
    });
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
            const colorCat  = obtenerColorCategoria(categoria);

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

function obtenerColorCategoria(categoria) {
    const cat = CATEGORIAS_DEFAULT?.find(c =>
        c.nombre.toLowerCase() === categoria.toLowerCase()
    );
    return cat?.color || '#475569';
}

function mostrarSkeletons() {
    const skel = (cls) => `<span class="skeleton ${cls}"></span>`;
    const elTotal = document.getElementById('val-total');
    const elUsd   = document.getElementById('val-total-usd');
    const elMov   = document.getElementById('val-movimientos');
    if (elTotal) elTotal.innerHTML       = skel('skeleton-kpi');
    if (elUsd)   elUsd.innerHTML         = skel('skeleton-sub');
    if (elMov)   elMov.innerHTML         = skel('skeleton-sub');
}

function ocultarSkeletons() {
    document.getElementById('val-total').textContent       = '—';
    document.getElementById('val-total-usd').textContent   = '';
    document.getElementById('val-movimientos').textContent = 'Sin datos aún';
}

function mostrarError(msg) {
    console.error(msg);
    document.getElementById('val-total').textContent = 'Error';
}
