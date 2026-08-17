// Integração com o ERP Sankhya (Gateway de Integração, OAuth 2.0 client_credentials).
//
// Usado pela dashboard de personalizados para:
//   1. Puxar o "Nro Único" (NUNOTA, a PK do cabeçalho de nota TGFCAB) de cada pedido a
//      partir do id da order Shopify, que o integrador grava em `AD_PEDECOMMERCE`.
//   2. Gravar a personalização (Tipo/Nome/Local/Posição) no campo AD_NOMEPERSONALIZADO
//      do ITEM (TGFITE) correspondente à peça personalizada, dentro daquele pedido.
//
// O token de acesso expira em 300s; cacheamos no KV com margem e, se um request voltar
// 401/403 ou o gateway acusar token inválido/expirado (GTW3403), limpamos o cache e
// reautenticamos 1x.

const SANKHYA_BASE = "https://api.sankhya.com.br";
const TOKEN_KV_KEY = "sankhya:token";
const TOKEN_TTL = 270; // s — token expira em 300s
const MATCH_FIELD = "AD_PEDECOMMERCE"; // coluna da TGFCAB com o id numérico da Shopify

// Campo (livre AD_) do ITEM (TGFITE / entidade ItemNota) que recebe a personalização.
const PERSO_FIELD = "AD_NOMEPERSONALIZADO";
// Campo (livre AD_) do PRODUTO (TGFPRO) com o SKU limpo da Shopify (ex.: "C0492G").
// É o match primário peça↔produto. NÃO usar REFERENCIA (guarda o EAN).
const PROD_SKU_FIELD = "AD_IDEXTERNO2";

export function hasSankhyaCreds(env) {
  return Boolean(env?.SANKHYA_CLIENT_ID && env?.SANKHYA_CLIENT_SECRET && env?.SANKHYA_CLIENT_XTOKEN);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Autentica com retry: o /authenticate às vezes devolve 401/429 transitório (blip do
// gateway ou rate-limit numa rajada de pedidos) mesmo com credenciais válidas. Tentamos
// até 3x com backoff antes de desistir. Erros claramente permanentes de credencial
// (4xx que não 401/429) não são re-tentados.
async function authenticate(env) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(300 * attempt); // 0ms, 300ms, 600ms
    let res;
    try {
      res = await fetch(`${SANKHYA_BASE}/authenticate`, {
        method: "POST",
        headers: {
          "X-Token": env.SANKHYA_CLIENT_XTOKEN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: env.SANKHYA_CLIENT_ID,
          client_secret: env.SANKHYA_CLIENT_SECRET,
          grant_type: "client_credentials",
        }),
      });
    } catch (e) {
      lastErr = new Error(`Sankhya auth erro de rede: ${e?.message || e}`);
      continue; // falha de rede → re-tenta
    }
    const raw = await res.text().catch(() => "");
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
    if (res.ok && data.access_token) return data.access_token;
    // DIAGNÓSTICO (temporário): corpo cru + headers do gateway p/ entender o 401 no cron.
    console.error(
      "[sankhya auth fail]",
      `status=${res.status} attempt=${attempt}`,
      `ct=${res.headers.get("content-type")}`,
      `server=${res.headers.get("server")}`,
      `cf-ray=${res.headers.get("cf-ray")}`,
      `cf-mitigated=${res.headers.get("cf-mitigated")}`,
      `kong-req=${res.headers.get("x-kong-request-id")}`,
      `retry-after=${res.headers.get("retry-after")}`,
      `body=${JSON.stringify(raw.slice(0, 300))}`
    );
    lastErr = new Error(data?.error_description || data?.error || `Sankhya auth HTTP ${res.status}`);
    // 4xx que não seja 401/429 = credencial inválida de fato → não adianta insistir.
    if (res.status && res.status < 500 && res.status !== 401 && res.status !== 429) break;
  }
  throw lastErr;
}

// Token em cache no KV (SESSIONS), renovado quando expira (TTL) ou quando `force`.
export async function getSankhyaToken(env, kv, force = false) {
  if (!hasSankhyaCreds(env)) throw new Error("Credenciais Sankhya não configuradas no worker.");
  if (kv && !force) {
    try {
      const cached = await kv.get(TOKEN_KV_KEY);
      if (cached) return cached;
    } catch {
      // ignora e reautentica
    }
  }
  const token = await authenticate(env);
  if (kv) {
    try {
      await kv.put(TOKEN_KV_KEY, token, { expirationTtl: TOKEN_TTL });
    } catch {
      // cache é best-effort
    }
  }
  return token;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sqlStr(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ── Camada HTTP genérica do gateway MGE (service.sbr) ──

// Chama um serviço do gateway (DbExplorerSP.executeQuery, DatasetSP.save, …) e devolve
// o JSON de resposta, traduzindo os dois formatos de erro do Sankhya em Error:
//   - erro de gateway: { error: { codigo, descricao } }  (ex.: GTW3403 = token vencido)
//   - erro de negócio: { status: "N", statusMessage: <base64?> }
async function callService(token, serviceName, requestBody) {
  const url = `${SANKHYA_BASE}/gateway/v1/mge/service.sbr?serviceName=${serviceName}&outputType=json`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ serviceName, requestBody }),
  });
  const data = await res.json().catch(() => ({}));
  if (data?.error) {
    const cod = data.error.codigo || "";
    const msg = data.error.descricao || cod || "erro gateway";
    throw new Error(`Sankhya ${cod}: ${msg}`.trim());
  }
  if (!res.ok) throw new Error(`Sankhya ${serviceName} HTTP ${res.status}`);
  if (data && data.status != null && String(data.status) !== "1") {
    let msg = data.statusMessage || "erro desconhecido";
    try { msg = atob(msg); } catch { /* nem sempre é base64 */ }
    throw new Error(`Sankhya: ${msg}`);
  }
  return data;
}

function isAuthError(e) {
  const m = String(e?.message || "");
  return /HTTP 40[13]/.test(m) || /GTW3403/.test(m) || /Token inv|expirad/i.test(m);
}

// Executa `fn(token)` renovando o token 1x se o gateway acusar auth inválida/expirada.
async function withAuth(env, kv, fn) {
  const token = await getSankhyaToken(env, kv);
  try {
    return await fn(token);
  } catch (e) {
    if (isAuthError(e)) {
      if (kv) { try { await kv.delete(TOKEN_KV_KEY); } catch { /* segue */ } }
      const fresh = await getSankhyaToken(env, kv, true);
      return await fn(fresh);
    }
    throw e;
  }
}

// SELECT via DbExplorerSP.executeQuery → array de linhas ([[col1, col2, …], …]).
async function runQuery(env, kv, sql) {
  const data = await withAuth(env, kv, (token) =>
    callService(token, "DbExplorerSP.executeQuery", { sql })
  );
  return data?.responseBody?.rows || [];
}

// Grava campos de itens (entidade ItemNota / TGFITE) via DatasetSP.save.
// `records`: [{ pk: { NUNOTA, SEQUENCIA }, values: { "0": "<texto>" } }, …], onde a
// chave numérica em `values` é o índice do campo em `fields`.
async function saveItemFields(env, kv, fields, records) {
  return withAuth(env, kv, (token) =>
    callService(token, "DatasetSP.save", {
      entityName: "ItemNota",
      standAlone: false,
      fields,
      records,
    })
  );
}

// ── NUNOTA por id da Shopify (usado na coluna "Nº Sankhya" da dashboard) ──

// Retorna um mapa { shopifyLegacyId(string) -> NUNOTA(number) } para os ids informados.
// A busca é feita em lote (chunks) — nunca 1 request por pedido. Erros são propagados
// para o chamador decidir (a dashboard trata como não-fatal e mostra no banner).
export async function fetchNunotasByShopifyIds(env, kv, ids, { empresa = null } = {}) {
  const clean = [...new Set((ids || []).map((x) => String(x ?? "").trim()).filter(Boolean))];
  if (clean.length === 0) return {};

  const map = {};
  for (const part of chunk(clean, 200)) {
    const where = [`${MATCH_FIELD} IN (${part.map(sqlStr).join(",")})`];
    if (empresa != null) where.push(`CODEMP = ${Number(empresa)}`);
    const sql = `SELECT NUNOTA, ${MATCH_FIELD} FROM TGFCAB WHERE ${where.join(" AND ")}`;
    const rows = await runQuery(env, kv, sql); // rows: [ [NUNOTA, AD_PEDECOMMERCE], ... ]
    for (const r of rows) {
      const shopId = String(r[1] ?? "").trim();
      if (shopId) map[shopId] = r[0];
    }
  }
  return map;
}

// ── Escrita da personalização no item do pedido ──

// Itens de uma nota (NUNOTA) com o SKU/refs do produto, para casar com a peça
// personalizada. Retorna [{ sequencia, codprod, sku, descr }].
async function fetchOrderItems(env, kv, nunota) {
  const sql =
    `SELECT I.SEQUENCIA, I.CODPROD, P.${PROD_SKU_FIELD}, P.DESCRPROD ` +
    `FROM TGFITE I JOIN TGFPRO P ON P.CODPROD = I.CODPROD ` +
    `WHERE I.NUNOTA = ${Number(nunota)}`;
  const rows = await runQuery(env, kv, sql);
  return rows.map((r) => ({
    sequencia: r[0],
    codprod: r[1],
    sku: r[2] == null ? "" : String(r[2]).trim(),
    descr: r[3] == null ? "" : String(r[3]),
  }));
}

// Casa o "Produto" da personalização (vem da property do PE1198 na Shopify) com um
// item DO PEDIDO. O match é local ao pedido de propósito: AD_IDEXTERNO2 tem duplicatas
// na base inteira, mas dentro de uma nota o SKU é único. Ordem de precedência:
//   1. SKU limpo (AD_IDEXTERNO2)  — caso normal
//   2. CODPROD                    — quando a Shopify guarda o id do Sankhya no lugar do SKU
//   3. prefixo do DESCRPROD       — último recurso ("SKU - DESCRIÇÃO…")
function matchItem(items, garment) {
  const g = String(garment ?? "").trim().toUpperCase();
  if (!g) return null;
  return (
    items.find((i) => i.sku.toUpperCase() === g) ||
    items.find((i) => String(i.codprod) === g) ||
    items.find((i) => i.descr.toUpperCase().startsWith(`${g} - `)) ||
    null
  );
}

// Texto gravado no campo do item, no formato acordado com a Formatação.
function persoText(p) {
  return `NOME: ${p.nome || ""} | LOCAL: ${p.local || ""} | POSIÇÃO: ${p.posicao || ""}`;
}

// Envia as personalizações de vários pedidos ao Sankhya. Cada pedido é atômico: se
// QUALQUER personalização não casar com um item da nota, NADA daquele pedido é gravado
// (retorna erro "Produtos não encontrados no Sankhya: …" para conferência manual). Os
// demais pedidos do lote seguem normalmente.
//
// `orders`: [{ legacyId, name, nunota, personalizations: [{ sku, tipo, nome, local, posicao }] }]
// Retorna: [{ legacyId, name, nunota, ok, written, error }]
export async function sendPersonalizationsToSankhya(env, kv, orders) {
  const results = [];
  for (const o of orders || []) {
    const r = { legacyId: o.legacyId, name: o.name, nunota: o.nunota ?? null, ok: false, written: 0, error: null };
    try {
      if (o.nunota == null) throw new Error("Pedido ainda não sincronizado no Sankhya (sem Nº Sankhya).");

      const persos = (o.personalizations || []).filter((p) => String(p.sku ?? "").trim());
      if (persos.length === 0) throw new Error("Nenhuma personalização com produto vinculado.");

      const items = await fetchOrderItems(env, kv, o.nunota);

      // Casa cada personalização com um item; agrupa por SEQUENCIA (uma peça pode ter
      // mais de uma personalização → concatenamos as linhas no mesmo campo).
      const byItem = new Map(); // sequencia -> { item, texts: [] }
      const notFound = [];
      for (const p of persos) {
        const item = matchItem(items, p.sku);
        if (!item) { notFound.push(String(p.sku).trim()); continue; }
        if (!byItem.has(item.sequencia)) byItem.set(item.sequencia, { item, texts: [] });
        byItem.get(item.sequencia).texts.push(persoText(p));
      }
      if (notFound.length) {
        throw new Error(`Produtos não encontrados no Sankhya: ${[...new Set(notFound)].join(", ")}`);
      }

      const records = [...byItem.values()].map(({ item, texts }) => ({
        pk: { NUNOTA: String(o.nunota), SEQUENCIA: String(item.sequencia) },
        values: { "0": texts.join("\n") },
      }));
      await saveItemFields(env, kv, [PERSO_FIELD], records);
      r.ok = true;
      r.written = records.length;
    } catch (e) {
      r.error = e?.message || String(e);
    }
    results.push(r);
  }
  return results;
}
