// Cadastro de vendedores do e-commerce.
//
// Mapeia tags de pedido -> vendedor. Vendedores externos anexam ao pedido uma
// tag com o nome deles (alem de "Nome Personalizado") e colocam a especificacao
// da personalizacao na NOTA do pedido (order.note), em vez dos atributos do modal.
//
// A dashboard de personalizados usa esse mapa para:
//   1) identificar de qual vendedor e a venda (pela tag);
//   2) atribuir a tarefa no ClickUp na label "Vendedores E-commerce";
//   3) usar a nota do pedido como descricao da tarefa.
//
// Persistencia: metafield JSON da loja `brk_perso:sellers`, no formato:
//   [{ "name": "Francisca Aparecida", "tags": ["Francisca Aparecida"] }]

export const SELLERS_NS = "brk_perso";
export const SELLERS_KEY = "sellers";

// Normaliza para comparacao: sem acento, minusculo, sem espacos nas pontas.
export function normalizeStr(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

export async function loadSellers(admin) {
  const res = await admin.graphql(
    `query { shop { id metafield(namespace: "${SELLERS_NS}", key: "${SELLERS_KEY}") { value } } }`
  );
  const data = await res.json();
  const shopId = data.data.shop.id;
  let sellers = [];
  try {
    const raw = data.data.shop.metafield?.value;
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) sellers = parsed;
  } catch {
    sellers = [];
  }
  return { shopId, sellers };
}

export async function saveSellers(admin, shopId, sellers) {
  const res = await admin.graphql(
    `mutation set($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { field message } }
    }`,
    {
      variables: {
        metafields: [{
          ownerId: shopId,
          namespace: SELLERS_NS,
          key: SELLERS_KEY,
          type: "json",
          value: JSON.stringify(sellers),
        }],
      },
    }
  );
  const data = await res.json();
  return data.data.metafieldsSet.userErrors;
}

// Retorna o vendedor cuja alguma tag casa com alguma tag do pedido, ou null.
export function findSellerForTags(orderTags, sellers) {
  const set = new Set((orderTags || []).map(normalizeStr));
  for (const s of sellers || []) {
    for (const t of s.tags || []) {
      if (set.has(normalizeStr(t))) return s;
    }
  }
  return null;
}
