/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";

const MEASUREMENT_UNITS = {
  weight: ["g", "kg", "oz", "lb"],
  volume: ["ml", "cl", "l", "m3", "us_fl_oz", "us_pt", "us_qt", "us_gal"],
  dimension: ["mm", "cm", "m", "in", "ft", "yd"],
};

async function adminQuery(query, variables = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch("shopify:admin/api/graphql.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === "AbortError") {
      throw new Error("Timeout (15s) ao chamar a Admin API");
    }
    throw e;
  }
}

async function fetchAllDefinitions() {
  const res = await adminQuery(
    `query {
      metafieldDefinitions(ownerType: PRODUCT, first: 50) {
        edges {
          node {
            id
            name
            namespace
            key
            type { name }
            description
            validations { name value }
          }
        }
      }
    }`
  );
  if (res.errors) {
    throw new Error(res.errors.map((e) => e.message).join(", "));
  }
  const edges = res.data?.metafieldDefinitions?.edges || [];
  return edges.map((e) => e.node);
}

function isMeasurementType(type) {
  return type === "weight" || type === "volume" || type === "dimension";
}

function isListType(type) {
  return type.startsWith("list.");
}

function isReferenceType(type) {
  return type.endsWith("_reference");
}

// Lê a validação "choices" (lista fixa de valores permitidos) da definição.
// Só existe para single_line_text_field e list.single_line_text_field.
function getChoices(def) {
  if (!def || !Array.isArray(def.validations)) return null;
  const v = def.validations.find((x) => x.name === "choices");
  if (!v || !v.value) return null;
  try {
    const parsed = JSON.parse(v.value);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((x) => String(x));
    }
  } catch {}
  return null;
}

function formatValue(type, rawValue, unit) {
  if (!rawValue && rawValue !== "0" && rawValue !== 0) return null;

  if (type === "boolean") return rawValue === "true" ? "true" : "false";
  if (type === "number_integer") return String(parseInt(rawValue, 10));
  if (type === "number_decimal") return String(parseFloat(rawValue));
  if (type === "json" || type === "rich_text_field") return rawValue;
  if (type === "rating") {
    try {
      return JSON.stringify(JSON.parse(rawValue));
    } catch {
      return JSON.stringify({ scale_min: "1.0", scale_max: "5.0", value: String(parseFloat(rawValue)) });
    }
  }
  if (isMeasurementType(type)) {
    return JSON.stringify({ value: parseFloat(rawValue), unit });
  }
  if (isListType(type)) {
    try {
      const parsed = JSON.parse(rawValue);
      if (Array.isArray(parsed)) return JSON.stringify(parsed);
    } catch {}
    return JSON.stringify(rawValue.split(",").map((v) => v.trim()).filter(Boolean));
  }
  return String(rawValue);
}

function parseExistingValue(type, value) {
  if (value == null) return { raw: "", unit: "" };

  if (isMeasurementType(type)) {
    try {
      const parsed = JSON.parse(value);
      return { raw: String(parsed.value ?? ""), unit: parsed.unit ?? "" };
    } catch {}
  }
  if (type === "rating") {
    try {
      const parsed = JSON.parse(value);
      return { raw: String(parsed.value ?? ""), unit: "" };
    } catch {}
  }
  if (isListType(type)) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return { raw: parsed.join(", "), unit: "" };
    } catch {}
  }
  return { raw: value, unit: "" };
}

export default async () => {
  render(<Extension />, document.body);
};

function Extension() {
  const selected = (shopify && shopify.data && shopify.data.selected) || [];
  const selectedCount = selected.length;

  const [definitions, setDefinitions] = useState([]);
  const [defsStatus, setDefsStatus] = useState("loading"); // loading | ready | error
  const [defsError, setDefsError] = useState("");

  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchAllDefinitions()
      .then((defs) => {
        if (cancelled) return;
        setDefinitions(defs);
        setDefsStatus("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setDefsError(String(e && e.message ? e.message : e));
        setDefsStatus("error");
      });
    return () => { cancelled = true; };
  }, []);

  const addField = useCallback(() => {
    if (definitions.length === 0) return;
    const def = definitions[0];
    setFields((prev) => [
      ...prev,
      {
        id: Date.now() + Math.random(),
        definitionId: def.id,
        namespace: def.namespace,
        key: def.key,
        type: def.type.name,
        value: "",
        unit: isMeasurementType(def.type.name) ? MEASUREMENT_UNITS[def.type.name][0] : "",
        action: "set",
      },
    ]);
  }, [definitions]);

  const selectDefinition = useCallback(
    (fieldId, defId) => {
      const def = definitions.find((d) => d.id === defId);
      if (!def) return;
      setFields((prev) =>
        prev.map((f) => {
          if (f.id !== fieldId) return f;
          return {
            ...f,
            definitionId: def.id,
            namespace: def.namespace,
            key: def.key,
            type: def.type.name,
            value: "",
            unit: isMeasurementType(def.type.name) ? MEASUREMENT_UNITS[def.type.name][0] : "",
          };
        })
      );
    },
    [definitions]
  );

  const updateField = useCallback((fieldId, prop, val) => {
    setFields((prev) =>
      prev.map((f) => (f.id !== fieldId ? f : { ...f, [prop]: val }))
    );
  }, []);

  const removeField = useCallback((fieldId) => {
    setFields((prev) => prev.filter((f) => f.id !== fieldId));
  }, []);

  const loadValues = useCallback(async () => {
    if (selectedCount === 0 || definitions.length === 0) return;
    setLoading(true);
    setError(null);

    try {
      const productId = selected[0].id;
      const res = await adminQuery(
        `query GetMetafields($id: ID!) {
          product(id: $id) {
            metafields(first: 100) {
              edges { node { namespace key type value } }
            }
          }
        }`,
        { id: productId }
      );

      const existing = res.data?.product?.metafields?.edges || [];
      const defMap = new Map(definitions.map((d) => [`${d.namespace}.${d.key}`, d]));

      const loaded = existing
        .filter((e) => defMap.has(`${e.node.namespace}.${e.node.key}`))
        .map((e) => {
          const m = e.node;
          const def = defMap.get(`${m.namespace}.${m.key}`);
          const { raw, unit } = parseExistingValue(m.type, m.value);
          return {
            id: Date.now() + Math.random(),
            definitionId: def.id,
            namespace: m.namespace,
            key: m.key,
            type: m.type,
            value: raw,
            unit: unit || (isMeasurementType(m.type) ? MEASUREMENT_UNITS[m.type][0] : ""),
            action: "set",
          };
        });

      if (loaded.length === 0) {
        setError("Nenhum metacampo com definição encontrado no primeiro produto.");
      } else {
        setFields(loaded);
      }
    } catch (e) {
      setError("Erro ao carregar valores: " + String(e && e.message ? e.message : e));
    }

    setLoading(false);
  }, [selected, selectedCount, definitions]);

  const handleApply = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setProgress("");

    const toSet = fields.filter((f) => f.action === "set" && f.key);
    const toDelete = fields.filter((f) => f.action === "delete" && f.key);

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    for (let i = 0; i < selectedCount; i++) {
      const productId = selected[i].id;
      setProgress(`Processando produto ${i + 1} de ${selectedCount}...`);

      if (toSet.length > 0) {
        const metafields = toSet.map((f) => ({
          ownerId: productId,
          namespace: f.namespace,
          key: f.key,
          type: f.type,
          value: formatValue(f.type, f.value, f.unit),
        }));

        try {
          const res = await adminQuery(
            `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                metafields { id }
                userErrors { field message }
              }
            }`,
            { metafields }
          );
          const userErrors = res.data?.metafieldsSet?.userErrors || [];
          if (userErrors.length > 0) {
            errorCount++;
            errors.push(`Produto ${i + 1}: ${userErrors.map((e) => e.message).join(", ")}`);
          } else if (res.errors) {
            errorCount++;
            errors.push(`Produto ${i + 1}: ${res.errors.map((e) => e.message).join(", ")}`);
          } else {
            successCount++;
          }
        } catch (e) {
          errorCount++;
          errors.push(`Produto ${i + 1}: ${String(e && e.message ? e.message : e)}`);
        }
      }

      if (toDelete.length > 0) {
        for (const f of toDelete) {
          try {
            const findRes = await adminQuery(
              `query FindMf($id: ID!, $ns: String!, $k: String!) {
                product(id: $id) { metafield(namespace: $ns, key: $k) { id } }
              }`,
              { id: productId, ns: f.namespace, k: f.key }
            );
            const mfId = findRes.data?.product?.metafield?.id;
            if (mfId) {
              const delRes = await adminQuery(
                `mutation MfDel($input: MetafieldDeleteInput!) {
                  metafieldDelete(input: $input) { userErrors { message } }
                }`,
                { input: { id: mfId } }
              );
              const delErrors = delRes.data?.metafieldDelete?.userErrors || [];
              if (delErrors.length > 0) {
                errors.push(`Produto ${i + 1} (del ${f.key}): ${delErrors.map((e) => e.message).join(", ")}`);
              }
            }
          } catch (e) {
            errors.push(`Produto ${i + 1} (del ${f.key}): ${String(e && e.message ? e.message : e)}`);
          }
        }
        if (!toSet.length) successCount++;
      }
    }

    setProgress("");
    if (errors.length > 0) setError(errors.join("\n"));
    setResult(
      `Concluído: ${successCount} produto(s) atualizado(s)` +
        (errorCount > 0 ? `, ${errorCount} erro(s)` : "")
    );
    setLoading(false);
  }, [fields, selected, selectedCount]);

  const canAdd = defsStatus === "ready" && definitions.length > 0;

  return (
    <s-admin-action heading="Editar Metacampos" loading={loading}>
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-badge tone="info">{selectedCount} produto(s) selecionado(s)</s-badge>
          <s-button variant="tertiary" onClick={loadValues} disabled={loading || !canAdd}>
            Carregar valores do 1º produto
          </s-button>
        </s-stack>

        {defsStatus === "loading" && (
          <s-text color="subdued">Carregando definições de metacampos...</s-text>
        )}

        {defsStatus === "error" && (
          <s-banner tone="critical" heading="Falha ao carregar metacampos">
            {defsError}
          </s-banner>
        )}

        {defsStatus === "ready" && definitions.length === 0 && (
          <s-banner tone="warning">
            Nenhuma definição de metacampo de produto encontrada. Crie em Configurações &gt; Dados personalizados &gt; Produtos.
          </s-banner>
        )}

        {error && (
          <s-banner tone="critical" dismissible onDismiss={() => setError(null)}>
            {error}
          </s-banner>
        )}
        {result && (
          <s-banner tone="success" dismissible onDismiss={() => setResult(null)}>
            {result}
          </s-banner>
        )}
        {progress && <s-text color="subdued">{progress}</s-text>}

        {fields.map((field) => (
          <FieldRow
            key={field.id}
            field={field}
            definitions={definitions}
            onSelectDef={selectDefinition}
            onUpdate={updateField}
            onRemove={removeField}
            disabled={loading}
          />
        ))}

        <s-button variant="tertiary" onClick={addField} disabled={loading || !canAdd}>
          Adicionar metacampo
        </s-button>
      </s-stack>

      <s-button
        slot="primary-action"
        variant="primary"
        onClick={handleApply}
        disabled={loading || fields.length === 0}
      >
        {loading ? "Salvando..." : "Aplicar"}
      </s-button>
      <s-button slot="secondary-actions" onClick={() => shopify.close()} disabled={loading}>
        Fechar
      </s-button>
    </s-admin-action>
  );
}

function FieldRow({ field, definitions, onSelectDef, onUpdate, onRemove, disabled }) {
  const def = definitions.find((d) => d.id === field.definitionId);
  const showUnit = isMeasurementType(field.type);
  const units = showUnit ? MEASUREMENT_UNITS[field.type] : [];

  return (
    <s-section heading={def ? def.name : field.key}>
      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="2fr 1fr" gap="base">
          <s-select
            label="Metacampo"
            value={field.definitionId}
            disabled={disabled}
            onChange={(e) => onSelectDef(field.id, e.currentTarget.value)}
          >
            {definitions.map((d) => (
              <s-option key={d.id} value={d.id}>
                {d.name} ({d.namespace}.{d.key})
              </s-option>
            ))}
          </s-select>

          <s-select
            label="Ação"
            value={field.action}
            disabled={disabled}
            onChange={(e) => onUpdate(field.id, "action", e.currentTarget.value)}
          >
            <s-option value="set">Definir</s-option>
            <s-option value="delete">Deletar</s-option>
          </s-select>
        </s-grid>

        {def && (
          <s-text color="subdued">
            Tipo: {field.type}{def.description ? ` — ${def.description}` : ""}
          </s-text>
        )}

        {field.action === "set" && (
          <ValueInput field={field} def={def} onUpdate={onUpdate} disabled={disabled} units={units} showUnit={showUnit} />
        )}

        <s-button variant="tertiary" tone="critical" onClick={() => onRemove(field.id)} disabled={disabled}>
          Remover
        </s-button>
      </s-stack>
    </s-section>
  );
}

function ValueInput({ field, def, onUpdate, disabled, units, showUnit }) {
  const type = field.type;

  // Se a definição tem lista fixa de valores (choices), vira picker.
  const choices = getChoices(def);
  if (choices) {
    if (isListType(type)) {
      // Lista com choices: um <s-select> por valor escolhido + um para adicionar.
      // Padrão nativo da Shopify (evita lista vertical gigante de checkboxes).
      const selectedValues = (field.value || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const commit = (arr) =>
        onUpdate(field.id, "value", arr.filter(Boolean).join(", "));

      const changeAt = (index, val) => {
        const next = selectedValues.slice();
        if (val === "") next.splice(index, 1);
        else next[index] = val;
        commit(next);
      };

      const addVal = (val) => {
        if (val) commit([...selectedValues, val]);
      };

      // Opções de uma linha: as ainda não escolhidas + o valor atual da linha.
      const optionsFor = (currentVal) =>
        choices.filter((c) => c === currentVal || !selectedValues.includes(c));

      const remaining = choices.filter((c) => !selectedValues.includes(c));

      return (
        <s-stack direction="block" gap="base">
          <s-text>Valores</s-text>
          {selectedValues.map((val, i) => (
            <s-select
              key={`${i}-${val}`}
              label={`Valor ${i + 1}`}
              labelAccessibilityVisibility="exclusive"
              value={val}
              disabled={disabled}
              onChange={(e) => changeAt(i, e.currentTarget.value)}
            >
              <s-option value="">— remover —</s-option>
              {optionsFor(val).map((c) => (
                <s-option key={c} value={c}>{c}</s-option>
              ))}
            </s-select>
          ))}
          {remaining.length > 0 && (
            <s-select
              key={`add-${selectedValues.length}`}
              label="Adicionar valor"
              labelAccessibilityVisibility="exclusive"
              value=""
              disabled={disabled}
              onChange={(e) => addVal(e.currentTarget.value)}
            >
              <s-option value="">+ Adicionar valor</s-option>
              {remaining.map((c) => (
                <s-option key={c} value={c}>{c}</s-option>
              ))}
            </s-select>
          )}
        </s-stack>
      );
    }
    return (
      <s-select
        label="Valor"
        value={field.value}
        disabled={disabled}
        onChange={(e) => onUpdate(field.id, "value", e.currentTarget.value)}
      >
        <s-option value="">— selecione —</s-option>
        {choices.map((c) => (
          <s-option key={c} value={c}>{c}</s-option>
        ))}
      </s-select>
    );
  }

  if (type === "boolean") {
    return (
      <s-select
        label="Valor"
        value={field.value || "true"}
        disabled={disabled}
        onChange={(e) => onUpdate(field.id, "value", e.currentTarget.value)}
      >
        <s-option value="true">Verdadeiro</s-option>
        <s-option value="false">Falso</s-option>
      </s-select>
    );
  }

  if (type === "color") {
    return (
      <s-color-field
        label="Cor"
        value={field.value || "#000000"}
        disabled={disabled}
        onInput={(e) => onUpdate(field.id, "value", e.currentTarget.value)}
      />
    );
  }

  if (type === "date") {
    return (
      <s-date-field
        label="Data"
        value={field.value}
        disabled={disabled}
        onChange={(e) => onUpdate(field.id, "value", e.currentTarget.value)}
      />
    );
  }

  if (type === "number_integer") {
    return (
      <s-number-field
        label="Valor"
        value={field.value}
        disabled={disabled}
        step={1}
        onInput={(e) => onUpdate(field.id, "value", e.currentTarget.value)}
      />
    );
  }

  if (type === "number_decimal") {
    return (
      <s-number-field
        label="Valor"
        value={field.value}
        disabled={disabled}
        step={0.01}
        onInput={(e) => onUpdate(field.id, "value", e.currentTarget.value)}
      />
    );
  }

  if (type === "url") {
    return (
      <s-url-field
        label="URL"
        value={field.value}
        placeholder="https://exemplo.com"
        disabled={disabled}
        onInput={(e) => onUpdate(field.id, "value", e.currentTarget.value)}
      />
    );
  }

  if (type === "multi_line_text_field" || type === "json" || type === "rich_text_field") {
    return (
      <s-text-area
        label="Valor"
        value={field.value}
        placeholder={type === "json" ? '{"key": "value"}' : "Texto..."}
        disabled={disabled}
        rows={4}
        onInput={(e) => onUpdate(field.id, "value", e.currentTarget.value)}
      />
    );
  }

  if (showUnit) {
    return (
      <s-grid gridTemplateColumns="2fr 1fr" gap="base">
        <s-number-field
          label="Valor"
          value={field.value}
          disabled={disabled}
          step={0.01}
          onInput={(e) => onUpdate(field.id, "value", e.currentTarget.value)}
        />
        <s-select
          label="Unidade"
          value={field.unit}
          disabled={disabled}
          onChange={(e) => onUpdate(field.id, "unit", e.currentTarget.value)}
        >
          {units.map((u) => (
            <s-option key={u} value={u}>{u}</s-option>
          ))}
        </s-select>
      </s-grid>
    );
  }

  if (type === "rating") {
    const validations = def?.validations || [];
    const minVal = validations.find((v) => v.name === "scale_min")?.value || "1";
    const maxVal = validations.find((v) => v.name === "scale_max")?.value || "5";
    return (
      <s-number-field
        label={`Rating (${minVal}-${maxVal})`}
        value={field.value}
        disabled={disabled}
        min={parseFloat(minVal)}
        max={parseFloat(maxVal)}
        step={0.1}
        onInput={(e) => onUpdate(field.id, "value", e.currentTarget.value)}
      />
    );
  }

  if (isListType(type)) {
    return (
      <s-text-area
        label="Valores (separados por vírgula)"
        value={field.value}
        placeholder="valor1, valor2, valor3"
        disabled={disabled}
        rows={2}
        onInput={(e) => onUpdate(field.id, "value", e.currentTarget.value)}
      />
    );
  }

  if (isReferenceType(type)) {
    return (
      <s-text-field
        label="GID da referência"
        value={field.value}
        placeholder="gid://shopify/Product/123456"
        disabled={disabled}
        onInput={(e) => onUpdate(field.id, "value", e.currentTarget.value)}
      />
    );
  }

  return (
    <s-text-field
      label="Valor"
      value={field.value}
      placeholder="Valor do metafield"
      disabled={disabled}
      onInput={(e) => onUpdate(field.id, "value", e.currentTarget.value)}
    />
  );
}
