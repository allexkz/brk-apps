/**
 * Helper de acesso ao D1 (BUNDLES_DB) para o tracking dos BRK Bundles.
 *
 * Tabela append-only `bundle_sales` (ver web/migrations/0001_bundle_sales.sql):
 * cada pedido que contém bundle gera 1 linha por bundle. Sem read-modify-write,
 * logo sem race condition entre pedidos simultâneos.
 *
 * Todas as funções são defensivas: se `db` não estiver configurado (D1 ainda não
 * criado/bindado), viram no-op e o app continua funcionando sem o tracking.
 */

/**
 * Grava as vendas de bundle de um pedido (idempotente via UNIQUE index).
 * @param {D1Database|undefined|null} db
 * @param {string} shop
 * @param {Array<{
 *   bundleId: string, orderId: string, orderName?: string, variantId?: string,
 *   quantity?: number, grossCents?: number, discountCents?: number,
 *   netCents?: number, mode?: string, createdAt: string
 * }>} rows
 * @returns {Promise<number>} nº de linhas efetivamente inseridas (aprox.)
 */
export async function recordBundleSales(db, shop, rows) {
  if (!db || !rows || rows.length === 0) return 0;

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO bundle_sales
       (shop, bundle_id, order_id, order_name, variant_id, quantity,
        gross_cents, discount_cents, net_cents, mode, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const batch = rows.map((r) =>
    stmt.bind(
      shop,
      String(r.bundleId),
      String(r.orderId),
      r.orderName ?? null,
      r.variantId != null ? String(r.variantId) : null,
      Number(r.quantity ?? 1),
      Number(r.grossCents ?? 0),
      Number(r.discountCents ?? 0),
      Number(r.netCents ?? 0),
      r.mode ?? null,
      r.createdAt
    )
  );

  const results = await db.batch(batch);
  return results.reduce((n, res) => n + (res?.meta?.changes ?? 0), 0);
}

// Monta o "WHERE" de data (created_at é ISO, comparação lexicográfica funciona).
function dateClause(start, end) {
  const clauses = [];
  const binds = [];
  if (start) {
    clauses.push("created_at >= ?");
    binds.push(start);
  }
  if (end) {
    clauses.push("created_at <= ?");
    binds.push(end);
  }
  return { sql: clauses.length ? " AND " + clauses.join(" AND ") : "", binds };
}

/**
 * Agrega por bundle: nº de pedidos (distintos), quantidade e receita líquida.
 * @param {D1Database|undefined|null} db
 * @param {string} shop
 * @param {{start?: string, end?: string}} [range]
 * @returns {Promise<Record<string, {orders:number, quantity:number, netCents:number, grossCents:number}>>}
 */
export async function statsByBundle(db, shop, range = {}) {
  if (!db) return {};
  const { sql, binds } = dateClause(range.start, range.end);
  const res = await db
    .prepare(
      `SELECT bundle_id,
              COUNT(DISTINCT order_id) AS orders,
              SUM(quantity)            AS quantity,
              SUM(net_cents)           AS net_cents,
              SUM(gross_cents)         AS gross_cents
         FROM bundle_sales
        WHERE shop = ?${sql}
        GROUP BY bundle_id`
    )
    .bind(shop, ...binds)
    .all();

  const out = {};
  for (const row of res.results || []) {
    out[row.bundle_id] = {
      orders: Number(row.orders || 0),
      quantity: Number(row.quantity || 0),
      netCents: Number(row.net_cents || 0),
      grossCents: Number(row.gross_cents || 0),
    };
  }
  return out;
}

/**
 * Linhas detalhadas para export/relatório (ex.: Dezembro/2026).
 * @param {D1Database|undefined|null} db
 * @param {string} shop
 * @param {{start?: string, end?: string, bundleIds?: string[]}} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function salesReport(db, shop, opts = {}) {
  if (!db) return [];
  const { sql, binds } = dateClause(opts.start, opts.end);
  let extra = "";
  const extraBinds = [];
  if (opts.bundleIds && opts.bundleIds.length) {
    extra = ` AND bundle_id IN (${opts.bundleIds.map(() => "?").join(",")})`;
    extraBinds.push(...opts.bundleIds);
  }
  const res = await db
    .prepare(
      `SELECT bundle_id, order_id, order_name, variant_id, quantity,
              gross_cents, discount_cents, net_cents, mode, created_at
         FROM bundle_sales
        WHERE shop = ?${sql}${extra}
        ORDER BY created_at DESC`
    )
    .bind(shop, ...binds, ...extraBinds)
    .all();
  return res.results || [];
}
