import { json } from "@remix-run/cloudflare";
import {
  useLoaderData,
  useActionData,
  useSubmit,
  useNavigation,
} from "@remix-run/react";
import { useState, useCallback, useMemo, useRef } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Banner,
  Thumbnail,
  Select,
  Badge,
  Box,
  Divider,
  EmptyState,
  IndexTable,
  useIndexResourceState,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

import { getShopify } from "../shopify.server";

const NS = "brk_groups";
const KEY_LISTING = "combined_listing"; // per-product json: { groupId, optionName, swatchSource, items:[{id,value,color}] }
const KEY_GROUP = "product_group"; // per-product list.product_reference: irmãos do grupo — resolução por ID (à prova de mudança de handle)
const KEY_INDEX = "index"; // shop metafield (admin index)

function numericId(gid) {
  return Number(String(gid).split("/").pop());
}

const SWATCH_SOURCES = [
  { label: "Primeira imagem do produto", value: "first" },
  { label: "Segunda imagem do produto", value: "second" },
  { label: "Última imagem do produto", value: "last" },
  { label: "Cor / imagem custom", value: "custom" },
];

const STATUS_OPTIONS = [
  { label: "Ativo", value: "active" },
  { label: "Rascunho", value: "draft" },
  { label: "Arquivado", value: "archived" },
];

const PAGE_SIZE_OPTIONS = [
  { label: "10 por página", value: "10" },
  { label: "25 por página", value: "25" },
  { label: "50 por página", value: "50" },
  { label: "100 por página", value: "100" },
  { label: "150 por página", value: "150" },
  { label: "Todos", value: "all" },
];

// ── GraphQL helpers ─────────────────────────────────────────────────────────

async function ensureDefinitions(admin) {
  // Cria as metafield definitions (idempotente). Leitura no Online Store p/ Liquid.
  const defs = [
    { name: "Combined Listing (BRK)", key: KEY_LISTING, type: "json" },
    { name: "Grupo de Produtos (BRK)", key: KEY_GROUP, type: "list.product_reference" },
  ];
  for (const d of defs) {
    await admin.graphql(
      `mutation create($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition { id }
          userErrors { code message }
        }
      }`,
      {
        variables: {
          definition: {
            name: d.name,
            namespace: NS,
            key: d.key,
            ownerType: "PRODUCT",
            type: d.type,
            access: { storefront: "PUBLIC_READ" },
          },
        },
      }
    ).catch(() => {});
  }
}

async function loadIndex(admin) {
  const res = await admin.graphql(
    `query {
      shop {
        id
        metafield(namespace: "${NS}", key: "${KEY_INDEX}") { value }
      }
    }`
  );
  const data = await res.json();
  const shopId = data.data.shop.id;
  const raw = data.data.shop.metafield?.value;
  let groups = [];
  try {
    groups = raw ? JSON.parse(raw) : [];
  } catch {
    groups = [];
  }
  return { shopId, groups };
}

async function saveIndex(admin, shopId, groups) {
  const res = await admin.graphql(
    `mutation set($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: [{
          ownerId: shopId,
          namespace: NS,
          key: KEY_INDEX,
          type: "json",
          value: JSON.stringify(groups),
        }],
      },
    }
  );
  const data = await res.json();
  return data.data.metafieldsSet.userErrors;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Monta os 2 valores de metafield (iguais p/ todos os produtos do grupo):
// - combined_listing (json): rótulos/cores por id + optionName/swatchSource
// - product_group (list.product_reference): GIDs dos irmãos (resolução por ID)
function buildGroupPayloads(id, optionName, swatchSource, products) {
  const combined = JSON.stringify({
    groupId: id,
    optionName,
    swatchSource: swatchSource || "first",
    items: products.map((p) => ({
      id: numericId(p.productGid),
      value: p.value || "",
      color: p.color || null,
    })),
  });
  const groupRefs = JSON.stringify(products.map((p) => p.productGid));
  return { combined, groupRefs };
}

// Lista plana de objetos metafieldsSet (2 por produto do grupo).
function groupMetafieldObjects(products, combined, groupRefs) {
  const out = [];
  for (const p of products) {
    out.push({ ownerId: p.productGid, namespace: NS, key: KEY_LISTING, type: "json", value: combined });
    out.push({ ownerId: p.productGid, namespace: NS, key: KEY_GROUP, type: "list.product_reference", value: groupRefs });
  }
  return out;
}

// Executa tarefas com concorrência limitada (reduz tempo total sem estourar throttle).
async function runConcurrent(tasks, limit) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      await tasks[idx]();
    }
  });
  await Promise.all(workers);
}

async function setMetafieldsChunked(admin, metafields) {
  const tasks = chunk(metafields, 25).map((group) => () =>
    admin.graphql(
      `mutation set($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`,
      { variables: { metafields: group } }
    )
  );
  await runConcurrent(tasks, 3);
}

// Apaga os dois metafields (combined_listing + product_group) dos produtos dados.
async function deleteGroupMetafields(admin, productGids) {
  const ids = productGids.filter(Boolean);
  if (ids.length === 0) return;
  const identifiers = [];
  for (const gid of ids) {
    identifiers.push({ ownerId: gid, namespace: NS, key: KEY_LISTING });
    identifiers.push({ ownerId: gid, namespace: NS, key: KEY_GROUP });
  }
  const tasks = chunk(identifiers, 25).map((group) => () =>
    admin.graphql(
      `mutation del($metafields: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $metafields) { userErrors { field message } }
      }`,
      { variables: { metafields: group } }
    )
  );
  await runConcurrent(tasks, 3);
}

// ── CSV (import/export) ──────────────────────────────────────────────────────

// Parser CSV simples mas correto: lida com aspas, "" escapado, vírgulas e
// quebras de linha dentro de aspas, e CRLF/LF.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (c === "\r") {
      if (text[i + 1] !== "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function csvSwatchSource(s) {
  const v = (s || "").trim().toLowerCase();
  if (["first", "second", "last", "custom"].includes(v)) return v;
  if (v.includes("second")) return "second";
  if (v.includes("last")) return "last";
  if (v.includes("custom") || v.includes("color") || v.includes("cor")) return "custom";
  return "first";
}

// Resolve handles -> { gid, title, image } em lotes (poucas queries).
async function resolveHandles(admin, handles) {
  const map = new Map();
  const BATCH = 40;
  for (let i = 0; i < handles.length; i += BATCH) {
    const slice = handles.slice(i, i + BATCH);
    const q = slice.map((h) => `handle:${h}`).join(" OR ");
    const res = await admin.graphql(
      `query ($q: String!) {
        products(first: 250, query: $q) {
          edges { node { id title handle featuredImage { url } } }
        }
      }`,
      { variables: { q } }
    );
    const data = await res.json();
    for (const e of data.data.products.edges) {
      map.set(e.node.handle, {
        gid: e.node.id,
        title: e.node.title,
        image: e.node.featuredImage?.url ?? null,
      });
    }
  }
  return map;
}

// ── Loader ────────────────────────────────────────────────────────────────

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { admin } = await shopify.authenticate.admin(request);

  await ensureDefinitions(admin);
  const { groups } = await loadIndex(admin);

  return json({ groups });
};

// ── Action ──────────────────────────────────────────────────────────────────

export const action = async ({ request, context }) => {
  try {
    const shopify = getShopify(context.env);
    const { admin } = await shopify.authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    const { shopId, groups } = await loadIndex(admin);

    if (intent === "save") {
      const group = JSON.parse(formData.get("group"));

      if (!group.optionName || !group.products || group.products.length < 2) {
        return json({ success: false, error: "Defina o nome da opção e ao menos 2 produtos." });
      }

      // id estável
      let id = group.id;
      if (!id) id = `g_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      const { combined, groupRefs } = buildGroupPayloads(id, group.optionName, group.swatchSource, group.products);

      // produtos que estavam no grupo antes (para limpar os removidos)
      const prev = groups.find((g) => g.id === id);
      const prevGids = prev ? prev.products.map((p) => p.productGid) : [];
      const currentGids = new Set(group.products.map((p) => p.productGid));
      const removedGids = prevGids.filter((gid) => !currentGids.has(gid));

      if (group.status === "active") {
        await setMetafieldsChunked(admin, groupMetafieldObjects(group.products, combined, groupRefs));
      } else {
        // grupo não-ativo: não renderiza na loja
        await deleteGroupMetafields(admin, group.products.map((p) => p.productGid));
      }
      await deleteGroupMetafields(admin, removedGids);

      const entry = {
        id,
        name: group.name || id,
        optionName: group.optionName,
        status: group.status || "active",
        swatchSource: group.swatchSource || "first",
        products: group.products,
      };
      const i = groups.findIndex((g) => g.id === id);
      if (i >= 0) groups[i] = entry; else groups.push(entry);

      const errs = await saveIndex(admin, shopId, groups);
      if (errs.length) return json({ success: false, error: errs.map((e) => e.message).join(", ") });

      return json({ success: true, action: "save", id });
    }

    if (intent === "delete") {
      const id = formData.get("id");
      const target = groups.find((g) => g.id === id);
      if (target) {
        await deleteGroupMetafields(admin, target.products.map((p) => p.productGid));
      }
      const next = groups.filter((g) => g.id !== id);
      const errs = await saveIndex(admin, shopId, next);
      if (errs.length) return json({ success: false, error: errs.map((e) => e.message).join(", ") });
      return json({ success: true, action: "delete" });
    }

    if (intent === "deleteMany") {
      const ids = JSON.parse(formData.get("ids") || "[]");
      const idSet = new Set(ids);
      const targets = groups.filter((g) => idSet.has(g.id));
      const gids = targets.flatMap((g) => g.products.map((p) => p.productGid));
      await deleteGroupMetafields(admin, gids);
      const next = groups.filter((g) => !idSet.has(g.id));
      const errs = await saveIndex(admin, shopId, next);
      if (errs.length) return json({ success: false, error: errs.map((e) => e.message).join(", ") });
      return json({ success: true, action: "deleteMany", count: targets.length });
    }

    if (intent === "import") {
      const csv = formData.get("csv");
      if (!csv) return json({ success: false, error: "Arquivo CSV vazio." });

      const rows = parseCSV(csv).filter(
        (r) => r.length > 1 || (r.length === 1 && r[0].trim() !== "")
      );
      if (rows.length < 2) return json({ success: false, error: "CSV sem linhas de dados." });

      const header = rows[0].map((h) => h.trim().toLowerCase());
      const ci = {
        group: header.indexOf("group"),
        option: header.indexOf("option_name"),
        status: header.indexOf("status"),
        source: header.indexOf("swatch_source"),
        handle: header.indexOf("product_handle"),
        value: header.indexOf("value"),
        color: header.indexOf("color"),
      };
      if (ci.group < 0 || ci.handle < 0) {
        return json({ success: false, error: "CSV precisa ao menos das colunas 'group' e 'product_handle'." });
      }
      const cell = (cells, idx) => (idx >= 0 ? (cells[idx] || "").trim() : "");

      // Agrupa as linhas por nome do grupo
      const byGroup = new Map();
      for (let r = 1; r < rows.length; r++) {
        const cells = rows[r];
        const gname = cell(cells, ci.group);
        const handle = cell(cells, ci.handle);
        if (!gname || !handle) continue;
        if (!byGroup.has(gname)) {
          byGroup.set(gname, {
            name: gname,
            optionName: cell(cells, ci.option),
            status: (cell(cells, ci.status) || "active").toLowerCase(),
            swatchSource: ci.source >= 0 ? csvSwatchSource(cells[ci.source]) : "first",
            products: [],
          });
        }
        const g = byGroup.get(gname);
        if (!g.optionName) g.optionName = cell(cells, ci.option);
        g.products.push({ handle, value: cell(cells, ci.value), color: cell(cells, ci.color) });
      }

      // Resolve todos os handles de uma vez
      const allHandles = [...new Set([...byGroup.values()].flatMap((g) => g.products.map((p) => p.handle)))];
      const resolved = await resolveHandles(admin, allHandles);

      const missing = new Set();
      const writes = []; // objetos metafieldsSet
      const deletes = []; // gids
      let importedGroups = 0;
      let skippedGroups = 0;

      for (const g of byGroup.values()) {
        const products = [];
        for (const p of g.products) {
          const r = resolved.get(p.handle);
          if (!r) { missing.add(p.handle); continue; }
          products.push({
            productGid: r.gid, handle: p.handle, title: r.title, image: r.image,
            value: p.value, color: p.color,
          });
        }
        if (products.length < 2) { skippedGroups++; continue; }

        const existing = groups.find((x) => x.name === g.name || x.id === g.name);
        const id = existing ? existing.id : `g_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const status = ["active", "draft", "archived"].includes(g.status) ? g.status : "active";
        const swatchSource = ["first", "second", "last", "custom"].includes(g.swatchSource) ? g.swatchSource : "first";

        const { combined, groupRefs } = buildGroupPayloads(id, g.optionName, swatchSource, products);
        if (status === "active") {
          writes.push(...groupMetafieldObjects(products, combined, groupRefs));
        } else {
          for (const p of products) deletes.push(p.productGid);
        }

        const entry = { id, name: g.name, optionName: g.optionName, status, swatchSource, products };
        const i = groups.findIndex((x) => x.id === id);
        if (i >= 0) groups[i] = entry; else groups.push(entry);
        importedGroups++;
      }

      await setMetafieldsChunked(admin, writes);
      await deleteGroupMetafields(admin, deletes);
      const errs = await saveIndex(admin, shopId, groups);
      if (errs.length) return json({ success: false, error: errs.map((e) => e.message).join(", ") });

      return json({
        success: true,
        action: "import",
        importedGroups,
        skippedGroups,
        missingCount: missing.size,
        missing: [...missing].slice(0, 30),
      });
    }

    return json({ success: false, error: "Ação inválida." });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[grupos-de-produtos action]", err);
    return json({ success: false, error: `Erro interno: ${err?.message}` });
  }
};

// ── Component ─────────────────────────────────────────────────────────────

const STATUS_TONE = { active: "success", draft: "attention", archived: undefined };

function blankGroup() {
  return { id: "", name: "", optionName: "", status: "active", swatchSource: "first", products: [] };
}

export default function GruposDeProdutos() {
  const { groups } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [editing, setEditing] = useState(null); // null = lista; objeto = editor
  const isSubmitting = navigation.state === "submitting";

  const startNew = useCallback(() => setEditing(blankGroup()), []);
  const startEdit = useCallback((g) => setEditing(JSON.parse(JSON.stringify(g))), []);
  const cancel = useCallback(() => setEditing(null), []);

  const handleAddProducts = useCallback(async () => {
    const picked = await shopify.resourcePicker({ type: "product", multiple: true, action: "select" });
    if (!picked || picked.length === 0) return;
    setEditing((cur) => {
      const existing = new Map(cur.products.map((p) => [p.productGid, p]));
      for (const p of picked) {
        if (existing.has(p.id)) continue;
        existing.set(p.id, {
          productGid: p.id,
          handle: p.handle,
          title: p.title,
          image: p.images?.[0]?.originalSrc ?? p.images?.[0]?.src ?? null,
          value: "",
          color: "",
        });
      }
      return { ...cur, products: Array.from(existing.values()) };
    });
  }, [shopify]);

  const updateProduct = useCallback((gid, field, val) => {
    setEditing((cur) => ({
      ...cur,
      products: cur.products.map((p) => (p.productGid === gid ? { ...p, [field]: val } : p)),
    }));
  }, []);

  const removeProduct = useCallback((gid) => {
    setEditing((cur) => ({ ...cur, products: cur.products.filter((p) => p.productGid !== gid) }));
  }, []);

  const handleSave = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "save");
    fd.set("group", JSON.stringify(editing));
    submit(fd, { method: "post" });
    setEditing(null);
  }, [editing, submit]);

  // ── Export / Import CSV ──
  const fileRef = useRef(null);

  const handleExport = useCallback(() => {
    const esc = (v) => {
      const s = String(v ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["group", "option_name", "status", "swatch_source", "product_handle", "value", "color"];
    const lines = [header.join(",")];
    for (const g of groups) {
      for (const p of g.products || []) {
        lines.push([g.name || g.id, g.optionName, g.status, g.swatchSource, p.handle, p.value, p.color || ""].map(esc).join(","));
      }
    }
    // BOM p/ Excel abrir acentos corretamente
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "grupos-de-produtos.csv";
    a.click();
    URL.revokeObjectURL(url);
  }, [groups]);

  const handleImportFile = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const fd = new FormData();
      fd.set("intent", "import");
      fd.set("csv", String(reader.result || ""));
      submit(fd, { method: "post" });
    };
    reader.readAsText(file, "utf-8");
    e.target.value = ""; // permite reimportar o mesmo arquivo
  }, [submit]);

  // ── Paginação + seleção múltipla (IndexTable) ──
  const [pageSize, setPageSize] = useState("25");
  const [page, setPage] = useState(0);

  const pageSizeNum = pageSize === "all" ? Math.max(groups.length, 1) : Number(pageSize);
  const pageCount = Math.max(1, Math.ceil(groups.length / pageSizeNum));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = useMemo(
    () => groups.slice(safePage * pageSizeNum, safePage * pageSizeNum + pageSizeNum),
    [groups, safePage, pageSizeNum]
  );

  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(pageItems);

  const changePageSize = useCallback((v) => { setPageSize(v); setPage(0); clearSelection(); }, [clearSelection]);
  const goPrev = useCallback(() => { setPage((p) => Math.max(0, p - 1)); clearSelection(); }, [clearSelection]);
  const goNext = useCallback(() => { setPage((p) => p + 1); clearSelection(); }, [clearSelection]);

  const handleBulkDelete = useCallback(() => {
    if (selectedResources.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "deleteMany");
    fd.set("ids", JSON.stringify(selectedResources));
    submit(fd, { method: "post" });
    clearSelection();
  }, [selectedResources, submit, clearSelection]);

  const canSave = useMemo(() => {
    if (!editing) return false;
    return editing.optionName.trim() !== "" && editing.products.length >= 2 &&
      editing.products.every((p) => p.value.trim() !== "");
  }, [editing]);

  // ── Editor ──
  if (editing) {
    const isCustom = editing.swatchSource === "custom";
    return (
      <Page
        title={editing.id ? "Editar grupo" : "Novo grupo"}
        backAction={{ content: "Grupos", onAction: cancel }}
        primaryAction={{ content: "Salvar", onAction: handleSave, disabled: !canSave, loading: isSubmitting }}
      >
        <BlockStack gap="500">
          {!canSave && (
            <Banner tone="info">
              <p>Informe o <strong>nome da opção</strong>, adicione <strong>2+ produtos</strong> e preencha o <strong>valor</strong> de cada um.</p>
            </Banner>
          )}
          <Layout>
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <TextField
                    label="Nome do grupo (referência interna)"
                    value={editing.name}
                    onChange={(v) => setEditing((c) => ({ ...c, name: v }))}
                    autoComplete="off"
                    placeholder="Ex: C02615"
                  />
                  <TextField
                    label="Nome da opção (visível na loja)"
                    value={editing.optionName}
                    onChange={(v) => setEditing((c) => ({ ...c, optionName: v }))}
                    autoComplete="off"
                    placeholder="Ex: Modelo:"
                  />
                </BlockStack>
              </Card>

              <Box paddingBlockStart="400">
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">Produtos do grupo</Text>
                      <Button onClick={handleAddProducts}>Adicionar produtos</Button>
                    </InlineStack>

                    {editing.products.length === 0 && (
                      <Text as="p" tone="subdued">Nenhum produto. Clique em "Adicionar produtos".</Text>
                    )}

                    <BlockStack gap="300">
                      {editing.products.map((p) => (
                        <Box key={p.productGid} padding="300" borderWidth="025" borderColor="border" borderRadius="200">
                          <InlineStack gap="400" blockAlign="center" wrap={false}>
                            {p.image && <Thumbnail source={p.image} alt={p.title} size="small" />}
                            <Box minWidth="0" width="100%">
                              <BlockStack gap="200">
                                <Text as="span" variant="bodyMd" truncate>{p.title}</Text>
                                <InlineStack gap="300" wrap>
                                  <Box minWidth="180px">
                                    <TextField
                                      label="Valor (ex: Masculino)"
                                      labelHidden
                                      value={p.value}
                                      onChange={(v) => updateProduct(p.productGid, "value", v)}
                                      autoComplete="off"
                                      placeholder="Valor da opção"
                                    />
                                  </Box>
                                  {isCustom && (
                                    <Box minWidth="140px">
                                      <TextField
                                        label="Cor (hex)"
                                        labelHidden
                                        value={p.color}
                                        onChange={(v) => updateProduct(p.productGid, "color", v)}
                                        autoComplete="off"
                                        placeholder="#000000"
                                      />
                                    </Box>
                                  )}
                                </InlineStack>
                              </BlockStack>
                            </Box>
                            <Button variant="plain" tone="critical" onClick={() => removeProduct(p.productGid)}>
                              Remover
                            </Button>
                          </InlineStack>
                        </Box>
                      ))}
                    </BlockStack>
                  </BlockStack>
                </Card>
              </Box>
            </Layout.Section>

            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="400">
                  <Select
                    label="Status"
                    options={STATUS_OPTIONS}
                    value={editing.status}
                    onChange={(v) => setEditing((c) => ({ ...c, status: v }))}
                  />
                  <Select
                    label="Fonte da imagem do swatch"
                    options={SWATCH_SOURCES}
                    value={editing.swatchSource}
                    onChange={(v) => setEditing((c) => ({ ...c, swatchSource: v }))}
                  />
                  <Divider />
                  <Text as="p" variant="bodySm" tone="subdued">
                    Só grupos <strong>Ativos</strong> aparecem na loja. Os swatches são renderizados nativamente pelo app block "Grupo de Variantes" no Product Information.
                  </Text>
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>
        </BlockStack>
      </Page>
    );
  }

  // ── Lista ──
  const isImporting = isSubmitting && navigation.formData?.get("intent") === "import";
  return (
    <Page
      title="Grupos de Produtos"
      subtitle="Agrupe produtos relacionados (ex: Masculino / Feminino / Infantil) e mostre swatches clicáveis na página de produto — nativo, sem app externo."
      primaryAction={{ content: "Novo grupo", onAction: startNew }}
      secondaryActions={[
        { content: "Exportar CSV", onAction: handleExport, disabled: groups.length === 0 },
        { content: "Importar CSV", onAction: () => fileRef.current?.click(), loading: isImporting },
      ]}
    >
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        onChange={handleImportFile}
        style={{ display: "none" }}
      />
      <BlockStack gap="500">
        {actionData?.success && actionData.action === "save" && (
          <Banner tone="success" title="Grupo salvo!" />
        )}
        {actionData?.success && actionData.action === "delete" && (
          <Banner tone="success" title="Grupo excluído." />
        )}
        {actionData?.success && actionData.action === "deleteMany" && (
          <Banner tone="success" title={`${actionData.count} grupo(s) excluído(s).`} />
        )}
        {actionData?.success && actionData.action === "import" && (
          <Banner tone={actionData.missingCount > 0 ? "warning" : "success"} title={`Importação concluída: ${actionData.importedGroups} grupo(s).`}>
            <BlockStack gap="100">
              {actionData.skippedGroups > 0 && (
                <Text as="p" variant="bodySm">{actionData.skippedGroups} grupo(s) ignorado(s) (menos de 2 produtos válidos).</Text>
              )}
              {actionData.missingCount > 0 && (
                <Text as="p" variant="bodySm">
                  {actionData.missingCount} handle(s) não encontrado(s) na loja: {actionData.missing.join(", ")}{actionData.missingCount > actionData.missing.length ? "…" : ""}
                </Text>
              )}
            </BlockStack>
          </Banner>
        )}
        {actionData?.error && (
          <Banner tone="critical" title="Erro"><p>{actionData.error}</p></Banner>
        )}

        <Banner tone="info">
          <Text as="p" variant="bodySm">
            <strong>Formato do CSV:</strong> colunas <code>group, option_name, status, swatch_source, product_handle, value, color</code> — uma linha por produto, repetindo os campos do grupo. <code>status</code>: active/draft/archived. <code>swatch_source</code>: first/second/last/custom. Exporte para ver um modelo preenchido.
          </Text>
        </Banner>

        {groups.length === 0 ? (
          <Card>
            <EmptyState
              heading="Nenhum grupo ainda"
              action={{ content: "Novo grupo", onAction: startNew }}
              image="https://cdn.shopify.com/shopifycloud/web/assets/v1/vite/client/en/assets/personalized-empty-state-Bu4xlcHV0rQu.svg"
            >
              <p>Crie um grupo para conectar produtos e exibir os swatches na página de produto.</p>
            </EmptyState>
          </Card>
        ) : (
          <Card padding="0">
            <Box padding="300" borderBlockEndWidth="025" borderColor="border">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="span" variant="bodySm" tone="subdued">
                  {groups.length} grupo(s){selectedResources.length > 0 ? ` · ${selectedResources.length} selecionado(s)` : ""}
                </Text>
                <Box minWidth="190px">
                  <Select
                    label="Por página"
                    labelInline
                    options={PAGE_SIZE_OPTIONS}
                    value={pageSize}
                    onChange={changePageSize}
                  />
                </Box>
              </InlineStack>
            </Box>
            <IndexTable
              resourceName={{ singular: "grupo", plural: "grupos" }}
              itemCount={pageItems.length}
              selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              bulkActions={[
                { content: "Excluir selecionados", destructive: true, onAction: handleBulkDelete },
              ]}
              headings={[{ title: "Grupo" }, { title: "Opção" }, { title: "Produtos" }]}
              pagination={
                pageCount > 1
                  ? {
                      hasPrevious: safePage > 0,
                      hasNext: safePage < pageCount - 1,
                      onPrevious: goPrev,
                      onNext: goNext,
                      label: `Página ${safePage + 1} de ${pageCount}`,
                    }
                  : undefined
              }
            >
              {pageItems.map((g, index) => (
                <IndexTable.Row
                  id={g.id}
                  key={g.id}
                  position={index}
                  selected={selectedResources.includes(g.id)}
                  onClick={() => startEdit(g)}
                >
                  <IndexTable.Cell>
                    <InlineStack gap="300" blockAlign="center">
                      {g.products?.[0]?.image && (
                        <Thumbnail source={g.products[0].image} alt={g.name} size="small" />
                      )}
                      <BlockStack gap="050">
                        <Text as="span" variant="bodyMd" fontWeight="bold">{g.name || g.id}</Text>
                        <Badge tone={STATUS_TONE[g.status]}>
                          {STATUS_OPTIONS.find((s) => s.value === g.status)?.label ?? g.status}
                        </Badge>
                      </BlockStack>
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>{g.optionName}</IndexTable.Cell>
                  <IndexTable.Cell>{g.products?.length ?? 0}</IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
