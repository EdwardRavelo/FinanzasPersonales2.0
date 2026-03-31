// ================================================================
// DB.JS — Capa de datos: Supabase queries + migración
// ================================================================

const DB = (() => {

    let supabase = null;
    let userId   = null;

    // ----------------------------------------------------------------
    // INIT — conectar con Supabase
    // ----------------------------------------------------------------
    function inicializar() {
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
            auth: {
                // Persiste la sesion en localStorage entre recargas
                persistSession:    true,
                // Detecta automaticamente el token del magic link en la URL
                detectSessionInUrl: true,
                // Refresca el token automaticamente antes de que expire
                autoRefreshToken:  true,
                // PKCE es inmune a scanners de email que consumen el token
                // antes de que el usuario abra el link (problema comun en movil)
                flowType:          'pkce',
            }
        });
    }

    function setUserId(id) { userId = id; }
    function getClient()   { return supabase; }

    // ----------------------------------------------------------------
    // AUTH — Magic Link
    // ----------------------------------------------------------------
    async function loginConGoogle() {
        const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.origin },
        });
        if (error) throw error;
    }

    async function enviarMagicLink(email) {
        const { error } = await supabase.auth.signInWithOtp({
            email,
            options: {
                // Usar origin (sin path/hash) para evitar loops de redireccion
                emailRedirectTo: window.location.origin,
            },
        });
        if (error) throw error;
    }

    async function obtenerSesion() {
        const { data: { session } } = await supabase.auth.getSession();
        return session;
    }

    function escucharCambiosAuth(callback) {
        supabase.auth.onAuthStateChange((_event, session) => {
            callback(session);
        });
    }

    async function cerrarSesion() {
        await supabase.auth.signOut();
    }

    // ----------------------------------------------------------------
    // MESES DISPONIBLES
    // ----------------------------------------------------------------
    async function obtenerMeses() {
        const { data, error } = await supabase
            .from('movimientos')
            .select('mes_periodo')
            .eq('user_id', userId)
            .order('mes_periodo', { ascending: false });

        if (error) throw error;

        // Deduplicar
        const unicos = [...new Set(data.map(r => r.mes_periodo))];
        return unicos;
    }

    // ----------------------------------------------------------------
    // KPIs del mes
    // Gasto neto: suma todos los movimientos incluyendo créditos/reintegros
    // como montos negativos, reflejando lo mismo que muestra el banco.
    // ----------------------------------------------------------------
    async function obtenerKPIs(mesPeriodo) {
        const { data, error } = await supabase
            .from('movimientos')
            .select('monto_ars, monto_usd')
            .eq('user_id', userId)
            .eq('mes_periodo', mesPeriodo);

        if (error) throw error;

        let totalARS = 0;
        let totalUSD = 0;

        data.forEach(m => {
            if (m.monto_ars != null) totalARS += parseFloat(m.monto_ars);
            if (m.monto_usd != null) totalUSD += parseFloat(m.monto_usd);
        });

        return {
            totalARS,
            totalUSD,
            cantidadMovimientos: data.length,
        };
    }

    // ----------------------------------------------------------------
    // DISTRIBUCIÓN POR CATEGORÍA (para donut)
    // ----------------------------------------------------------------
    async function obtenerDistribucion(mesPeriodo) {
        const { data, error } = await supabase
            .from('movimientos')
            .select('categoria, monto_ars, monto_usd')
            .eq('user_id', userId)
            .eq('mes_periodo', mesPeriodo)
            .eq('es_reintegro', false);

        if (error) throw error;

        const mapa = {};
        data.forEach(m => {
            const cat = m.categoria || 'A Clasificar';
            if (!mapa[cat]) mapa[cat] = 0;
            if (m.monto_ars) mapa[cat] += parseFloat(m.monto_ars);
            // USD se omite en el donut ARS (se puede agregar conversión luego)
        });

        return Object.entries(mapa)
            .map(([categoria, total]) => ({ categoria, total }))
            .filter(r => r.total > 0)
            .sort((a, b) => b.total - a.total);
    }

    // ----------------------------------------------------------------
    // TOP 10 COMERCIOS (para barras)
    // ----------------------------------------------------------------
    async function obtenerTop10(mesPeriodo) {
        const { data, error } = await supabase
            .from('movimientos')
            .select('comercio, comercio_crudo, monto_ars')
            .eq('user_id', userId)
            .eq('mes_periodo', mesPeriodo)
            .eq('es_reintegro', false)
            .not('monto_ars', 'is', null);

        if (error) throw error;

        const mapa = {};
        data.forEach(m => {
            const nombre = m.comercio || m.comercio_crudo;
            if (!mapa[nombre]) mapa[nombre] = 0;
            mapa[nombre] += parseFloat(m.monto_ars);
        });

        return Object.entries(mapa)
            .map(([comercio, total]) => ({ comercio, total }))
            .sort((a, b) => b.total - a.total)
            .slice(0, 10);
    }

    // ----------------------------------------------------------------
    // EVOLUCIÓN HISTÓRICA (para línea)
    // Total por mes de todos los meses disponibles
    // ----------------------------------------------------------------
    async function obtenerEvolucion() {
        const { data, error } = await supabase
            .from('movimientos')
            .select('mes_periodo, monto_ars')
            .eq('user_id', userId)
            .eq('es_reintegro', false)
            .not('monto_ars', 'is', null)
            .order('mes_periodo', { ascending: true });

        if (error) throw error;

        const mapa = {};
        data.forEach(m => {
            const p = m.mes_periodo;
            if (!mapa[p]) mapa[p] = 0;
            mapa[p] += parseFloat(m.monto_ars);
        });

        return Object.entries(mapa)
            .map(([periodo, total]) => ({
                periodo,
                etiqueta: formatearMes(periodo),
                total,
            }));
    }

    // ----------------------------------------------------------------
    // CUOTAS PENDIENTES del mes
    // ----------------------------------------------------------------
    async function obtenerCuotas(mesPeriodo) {
        const { data, error } = await supabase
            .from('movimientos')
            .select('comercio, comercio_crudo, cuota_actual, cuota_total, monto_ars')
            .eq('user_id', userId)
            .eq('mes_periodo', mesPeriodo)
            .not('cuota_actual', 'is', null)
            .order('monto_ars', { ascending: false });

        if (error) throw error;

        return data.map(m => ({
            comercio:    m.comercio || m.comercio_crudo,
            cuota:       `${m.cuota_actual}/${m.cuota_total}`,
            monto:       parseFloat(m.monto_ars),
        }));
    }

    // ----------------------------------------------------------------
    // EXTRACTO COMPLETO DEL MES (tabla cronológica)
    // ----------------------------------------------------------------
    async function obtenerExtracto(mesPeriodo) {
        const { data, error } = await supabase
            .from('movimientos')
            .select('fecha, comercio, comercio_crudo, categoria, monto_ars, monto_usd, es_reintegro, cuota_actual, cuota_total')
            .eq('user_id', userId)
            .eq('mes_periodo', mesPeriodo)
            .order('fecha', { ascending: false })
            .order('id',    { ascending: false });

        if (error) throw error;
        return data;
    }

    // ----------------------------------------------------------------
    // OBTENER TODOS LOS DATOS DEL DASHBOARD en paralelo
    // ----------------------------------------------------------------
    async function obtenerDatosDashboard(mesPeriodo) {
        const [meses, kpis, distribucion, top10, evolucion, cuotas, extracto] =
            await Promise.all([
                obtenerMeses(),
                obtenerKPIs(mesPeriodo),
                obtenerDistribucion(mesPeriodo),
                obtenerTop10(mesPeriodo),
                obtenerEvolucion(),
                obtenerCuotas(mesPeriodo),
                obtenerExtracto(mesPeriodo),
            ]);

        return { meses, kpis, distribucion, top10, evolucion, cuotas, extracto };
    }

    // ----------------------------------------------------------------
    // IMPORTAR MOVIMIENTOS (desde .xlsx parseado)
    // El XLSX es la fuente de verdad para el mes: reemplaza todas las
    // filas existentes de ese mes_periodo. Esto evita el problema de
    // montos redondeados en Sheets vs exactos en XLSX que burla el dedup.
    // Los meses históricos (no incluidos en el archivo) no se tocan.
    // ----------------------------------------------------------------
    async function importarMovimientos(movimientos) {
        if (!movimientos.length) return { insertados: 0, duplicados: 0 };

        // Aplicar clasificaciones existentes antes de insertar
        const clasifs = await obtenerTodasClasificaciones();
        const movConClasif = movimientos.map(m => {
            const clave = m.comercio_crudo.trim().toUpperCase();
            const regla = clasifs[clave];
            return {
                ...m,
                user_id:   userId,
                comercio:  regla?.nombre_limpio || m.comercio || null,
                categoria: regla?.categoria     || m.categoria || null,
            };
        });

        const mesPeriodo = movConClasif[0]?.mes_periodo;
        if (!mesPeriodo) return { insertados: 0, duplicados: 0 };

        // Borrar todas las filas existentes del mes para reemplazar con el XLSX
        const { error: errDel } = await supabase
            .from('movimientos')
            .delete()
            .eq('user_id', userId)
            .eq('mes_periodo', mesPeriodo);

        if (errDel) throw errDel;

        // Insertar los movimientos del XLSX
        const { data, error } = await supabase
            .from('movimientos')
            .insert(movConClasif)
            .select('id');

        if (error) throw error;

        return {
            insertados: data?.length ?? 0,
            duplicados: 0,
        };
    }

    // ----------------------------------------------------------------
    // CLASIFICACIONES
    // ----------------------------------------------------------------
    async function obtenerTodasClasificaciones() {
        const { data, error } = await supabase
            .from('clasificaciones')
            .select('clave, nombre_limpio, categoria')
            .eq('user_id', userId);

        if (error) throw error;

        const mapa = {};
        data.forEach(r => { mapa[r.clave] = r; });
        return mapa;
    }

    async function obtenerPendientes() {
        const { data, error } = await supabase
            .from('movimientos')
            .select('comercio_crudo')
            .eq('user_id', userId)
            .is('categoria', null);

        if (error) throw error;

        // Deduplicar
        const unicos = [...new Set(data.map(r => r.comercio_crudo))];
        return unicos.map(crudo => ({
            cruda: crudo,
            limpia: limpiarNombreComercio(crudo),
        }));
    }

    async function obtenerCategorias() {
        const { data, error } = await supabase
            .from('categorias')
            .select('nombre, icono, color')
            .eq('user_id', userId)
            .order('nombre');

        if (error) throw error;
        return data.map(r => r.nombre);
    }

    async function guardarClasificacion(clave, nombreLimpio, categoria) {
        // 1. Guardar la regla
        const { error: errClasif } = await supabase
            .from('clasificaciones')
            .upsert({
                user_id:       userId,
                clave:         clave.toUpperCase(),
                nombre_limpio: nombreLimpio,
                categoria,
                updated_at:    new Date().toISOString(),
            }, { onConflict: 'user_id,clave' });

        if (errClasif) throw errClasif;

        // 2. Aplicar a todos los movimientos que tengan ese comercio_crudo
        const { error: errUpdate } = await supabase
            .from('movimientos')
            .update({ comercio: nombreLimpio, categoria })
            .eq('user_id', userId)
            .eq('comercio_crudo', clave);

        if (errUpdate) throw errUpdate;
    }

    async function guardarVariasClasificaciones(reglas) {
        // reglas: [{ clave, nombreLimpio, categoria }]
        for (const r of reglas) {
            await guardarClasificacion(r.clave, r.nombreLimpio, r.categoria);
        }
    }

    // ----------------------------------------------------------------
    // MIGRACIÓN DESDE GOOGLE SHEETS (una sola vez)
    // ----------------------------------------------------------------
    async function migrarDesdeSheets(onProgreso) {
        onProgreso?.('Descargando datos históricos de Google Sheets...');

        // 1. Fetch del CSV
        const resp = await fetch(SHEETS_MIGRATION_URL);
        if (!resp.ok) throw new Error('No se pudo acceder a Google Sheets. ¿El link sigue siendo público?');
        const csvText = await resp.text();

        onProgreso?.('Procesando datos...');

        // 2. Parsear
        const { movimientos, clasificaciones } = Parser.parsearCSVSheets(csvText);

        onProgreso?.(`Importando ${movimientos.length} movimientos históricos...`);

        // 3. Insertar clasificaciones primero
        if (clasificaciones.length > 0) {
            const clasifConUser = clasificaciones.map(c => ({
                ...c,
                user_id: userId,
                updated_at: new Date().toISOString(),
            }));

            const { error } = await supabase
                .from('clasificaciones')
                .upsert(clasifConUser, { onConflict: 'user_id,clave', ignoreDuplicates: false });

            if (error) throw error;
        }

        onProgreso?.(`Importando movimientos (puede tomar unos segundos)...`);

        // 4. Insertar movimientos en lotes de 500
        // Sin onConflict para que el índice de expresión (COALESCE) actúe;
        // ignoreDuplicates: true genera ON CONFLICT DO NOTHING sobre todos los índices únicos.
        const LOTE = 500;
        let insertados = 0;

        for (let i = 0; i < movimientos.length; i += LOTE) {
            const lote = movimientos.slice(i, i + LOTE).map(m => ({
                ...m,
                user_id: userId,
            }));

            const { data, error } = await supabase
                .from('movimientos')
                .upsert(lote, { ignoreDuplicates: true })
                .select('id');

            if (error) throw error;
            insertados += data?.length ?? 0;

            const porcentaje = Math.round(((i + LOTE) / movimientos.length) * 100);
            onProgreso?.(`Importando... ${Math.min(porcentaje, 100)}%`);
        }

        // 5. Insertar categorías por defecto
        await sincronizarCategorias();

        onProgreso?.('¡Migración completada!');

        return {
            movimientos:     movimientos.length,
            insertados,
            clasificaciones: clasificaciones.length,
        };
    }

    // ----------------------------------------------------------------
    // VERIFICAR si ya existe data (para saber si mostrar botón migrar)
    // ----------------------------------------------------------------
    async function tieneData() {
        const { count, error } = await supabase
            .from('movimientos')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId);

        if (error) return false;
        return (count ?? 0) > 0;
    }

    // ----------------------------------------------------------------
    // SINCRONIZAR CATEGORÍAS por defecto
    // ----------------------------------------------------------------
    async function sincronizarCategorias() {
        const rows = CATEGORIAS_DEFAULT.map(c => ({
            user_id: userId,
            nombre:  c.nombre,
            icono:   c.icono,
            color:   c.color,
        }));

        await supabase
            .from('categorias')
            .upsert(rows, { onConflict: 'user_id,nombre', ignoreDuplicates: true });
    }

    // ----------------------------------------------------------------
    // UTILIDADES
    // ----------------------------------------------------------------
    function formatearMes(periodo) {
        // '2026-03' → 'Mar 26'
        const [y, m] = periodo.split('-');
        const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        return `${meses[parseInt(m, 10) - 1]} ${y.slice(2)}`;
    }

    function limpiarNombreComercio(nombre) {
        return nombre
            .replace(/^(MERPAGO\*|DLO\*|PAYU\*AR\*|PEDIDOSYA\*)/i, '')
            .replace(/\s+\w{8,}$/,'')   // quitar hashes al final
            .trim()
            .split(' ')
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join(' ');
    }

    // API pública
    return {
        inicializar,
        setUserId,
        getClient,
        // Auth
        loginConGoogle,
        enviarMagicLink,
        obtenerSesion,
        escucharCambiosAuth,
        cerrarSesion,
        // Data
        obtenerMeses,
        obtenerDatosDashboard,
        obtenerExtracto,
        // Importación
        importarMovimientos,
        // Clasificaciones
        obtenerPendientes,
        obtenerCategorias,
        guardarClasificacion,
        guardarVariasClasificaciones,
        // Migración
        migrarDesdeSheets,
        tieneData,
        sincronizarCategorias,
    };

})();
