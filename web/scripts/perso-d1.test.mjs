// Testes do pipeline de personalizados no D1 (perso-store.server.js + personalizados.server.js)
// com um D1 de verdade em memória (node:sqlite = mesmo motor SQLite do D1) e Sankhya falso.
// Uso: node scripts/run-d1-test.mjs
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  ingestPersoOrder,
  drainSankhyaQueue,
  completeOrders,
  setManualNunota,
  reprocessOrders,
  QUEUE_LIMIT,
  GIVE_UP_DAYS,
} from "../app/personalizados.server.js";
import { d1Store, ensureMigrated, exportToKv, _resetMigrationCache } from "../app/perso-store.server.js";

const SHOP = "test.myshopify.com";
const SCHEMA = readFileSync(new URL("../migrations-perso/0001_perso_jobs.sql", import.meta.url), "utf8");
const env0 = { SANKHYA_CLIENT_ID: "id", SANKHYA_CLIENT_SECRET: "s", SANKHYA_CLIENT_XTOKEN: "x" };

// ── D1 fake sobre node:sqlite (mesma API usada pelo app) ──
function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const stats = { statements: 0, rows: 0 };
  const conv = (v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
  class Stmt {
    constructor(sql, binds = []) { this.sql = sql; this.binds = binds; }
    bind(...b) { return new Stmt(this.sql, b); }
    _exec() {
      stats.statements++;
      const s = db.prepare(this.sql);
      if (/^\s*SELECT/i.test(this.sql)) {
        const rows = s.all(...this.binds.map(conv));
        stats.rows += rows.length;
        return { results: rows };
      }
      const info = s.run(...this.binds.map(conv));
      return { results: [], meta: { changes: Number(info.changes) } };
    }
    async all() { return this._exec(); }
    async first() { return this._exec().results[0] ?? null; }
    async run() { return this._exec(); }
  }
  return {
    raw: db,
    stats,
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const r = stmts.map((s) => s._exec());
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

function makeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  const ops = { get: 0, put: [] };
  return {
    store,
    ops,
    async get(key, type) {
      ops.get++;
      const v = store.has(key) ? store.get(key) : null;
      if (v == null) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, val) { ops.put.push(key); store.set(key, val); },
    async delete(key) { store.delete(key); },
  };
}

// ── Sankhya falso ──
const sk = { nunotaRows: [], itemRows: [], calls: 0 };
globalThis.fetch = async (url, opts) => {
  sk.calls++;
  const ok = (payload) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload), headers: { get: () => null } });
  if (String(url).includes("/authenticate")) return ok({ access_token: "tok" });
  const body = JSON.parse(opts?.body || "{}");
  if (body.serviceName === "DbExplorerSP.executeQuery") {
    const sql = body.requestBody?.sql || "";
    if (sql.includes("TGFITE")) return ok({ responseBody: { rows: sk.itemRows } });
    // devolve só as linhas pedidas no SQL (como o Sankhya faria): por id do pedido
    // (AD_PEDECOMMERCE, coluna 1) ou pelo próprio Nº (NUNOTA = n, coluna 0).
    return ok({
      responseBody: {
        rows: sk.nunotaRows.filter((r) => sql.includes(`NUNOTA = ${r[0]}`) || (r[1] != null && sql.includes(String(r[1])))),
      },
    });
  }
  if (body.serviceName === "DatasetSP.save") return ok({ responseBody: {} });
  return { ok: false, status: 404, json: async () => ({}) };
};

let passed = 0;
async function test(name, fn) {
  try {
    _resetMigrationCache();
    sk.nunotaRows = [];
    sk.itemRows = [];
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FALHOU  ${name}\n${e.stack}`);
    process.exitCode = 1;
  }
}

// Ambiente "já migrado" (D1 vazio + flag) para os cenários do pipeline.
async function freshEnv(kvSeed = {}) {
  const PERSO_DB = makeD1();
  const env = { ...env0, PERSO_DB };
  const kv = makeKV(kvSeed);
  await ensureMigrated(env, kv, SHOP);
  return { env, kv, db: PERSO_DB, store: d1Store(PERSO_DB, SHOP) };
}
const persoOf = (id, extra = {}) => ({
  legacyId: String(id),
  name: `#${id}`,
  createdAt: "2026-10-08T10:00:00Z",
  seller: null,
  rawPerso: 1,
  personalizations: [{ sku: "C0492G", tipo: "Nome", nome: "JOAO", local: "Costas", posicao: "Centro" }],
  ...extra,
});
const rowOf = (db, id) => db.raw.prepare("SELECT * FROM perso_jobs WHERE shop=? AND legacy_id=?").get(SHOP, String(id));
const counters = async (store) => store.counters();

// ── Migração com o backup REAL do Fishing ──
const B = "C:/Users/BRK TI/Documents/dev/brk-backups/2026-10-08/fishing/kv/";
const haveBackup = existsSync(B + "personalizados_sankhya.json");

await test("migração KV → D1 com o backup real: contadores batem e o KV fica intacto", async () => {
  if (!haveBackup) { console.log("    (backup não encontrado — pulado)"); return; }
  const statusTxt = readFileSync(B + "personalizados_sankhya.json", "utf8");
  const nunTxt = readFileSync(B + "personalizados_nunotas.json", "utf8");
  const statusMap = JSON.parse(statusTxt);
  const nunMap = JSON.parse(nunTxt);
  const kv = makeKV({ [`personalizados:sankhya:${SHOP}`]: statusTxt, [`personalizados:nunotas:${SHOP}`]: nunTxt });
  const PERSO_DB = makeD1();
  const env = { ...env0, PERSO_DB };
  assert.equal(await ensureMigrated(env, kv, SHOP), true);
  const store = d1Store(PERSO_DB, SHOP);
  const c = await counters(store);
  const expect = { sent: 0, pending: 0, error: 0, seller: 0, hold: 0, done: 0 };
  for (const e of Object.values(statusMap)) {
    if (e.status === "seller" && !(e.personalizations || []).length) continue; // fora do universo
    expect[e.status]++;
  }
  assert.deepEqual(c, expect);
  assert.equal(c.sent, 508);
  // Nº Sankhya: todos os do mapa durável
  const nn = PERSO_DB.raw.prepare("SELECT COUNT(*) c FROM perso_jobs WHERE shop=? AND nunota IS NOT NULL").get(SHOP).c;
  assert.equal(Number(nn), Object.values(nunMap).filter((v) => v != null).length);
  // amostra: status/razão/personalizações preservados
  const [sid, se] = Object.entries(statusMap).find(([, e]) => e.status === "sent");
  const job = (await store.getJobs([sid]))[sid];
  assert.equal(job.status, "sent");
  assert.deepEqual(job.personalizations, se.personalizations);
  // KV NÃO foi alterado
  assert.equal(kv.ops.put.length, 0);
  assert.equal(kv.store.get(`personalizados:sankhya:${SHOP}`), statusTxt);
  // idempotente: 2ª chamada não reimporta
  _resetMigrationCache();
  const before = PERSO_DB.stats.statements;
  await ensureMigrated(env, kv, SHOP);
  assert.equal(PERSO_DB.stats.statements - before, 1); // só lê a flag
});

await test("webhook: pedido novo sem Nº → pendente na fila, com próxima tentativa em 15 min", async () => {
  const { env, kv, db, store } = await freshEnv();
  await ingestPersoOrder(env, kv, SHOP, persoOf(111));
  const r = rowOf(db, 111);
  assert.equal(r.status, "pending");
  assert.equal(r.retry, 1);
  assert.equal(r.attempts, 1);
  const waitMin = (Date.parse(r.next_try_at) - Date.now()) / 60000;
  assert.ok(waitMin > 14 && waitMin <= 15.1, `espera ${waitMin}`);
  assert.equal((await counters(store)).pending, 1);
  assert.equal(kv.ops.put.length, 0); // nada no KV
});

await test("webhook: com Nº disponível grava na hora (sent) e guarda o Nº", async () => {
  const { env, kv, db, store } = await freshEnv();
  sk.nunotaRows = [[5001, "222"]];
  sk.itemRows = [[1, 900, "C0492G", "CAMISA"]];
  await ingestPersoOrder(env, kv, SHOP, persoOf(222));
  const r = rowOf(db, 222);
  assert.equal(r.status, "sent");
  assert.equal(r.retry, 0);
  assert.equal(Number(r.nunota), 5001);
  assert.deepEqual(await counters(store), { sent: 1, pending: 0, error: 0, seller: 0, hold: 0, done: 0 });
});

await test("webhook: reentrega de pedido já gravado não mexe em nada", async () => {
  const { env, kv, db } = await freshEnv();
  sk.nunotaRows = [[5001, "222"]];
  sk.itemRows = [[1, 900, "C0492G", "CAMISA"]];
  await ingestPersoOrder(env, kv, SHOP, persoOf(222));
  const before = rowOf(db, 222).updated_at;
  const calls = sk.calls;
  await ingestPersoOrder(env, kv, SHOP, persoOf(222));
  assert.equal(rowOf(db, 222).updated_at, before);
  assert.equal(sk.calls, calls);
});

await test("webhook: vendedor sem PE1198 não é registrado; vendedor com PE1198 sem atributos vira 'seller'", async () => {
  const { env, kv, db, store } = await freshEnv();
  await ingestPersoOrder(env, kv, SHOP, persoOf(301, { seller: "Ana", rawPerso: 0, personalizations: [] }));
  assert.equal(rowOf(db, 301), undefined);
  await ingestPersoOrder(env, kv, SHOP, persoOf(302, { seller: "Ana", rawPerso: 1, personalizations: [] }));
  const r = rowOf(db, 302);
  assert.equal(r.status, "seller");
  assert.equal(r.has_attrs, 0);
  assert.equal((await counters(store)).seller, 1);
  // sem atributos (não vendedor) → erro
  await ingestPersoOrder(env, kv, SHOP, persoOf(303, { rawPerso: 1, personalizations: [] }));
  assert.equal(rowOf(db, 303).status, "error");
  assert.equal(rowOf(db, 303).has_attrs, 0);
});

await test("dreno ocioso: fila vencida vazia = 1 consulta, sem chamar o Sankhya", async () => {
  const { env, kv, db } = await freshEnv();
  await ingestPersoOrder(env, kv, SHOP, persoOf(111)); // próxima tentativa só daqui 15 min
  const calls = sk.calls;
  const st = db.stats.statements;
  const r = await drainSankhyaQueue(env, kv, SHOP);
  assert.equal(r.processed, 0);
  assert.equal(sk.calls, calls);
  assert.equal(db.stats.statements - st, 1);
});

await test("dreno: pendente vencido ganha Nº → grava; contadores pending→sent", async () => {
  const { env, kv, db, store } = await freshEnv();
  await ingestPersoOrder(env, kv, SHOP, persoOf(111));
  db.raw.prepare("UPDATE perso_jobs SET next_try_at=? WHERE legacy_id='111'").run("2000-01-01T00:00:00Z");
  sk.nunotaRows = [[7001, "111"]];
  sk.itemRows = [[1, 900, "C0492G", "CAMISA"]];
  const r = await drainSankhyaQueue(env, kv, SHOP);
  assert.equal(r.sent, 1);
  assert.equal(rowOf(db, 111).status, "sent");
  assert.deepEqual(await counters(store), { sent: 1, pending: 0, error: 0, seller: 0, hold: 0, done: 0 });
});

await test("espera crescente: 15 → 30 → 60 min entre tentativas", async () => {
  const { env, kv, db } = await freshEnv();
  await ingestPersoOrder(env, kv, SHOP, persoOf(111)); // tentativa 1 → +15
  const waits = [];
  for (let i = 0; i < 2; i++) {
    db.raw.prepare("UPDATE perso_jobs SET next_try_at=? WHERE legacy_id='111'").run("2000-01-01T00:00:00Z");
    await drainSankhyaQueue(env, kv, SHOP);
    waits.push(Math.round((Date.parse(rowOf(db, 111).next_try_at) - Date.now()) / 60000));
  }
  assert.deepEqual(waits, [30, 60]);
  assert.equal(rowOf(db, 111).attempts, 3);
});

await test(`após ${GIVE_UP_DAYS} dias sem Nº: sai da fila e aparece em "Presos"`, async () => {
  const { env, kv, db, store } = await freshEnv();
  await ingestPersoOrder(env, kv, SHOP, persoOf(111));
  const old = new Date(Date.now() - (GIVE_UP_DAYS + 1) * 86400000).toISOString();
  db.raw.prepare("UPDATE perso_jobs SET next_try_at=?, status_at=? WHERE legacy_id='111'").run("2000-01-01T00:00:00Z", old);
  await drainSankhyaQueue(env, kv, SHOP);
  const r = rowOf(db, 111);
  assert.equal(r.status, "pending");
  assert.equal(r.retry, 0);
  assert.match(r.reason, /^Parado/);
  assert.equal(r.status_at, old); // prazo conta do início da pendência
  const again = await drainSankhyaQueue(env, kv, SHOP);
  assert.equal(again.processed, 0);
  const cutoff = new Date(Date.now() - 45 * 60000).toISOString();
  assert.deepEqual((await store.listIds("presos", { cutoffIso: cutoff, size: 25 })).ids, ["111"]);
  assert.equal((await store.stuck(cutoff)).count, 1);
});

await test(`dreno processa no máximo ${QUEUE_LIMIT} por ciclo e sinaliza lote cheio`, async () => {
  const { env, kv, db } = await freshEnv();
  for (let i = 0; i < 20; i++) await ingestPersoOrder(env, kv, SHOP, persoOf(1000 + i));
  db.raw.prepare("UPDATE perso_jobs SET next_try_at=?").run("2000-01-01T00:00:00Z");
  const r = await drainSankhyaQueue(env, kv, SHOP);
  assert.equal(r.processed, QUEUE_LIMIT);
  assert.equal(r.full, true);
  const r2 = await drainSankhyaQueue(env, kv, SHOP);
  assert.equal(r2.processed, 5);
  assert.equal(r2.full, false);
});

await test("concluir: status done, sai da fila e do contador de pendentes", async () => {
  const { env, kv, db, store } = await freshEnv();
  await ingestPersoOrder(env, kv, SHOP, persoOf(111));
  const r = await completeOrders(kv, SHOP, ["111"], env);
  assert.equal(r.done, 1);
  assert.equal(rowOf(db, 111).status, "done");
  assert.equal(rowOf(db, 111).retry, 0);
  assert.deepEqual(await counters(store), { sent: 0, pending: 0, error: 0, seller: 0, hold: 0, done: 1 });
});

await test("vincular Nº manual: duplicidade checada pelo índice, marca manual", async () => {
  const { env, kv, db } = await freshEnv();
  await ingestPersoOrder(env, kv, SHOP, persoOf(111));
  await ingestPersoOrder(env, kv, SHOP, persoOf(222));
  sk.nunotaRows = [[1619183, null, 2, "01/10/2026"]];
  const ok = await setManualNunota(env, kv, SHOP, "111", "1619183");
  assert.equal(ok.ok, true);
  assert.equal(Number(rowOf(db, 111).nunota), 1619183);
  assert.equal(rowOf(db, 111).nunota_manual, 1);
  const dup = await setManualNunota(env, kv, SHOP, "222", "1619183");
  assert.equal(dup.ok, false);
  assert.match(dup.error, /na dashboard/);
});

await test("reprocessar: reinicia a pendência e tenta na hora", async () => {
  const { env, kv, db } = await freshEnv();
  await completeOrders(kv, SHOP, ["111"], env);
  sk.nunotaRows = [[8001, "111"]];
  sk.itemRows = [[1, 900, "C0492G", "CAMISA"]];
  const od = { legacyId: "111", name: "#111", tags: [], createdAt: "2026-10-01T00:00:00Z", rawPersoCount: 1, personalizations: [{ sku: "C0492G", tipo: "Nome", nome: "X", local: "Frente", posicao: "Peito" }] };
  const r = await reprocessOrders(env, kv, SHOP, [od], []);
  assert.equal(r.sent, 1);
  assert.equal(rowOf(db, 111).status, "sent");
});

await test("páginas das abas no D1: mais antigos/mais novos e totais", async () => {
  const { store, db } = await freshEnv();
  const ins = db.raw.prepare("INSERT INTO perso_jobs (shop, legacy_id, status, has_attrs, updated_at) VALUES (?,?,?,0,'t')");
  for (let i = 1; i <= 7; i++) ins.run(SHOP, String(7000000000000 + i), "error");
  const p1 = await store.listIds("semAtributos", { size: 3 });
  assert.deepEqual(p1.ids, ["7000000000007", "7000000000006", "7000000000005"]);
  assert.equal(p1.hasNext, true);
  assert.equal(p1.hasPrev, false);
  const p2 = await store.listIds("semAtributos", { older: p1.ids.at(-1), size: 3 });
  assert.deepEqual(p2.ids, ["7000000000004", "7000000000003", "7000000000002"]);
  const back = await store.listIds("semAtributos", { newer: p2.ids[0], size: 3 });
  assert.deepEqual(back.ids, p1.ids);
  assert.equal(back.hasPrev, false);
  assert.equal(await store.countList("semAtributos", {}), 7);
});

await test("rollback: exportar D1 → KV e reimportar reproduz o mesmo estado", async () => {
  const { env, kv, store } = await freshEnv();
  sk.nunotaRows = [[5001, "222"]];
  sk.itemRows = [[1, 900, "C0492G", "CAMISA"]];
  await ingestPersoOrder(env, kv, SHOP, persoOf(111));
  await ingestPersoOrder(env, kv, SHOP, persoOf(222));
  await completeOrders(kv, SHOP, ["333"], env);
  const r = await exportToKv(env, kv, SHOP);
  assert.equal(r.jobs, 3);
  const exported = JSON.parse(kv.store.get(`personalizados:sankhya:${SHOP}`));
  assert.equal(exported["222"].status, "sent");
  assert.equal(exported["111"].status, "pending");
  assert.equal(JSON.parse(kv.store.get(`personalizados:nunotas:${SHOP}`))["222"], 5001);
  // reimporta num D1 novo a partir do KV exportado
  _resetMigrationCache();
  const PERSO_DB = makeD1();
  const env2 = { ...env0, PERSO_DB };
  await ensureMigrated(env2, kv, SHOP);
  assert.deepEqual(await d1Store(PERSO_DB, SHOP).counters(), await store.counters());
});

await test("CUSTO CONSTANTE: mesmas consultas e linhas lidas com 10 ou 5.000 pedidos no histórico", async () => {
  const measure = async (historySize) => {
    const { env, kv, db, store } = await freshEnv();
    const ins = db.raw.prepare(
      "INSERT INTO perso_jobs (shop, legacy_id, name, status, retry, has_attrs, perso_json, nunota, status_at, updated_at) VALUES (?,?,?,?,0,1,'[]',?,?,?)"
    );
    db.raw.exec("BEGIN");
    for (let i = 0; i < historySize; i++) ins.run(SHOP, String(5000000000000 + i), `#${i}`, "sent", 100000 + i, "2026-08-01T00:00:00Z", "t");
    db.raw.exec("COMMIT");
    const out = {};
    const run = async (label, fn) => {
      const s0 = db.stats.statements;
      const r0 = db.stats.rows;
      await fn();
      out[label] = { statements: db.stats.statements - s0, rows: db.stats.rows - r0 };
    };
    await run("webhook", () => ingestPersoOrder(env, kv, SHOP, persoOf(9999999999999)));
    await run("dreno ocioso", () => drainSankhyaQueue(env, kv, SHOP));
    const ids = ["5000000000001", "5000000000002", "5000000000003"];
    await run("página (status+Nº+contadores)", async () => {
      await store.getJobs(ids);
      await store.getNunotas(ids);
      await store.counters();
      await store.stuck(new Date().toISOString());
    });
    await run("busca por Nº Sankhya", () => store.idsByNunota(100002));
    return out;
  };
  const small = await measure(10);
  const big = await measure(5000);
  assert.deepEqual(big, small, `\n10:   ${JSON.stringify(small)}\n5000: ${JSON.stringify(big)}`);
  console.log(`    custo por operação (10 = 5.000 pedidos): ${JSON.stringify(small)}`);
});

console.log(`\n${passed} teste(s) ok${process.exitCode ? " — COM FALHAS" : ""}`);
