// ================================================================
// PARSER.JS — Parseo del .xlsx del banco
// Soporta ambos formatos: nuevo (4 col) y viejo (6 col)
// ================================================================

const Parser = (() => {

    // ----------------------------------------------------------------
    // CARGOS BANCARIOS a filtrar (se importan como "Cargos Bancarios")
    // ----------------------------------------------------------------
    const PATRONES_CARGOS_BANCARIOS = [
        /^IMP DE SELLOS/i,
        /^DB IVA/i,
        /^IVA SERV\.DIGITAL/i,
        /^INTERESES FINANCIACION/i,
        /^PERC\. IB SERV\. DIGITALES/i,
        /^PERCEPCI[OÓ]N AFIP/i,
        /^CR\. RG 5463/i,
        /^CR\.RG 5617/i,
        /^CR PESOS P\/DEVOLUCION/i,
    ];

    // ----------------------------------------------------------------
    // CARGOS A IGNORAR COMPLETAMENTE (pagos del resumen, etc.)
    // ----------------------------------------------------------------
    const PATRONES_IGNORAR = [
        /^SU PAGO EN PESOS/i,
        /^SU PAGO EN USD/i,
        /^Total Tarjeta/i,
        /^Monto total de los Movimientos/i,
    ];

    // ----------------------------------------------------------------
    // Detectar si un nombre es cargo bancario
    // ----------------------------------------------------------------
    function esCargoBancario(nombre) {
        return PATRONES_CARGOS_BANCARIOS.some(p => p.test(nombre));
    }

    function debeIgnorar(nombre) {
        return PATRONES_IGNORAR.some(p => p.test(nombre));
    }

    // ----------------------------------------------------------------
    // Parsear fecha en múltiples formatos → 'YYYY-MM-DD'
    // Formatos soportados: DD/MM/YY, DD/MM/YYYY
    // ----------------------------------------------------------------
    function parsearFecha(str) {
        if (!str) return null;
        str = String(str).trim();

        // DD/MM/YY o DD/MM/YYYY
        const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
        if (!m) return null;

        let [, d, mo, y] = m;
        d  = d.padStart(2, '0');
        mo = mo.padStart(2, '0');

        // Año de 2 dígitos: 26 → 2026
        if (y.length === 2) {
            const n = parseInt(y, 10);
            y = (n >= 0 && n <= 50) ? `20${y}` : `19${y}`;
        }

        return `${y}-${mo}-${d}`;
    }

    // ----------------------------------------------------------------
    // Parsear monto de texto del banco → { ars, usd, esReintegro }
    // Formatos:
    //   Nuevo xlsx: "$ 9.400,00" / "USD 20,00" / "$ -963.439,11"
    //   Viejo xlsx: "9.400,00" / "550,40" (columnas separadas)
    // ----------------------------------------------------------------
    function parsearMonto(str) {
        if (!str && str !== 0) return { ars: null, usd: null, esReintegro: false };

        str = String(str).trim();

        // Detectar moneda
        const esUSD = /^USD\s/i.test(str);

        // Limpiar: quitar "$ ", "USD ", puntos de miles, convertir coma decimal
        let limpio = str
            .replace(/^USD\s*/i, '')
            .replace(/^\$\s*/,   '')
            .replace(/\./g, '')      // quitar separador de miles
            .replace(',', '.')       // coma decimal → punto
            .trim();

        const valor = parseFloat(limpio);
        if (isNaN(valor)) return { ars: null, usd: null, esReintegro: false };

        const esReintegro = valor < 0;

        return {
            ars:         esUSD ? null : valor,
            usd:         esUSD ? Math.abs(valor) : null,
            esReintegro,
        };
    }

    // ----------------------------------------------------------------
    // Parsear cuota → { cuotaActual, cuotaTotal }
    // Formatos: "02/03", "-", "/", ""
    // ----------------------------------------------------------------
    function parsearCuota(str) {
        if (!str) return { cuotaActual: null, cuotaTotal: null };
        str = String(str).trim();

        const m = str.match(/^(\d+)\/(\d+)$/);
        if (m) {
            return {
                cuotaActual: parseInt(m[1], 10),
                cuotaTotal:  parseInt(m[2], 10),
            };
        }
        return { cuotaActual: null, cuotaTotal: null };
    }

    // ----------------------------------------------------------------
    // Derivar mes_periodo desde fecha: '2026-03-14' → '2026-03'
    // ----------------------------------------------------------------
    function mesPeriodo(fechaISO) {
        if (!fechaISO) return null;
        return fechaISO.substring(0, 7);
    }

    // ----------------------------------------------------------------
    // Sobreescribir mes_periodo de todas las filas con el mes de liquidación
    // = el mes que aparece con mayor frecuencia entre las fechas parseadas.
    // Esto asegura que las cuotas (cuya fecha es la de compra original, no
    // la del resumen) queden asignadas al mes correcto de facturación.
    // ----------------------------------------------------------------
    function normalizarMesPeriodo(filas) {
        if (!filas.length) return;
        const conteo = {};
        filas.forEach(m => {
            if (m.mes_periodo) conteo[m.mes_periodo] = (conteo[m.mes_periodo] || 0) + 1;
        });
        const mesLiquidacion = Object.entries(conteo).sort((a, b) => b[1] - a[1])[0]?.[0];
        if (mesLiquidacion) {
            filas.forEach(m => { m.mes_periodo = mesLiquidacion; });
        }
    }

    // ----------------------------------------------------------------
    // FORMATO NUEVO (xlsx actual del banco)
    // Hoja: "movements"
    // Columnas: [Fecha y hora, Movimientos, Cuota, Monto]
    // Fila 1: título "Últimos Movimientos"
    // Fila 2: cabecera
    // Fila 3+: datos
    // ----------------------------------------------------------------
    function parsearFormatoNuevo(filas, nombreArchivo) {
        const resultados = [];

        for (let i = 2; i < filas.length; i++) {
            const fila = filas[i];
            if (!fila || !fila.some(c => c !== null && c !== '')) continue;

            const fechaRaw    = fila[0];
            const nombreRaw   = fila[1];
            const cuotaRaw    = fila[2];
            const montoRaw    = fila[3];

            if (!nombreRaw || !fechaRaw) continue;
            if (debeIgnorar(String(nombreRaw))) continue;

            const fecha = parsearFecha(String(fechaRaw));
            if (!fecha) continue;

            const { ars, usd, esReintegro } = parsearMonto(String(montoRaw || ''));
            const { cuotaActual, cuotaTotal } = parsearCuota(cuotaRaw);
            const nombre = String(nombreRaw).trim();

            resultados.push({
                fecha,
                mes_periodo:    mesPeriodo(fecha),
                comercio_crudo: nombre,
                comercio:       null,
                categoria:      esCargoBancario(nombre) ? 'Cargos Bancarios' : null,
                cuota_actual:   cuotaActual,
                cuota_total:    cuotaTotal,
                monto_ars:      ars,
                monto_usd:      usd,
                es_reintegro:   esReintegro,
                archivo_origen: nombreArchivo,
            });
        }

        // Todas las filas del resumen pertenecen al mes de liquidación,
        // no al mes de la compra original. Esto evita que las cuotas
        // aparezcan en meses viejos en lugar del mes del resumen actual.
        normalizarMesPeriodo(resultados);

        return resultados;
    }

    // ----------------------------------------------------------------
    // FORMATO VIEJO (xls con 6 columnas y Nro. Tarjeta)
    // Columnas: [Nro. Tarjeta, Fecha, Establecimiento, Cuota, Importe $, Importe USD]
    // Fila 1: título "Movimientos del Período"
    // Fila 2: cabecera
    // Fila 3+: datos, última fila es total
    // ----------------------------------------------------------------
    function parsearFormatoViejo(filas, nombreArchivo) {
        const resultados = [];

        for (let i = 2; i < filas.length; i++) {
            const fila = filas[i];
            if (!fila || !fila.some(c => c !== null && c !== '')) continue;

            const fechaRaw  = fila[1];
            const nombreRaw = fila[2];
            const cuotaRaw  = fila[3];
            const arsRaw    = fila[4];
            const usdRaw    = fila[5];

            if (!nombreRaw || !fechaRaw) continue;
            if (debeIgnorar(String(nombreRaw))) continue;

            // Última fila de totales
            if (String(nombreRaw).startsWith('Total Tarjeta')) continue;
            if (String(fila[0] || '').startsWith('Total')) continue;

            const fecha = parsearFecha(String(fechaRaw));
            if (!fecha) continue;

            // En el viejo formato los montos están en columnas separadas
            let ars = null, usd = null, esReintegro = false;

            if (arsRaw && String(arsRaw).trim() !== '') {
                const r = parsearMonto(String(arsRaw));
                ars = r.ars;
                esReintegro = r.esReintegro;
            }
            if (usdRaw && String(usdRaw).trim() !== '') {
                const r = parsearMonto(String(usdRaw));
                usd = r.usd ?? Math.abs(parseFloat(String(usdRaw).replace(',', '.')) || 0);
            }

            if (ars === null && usd === null) continue;

            const { cuotaActual, cuotaTotal } = parsearCuota(cuotaRaw);
            const nombre = String(nombreRaw).trim();

            resultados.push({
                fecha,
                mes_periodo:    mesPeriodo(fecha),
                comercio_crudo: nombre,
                comercio:       null,
                categoria:      esCargoBancario(nombre) ? 'Cargos Bancarios' : null,
                cuota_actual:   cuotaActual,
                cuota_total:    cuotaTotal,
                monto_ars:      ars,
                monto_usd:      usd,
                es_reintegro:   esReintegro,
                archivo_origen: nombreArchivo,
            });
        }

        // Mismo criterio: todas las filas al mes de liquidación.
        normalizarMesPeriodo(resultados);

        return resultados;
    }

    // ----------------------------------------------------------------
    // FUNCIÓN PRINCIPAL: parsear un File objeto (.xlsx / .xls)
    // Retorna Promise<Array<Movimiento>>
    // ----------------------------------------------------------------
    async function parsearArchivo(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.onload = (e) => {
                try {
                    const data = new Uint8Array(e.target.result);
                    const wb   = XLSX.read(data, { type: 'array' });
                    const hoja = wb.Sheets[wb.SheetNames[0]];
                    const filas = XLSX.utils.sheet_to_json(hoja, {
                        header: 1,
                        defval: null,
                        raw:    false,
                    });

                    // Detectar formato viejo buscando "Nro. Tarjeta" en cualquiera
                    // de las primeras filas (puede estar en la fila 2, no en la 1).
                    const esFormatoViejo = filas.slice(0, 5).some(f =>
                        f && String(f[0] || '').includes('Nro. Tarjeta')
                    );

                    let movimientos;

                    if (esFormatoViejo) {
                        movimientos = parsearFormatoViejo(filas, file.name);
                    } else {
                        movimientos = parsearFormatoNuevo(filas, file.name);
                    }

                    // Filtrar movimientos sin fecha o monto
                    const validos = movimientos.filter(m =>
                        m.fecha &&
                        (m.monto_ars !== null || m.monto_usd !== null)
                    );

                    resolve(validos);
                } catch (err) {
                    reject(new Error(`Error al parsear ${file.name}: ${err.message}`));
                }
            };

            reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
            reader.readAsArrayBuffer(file);
        });
    }

    // ----------------------------------------------------------------
    // PARSEAR CSV DE GOOGLE SHEETS (para migración)
    // ----------------------------------------------------------------
    function parsearCSVSheets(csvText) {
        // Parser CSV robusto (maneja comillas y comas internas)
        function parseCSVLine(line) {
            const result = [];
            let current = '';
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                const ch = line[i];
                if (ch === '"') {
                    if (inQuotes && line[i + 1] === '"') {
                        current += '"';
                        i++;
                    } else {
                        inQuotes = !inQuotes;
                    }
                } else if (ch === ',' && !inQuotes) {
                    result.push(current);
                    current = '';
                } else {
                    current += ch;
                }
            }
            result.push(current);
            return result;
        }

        const lineas = csvText.split('\n').filter(l => l.trim() !== '');
        if (lineas.length < 2) return { movimientos: [], clasificaciones: [] };

        // Cabecera: ID,Fecha ,Mes/Año,Movimiento,Categoría ,Monto ARS ,Monto USD,Estado,Comercio limpio,Detalle cuotas,Columna 1
        // Índices:   0   1      2       3           4           5          6        7       8               9             10

        const KEYWORDS_CARGOS = [
            'IMP DE SELLOS', 'DB IVA', 'IVA SERV.DIGITAL', 'INTERESES FINANCIACION',
            'PERC. IB SERV. DIGITALES', 'PERCEPCION AFIP', 'CR. RG 5463',
            'CR.RG 5617', 'CR PESOS P/DEVOLUCION',
        ];

        const esCargoBancarioSheet = (nombre) =>
            KEYWORDS_CARGOS.some(k =>
                nombre.toUpperCase().includes(k.toUpperCase())
            );

        const movimientos   = [];
        const clasifMap     = new Map(); // clave → { nombre_limpio, categoria }

        for (let i = 1; i < lineas.length; i++) {
            const cols = parseCSVLine(lineas[i]);
            if (cols.length < 5) continue;

            const tipoCuenta    = (cols[10] || '').trim().toUpperCase();
            const movimientoRaw = (cols[3]  || '').trim();
            const estadoRaw     = (cols[7]  || '').trim();
            const comercioLimpio= (cols[8]  || '').trim();
            const categoriaRaw  = (cols[4]  || '').trim();
            const fechaRaw      = (cols[1]  || '').trim();
            const mesAnio       = (cols[2]  || '').trim();
            const montoARSRaw   = (cols[5]  || '').trim();
            const montoUSDRaw   = (cols[6]  || '').trim();
            const detalleCuota  = (cols[9]  || '').trim();

            // Filtrar débitos/transferencias
            if (tipoCuenta === 'DEBITO') continue;

            // Filtrar pagos del resumen (montos negativos grandes)
            if (!movimientoRaw) continue;
            if (debeIgnorar(movimientoRaw)) continue;

            // Parsear fecha
            const fecha = parsearFecha(fechaRaw);
            if (!fecha) continue;

            // Parsear montos
            // En la Sheet: Monto ARS viene como "$43.050" o "-$1.230"
            //              Monto USD viene como "6,28"
            let ars = null, usd = null, esReintegro = false;

            if (montoARSRaw && montoARSRaw !== '') {
                // Limpiar: "$43.050" → 43050, "-$1.230" → -1230
                const limpio = montoARSRaw
                    .replace(/^\$\s*/, '')
                    .replace(/\-\$/, '-')
                    .replace(/\./g, '')
                    .replace(',', '.')
                    .trim();
                const v = parseFloat(limpio);
                if (!isNaN(v)) {
                    ars = v;
                    esReintegro = v < 0;
                }
            }

            if (montoUSDRaw && montoUSDRaw !== '') {
                const v = parseFloat(montoUSDRaw.replace(',', '.'));
                if (!isNaN(v)) usd = v;
            }

            if (ars === null && usd === null) continue;

            // Normalizar categoría
            let categoria = normalizarCategoria(categoriaRaw);

            // Reclasificar cargos bancarios
            if (esCargoBancarioSheet(movimientoRaw)) {
                categoria = 'Cargos Bancarios';
            }

            // Parsear cuotas
            const { cuotaActual, cuotaTotal } = parsearCuota(detalleCuota);

            // Período: la Sheet puede usar "2026-01" o "01/2026" (formato argentino)
            let mes_periodo = mesAnio || mesPeriodo(fecha);
            // Normalizar "01/2026" → "2026-01"
            const matchMM = mes_periodo.match(/^(\d{1,2})\/(\d{4})$/);
            if (matchMM) {
                mes_periodo = `${matchMM[2]}-${matchMM[1].padStart(2, '0')}`;
            }

            movimientos.push({
                fecha,
                mes_periodo,
                comercio_crudo: movimientoRaw,
                comercio:       comercioLimpio || null,
                categoria,
                cuota_actual:   cuotaActual,
                cuota_total:    cuotaTotal,
                monto_ars:      ars,
                monto_usd:      usd,
                es_reintegro:   esReintegro,
                archivo_origen: 'migracion-google-sheets',
            });

            // Construir tabla de clasificaciones desde registros OK
            if (estadoRaw === 'OK' && comercioLimpio && categoria) {
                const clave = movimientoRaw.trim().toUpperCase();
                if (!clasifMap.has(clave)) {
                    clasifMap.set(clave, {
                        clave,
                        nombre_limpio: comercioLimpio,
                        categoria,
                    });
                }
            }
        }

        const clasificaciones = Array.from(clasifMap.values());

        return { movimientos, clasificaciones };
    }

    // ----------------------------------------------------------------
    // Normalizar nombres de categorías a Title Case consistente
    // ----------------------------------------------------------------
    function normalizarCategoria(raw) {
        if (!raw) return 'A Clasificar';
        const mapa = {
            'comida':             'Comida',
            'comida fuera':       'Comida Fuera',
            'supermercado':       'Supermercado',
            'transporte':         'Transporte',
            'suscripciones':      'Suscripciones',
            'gimnasio':           'Gimnasio',
            'ocio':               'Ocio',
            'farmacia':           'Farmacia',
            'ropa':               'Ropa',
            'hogar':              'Hogar',
            'cuotas pendientes':  'Cuotas Pendientes',
            'cargos bancarios':   'Cargos Bancarios',
            'otros':              'Otros',
            'debito':             'Otros',          // los pocos que pasaron el filtro
            'a clasificar':       'A Clasificar',
            'nuevo comercio':     'A Clasificar',
        };
        const key = raw.trim().toLowerCase();
        return mapa[key] || raw.trim();
    }

    // API pública
    return {
        parsearArchivo,
        parsearCSVSheets,
        normalizarCategoria,
    };

})();
