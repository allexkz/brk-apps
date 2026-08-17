import { json } from "@remix-run/cloudflare";
import {
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import { useCallback, useState } from "react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Box,
  TextField,
  FormLayout,
  EmptyState,
  Tag,
  Modal,
  ButtonGroup,
} from "@shopify/polaris";

import { getShopify } from "../shopify.server";
import { loadSellers, saveSellers, normalizeStr } from "../vendedores";

// ── Loader ──

export const loader = async ({ request, context }) => {
  const shopify = getShopify(context.env);
  const { admin } = await shopify.authenticate.admin(request);
  const { sellers } = await loadSellers(admin);
  return json({ sellers });
};

// ── Action ──

export const action = async ({ request, context }) => {
  try {
    const shopify = getShopify(context.env);
    const { admin } = await shopify.authenticate.admin(request);
    const form = await request.formData();
    const intent = form.get("intent");

    const { shopId, sellers } = await loadSellers(admin);

    if (intent === "save") {
      const originalName = String(form.get("originalName") || "").trim();
      const name = String(form.get("name") || "").trim();
      const tags = JSON.parse(form.get("tags") || "[]")
        .map((t) => String(t).trim())
        .filter(Boolean);

      if (!name) return json({ success: false, error: "Informe o nome do vendedor." });
      if (tags.length === 0) return json({ success: false, error: "Adicione pelo menos uma tag." });

      // Remove a entrada antiga (caso tenha renomeado) e qualquer duplicata pelo
      // nome novo, depois insere a versao atual.
      const next = sellers.filter(
        (s) =>
          normalizeStr(s.name) !== normalizeStr(name) &&
          (!originalName || normalizeStr(s.name) !== normalizeStr(originalName))
      );
      next.push({ name, tags });
      next.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

      const errs = await saveSellers(admin, shopId, next);
      if (errs.length) return json({ success: false, error: errs.map((e) => e.message).join(", ") });
      return json({ success: true, action: "save", name });
    }

    if (intent === "delete") {
      const name = String(form.get("name") || "").trim();
      const next = sellers.filter((s) => normalizeStr(s.name) !== normalizeStr(name));
      const errs = await saveSellers(admin, shopId, next);
      if (errs.length) return json({ success: false, error: errs.map((e) => e.message).join(", ") });
      return json({ success: true, action: "delete", name });
    }

    return json({ success: false, error: "Acao invalida." });
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[cadastro-de-vendedores action]", err);
    return json({ success: false, error: `Erro interno: ${err?.message}` });
  }
};

// ── Component ──

export default function CadastroDeVendedores() {
  const { sellers } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [editing, setEditing] = useState(null); // { originalName } | null
  const [name, setName] = useState("");
  const [tags, setTags] = useState([]);
  const [tagInput, setTagInput] = useState("");

  const openNew = useCallback(() => {
    setEditing({ originalName: "" });
    setName("");
    setTags([]);
    setTagInput("");
  }, []);

  const openEdit = useCallback((s) => {
    setEditing({ originalName: s.name });
    setName(s.name);
    setTags(s.tags || []);
    setTagInput("");
  }, []);

  const closeModal = useCallback(() => setEditing(null), []);

  const addTag = useCallback(() => {
    const t = tagInput.trim();
    if (!t) return;
    setTags((prev) =>
      prev.some((x) => x.toLowerCase() === t.toLowerCase()) ? prev : [...prev, t]
    );
    setTagInput("");
  }, [tagInput]);

  const removeTag = useCallback((t) => {
    setTags((prev) => prev.filter((x) => x !== t));
  }, []);

  const save = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "save");
    fd.set("originalName", editing?.originalName || "");
    fd.set("name", name);
    fd.set("tags", JSON.stringify(tags));
    submit(fd, { method: "post" });
    setEditing(null);
  }, [editing, name, tags, submit]);

  const del = useCallback(
    (sellerName) => {
      const fd = new FormData();
      fd.set("intent", "delete");
      fd.set("name", sellerName);
      submit(fd, { method: "post" });
    },
    [submit]
  );

  return (
    <Page
      title="Cadastro de vendedores"
      subtitle="Associe as tags de pedido de cada vendedor. Pedidos com essas tags sao atribuidos ao vendedor na tarefa do ClickUp."
      backAction={{ content: "Personalizados", onAction: () => navigate("/app/personalizados") }}
      primaryAction={{ content: "Novo vendedor", onAction: openNew }}
    >
      <BlockStack gap="500">
        {actionData?.success && (
          <Banner
            tone="success"
            title={
              actionData.action === "delete"
                ? `Vendedor "${actionData.name}" removido.`
                : `Vendedor "${actionData.name}" salvo.`
            }
          />
        )}
        {actionData?.error && (
          <Banner tone="critical" title="Erro">
            <p>{actionData.error}</p>
          </Banner>
        )}

        {sellers.length === 0 ? (
          <Card>
            <EmptyState
              heading="Nenhum vendedor cadastrado"
              action={{ content: "Novo vendedor", onAction: openNew }}
              image="https://cdn.shopify.com/shopifycloud/web/assets/v1/vite/client/en/assets/personalized-empty-state-Bu4xlcHV0rQu.svg"
            >
              <p>Cadastre os vendedores e as tags de pedido de cada um.</p>
            </EmptyState>
          </Card>
        ) : (
          <Card padding="0">
            <BlockStack gap="0">
              {sellers.map((s, i) => (
                <Box
                  key={s.name}
                  padding="400"
                  borderBlockEndWidth={i < sellers.length - 1 ? "025" : "0"}
                  borderColor="border"
                >
                  <InlineStack align="space-between" blockAlign="center" wrap>
                    <BlockStack gap="150">
                      <Text as="h3" variant="headingMd">{s.name}</Text>
                      <InlineStack gap="150" wrap>
                        {(s.tags || []).length === 0 ? (
                          <Text as="span" tone="subdued" variant="bodySm">Sem tags</Text>
                        ) : (
                          (s.tags || []).map((t) => <Tag key={t}>{t}</Tag>)
                        )}
                      </InlineStack>
                    </BlockStack>
                    <ButtonGroup>
                      <Button onClick={() => openEdit(s)}>Editar</Button>
                      <Button
                        tone="critical"
                        variant="plain"
                        loading={isSubmitting}
                        onClick={() => del(s.name)}
                      >
                        Remover
                      </Button>
                    </ButtonGroup>
                  </InlineStack>
                </Box>
              ))}
            </BlockStack>
          </Card>
        )}

        <Box paddingBlockEnd="800" />
      </BlockStack>

      {editing && (
        <Modal
          open
          onClose={closeModal}
          title={editing.originalName ? `Editar ${editing.originalName}` : "Novo vendedor"}
          primaryAction={{
            content: "Salvar",
            onAction: save,
            disabled: !name.trim() || tags.length === 0,
          }}
          secondaryActions={[{ content: "Cancelar", onAction: closeModal }]}
        >
          <Modal.Section>
            <FormLayout>
              <TextField
                label="Nome do vendedor"
                value={name}
                onChange={setName}
                autoComplete="off"
                helpText='Deve ser igual a option no campo "Vendedores E-commerce" do ClickUp.'
              />
              <TextField
                label="Tags de pedido"
                value={tagInput}
                onChange={setTagInput}
                autoComplete="off"
                placeholder="Ex.: Francisca Aparecida"
                connectedRight={<Button onClick={addTag}>Adicionar</Button>}
                helpText="Adicione as tags que os pedidos desse vendedor recebem."
              />
              {tags.length > 0 && (
                <InlineStack gap="150" wrap>
                  {tags.map((t) => (
                    <Tag key={t} onRemove={() => removeTag(t)}>{t}</Tag>
                  ))}
                </InlineStack>
              )}
            </FormLayout>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
