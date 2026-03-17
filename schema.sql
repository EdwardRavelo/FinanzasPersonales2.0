-- ================================================================
-- FINANZAS PERSONAL — Schema Supabase
-- Ejecutar completo en: Supabase Dashboard > SQL Editor
-- ================================================================

-- ----------------------------------------------------------------
-- TABLA: movimientos
-- Todos los gastos de tarjeta de crédito importados del banco
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS movimientos (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID REFERENCES auth.users NOT NULL,

    -- Datos del movimiento
    fecha           DATE NOT NULL,
    mes_periodo     TEXT NOT NULL,           -- '2026-03'  (YYYY-MM)
    comercio_crudo  TEXT NOT NULL,           -- nombre exacto del banco
    comercio        TEXT,                    -- nombre limpio post-clasificacion
    categoria       TEXT,                    -- asignada por el usuario

    -- Cuotas
    cuota_actual    INT,                     -- 2  (de "02/03")
    cuota_total     INT,                     -- 3  (de "02/03")

    -- Montos (solo uno de los dos es no-null por movimiento)
    monto_ars       NUMERIC(14, 2),
    monto_usd       NUMERIC(10, 4),

    -- Flags
    es_reintegro    BOOLEAN DEFAULT false,   -- monto negativo (reembolso, OFF VISA GARPA)

    -- Metadata
    archivo_origen  TEXT,                    -- nombre del .xlsx importado
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    -- Evitar duplicados al reimportar el mismo archivo
    UNIQUE (user_id, fecha, comercio_crudo, monto_ars, monto_usd)
);

-- ----------------------------------------------------------------
-- TABLA: clasificaciones
-- Reglas comercio_crudo -> nombre_limpio + categoria
-- Se acumulan con cada clasificacion manual; se aplican automaticamente
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clasificaciones (
    user_id         UUID REFERENCES auth.users NOT NULL,
    clave           TEXT NOT NULL,           -- UPPERCASE(comercio_crudo)
    nombre_limpio   TEXT NOT NULL,
    categoria       TEXT NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, clave)
);

-- ----------------------------------------------------------------
-- TABLA: categorias
-- Lista de categorias disponibles con metadatos visuales
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categorias (
    user_id         UUID REFERENCES auth.users NOT NULL,
    nombre          TEXT NOT NULL,
    icono           TEXT,                    -- emoji
    color           TEXT,                    -- hex color
    PRIMARY KEY (user_id, nombre)
);

-- ----------------------------------------------------------------
-- INDICES
-- ----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_movimientos_user_mes
    ON movimientos (user_id, mes_periodo);

CREATE INDEX IF NOT EXISTS idx_movimientos_user_fecha
    ON movimientos (user_id, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_movimientos_categoria
    ON movimientos (user_id, categoria);

CREATE INDEX IF NOT EXISTS idx_clasificaciones_user
    ON clasificaciones (user_id);

-- ----------------------------------------------------------------
-- ROW LEVEL SECURITY
-- Cada usuario solo puede ver y modificar sus propios datos
-- ----------------------------------------------------------------
ALTER TABLE movimientos    ENABLE ROW LEVEL SECURITY;
ALTER TABLE clasificaciones ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorias     ENABLE ROW LEVEL SECURITY;

-- Politicas para movimientos
CREATE POLICY "movimientos: usuario solo ve los suyos"
    ON movimientos FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "movimientos: usuario solo inserta los suyos"
    ON movimientos FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "movimientos: usuario solo actualiza los suyos"
    ON movimientos FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "movimientos: usuario solo borra los suyos"
    ON movimientos FOR DELETE
    USING (auth.uid() = user_id);

-- Politicas para clasificaciones
CREATE POLICY "clasificaciones: usuario solo ve las suyas"
    ON clasificaciones FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "clasificaciones: usuario solo inserta las suyas"
    ON clasificaciones FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "clasificaciones: usuario solo actualiza las suyas"
    ON clasificaciones FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "clasificaciones: usuario solo borra las suyas"
    ON clasificaciones FOR DELETE
    USING (auth.uid() = user_id);

-- Politicas para categorias
CREATE POLICY "categorias: usuario solo ve las suyas"
    ON categorias FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "categorias: usuario solo inserta las suyas"
    ON categorias FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "categorias: usuario solo actualiza las suyas"
    ON categorias FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "categorias: usuario solo borra las suyas"
    ON categorias FOR DELETE
    USING (auth.uid() = user_id);

-- ----------------------------------------------------------------
-- DATOS INICIALES: categorias por defecto
-- Se insertan al hacer la primera clasificacion (desde app.js)
-- Aca se definen los valores base que se usan en la migracion
-- ----------------------------------------------------------------
-- NOTA: Esto no se puede ejecutar antes de tener un user_id.
-- Las categorias se crean automaticamente desde la app al migrar.
-- ----------------------------------------------------------------
