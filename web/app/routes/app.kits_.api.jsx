import { json } from "@remix-run/cloudflare";

import { getShopify } from "../shopify.server";
import { kitVariantPrice, kitTitle } from "../kits.js";

// API da tela "Kits" (app.kits.jsx). Rota de recurso: cria bundles fixos NATIVOS da Shopify
// (productBundleCreate) — o kit é um produto cujos componentes são a camisa e a botina
// originais; a venda dá baixa nos componentes. Só ADICIONA produtos novos; nada é gravado
// no Cloudflare. Um kit por chamada (longe do teto de subrequests do Worker):
//   preview → create (operação assíncrona) → status (polling) → finish (preço, compare-at,
//   SKU, tags, descrição, fotos, status).
// Idempotente: o kit existente é achado pelo TÍTULO (não pela tag, que só entra no finish);
// "finish" pode ser repetido num kit incompleto. Uma automação da loja (Flow) mexe em todo
// produto novo logo após a criação — por isso as tags são ADICIONADAS (tagsAdd, preserva as
// dela) e o cliente repete a chamada quando a Shopify responde "being modified".

const KIT_TAGS = ["kit-camisa-botina", "bundle"];
const OPT_SHIRT = "Tamanho da Camisa";
const OPT_BOOT = "Tamanho da Botina";
const ID_RE = /^\d{6,20}$/;
const pgid = (id) => `gid://shopify/Product/${id}`;

// ── GraphQL ──

const PRODUCTS_QUERY = `query ($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Product {
      id legacyResourceId title handle status vendor hasVariantsThatRequiresComponents
      options { id name values }
      featuredMedia { preview { image { url } } }
      variants(first: 100) { nodes { id sku price selectedOptions { name value } } }
    }
  }
}`;

const FIND_QUERY = `query ($q: String!) {
  products(first: 10, query: $q) {
    nodes {
      id title tags hasVariantsThatRequiresComponents
      media(first: 1) { nodes { id } }
      variants(first: 1) { nodes { price compareAtPrice } }
    }
  }
}`;

const CREATE_MUTATION = `mutation ($input: ProductBundleCreateInput!) {
  productBundleCreate(input: $input) {
    productBundleOperation { id status }
    userErrors { field message }
  }
}`;

const OP_QUERY = `query ($id: ID!) {
  productOperation(id: $id) {
    ... on ProductBundleOperation { status product { id } userErrors { field message } }
  }
}`;

const KIT_VARIANTS_QUERY = `query ($id: ID!) {
  product(id: $id) {
    id hasVariantsThatRequiresComponents
    media(first: 1) { nodes { id } }
    variants(first: 100) { nodes { id selectedOptions { name value } } }
  }
}`;

const VARIANTS_MUTATION = `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants { id }
    userErrors { field message }
  }
}`;

const PRODUCT_MUTATION = `mutation ($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
  productUpdate(product: $product, media: $media) {
    product { id handle status }
    userErrors { field message }
  }
}`;

const TAGS_MUTATION = `mutation ($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
}`;

async function gql(admin, query, variables) {
  const res = await admin.graphql(query, { variables });
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  return body.data;
}
const errs = (list) => (list || []).map((e) => e.message).join("; ");

async function loadPair(admin, shirtId, bootId) {
  const data = await gql(admin, PRODUCTS_QUERY, { ids: [pgid(shirtId), pgid(bootId)] });
  const [shirt, boot] = data.nodes || [];
  if (!shirt?.id) throw new Error(`Camisa ${shirtId} não encontrada.`);
  if (!boot?.id) throw new Error(`Botina ${bootId} não encontrada.`);
  for (const p of [shirt, boot]) {
    if (p.options.length !== 1) throw new Error(`"${p.title}" tem ${p.options.length} opções (esperado 1: tamanho).`);
    if (p.hasVariantsThatRequiresComponents) throw new Error(`"${p.title}" já é um bundle.`);
    if (p.variants.nodes.some((v) => /_FULL$/i.test(v.sku || ""))) throw new Error(`"${p.title}" é FULL (fora da regra).`);
  }
  return { shirt, boot };
}

// Linha (tamanho) → variante, pelo valor da única opção do produto.
const bySize = (p) => Object.fromEntries(p.variants.nodes.map((v) => [v.selectedOptions[0]?.value, v]));

function priceRange(shirt, boot, pct, fixed) {
  const sums = [];
  for (const s of shirt.variants.nodes) for (const b of boot.variants.nodes) sums.push(Number(s.price) + Number(b.price));
  const lo = Math.min(...sums);
  const hi = Math.max(...sums);
  return { compareAt: [lo.toFixed(2), hi.toFixed(2)], price: [kitVariantPrice(lo, pct, fixed), kitVariantPrice(hi, pct, fixed)] };
}

// Preço, compare-at e SKU de cada variante do kit (a partir dos componentes atuais).
// `manual` ({ price, compareAt }) = valores digitados na linha da tela: valem para TODAS as
// variantes do kit (compareAt vazio remove o riscado).
async function writeVariantPrices(admin, kit, shirt, boot, pct, fixed, manual = null) {
  const shirtBy = bySize(shirt);
  const bootBy = bySize(boot);
  const variants = kit.variants.nodes.map((v) => {
    const opt = Object.fromEntries(v.selectedOptions.map((o) => [o.name, o.value]));
    const s = shirtBy[opt[OPT_SHIRT]];
    const b = bootBy[opt[OPT_BOOT]];
    if (!s || !b) throw new Error(`Variante sem par: ${JSON.stringify(opt)}.`);
    const sum = Number(s.price) + Number(b.price);
    const price = manual ? manual.price : kitVariantPrice(sum, pct, fixed);
    const compareAtPrice = manual ? manual.compareAt : sum.toFixed(2);
    return { id: v.id, compareAtPrice, price, inventoryItem: { sku: `KIT-${s.sku}-${b.sku}` } };
  });
  const vr = (await gql(admin, VARIANTS_MUTATION, { productId: kit.id, variants })).productVariantsBulkUpdate;
  if (vr.userErrors?.length) throw new Error(errs(vr.userErrors));
  return variants;
}

// Preço manual da linha (opcional). Recusa riscado ≤ preço (desconto falso).
function parseManual(body) {
  if (body?.price == null || body.price === "") return null;
  const num = (v) => Number(String(v).replace(",", "."));
  const price = num(body.price);
  if (!(price > 0 && price < 100000)) throw new Error("Preço inválido.");
  const hasCmp = body.compareAt != null && body.compareAt !== "";
  const compareAt = hasCmp ? num(body.compareAt) : null;
  if (hasCmp && !(compareAt > price)) throw new Error("O preço riscado precisa ser maior que o preço.");
  return { price: price.toFixed(2), compareAt: hasCmp ? compareAt.toFixed(2) : null };
}

async function loadKit(admin, productId) {
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(String(productId))) throw new Error("Produto inválido.");
  const kit = (await gql(admin, KIT_VARIANTS_QUERY, { id: productId })).product;
  if (!kit?.hasVariantsThatRequiresComponents) throw new Error("Kit não encontrado (ou não é bundle).");
  return kit;
}

// Kit (bundle) já existente com este título; `complete` = finish já rodou por inteiro.
async function findExisting(admin, title) {
  const data = await gql(admin, FIND_QUERY, { q: `title:${JSON.stringify(title)}` });
  const p = (data.products.nodes || []).find((n) => n.title === title && n.hasVariantsThatRequiresComponents);
  if (!p) return null;
  const complete =
    KIT_TAGS.every((t) => p.tags.includes(t)) && p.variants.nodes[0]?.compareAtPrice != null && p.media.nodes.length > 0;
  const v = p.variants.nodes[0] || {};
  return { id: p.id, complete, price: v.price ?? null, compareAt: v.compareAtPrice ?? null };
}

function descriptionHtml(shirt, boot) {
  const li = (p) => `<li>${p.title}</li>`;
  return `<p>Kit com:</p><ul>${li(shirt)}${li(boot)}</ul><p>Escolha o tamanho da camisa e da botina.</p>`;
}

export const action = async ({ request, context }) => {
  const { admin } = await getShopify(context.env).authenticate.admin(request);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "JSON inválido." });
  }
  const { intent, shirtId, bootId } = body || {};
  const pct = Number(body?.pct);
  const fixed = body?.fixed == null || body.fixed === "" ? null : Number(body.fixed);
  try {
    if (["preview", "create", "finish", "reprice"].includes(intent)) {
      if (!ID_RE.test(String(shirtId)) || !ID_RE.test(String(bootId))) throw new Error("IDs inválidos.");
      if (!(pct >= 0 && pct < 90)) throw new Error("Desconto inválido.");
      if (fixed != null && !(fixed > 0 && fixed < 100000)) throw new Error("Preço fixo inválido.");
    }

    // Dry-run: monta o kit sem gravar nada.
    if (intent === "preview") {
      const { shirt, boot } = await loadPair(admin, shirtId, bootId);
      const title = kitTitle(shirt, boot);
      const existing = await findExisting(admin, title);
      return json({
        ok: true,
        title,
        shirtSizes: shirt.options[0].values,
        bootSizes: boot.options[0].values,
        variants: shirt.options[0].values.length * boot.options[0].values.length,
        ...priceRange(shirt, boot, pct, fixed),
        existing: existing?.id || null,
        existingComplete: Boolean(existing?.complete),
        current: existing ? { price: existing.price, compareAt: existing.compareAt } : null,
      });
    }

    // Dispara a criação (assíncrona). Recusa se já existir kit com o mesmo título.
    if (intent === "create") {
      const { shirt, boot } = await loadPair(admin, shirtId, bootId);
      const title = kitTitle(shirt, boot);
      if (await findExisting(admin, title)) throw new Error(`Já existe: "${title}".`);
      const component = (p, name) => ({
        productId: p.id,
        quantity: 1,
        optionSelections: [{ componentOptionId: p.options[0].id, name, values: p.options[0].values }],
      });
      const data = await gql(admin, CREATE_MUTATION, {
        input: { title, components: [component(shirt, OPT_SHIRT), component(boot, OPT_BOOT)] },
      });
      const r = data.productBundleCreate;
      if (r.userErrors?.length) throw new Error(errs(r.userErrors));
      return json({ ok: true, title, operationId: r.productBundleOperation.id });
    }

    if (intent === "status") {
      if (!/^gid:\/\/shopify\/ProductBundleOperation\/\d+$/.test(String(body.operationId))) throw new Error("Operação inválida.");
      const data = await gql(admin, OP_QUERY, { id: body.operationId });
      const op = data.productOperation;
      if (op?.userErrors?.length) throw new Error(errs(op.userErrors));
      return json({ ok: true, status: op?.status || null, productId: op?.product?.id || null });
    }

    // Completa o kit criado: preço/compare-at/SKU por variante, tags, descrição, fotos, status.
    if (intent === "finish") {
      const { shirt, boot } = await loadPair(admin, shirtId, bootId);
      const kit = await loadKit(admin, body.productId);
      const variants = await writeVariantPrices(admin, kit, shirt, boot, pct, fixed);

      // Fotos só se o kit ainda não tem nenhuma (repetir o finish não duplica).
      const media = kit.media.nodes.length ? [] : [shirt, boot]
        .map((p) => p.featuredMedia?.preview?.image?.url)
        .filter(Boolean)
        .map((url, i) => ({ originalSource: url, mediaContentType: "IMAGE", alt: i === 0 ? shirt.title : boot.title }));
      const product = {
        id: kit.id,
        productType: "Kit",
        vendor: shirt.vendor,
        descriptionHtml: descriptionHtml(shirt, boot),
        status: body.active ? "ACTIVE" : "DRAFT",
        // Teste: fora da busca e do sitemap da loja (só abre por URL direta).
        ...(body.seoHidden ? { metafields: [{ namespace: "seo", key: "hidden", type: "number_integer", value: "1" }] } : {}),
      };
      const pr = (await gql(admin, PRODUCT_MUTATION, { product, media })).productUpdate;
      if (pr.userErrors?.length) throw new Error(errs(pr.userErrors));
      const tr = (await gql(admin, TAGS_MUTATION, { id: kit.id, tags: KIT_TAGS })).tagsAdd;
      if (tr.userErrors?.length) throw new Error(errs(tr.userErrors));
      return json({ ok: true, productId: kit.id, handle: pr.product.handle, status: pr.product.status, variants: variants.length });
    }

    // Só regrava preço/compare-at/SKU de um kit existente (não mexe em fotos, tags, status).
    if (intent === "reprice") {
      const { shirt, boot } = await loadPair(admin, shirtId, bootId);
      const kit = await loadKit(admin, body.productId);
      const manual = parseManual(body);
      const variants = await writeVariantPrices(admin, kit, shirt, boot, pct, fixed, manual);
      return json({ ok: true, productId: kit.id, variants: variants.length, price: variants[0]?.price, compareAt: variants[0]?.compareAtPrice });
    }

    return json({ ok: false, error: "Intent desconhecido." });
  } catch (e) {
    return json({ ok: false, error: e?.message || String(e) });
  }
};

