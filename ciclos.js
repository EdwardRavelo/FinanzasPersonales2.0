// ================================================================
// CICLOS.JS — Calendario de ciclos de facturación de la tarjeta
//
// El resumen NO cierra por mes calendario: cierra cada 4 semanas,
// siempre un jueves. Confirmado en el resumen PDF del banco, que
// trae las tres fechas explícitas:
//
//     CIERRE ANTERIOR   02-Jul-26   (jueves)
//     CIERRE ACTUAL     30-Jul-26   (jueves)   ← ancla
//     PRÓXIMO CIERRE    27-Ago-26   (jueves)
//
// 02→30 Jul = 28 días y 30 Jul→27 Ago = 28 días, de ahí la cadencia.
// Por eso NO es "el último jueves del mes": el 02-Jul fue el primero.
//
// Convención de rango: un ciclo es [cierre_previo, cierre), es decir
// el día del cierre pertenece al ciclo SIGUIENTE. Verificado contra
// los dos documentos del banco: el resumen cerrado el 30-Jul lista
// movimientos del 25 y 28 de julio pero ninguno del 30, y el feed
// "Últimos Movimientos" del ciclo nuevo arranca justamente el 30-Jul.
// ================================================================

const Ciclos = (() => {

    const MS_DIA = 86400000;

    // Ancla: cierre confirmado por el banco (jueves 30-Jul-2026), en UTC
    // para que el cálculo no se corra por zona horaria ni horario de verano.
    const ANCLA_UTC   = Date.UTC(2026, 6, 30);
    const DIAS_CICLO  = 28;
    const MS_CICLO    = DIAS_CICLO * MS_DIA;

    // ----------------------------------------------------------------
    // Helpers de fecha — todo en UTC a medianoche
    // ----------------------------------------------------------------
    function aUTC(fecha) {
        if (typeof fecha === 'number') return fecha;   // ya es un timestamp UTC
        if (fecha instanceof Date) {
            return Date.UTC(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
        }
        // ISO 'YYYY-MM-DD' (lo que guarda el parser en el campo fecha)
        const m = String(fecha).match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return null;
        return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    }

    function aISO(ms) {
        return new Date(ms).toISOString().slice(0, 10);
    }

    function hoyUTC() {
        const h = new Date();
        return Date.UTC(h.getFullYear(), h.getMonth(), h.getDate());
    }

    // ----------------------------------------------------------------
    // Cierre que le corresponde a una fecha
    // Devuelve el cierre del ciclo que la contiene, con rango [previo, cierre)
    // ----------------------------------------------------------------
    function cierreDe(fecha) {
        const t = aUTC(fecha);
        if (t === null) return null;
        // Cuántos ciclos completos pasaron desde el ancla (hacia atrás o adelante).
        // floor() + 1 porque el día del cierre ya pertenece al ciclo siguiente.
        const n = Math.floor((t - ANCLA_UTC) / MS_CICLO) + 1;
        return aISO(ANCLA_UTC + n * MS_CICLO);
    }

    // Inicio (inclusive) y fin (exclusivo) del ciclo que cierra en `cierreISO`
    function rangoDe(cierreISO) {
        const fin = aUTC(cierreISO);
        return { desde: aISO(fin - MS_CICLO), hasta: aISO(fin) };
    }

    // ----------------------------------------------------------------
    // Próximo cierre y cuenta regresiva (respecto de hoy)
    // ----------------------------------------------------------------
    function proximoCierre() {
        return cierreDe(hoyUTC());
    }

    // ¿Hoy (u otra fecha) es exactamente un día de cierre?
    function esDiaDeCierre(fecha) {
        const t = aUTC(fecha === undefined ? hoyUTC() : fecha);
        return t !== null && (t - ANCLA_UTC) % MS_CICLO === 0;
    }

    // Cierre que le toca mostrar al panel. El día del cierre, `cierreDe()`
    // ya devuelve el siguiente (esa fecha pertenece al ciclo nuevo), así que
    // la cuenta saltaría de 1 a 28 y nunca se vería "cierra hoy". Ese día se
    // muestra el cierre de hoy, que es el evento que le importa al usuario.
    function cierreVigente() {
        return esDiaDeCierre() ? aISO(hoyUTC()) : proximoCierre();
    }

    function diasHastaCierre(cierreISO) {
        const c = aUTC(cierreISO || cierreVigente());
        return c === null ? null : Math.round((c - hoyUTC()) / MS_DIA);
    }

    // Progreso del ciclo, 0..1 — para la barra del panel
    function progresoCiclo(cierreISO) {
        const { desde, hasta } = rangoDe(cierreISO || cierreVigente());
        const total        = (aUTC(hasta) - aUTC(desde)) / MS_DIA;
        const transcurrido = (hoyUTC() - aUTC(desde)) / MS_DIA;
        return Math.min(1, Math.max(0, transcurrido / total));
    }

    // ----------------------------------------------------------------
    // mes_periodo — el mes calendario donde cae la MAYOR PARTE del ciclo
    //
    // Reemplaza al criterio de "mes más frecuente entre las filas": este
    // depende sólo del calendario, así que es determinista y no cambia
    // según cuántas filas trajo el archivo ni cuántas cuotas viejas
    // arrastre. Da el mismo resultado que el criterio anterior en los
    // meses ya cargados.
    //
    // No se usa el mes del cierre: el ciclo 04-Jun→02-Jul cierra en julio
    // pero es el resumen de junio, y etiquetarlo '2026-07' chocaría con el
    // ciclo 02-Jul→30-Jul. El reparto de días no puede empatar porque el
    // rango es semiabierto y 28 es par (14 vs 14 es imposible: un extremo
    // queda afuera). `hayColision()` avisa si dos ciclos comparten mes.
    // ----------------------------------------------------------------
    function periodoDe(fecha) {
        const cierre = cierreDe(fecha);
        if (!cierre) return null;
        const { desde, hasta } = rangoDe(cierre);

        // Contar días por mes en [desde, hasta)
        const cuenta = {};
        for (let t = aUTC(desde); t < aUTC(hasta); t += MS_DIA) {
            const mes = aISO(t).slice(0, 7);
            cuenta[mes] = (cuenta[mes] || 0) + 1;
        }
        return Object.keys(cuenta).sort((a, b) => cuenta[b] - cuenta[a])[0];
    }

    // ¿El ciclo vecino comparte mes_periodo con este? Si pasa, importar uno
    // borraría al otro (el import reemplaza el mes completo).
    function hayColision(cierreISO) {
        const t = aUTC(cierreISO);
        if (t === null) return false;
        const mes = periodoDe(aISO(t - MS_DIA));
        return periodoDe(aISO(t - MS_CICLO - MS_DIA)) === mes
            || periodoDe(aISO(t + MS_CICLO - MS_DIA)) === mes;
    }

    // ----------------------------------------------------------------
    // Vencimientos — NO se calculan: el banco no usa un offset fijo
    // (02-Jul→13-Jul son 11 días, 30-Jul→07-Ago son 8, 27-Ago→07-Sep son 11).
    // Sólo se muestran los que el resumen confirma; para el resto se omite
    // en lugar de inventar una fecha de pago.
    // ----------------------------------------------------------------
    const VENCIMIENTOS = {
        '2026-07-02': '2026-07-13',
        '2026-07-30': '2026-08-07',
        '2026-08-27': '2026-09-07',
    };

    function vencimientoDe(cierreISO) {
        return VENCIMIENTOS[cierreISO] || null;
    }

    // '2026-08-27' → 'jueves 27 de agosto'
    // El locale mete una coma tras el día de la semana ('jueves, 27 de…'); se
    // quita para que entre limpio en el título del panel.
    function formatearFecha(iso, conAnio = false) {
        const t = aUTC(iso);
        if (t === null) return '';
        const opts = { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' };
        if (conAnio) opts.year = 'numeric';
        return new Date(t).toLocaleDateString('es-AR', opts).replace(',', '');
    }

    // '2026-08-27' → '27/08'
    // Se corta el ISO a mano en lugar de usar toLocaleDateString: con
    // day/month '2-digit' el resultado depende del ICU del runtime y sale
    // '27/8' en algunos, rompiendo la alineación de la fila.
    function formatearCorta(iso) {
        const s = String(iso);
        if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return '';
        return `${s.slice(8, 10)}/${s.slice(5, 7)}`;
    }

    // Lista de cierres alrededor de una fecha, para depurar el calendario
    function calendario(desdeCierre, cantidad = 6) {
        const base = aUTC(desdeCierre || proximoCierre());
        const out  = [];
        for (let i = 0; i < cantidad; i++) out.push(aISO(base + i * MS_CICLO));
        return out;
    }

    return {
        cierreDe,
        rangoDe,
        proximoCierre,
        cierreVigente,
        esDiaDeCierre,
        diasHastaCierre,
        progresoCiclo,
        periodoDe,
        hayColision,
        vencimientoDe,
        formatearFecha,
        formatearCorta,
        calendario,
        DIAS_CICLO,
    };

})();
