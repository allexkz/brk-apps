// Teste pré-deploy (sem framework) da correção de KV writes do pipeline Sankhya.
// Roda com: node scripts/kv-writes.test.mjs   (a partir de web/)
//
// Cobre os 4 cenários acordados no plano:
//   A) pendência inalterada  -> ZERO PUTs no KV
//   B) token reusado no lote  -> renovado só após expirar (1 auth reusada, +1 após TTL)
//   C) force + recuperação de erro de auth -> NENHUMA operação de KV de token
//   D) NUNOTA encontrada -> envio realizado + estado persistido
//
// Usa um KV fake que conta get/put/delete e um fetch fake que simula o Sankhya.

import {
  drainSankhyaQueue,
  completeOrders,
  setManualNunota,
} from "../app/personalizados.server.js";
import {
  getSankhyaToken,
  fetchNunotasByShopifyIds,
} from "../app/sankhya.server.js";

const PENDING_REASON = "Aguardando sincronização no Sankhya (sem Nº Sankhya).";
const SHOP = "test.myshopify.com";
const STATUS_KEY = `personalizados:sankhya:${SHOP}`;
const NUNOTA_KEY = `personalizados:nunotas:${SHOP}`;
const TOKEN_KEY = "sankhya:token"; // NÃO deve mais ser tocado
const env = {
  SANKHYA_CLIENT_ID: "id",
  SANKHYA_CLIENT_SECRET: "secret",
  SANKHYA_CLIENT_XTOKEN: "xtoken",
};

// ── KV fake (conta operações e registra chaves) ──
function makeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  const ops = { get: [], put: [], delete: [] };
  return {
    store,
    ops,
    async get(key, type) {
      ops.get.push(key);
      const v = store.has(key) ? store.get(key) : null;
      if (v == null) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, val) { ops.put.push(key); store.set(key, val); },
    async delete(key) { ops.delete.push(key); store.delete(key); },
  };
}

// ── fetch fake do Sankhya (configurável por cenário) ──
const cfg = { authCount: 0, nunotaRows: [], itemRows: [], failAuthOnce: false };
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  // Resposta com json()/text()/headers p/ cobrir as duas variantes de authenticate
  // (agro/motors usam res.json(); fishing usa res.text() no bloco de diagnóstico).
  const ok = (payload) => ({
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: { get: () => null },
  });
  if (u.includes("/authenticate")) {
    cfg.authCount++;
    return ok({ access_token: "tok" + cfg.authCount });
  }
  const body = JSON.parse(opts?.body || "{}");
  if (body.serviceName === "DbExplorerSP.executeQuery") {
    if (cfg.failAuthOnce) { cfg.failAuthOnce = false; return ok({ error: { codigo: "GTW3403", descricao: "token expirado" } }); }
    const sql = body.requestBody?.sql || "";
    const rows = sql.includes("TGFITE") ? cfg.itemRows : cfg.nunotaRows;
    return ok({ responseBody: { rows } });
  }
  if (body.serviceName === "DatasetSP.save") return ok({ responseBody: {} });
  return { ok: false, status: 404, json: async () => ({}) };
};

// ── util de asserção ──
let failures = 0;
function check(name, cond, detail = "") {
  const status = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
}

function seedPending() {
  // Ordem de chaves = a que processPersoJobs reconstrói (spread do job) → JSON idêntico.
  const map = {
    "111": {
      name: "#111",
      status: "pending",
      retry: true,
      reason: PENDING_REASON,
      seller: null,
      personalizations: [{ sku: "C0492G", nome: "JOAO", local: "COSTAS", posicao: "CENTRO" }],
      nunota: null,
      at: "2026-09-09T00:00:00.000Z",
    },
  };
  return { [STATUS_KEY]: JSON.stringify(map) };
}

async function run() {
  // ── Cenário B: token reusado no lote, renovado após expirar ──
  console.log("Cenário B — cache de token em memória (reuso + expiração):");
  {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      cfg.authCount = 0;
      await getSankhyaToken(env, null, true);      // força auth #1
      await getSankhyaToken(env, null);            // dentro da validade → reusa
      check("reuso dentro da validade não reautentica", cfg.authCount === 1, `auths=${cfg.authCount}`);
      now += 271_000;                              // passa o TTL (270s)
      await getSankhyaToken(env, null);            // expirou → reautentica
      check("reautentica após expirar o TTL", cfg.authCount === 2, `auths=${cfg.authCount}`);
    } finally {
      Date.now = realNow;
    }
  }

  // ── Cenário C: force + recuperação de erro de auth, sem KV de token ──
  console.log("Cenário C — recuperação de 401/GTW3403 sem tocar KV de token:");
  {
    const kv = makeKV();
    cfg.authCount = 0;
    cfg.failAuthOnce = true;                       // 1ª query devolve GTW3403
    cfg.nunotaRows = [[5001, "111"]];
    const res = await fetchNunotasByShopifyIds(env, kv, ["111"], { empresa: null });
    check("recuperou e retornou a NUNOTA", res["111"] === 5001, JSON.stringify(res));
    check("erro de auth foi exercitado", cfg.failAuthOnce === false);
    const touchedToken = [...kv.ops.get, ...kv.ops.put, ...kv.ops.delete].includes(TOKEN_KEY);
    check("nenhuma operação de KV com a chave de token", !touchedToken);
  }

  // ── Cenário A: pendência inalterada → ZERO PUTs ──
  console.log("Cenário A — dreno com pendência inalterada (0 writes):");
  {
    const kv = makeKV(seedPending());
    cfg.nunotaRows = [];                           // NUNOTA ainda não sincronizou
    cfg.itemRows = [];
    const before = JSON.stringify(await kv.get(STATUS_KEY, "json"));
    const r = await drainSankhyaQueue(env, kv, SHOP);
    check("nenhum PUT no KV", kv.ops.put.length === 0, `puts=[${kv.ops.put.join(",")}]`);
    check("nenhum DELETE no KV", kv.ops.delete.length === 0);
    check("estado permanece pendente", r.pending === 1 && r.sent === 0, JSON.stringify(r));
    const after = JSON.stringify(await kv.get(STATUS_KEY, "json"));
    check("mapa de status inalterado (at preservado)", before === after);
  }

  // ── Cenário D: NUNOTA encontrada → envio + persistência ──
  console.log("Cenário D — NUNOTA encontrada, envio + estado persistido:");
  {
    const kv = makeKV(seedPending());
    cfg.nunotaRows = [[5001, "111"]];             // NUNOTA sincronizou
    cfg.itemRows = [[1, 900, "C0492G", "CAMISA"]]; // sequencia, codprod, sku, descr
    const r = await drainSankhyaQueue(env, kv, SHOP);
    check("1 pedido enviado", r.sent === 1, JSON.stringify(r));
    const status = await kv.get(STATUS_KEY, "json");
    check("status do pedido = sent", status["111"]?.status === "sent", JSON.stringify(status["111"]));
    check("NUNOTA persistida", status["111"]?.nunota === 5001);
    check("houve PUT de nunotas e de status", kv.ops.put.includes(NUNOTA_KEY) && kv.ops.put.includes(STATUS_KEY), `puts=[${kv.ops.put.join(",")}]`);
    const touchedToken = [...kv.ops.get, ...kv.ops.put, ...kv.ops.delete].includes(TOKEN_KEY);
    check("nenhuma operação de KV com a chave de token", !touchedToken);
  }

  // ── Cenário E: "Concluir" (completeOrders) encerra o pedido e o tira do cron ──
  console.log("Cenário E — completeOrders: pedido concluído/encerrado:");
  {
    const kv = makeKV(seedPending());
    const noop = await completeOrders(kv, SHOP);        // sem ids → não altera nada
    check("completeOrders sem ids não altera nada", noop.done === 0, JSON.stringify(noop));
    const r = await completeOrders(kv, SHOP, ["111"]);
    check("1 pedido concluído", r.done === 1, JSON.stringify(r));
    const status = await kv.get(STATUS_KEY, "json");
    check("status = done", status["111"]?.status === "done", JSON.stringify(status["111"]));
    check("retry = false", status["111"]?.retry === false);
    cfg.nunotaRows = [[5001, "111"]];                   // mesmo com NUNOTA disponível…
    const drain = await drainSankhyaQueue(env, kv, SHOP);
    check("cron NÃO reprocessa pedido concluído", drain.processed === 0, JSON.stringify(drain));
  }

  // ── Cenário F: vínculo manual do Nº Sankhya (pedido lançado sem AD_PEDECOMMERCE) ──
  console.log("Cenário F — setManualNunota: vínculo manual do Nº Sankhya:");
  {
    const kv = makeKV(seedPending());
    cfg.nunotaRows = [];                                // NUNOTA não existe na TGFCAB
    const notFound = await setManualNunota(env, kv, SHOP, "111", "1619183");
    check("NUNOTA inexistente é recusado", !notFound.ok && /não encontrado/.test(notFound.error), JSON.stringify(notFound));
    const invalid = await setManualNunota(env, kv, SHOP, "111", "16a9");
    check("NUNOTA não numérico é recusado", !invalid.ok, JSON.stringify(invalid));
    cfg.nunotaRows = [[1619183, "999", 2, "01/10/2026"]]; // NUNOTA de OUTRO pedido Shopify
    const otherCab = await setManualNunota(env, kv, SHOP, "111", "1619183");
    check("NUNOTA com AD_PEDECOMMERCE de outro pedido é recusado", !otherCab.ok && /outro pedido da Shopify/.test(otherCab.error), JSON.stringify(otherCab));
    check("nada gravado no mapa após recusas", (await kv.get(NUNOTA_KEY, "json"))?.["111"] == null);

    cfg.nunotaRows = [[1619183, null, 2, "01/10/2026"]];  // NUNOTA sem vínculo → aceito
    const ok = await setManualNunota(env, kv, SHOP, "111", "1619183");
    check("NUNOTA válido é vinculado", ok.ok && ok.cab?.nunota === 1619183, JSON.stringify(ok));
    check("mapa de nunotas atualizado", (await kv.get(NUNOTA_KEY, "json"))?.["111"] === 1619183);
    check("job marcado nunotaManual", (await kv.get(STATUS_KEY, "json"))?.["111"]?.nunotaManual === true);

    const dup = await setManualNunota(env, kv, SHOP, "222", "1619183");
    check("mesmo NUNOTA em outro pedido da dashboard é recusado", !dup.ok && /na dashboard/.test(dup.error), JSON.stringify(dup));

    cfg.itemRows = [[1, 10, "C0492G", "C0492G - CAMISA"]];
    const drain = await drainSankhyaQueue(env, kv, SHOP);
    check("pendente com Nº manual é gravado no próximo dreno", drain.sent === 1, JSON.stringify(drain));
    check("status = sent", (await kv.get(STATUS_KEY, "json"))?.["111"]?.status === "sent");
  }

  console.log("");
  if (failures) {
    console.error(`❌ ${failures} verificação(ões) falharam.`);
    process.exit(1);
  }
  console.log("✅ Todos os cenários passaram.");
}

run().catch((e) => { console.error("Erro inesperado no teste:", e); process.exit(1); });
