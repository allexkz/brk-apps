import { json } from "@remix-run/cloudflare";

import { getShopify } from "../shopify.server";
import { fetchSkusByCodprod, hasSankhyaCreds } from "../sankhya.server";

// API da tela "SKUs Sankhya" (app.skus-sankhya.jsx). Rota de recurso, só ponte — NÃO grava
// nada no Cloudflare (sem KV, D1 ou DO).
//
// Passa pelo Worker só o que precisa do token do app (as Bulk Operations NÃO são aceitas
// pelo Direct API access do navegador) e o Sankhya (credenciais no servidor):
//   - comandos das Bulk Operations: iniciar leitura, status, cancelar, reservar upload e
//     iniciar a gravação (1 subrequest cada);
//   - consulta ao Sankhya (auth em memória + até 2 SQLs de 500 códigos).
// Os ARQUIVOS (upload do JSONL e download do resultado) vão direto entre o navegador e o
// storage da Shopify, sem passar por aqui.

const LOOKUP_MAX = 1000; // CODPRODs por chamada
const GID_BULK = /^gid:\/\/shopify\/BulkOperation\/\d+$/;

// Mutation rodada em massa: SÓ o SKU (inventoryItem.sku) é tocado. Fica no servidor para
// o cliente não poder disparar outra mutation.
const SKU_MUTATION = `mutation call($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id sku }
    userErrors { field message }
  }
}`;

// Queries de leitura montadas aqui (o cliente só manda o texto da busca).
function scanQuery(search) {
  const arg = search ? `(query: ${JSON.stringify(search)})` : "";
  return `{ products${arg} { edges { node { id title handle status variants { edges { node { id sku title } } } } } } }`;
}
const ALL_SKUS_QUERY = `{ productVariants { edges { node { id sku } } } }`;

async function gql(admin, query, variables) {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}

const userErrorsMsg = (errs) => (errs || []).map((e) => e.message).join("; ");
const fail = (error) => json({ ok: false, error });

export const action = async ({ request, context }) => {
  const { admin } = await getShopify(context.env).authenticate.admin(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return fail("JSON inválido.");
  }

  try {
    switch (body?.intent) {
      // Leitura em massa: "scan" (produtos do filtro + variantes) ou "skus" (todos os SKUs).
      case "startQuery": {
        let query;
        if (body.kind === "scan") query = scanQuery(String(body.search || "").trim());
        else if (body.kind === "skus") query = ALL_SKUS_QUERY;
        else return fail("Tipo de leitura inválido.");
        const r = (
          await gql(
            admin,
            `mutation ($query: String!) { bulkOperationRunQuery(query: $query) { bulkOperation { id status } userErrors { field message code } } }`,
            { query }
          )
        ).bulkOperationRunQuery;
        if (r.userErrors?.length) return fail(userErrorsMsg(r.userErrors));
        return json({ ok: true, id: r.bulkOperation.id });
      }

      // `node(id:)` em vez de `bulkOperation(id:)`: este só existe a partir da 2026-01, e o app
      // roda numa versão anterior (ApiVersion.January26 não existe na @shopify/shopify-api
      // instalada, então vale o padrão da lib).
      case "status": {
        if (!GID_BULK.test(body.id || "")) return fail("Operação inválida.");
        const d = await gql(
          admin,
          `query ($id: ID!) { node(id: $id) { ... on BulkOperation { id status errorCode objectCount url partialDataUrl } } }`,
          { id: body.id }
        );
        if (!d.node?.status) return fail("Operação não encontrada.");
        return json({ ok: true, op: d.node });
      }

      case "cancel": {
        if (!GID_BULK.test(body.id || "")) return fail("Operação inválida.");
        const r = (
          await gql(admin, `mutation ($id: ID!) { bulkOperationCancel(id: $id) { userErrors { message } } }`, { id: body.id })
        ).bulkOperationCancel;
        if (r.userErrors?.length) return fail(userErrorsMsg(r.userErrors));
        return json({ ok: true });
      }

      // Reserva o upload do JSONL da gravação; o navegador envia o arquivo direto ao storage.
      case "stage": {
        const st = (
          await gql(
            admin,
            `mutation ($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) { stagedTargets { url parameters { name value } } userErrors { field message } } }`,
            { input: [{ resource: "BULK_MUTATION_VARIABLES", filename: "skus.jsonl", mimeType: "text/jsonl", httpMethod: "POST" }] }
          )
        ).stagedUploadsCreate;
        if (st.userErrors?.length) return fail(userErrorsMsg(st.userErrors));
        const target = st.stagedTargets?.[0];
        if (!target?.url || !target.parameters?.some((p) => p.name === "key")) {
          return fail("A Shopify não devolveu o destino do upload.");
        }
        return json({ ok: true, url: target.url, parameters: target.parameters });
      }

      // Dispara a gravação em massa com o arquivo já enviado (`path` = parâmetro "key").
      case "runMutation": {
        const path = typeof body.path === "string" ? body.path : "";
        if (!path || path.length > 500 || !/^[\w./-]+$/.test(path)) return fail("Caminho do upload inválido.");
        const r = (
          await gql(
            admin,
            `mutation ($mutation: String!, $path: String!) { bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $path) { bulkOperation { id status } userErrors { field message code } } }`,
            { mutation: SKU_MUTATION, path }
          )
        ).bulkOperationRunMutation;
        if (r.userErrors?.length) return fail(userErrorsMsg(r.userErrors));
        return json({ ok: true, id: r.bulkOperation.id });
      }

      // CODPROD -> { idExterno, descricao }; a classificação é feita no navegador.
      case "lookup": {
        if (!hasSankhyaCreds(context.env)) return fail("Credenciais do Sankhya não configuradas no Worker.");
        const codprods = Array.isArray(body.codprods) ? body.codprods : [];
        if (codprods.length > LOOKUP_MAX) return fail(`Máximo de ${LOOKUP_MAX} códigos por chamada.`);
        const map = await fetchSkusByCodprod(context.env, context.env.SESSIONS, codprods);
        return json({ ok: true, map });
      }

      default:
        return fail("Ação inválida.");
    }
  } catch (e) {
    return fail(e?.message || String(e));
  }
};
