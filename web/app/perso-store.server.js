// Estado do pipeline de personalizados → Sankhya no D1 (binding PERSO_DB).
//
// Substitui os mapas do KV `personalizados:sankhya:<shop>` / `personalizados:nunotas:<shop>`,
// que cresciam com o histórico e eram baixados/parseados/regravados INTEIROS em cada
// webhook, ciclo do dreno e acesso à dashboard. Aqui tudo é por índice + LIMIT: o custo
// de cada operação depende só dos pedidos que ela toca, nunca do tamanho do histórico.
// Esquema: migrations-perso/0001_perso_jobs.sql (contadores mantidos por triggers).
//
// Migração NÃO destrutiva: na 1ª vez, copia os mapas do KV para o D1 (os mapas ficam
// intactos). Enquanto a cópia não acontece (ou sem PERSO_DB), o pipeline segue no KV.
// Rollback: exportToKv() regera os mapas no formato antigo a partir do D1.
//
// Formato do "job" (igual ao das entradas do mapa do KV, + campos novos):
//   { name, status, retry, reason, seller, personalizations, at, nunota, written,
//     nunotaManual, manual, attempts, nextTryAt, hasAttrs, orderCreatedAt }

const SANKHYA_KEY = (shop) => `personalizados:sankhya:${shop}`;
const NUNOTAS_KEY = (shop) => `personalizados:nunotas:${shop}`;
const MIGRATED_KEY = "kv_imported";
const IMPORT_CHUNK = 200; // entradas por statement (json_each) na cópia KV → D1

const nowISO = () => new Date().toISOString();

export function hasPersoDb(env) {
  return Boolean(env?.PERSO_DB);
}

function rowToJob(r) {
  let personalizations = [];
  try {
    personalizations = r.perso_json ? JSON.parse(r.perso_json) : [];
  } catch {
    personalizations = [];
  }
  return {
    name: r.name ?? undefined,
    status: r.status ?? undefined,
    retry: Boolean(r.retry),
    reason: r.reason ?? null,
    seller: r.seller ?? null,
    personalizations,
    at: r.status_at ?? undefined,
    nunota: r.nunota ?? null,
    written: r.written ?? undefined,
    nunotaManual: Boolean(r.nunota_manual),
    manual: Boolean(r.manual),
    attempts: Number(r.attempts || 0),
    nextTryAt: r.next_try_at ?? null,
    hasAttrs: r.has_attrs !== 0,
    orderCreatedAt: r.order_created_at ?? null,
  };
}

const UPSERT_SQL = `INSERT INTO perso_jobs
  (shop, legacy_id, name, order_created_at, status, retry, next_try_at, attempts, reason, seller,
   has_attrs, perso_json, nunota, nunota_manual, written, manual, status_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT (shop, legacy_id) DO UPDATE SET
    name = COALESCE(excluded.name, name),
    order_created_at = COALESCE(excluded.order_created_at, order_created_at),
    status = excluded.status,
    retry = excluded.retry,
    next_try_at = excluded.next_try_at,
    attempts = excluded.attempts,
    reason = excluded.reason,
    seller = excluded.seller,
    has_attrs = excluded.has_attrs,
    perso_json = excluded.perso_json,
    nunota = COALESCE(excluded.nunota, nunota),
    nunota_manual = MAX(excluded.nunota_manual, nunota_manual),
    written = COALESCE(excluded.written, written),
    manual = excluded.manual,
    status_at = excluded.status_at,
    updated_at = excluded.updated_at`;

// ── Store D1 ──

export function d1Store(db, shop) {
  const all = async (sql, ...binds) => (await db.prepare(sql).bind(...binds).all()).results || [];

  return {
    kind: "d1",

    // Jobs (com status) dos ids pedidos — 1 query indexada.
    async getJobs(ids) {
      const list = [...new Set((ids || []).map(String))];
      if (!list.length) return {};
      const rows = await all(
        `SELECT * FROM perso_jobs WHERE shop = ? AND legacy_id IN (SELECT value FROM json_each(?)) AND status IS NOT NULL`,
        shop,
        JSON.stringify(list)
      );
      const out = {};
      for (const r of rows) out[r.legacy_id] = rowToJob(r);
      return out;
    },

    // Fila do envio automático: só os que estão vencidos, no máximo `limit`.
    async getQueue(nowIso, limit) {
      const rows = await all(
        `SELECT * FROM perso_jobs WHERE shop = ? AND retry = 1 AND next_try_at <= ? ORDER BY next_try_at LIMIT ?`,
        shop,
        nowIso,
        limit
      );
      const out = {};
      for (const r of rows) out[r.legacy_id] = rowToJob(r);
      return out;
    },

    // Grava/atualiza jobs (1 statement por pedido, numa transação). Os contadores são
    // ajustados pelos triggers. `nunota` só sobrescreve se vier preenchido.
    async saveJobs(updates) {
      const ids = Object.keys(updates || {});
      if (!ids.length) return;
      const now = nowISO();
      const stmt = db.prepare(UPSERT_SQL);
      await db.batch(
        ids.map((id) => {
          const j = updates[id] || {};
          return stmt.bind(
            shop,
            String(id),
            j.name ?? null,
            j.orderCreatedAt ?? null,
            j.status ?? null,
            j.retry ? 1 : 0,
            j.retry ? j.nextTryAt ?? now : null,
            Number(j.attempts || 0),
            j.reason ?? null,
            j.seller ?? null,
            j.hasAttrs === false ? 0 : 1,
            JSON.stringify(j.personalizations || []),
            j.nunota ?? null,
            j.nunotaManual ? 1 : 0,
            j.written ?? null,
            j.manual ? 1 : 0,
            j.at ?? now,
            now
          );
        })
      );
    },

    // Nº Sankhya dos ids pedidos (inclui linhas sem status).
    async getNunotas(ids) {
      const list = [...new Set((ids || []).map(String))];
      if (!list.length) return {};
      const rows = await all(
        `SELECT legacy_id, nunota FROM perso_jobs WHERE shop = ? AND legacy_id IN (SELECT value FROM json_each(?)) AND nunota IS NOT NULL`,
        shop,
        JSON.stringify(list)
      );
      const out = {};
      for (const r of rows) out[r.legacy_id] = Number(r.nunota);
      return out;
    },

    // Grava Nº Sankhya ({ legacyId: nunota }); cria a linha (sem status) se não existir.
    async saveNunotas(map) {
      const entries = Object.entries(map || {}).filter(([, n]) => n != null);
      if (!entries.length) return;
      const now = nowISO();
      const stmt = db.prepare(
        `INSERT INTO perso_jobs (shop, legacy_id, nunota, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (shop, legacy_id) DO UPDATE SET nunota = excluded.nunota, updated_at = excluded.updated_at`
      );
      await db.batch(entries.map(([id, n]) => stmt.bind(shop, String(id), Number(n), now)));
    },

    // Outro pedido que já usa esse Nº (checagem de duplicidade) — índice (shop, nunota).
    async findNunotaOwner(nunota, exceptId) {
      const rows = await all(
        `SELECT legacy_id FROM perso_jobs WHERE shop = ? AND nunota = ? AND legacy_id <> ? LIMIT 1`,
        shop,
        Number(nunota),
        String(exceptId ?? "")
      );
      return rows[0]?.legacy_id ?? null;
    },

    // ids cujo Nº Sankhya é este (busca na dashboard).
    async idsByNunota(nunota) {
      const rows = await all(`SELECT legacy_id FROM perso_jobs WHERE shop = ? AND nunota = ? LIMIT 5`, shop, Number(nunota));
      return rows.map((r) => r.legacy_id);
    },

    async markNunotaManual(id) {
      await db
        .prepare(`UPDATE perso_jobs SET nunota_manual = 1 WHERE shop = ? AND legacy_id = ? AND status IS NOT NULL`)
        .bind(shop, String(id))
        .run();
    },

    // Contadores por status (≤ 6 linhas, mantidos pelos triggers).
    async counters() {
      const rows = await all(`SELECT status, n FROM perso_counters WHERE shop = ?`, shop);
      const out = { sent: 0, pending: 0, error: 0, seller: 0, hold: 0, done: 0 };
      for (const r of rows) if (r.status in out) out[r.status] = Math.max(0, Number(r.n || 0));
      return out;
    },

    // "Presos": pendentes há mais de X min (lê só os pendentes antigos — índice por status).
    async stuck(cutoffIso) {
      const rows = await all(
        `SELECT COUNT(*) AS c, MIN(status_at) AS oldest FROM perso_jobs WHERE shop = ? AND status = 'pending' AND status_at <= ?`,
        shop,
        cutoffIso
      );
      return { count: Number(rows[0]?.c || 0), oldestAt: rows[0]?.oldest || null };
    },

    // Página de ids (mais novos primeiro) para as abas "Presos" e "Sem atributos".
    // Paginação por chave (legacy_id cresce com o tempo):
    //   older = último id da página atual → próxima página (mais antigos)
    //   newer = primeiro id da página atual → página anterior (mais novos)
    async listIds(kind, { cutoffIso, older = null, newer = null, size = 25 }) {
      const cond = kind === "presos" ? `status = 'pending' AND status_at <= ?` : `has_attrs = 0`;
      const binds = kind === "presos" ? [cutoffIso] : [];
      if (newer) {
        const rows = await all(
          `SELECT legacy_id FROM perso_jobs WHERE shop = ? AND ${cond} AND legacy_id > ? ORDER BY legacy_id ASC LIMIT ?`,
          shop,
          ...binds,
          String(newer),
          size + 1
        );
        const asc = rows.map((r) => r.legacy_id);
        const ids = asc.slice(0, size).reverse();
        return { ids, hasNext: true, hasPrev: asc.length > size };
      }
      const rows = await all(
        `SELECT legacy_id FROM perso_jobs WHERE shop = ? AND ${cond} ${older ? "AND legacy_id < ?" : ""}
         ORDER BY legacy_id DESC LIMIT ?`,
        shop,
        ...binds,
        ...(older ? [String(older)] : []),
        size + 1
      );
      const ids = rows.map((r) => r.legacy_id);
      return { ids: ids.slice(0, size), hasNext: ids.length > size, hasPrev: Boolean(older) };
    },

    // Total das abas por lista (contagem pelo índice da própria condição).
    async countList(kind, { cutoffIso }) {
      const rows =
        kind === "presos"
          ? await all(`SELECT COUNT(*) AS c FROM perso_jobs WHERE shop = ? AND status = 'pending' AND status_at <= ?`, shop, cutoffIso)
          : await all(`SELECT COUNT(*) AS c FROM perso_jobs WHERE shop = ? AND has_attrs = 0`, shop);
      return Number(rows[0]?.c || 0);
    },

    // Pedidos sem Nº Sankhya (para o "Atualizar Banco"), em lotes.
    async idsWithoutNunota(limit, before = null) {
      const rows = await all(
        `SELECT legacy_id FROM perso_jobs WHERE shop = ? AND nunota IS NULL AND status IS NOT NULL
           AND status NOT IN ('seller', 'done') ${before ? "AND legacy_id < ?" : ""}
         ORDER BY legacy_id DESC LIMIT ?`,
        shop,
        ...(before ? [String(before)] : []),
        limit
      );
      return rows.map((r) => r.legacy_id);
    },

    // Marca pedidos (sem status ou já existentes) como "sem atributos" — sincronização única.
    async markNoAttrs(ids) {
      const list = [...new Set((ids || []).map(String))];
      if (!list.length) return;
      const now = nowISO();
      const stmt = db.prepare(
        `INSERT INTO perso_jobs (shop, legacy_id, has_attrs, updated_at) VALUES (?, ?, 0, ?)
         ON CONFLICT (shop, legacy_id) DO UPDATE SET has_attrs = 0, updated_at = excluded.updated_at`
      );
      await db.batch(list.map((id) => stmt.bind(shop, id, now)));
    },

    // Recalcula os contadores a partir da tabela (manutenção; O(N) só neste botão).
    async recountCounters() {
      await db.batch([
        db.prepare(`DELETE FROM perso_counters WHERE shop = ?`).bind(shop),
        db
          .prepare(
            `INSERT INTO perso_counters (shop, status, n)
             SELECT shop, status, COUNT(*) FROM perso_jobs WHERE shop = ? AND status IS NOT NULL GROUP BY status`
          )
          .bind(shop),
      ]);
    },

    async getMeta(key) {
      const rows = await all(`SELECT value FROM perso_meta WHERE shop = ? AND key = ?`, shop, key);
      return rows[0]?.value ?? null;
    },
    async setMeta(key, value) {
      await db
        .prepare(`INSERT INTO perso_meta (shop, key, value) VALUES (?, ?, ?) ON CONFLICT (shop, key) DO UPDATE SET value = excluded.value`)
        .bind(shop, key, value == null ? null : String(value))
        .run();
    },
  };
}

// ── Migração KV → D1 (única, idempotente, não destrutiva) ──

function kvEntryToRow(id, e, nowIso) {
  const perso = Array.isArray(e?.personalizations) ? e.personalizations : [];
  return {
    id: String(id),
    name: e?.name ?? null,
    status: e?.status ?? null,
    retry: e?.retry === true ? 1 : 0,
    next_try_at: e?.retry === true ? nowIso : null,
    reason: e?.reason ?? null,
    seller: e?.seller ?? null,
    // Só "erro sem atributos" é certeza de PE1198 sem atributos; os demais casos (vendedor
    // antigo etc.) são confirmados pela sincronização da dashboard (varre a Shopify 1x).
    has_attrs: e?.status === "error" && perso.length === 0 ? 0 : 1,
    perso_json: JSON.stringify(perso),
    nunota: e?.nunota ?? null,
    nunota_manual: e?.nunotaManual ? 1 : 0,
    written: e?.written ?? null,
    manual: e?.manual ? 1 : 0,
    status_at: e?.at ?? nowIso,
  };
}

async function importMaps(db, shop, statusMap, nunotasMap) {
  const now = nowISO();
  // "seller" sem personalização: no KV antigo inclui ~95% de pedidos de vendedor SEM PE1198
  // (fora da dashboard). Não copia; os vendedores reais (com PE1198) são registrados pela
  // sincronização da dashboard, que varre os pedidos com PE1198 na Shopify.
  const rows = Object.entries(statusMap || {})
    .filter(([, e]) => !(e?.status === "seller" && !(e.personalizations || []).length))
    .map(([id, e]) => kvEntryToRow(id, e, now));
  const stmts = [];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO perso_jobs
       (shop, legacy_id, name, status, retry, next_try_at, attempts, reason, seller, has_attrs,
        perso_json, nunota, nunota_manual, written, manual, status_at, updated_at)
     SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.status'),
            json_extract(value, '$.retry'), json_extract(value, '$.next_try_at'), 0,
            json_extract(value, '$.reason'), json_extract(value, '$.seller'), json_extract(value, '$.has_attrs'),
            json_extract(value, '$.perso_json'), json_extract(value, '$.nunota'), json_extract(value, '$.nunota_manual'),
            json_extract(value, '$.written'), json_extract(value, '$.manual'), json_extract(value, '$.status_at'), ?
       FROM json_each(?)`
  );
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK) {
    stmts.push(ins.bind(shop, now, JSON.stringify(rows.slice(i, i + IMPORT_CHUNK))));
  }
  // Mapa durável de Nº Sankhya (fonte que a dashboard exibia): vence o `nunota` do job.
  const nun = Object.entries(nunotasMap || {})
    .filter(([, n]) => n != null)
    .map(([id, n]) => ({ id: String(id), n: Number(n) }));
  const insNun = db.prepare(
    `INSERT INTO perso_jobs (shop, legacy_id, nunota, updated_at)
     SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.n'), ? FROM json_each(?) WHERE true
     ON CONFLICT (shop, legacy_id) DO UPDATE SET nunota = excluded.nunota`
  );
  for (let i = 0; i < nun.length; i += IMPORT_CHUNK) {
    stmts.push(insNun.bind(shop, now, JSON.stringify(nun.slice(i, i + IMPORT_CHUNK))));
  }
  if (stmts.length) await db.batch(stmts);
  return { jobs: rows.length, nunotas: nun.length };
}

async function readKvMaps(kv, shop) {
  if (!kv) return { statusMap: {}, nunotas: {} };
  const [statusMap, nunotas] = await Promise.all([
    kv.get(SANKHYA_KEY(shop), "json").catch(() => null),
    kv.get(NUNOTAS_KEY(shop), "json").catch(() => null),
  ]);
  return { statusMap: statusMap || {}, nunotas: nunotas || {} };
}

// Cache por isolate: depois de confirmado, não consulta o D1 de novo para isso.
const migratedShops = new Set();

// Garante a cópia KV → D1. Retorna true se o pipeline já pode usar o D1.
// Não destrutivo: os mapas do KV NÃO são alterados nem apagados.
export async function ensureMigrated(env, kv, shop) {
  if (!hasPersoDb(env)) return false;
  if (migratedShops.has(shop)) return true;
  const store = d1Store(env.PERSO_DB, shop);
  if (await store.getMeta(MIGRATED_KEY)) {
    migratedShops.add(shop);
    return true;
  }
  // 1ª passada → marca → 2ª passada (pega escritas no KV que ocorreram durante a 1ª;
  // após a marca, todos os escritores passam a usar o D1). INSERT OR IGNORE: idempotente.
  const first = await readKvMaps(kv, shop);
  const r = await importMaps(env.PERSO_DB, shop, first.statusMap, first.nunotas);
  await store.setMeta(MIGRATED_KEY, JSON.stringify({ at: nowISO(), ...r }));
  const second = await readKvMaps(kv, shop);
  await importMaps(env.PERSO_DB, shop, second.statusMap, second.nunotas);
  migratedShops.add(shop);
  console.log(`[perso-store] KV → D1 importado: ${r.jobs} jobs, ${r.nunotas} Nº Sankhya`);
  return true;
}

// Repassada extra (idempotente, INSERT OR IGNORE — nunca sobrescreve o D1): cobre escritas
// no KV feitas por instâncias da versão anterior durante a troca de versão no deploy.
export async function reimportFromKv(env, kv, shop) {
  if (!hasPersoDb(env)) return null;
  const maps = await readKvMaps(kv, shop);
  return importMaps(env.PERSO_DB, shop, maps.statusMap, maps.nunotas);
}

// Para testes.
export function _resetMigrationCache() {
  migratedShops.clear();
}

// Store do pipeline: D1 se disponível e migrado; senão null (o chamador usa o KV legado).
export async function getD1Store(env, kv, shop) {
  if (!(await ensureMigrated(env, kv, shop))) return null;
  return d1Store(env.PERSO_DB, shop);
}

// ── Rollback: D1 → mapas do KV no formato antigo (botão de manutenção) ──
// Guarda antes uma cópia dos valores atuais do KV (chaves `...:antes-export`).
export async function exportToKv(env, kv, shop) {
  const rows = (await env.PERSO_DB.prepare(`SELECT * FROM perso_jobs WHERE shop = ?`).bind(shop).all()).results || [];
  const statusMap = {};
  const nunotas = {};
  for (const r of rows) {
    if (r.nunota != null) nunotas[r.legacy_id] = Number(r.nunota);
    if (r.status == null) continue;
    const j = rowToJob(r);
    const e = { name: j.name, status: j.status, retry: j.retry };
    if (j.reason != null) e.reason = j.reason;
    if (j.seller != null) e.seller = j.seller;
    e.personalizations = j.personalizations;
    if (j.at) e.at = j.at;
    if (j.nunota != null) e.nunota = j.nunota;
    if (j.written != null) e.written = j.written;
    if (j.nunotaManual) e.nunotaManual = true;
    if (j.manual) e.manual = true;
    statusMap[r.legacy_id] = e;
  }
  const [prevS, prevN] = await Promise.all([kv.get(SANKHYA_KEY(shop)), kv.get(NUNOTAS_KEY(shop))]);
  if (prevS != null) await kv.put(`${SANKHYA_KEY(shop)}:antes-export`, prevS);
  if (prevN != null) await kv.put(`${NUNOTAS_KEY(shop)}:antes-export`, prevN);
  await kv.put(SANKHYA_KEY(shop), JSON.stringify(statusMap));
  await kv.put(NUNOTAS_KEY(shop), JSON.stringify(nunotas));
  return { jobs: Object.keys(statusMap).length, nunotas: Object.keys(nunotas).length };
}
