// ================================================================
// CICLOS.JS — Calendario de ciclos de facturación de la tarjeta
//
// El resumen NO cierra por mes calendario ni cada 28 días fijos: cierra
// UNA vez por mes, siempre un jueves — el primer jueves a partir del
// día 27 de ese mes. Los cierres confirmados por el banco:
//
//     resumen de junio        02-Jul-26   (el 27-Jun fue sábado)
//     resumen de julio        30-Jul-26   (el 27-Jul fue lunes)
//     resumen de agosto       27-Ago-26   (el 27-Ago fue jueves)
//     resumen de septiembre   01-Oct-26   (el 27-Sep fue domingo)
//
// Los ciclos duran 28 o 35 días. Durante un tiempo se supuso una
// cadencia fija de 28 (los tres primeros la cumplían) y el calendario
// ponía el cierre de septiembre el 24-Sep: el banco lo confirmó el
// 01-Oct. El Resumen Anual del banco también trae exactamente un resumen
// por mes, doce por año — con 28 días fijos serían trece.
//
// `CIERRES_CONFIRMADOS` manda sobre la regla: un feriado podría correr
// un cierre, y cuando un resumen trae la fecha se anota acá.
//
// Convención de rango: un ciclo es [cierre_previo, cierre), es decir
// el día del cierre pertenece al ciclo SIGUIENTE. Verificado contra
// los dos documentos del banco: el resumen cerrado el 30-Jul lista
// movimientos del 25 y 28 de julio pero ninguno del 30, y el feed
// "Últimos Movimientos" del ciclo nuevo arranca justamente el 30-Jul.
//
// mes_periodo es el mes del resumen ('2026-06' para el que cierra el
// 02-Jul), así que cada mes tiene exactamente un ciclo: no hay meses
// con dos cierres.
// ================================================================

const Ciclos = (() => {

    const MS_DIA = 86400000;

    const DIA_REFERENCIA = 27;   // el cierre es el primer jueves >= este día
    const JUEVES         = 4;    // getUTCDay()

    // mes del resumen → fecha de cierre, tal como la imprime el banco
    const CIERRES_CONFIRMADOS = {
        '2026-06': '2026-07-02',
        '2026-07': '2026-07-30',
        '2026-08': '2026-08-27',
        '2026-09': '2026-10-01',
    };

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

    // '2026-12' + 1 → '2027-01'
    function mesVecino(mes, delta) {
        const [a, m] = mes.split('-').map(Number);
        return aISO(Date.UTC(a, m - 1 + delta, 1)).slice(0, 7);
    }

    // ----------------------------------------------------------------
    // Cierre del resumen de un mes: 'YYYY-MM' → 'YYYY-MM-DD'
    // ----------------------------------------------------------------
    function cierreDePeriodo(mes) {
        if (!/^\d{4}-\d{2}$/.test(String(mes))) return null;
        if (CIERRES_CONFIRMADOS[mes]) return CIERRES_CONFIRMADOS[mes];
        const [a, m] = mes.split('-').map(Number);
        const ref    = Date.UTC(a, m - 1, DIA_REFERENCIA);
        const faltan = (JUEVES - new Date(ref).getUTCDay() + 7) % 7;
        return aISO(ref + faltan * MS_DIA);
    }

    // ----------------------------------------------------------------
    // mes_periodo de una fecha: el resumen cuyo ciclo la contiene.
    // El cierre de un mes cae entre su día 27 y el 2 del siguiente, así
    // que alcanza con mirar el mes de la fecha y sus dos vecinos.
    // ----------------------------------------------------------------
    function periodoDe(fecha) {
        const t = aUTC(fecha);
        if (t === null) return null;
        const mes = aISO(t).slice(0, 7);
        if (t >= aUTC(cierreDePeriodo(mes)))                return mesVecino(mes, 1);
        if (t <  aUTC(cierreDePeriodo(mesVecino(mes, -1)))) return mesVecino(mes, -1);
        return mes;
    }

    // Cierre del ciclo que contiene una fecha, con rango [previo, cierre)
    function cierreDe(fecha) {
        const p = periodoDe(fecha);
        return p ? cierreDePeriodo(p) : null;
    }

    // Inicio (inclusive) y fin (exclusivo) del ciclo que cierra en `cierreISO`
    function rangoDe(cierreISO) {
        const fin = aUTC(cierreISO);
        const mes = periodoDe(fin - MS_DIA);
        return { desde: cierreDePeriodo(mesVecino(mes, -1)), hasta: aISO(fin) };
    }

    // Largo del ciclo en días: 28 o 35
    function diasDelCiclo(cierreISO) {
        const { desde, hasta } = rangoDe(cierreISO);
        return Math.round((aUTC(hasta) - aUTC(desde)) / MS_DIA);
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
        return t !== null && cierreDe(t - MS_DIA) === aISO(t);
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

    // Día del ciclo transcurrido a hoy, 1-based (el primer día del ciclo
    // es el día 1). 0 si el ciclo todavía no empezó, su largo si ya cerró.
    function diaDelCiclo(cierreISO) {
        const { desde, hasta } = rangoDe(cierreISO);
        const largo = diasDelCiclo(cierreISO);
        if (hoyUTC() >= aUTC(hasta)) return largo;
        const d = Math.floor((hoyUTC() - aUTC(desde)) / MS_DIA) + 1;
        return Math.max(0, Math.min(largo, d));
    }

    // La fecha (exclusiva) hasta la que hay que contar para comparar un
    // ciclo con otro a la misma altura: `dia` días desde su inicio. Como
    // los ciclos miden 28 o 35 días, el día 33 de uno largo contra uno
    // corto se topa con el cierre de este en vez de pasarse al siguiente.
    function corteDelCiclo(cierreISO, dia) {
        const { desde, hasta } = rangoDe(cierreISO);
        return aISO(Math.min(aUTC(desde) + dia * MS_DIA, aUTC(hasta)));
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

    // Lista de cierres a partir de uno, para depurar el calendario
    function calendario(desdeCierre, cantidad = 6) {
        let mes = periodoDe(aUTC(desdeCierre || proximoCierre()) - MS_DIA);
        const out = [];
        for (let i = 0; i < cantidad; i++, mes = mesVecino(mes, 1)) {
            out.push(cierreDePeriodo(mes));
        }
        return out;
    }

    return {
        cierreDe,
        rangoDe,
        diasDelCiclo,
        proximoCierre,
        cierreVigente,
        esDiaDeCierre,
        diasHastaCierre,
        progresoCiclo,
        periodoDe,
        cierreDePeriodo,
        diaDelCiclo,
        corteDelCiclo,
        vencimientoDe,
        formatearFecha,
        formatearCorta,
        calendario,
    };

})();
