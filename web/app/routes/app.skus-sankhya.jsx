import { json } from "@remix-run/cloudflare";
import { useLoaderData } from "@remix-run/react";
import { useState, useCallback, useMemo, useRef, useEffect } from "react";
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
  Select,
  Badge,
  Checkbox,
  IndexTable,
  Pagination,
  Spinner,
  ProgressBar,
  DropZone,
  Link,
  List,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";

import { getShopify } from "../shopify.server";
import { hasSankhyaCreds } from "../sankhya.server";

// Tela "SKUs Sankhya": acha variantes com o CODPROD do Sankhya no SKU (só dígitos, ex.:
// "12905"), busca o SKU original no Sankhya (TGFPRO.AD_IDEXTERNO2; fallback: prefixo da
// descrição) e troca em massa. Custo zero de armazenamento no Cloudflare: nada é gravado
// em KV/D1; o estado vive no navegador e o backup é um CSV baixado antes de gravar.
// Leitura e gravação usam Bulk Operations da Shopify. Os comandos (iniciar, status,
// gravar) e o Sankhya passam pelo Worker (app.skus-sankhya_.api.jsx): Bulk Operations não
// são aceitas pelo Direct API access do navegador. Os ARQUIVOS (download do resultado e
// upload do JSONL) vão direto entre o navegador e o storage da Shopify.

export const loader = async ({ request, context }) => {
  await getShopify(context.env).authenticate.admin(request);
  return json({ hasSankhya: hasSankhyaCreds(context.env) });
};

const API = "/app/skus-sankhya/api";
const PAGE_SIZES = [25, 50, 100, 250, 500, 1000];
const LOOKUP_CHUNK = 1000;
const VARIANTS_PER_LINE = 250;
const DONE = ["COMPLETED", "FAILED", "CANCELED", "EXPIRED"];

const STATUS = {
  pendente: { label: "Pendente", tone: undefined },
  pronto: { label: "Pronto", tone: "success" },
  revisar: { label: "Revisar", tone: "attention" },
  conflito: { label: "Conflito", tone: "critical" },
  nao_encontrado: { label: "Não encontrado", tone: undefined },
  atualizado: { label: "Atualizado", tone: "info" },
  erro: { label: "Erro", tone: "critical" },
};
const LOCKED = new Set(["pendente", "nao_encontrado", "atualizado"]); // não selecionáveis

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const numId = (gid) => String(gid || "").split("/").pop();
const isNumericSku = (s) => /^\d+$/.test(s);
// CODPROD é inteiro no Sankhya: "012905" e "12905" são o mesmo produto.
const normCod = (s) => s.replace(/^0+(?=\d)/, "");

// ── Busca da Shopify (sintaxe de search) a partir dos filtros ──

function quote(v) {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildSearch(f) {
  const parts = [];
  // "Título começa com": cada palavra vira title:palavra e a última leva * (prefixo).
  const words = f.titulo.trim().split(/\s+/).map((w) => w.replace(/[":\\()*]/g, "")).filter(Boolean);
  words.forEach((w, i) => parts.push(`title:${w}${i === words.length - 1 ? "*" : ""}`));
  if (f.status) parts.push(`status:${f.status}`);
  if (f.tipo.trim()) parts.push(`product_type:${quote(f.tipo.trim())}`);
  if (f.tag.trim()) parts.push(`tag:${quote(f.tag.trim())}`);
  if (f.fornecedor.trim()) parts.push(`vendor:${quote(f.fornecedor.trim())}`);
  if (f.avancada.trim()) parts.push(`(${f.avancada.trim()})`);
  return parts.join(" AND ");
}

// ── Sankhya → SKU novo ──

// Código no início da descrição do Sankhya: "C02406P - CAMISA ... - TAMANHO:P" → "C02406P".
function prefixoDescricao(desc) {
  const m = /^\s*([A-Za-z0-9]+)\s*-/.exec(desc || "");
  return m && !isNumericSku(m[1]) ? m[1].toUpperCase() : "";
}

function classify(row, info) {
  if (!info) {
    return {
      status: "nao_encontrado",
      note: row.codprod.length > 10 ? "SKU numérico longo demais para ser CODPROD" : "CODPROD não existe no Sankhya",
    };
  }
  const idExt = info.idExterno && !isNumericSku(info.idExterno) && !/\s/.test(info.idExterno) ? info.idExterno : "";
  const pre = prefixoDescricao(info.descricao);
  const descricao = info.descricao;
  if (idExt) {
    if (pre && pre !== idExt.toUpperCase()) {
      return { status: "revisar", newSku: idExt, origem: "ID externo", descricao, note: `A descrição indica ${pre}` };
    }
    return { status: "pronto", newSku: idExt, origem: "ID externo", descricao, note: "" };
  }
  if (pre) {
    return { status: "revisar", newSku: pre, origem: "Descrição", descricao, note: "Sem AD_IDEXTERNO2: código tirado da descrição" };
  }
  return { status: "nao_encontrado", descricao, note: "Sem AD_IDEXTERNO2 e sem código na descrição" };
}

// Marca como conflito o SKU novo que já existe em OUTRA variante (da loja inteira, se
// checado, ou do que foi escaneado) ou que se repete na própria lista.
function markConflicts(rows, skuIndex) {
  const count = new Map();
  for (const r of rows) {
    if (!r.newSku || LOCKED.has(r.status)) continue;
    const k = r.newSku.toUpperCase();
    count.set(k, (count.get(k) || 0) + 1);
  }
  return rows.map((r) => {
    if (!r.newSku || !["pronto", "revisar"].includes(r.status)) return r;
    const k = r.newSku.toUpperCase();
    const others = [...(skuIndex.get(k) || [])].filter((id) => id !== r.id);
    if (others.length) {
      return { ...r, status: "conflito", note: `SKU já existe em ${others.length} outra(s) variante(s) da loja` };
    }
    if (count.get(k) > 1) return { ...r, status: "conflito", note: `SKU repetido em ${count.get(k)} variantes desta lista` };
    return r;
  });
}

// ── CSV (separador ";" + BOM, abre direto no Excel pt-BR) ──

function downloadCsv(filename, header, rows) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.map(esc).join(";"), ...rows.map((r) => r.map(esc).join(";"))];
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0] || "";
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ";" : ",";
  const rows = [];
  let row = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

// Agrupa { productId, id, sku } por produto, em linhas de até 250 variantes.
function toGroups(items) {
  const byProduct = new Map();
  for (const it of items) {
    if (!byProduct.has(it.productId)) byProduct.set(it.productId, []);
    byProduct.get(it.productId).push({ id: it.id, sku: it.sku });
  }
  const groups = [];
  for (const [productId, vs] of byProduct) {
    for (let i = 0; i < vs.length; i += VARIANTS_PER_LINE) groups.push({ productId, variants: vs.slice(i, i + VARIANTS_PER_LINE) });
  }
  return groups;
}

// ── Arquivos das Bulk Operations: direto entre o navegador e o storage da Shopify ──
// (CORS liberado nos dois sentidos; não passam pelo Worker.)

// JSONL da gravação: uma linha por grupo, na ordem de `groups` (o resultado é casado pelo
// __lineNumber). Só o SKU vai no input.
function mutationJsonl(groups) {
  return groups
    .map((g) => JSON.stringify({ productId: g.productId, variants: g.variants.map((v) => ({ id: v.id, inventoryItem: { sku: v.sku } })) }))
    .join("\n");
}

async function uploadStaged(target, text) {
  const form = new FormData();
  for (const prm of target.parameters) form.append(prm.name, prm.value);
  form.append("file", new Blob([text], { type: "text/jsonl" }), "skus.jsonl");
  const up = await fetch(target.url, { method: "POST", body: form });
  if (!up.ok) throw new Error(`Falha no upload do arquivo (HTTP ${up.status}).`);
  return target.parameters.find((prm) => prm.name === "key").value;
}

async function downloadJsonl(url) {
  if (!url) return "";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao baixar o resultado (HTTP ${res.status}).`);
  return res.text();
}

// Intervalo da consulta de andamento: 1 s nos primeiros 20 s, depois 2 s e, após ~2 min, 3 s.
const pollDelay = (i) => (i < 20 ? 1000 : i < 70 ? 2000 : 3000);

const EMPTY_FILTERS = { titulo: "", status: "", tipo: "", tag: "", fornecedor: "", avancada: "" };

export default function SkusSankhya() {
  const { hasSankhya } = useLoaderData();
  const shopify = useAppBridge();

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [checarLoja, setChecarLoja] = useState(true);
  const search = useMemo(() => buildSearch(filters), [filters]);

  const [rows, setRows] = useState(null); // null = ainda não escaneou
  const [scanInfo, setScanInfo] = useState(null); // { products, variants, search }
  const [selected, setSelected] = useState(() => new Set());
  const [job, setJob] = useState(null); // { title, detail, progress?, cancelable }
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(null); // { tone, title, lines[] }
  const [confirmApply, setConfirmApply] = useState(false);
  const [revert, setRevert] = useState(null); // { items, products, fileName, confirm }
  const cancelRef = useRef({ cancel: false, opId: null });
  const skuIndexRef = useRef(new Map()); // SKU (maiúsculo) -> Set(variant ids)

  const [statusFilter, setStatusFilter] = useState("todos");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);

  const busy = Boolean(job);

  // Atualiza o processo em andamento mantendo o início (para o tempo decorrido).
  const updateJob = useCallback((patch) => {
    setJob((j) => ({ startedAt: Date.now(), ...j, progress: undefined, ...patch }));
  }, []);

  // Tempo decorrido (re-render a cada segundo só enquanto há processo) + barra de
  // carregamento do próprio admin da Shopify.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!busy) return undefined;
    try { shopify.loading(true); } catch { /* fora do admin */ }
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => {
      clearInterval(t);
      try { shopify.loading(false); } catch { /* fora do admin */ }
    };
  }, [busy, shopify]);

  const toast = useCallback((msg, isError = false) => {
    try { shopify.toast.show(msg, { isError, duration: 5000 }); } catch { /* fora do admin */ }
  }, [shopify]);
  const setFilter = (k) => (v) => setFilters((f) => ({ ...f, [k]: v }));

  // ── Chamadas ao Worker (rota de recurso, com o session token do App Bridge) ──

  const api = useCallback(async (body) => {
    const token = await shopify.idToken();
    const res = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(res.status === 401 ? "Sessão expirada: recarregue a página." : `Erro HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Erro desconhecido.");
    return data;
  }, [shopify]);

  // Espera a Bulk Operation terminar e devolve o objeto final.
  const waitBulk = useCallback(async (id, title, cancelable) => {
    cancelRef.current.opId = id;
    for (let i = 0; ; i++) {
      await sleep(pollDelay(i));
      if (cancelable && cancelRef.current.cancel) {
        await api({ intent: "cancel", id }).catch(() => {});
        throw new Error("Cancelado.");
      }
      const { op } = await api({ intent: "status", id });
      updateJob({ title, detail: `${op.status === "RUNNING" ? "Processando" : op.status} · ${Number(op.objectCount || 0).toLocaleString("pt-BR")} objetos`, cancelable });
      if (DONE.includes(op.status)) {
        cancelRef.current.opId = null;
        return op;
      }
    }
  }, [api, updateJob]);

  const runQueryBulk = useCallback(async (kind, title) => {
    updateJob({ title, detail: "Iniciando…", cancelable: true });
    const { id } = await api({ intent: "startQuery", kind, search });
    const op = await waitBulk(id, title, true);
    if (op.status !== "COMPLETED") throw new Error(`Leitura terminou com status ${op.status}${op.errorCode ? ` (${op.errorCode})` : ""}.`);
    updateJob({ title, detail: "Baixando o resultado…", cancelable: false });
    return downloadJsonl(op.url);
  }, [api, search, waitBulk, updateJob]);

  // Consulta o Sankhya para as linhas ainda "pendente" (também serve para tentar de novo).
  const lookup = useCallback(async (baseRows, title = "Consultando o Sankhya") => {
    const cods = [...new Set(baseRows.filter((r) => r.status === "pendente" && r.codprod.length <= 10).map((r) => r.codprod))];
    const info = {};
    for (let i = 0; i < cods.length; i += LOOKUP_CHUNK) {
      updateJob({
        title,
        detail: `${Math.min(i + LOOKUP_CHUNK, cods.length).toLocaleString("pt-BR")} de ${cods.length.toLocaleString("pt-BR")} códigos`,
        progress: Math.round((i / Math.max(cods.length, 1)) * 100),
        cancelable: false,
      });
      const { map } = await api({ intent: "lookup", codprods: cods.slice(i, i + LOOKUP_CHUNK) });
      Object.assign(info, map);
    }
    const out = baseRows.map((r) => (r.status === "pendente" ? { ...r, ...classify(r, info[r.codprod]) } : r));
    return markConflicts(out, skuIndexRef.current);
  }, [api, updateJob]);

  const preselect = (list) => new Set(list.filter((r) => r.status === "pronto").map((r) => r.id));

  // ── 1) Escanear ──

  const scan = useCallback(async () => {
    cancelRef.current = { cancel: false, opId: null };
    setError("");
    setNotice(null);
    setConfirmApply(false);
    let current = null;
    try {
      const steps = checarLoja ? 3 : 2;
      const text = await runQueryBulk("scan", `Etapa 1 de ${steps} · Lendo produtos na Shopify`);
      const products = new Map();
      const variants = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const o = JSON.parse(line);
        if (o.__parentId) variants.push(o);
        else products.set(o.id, o);
      }

      // Índice de SKUs do que foi lido (a checagem da loja inteira, se ligada, substitui).
      const index = new Map();
      const addSku = (sku, id) => {
        const k = String(sku || "").trim().toUpperCase();
        if (!k) return;
        if (!index.has(k)) index.set(k, new Set());
        index.get(k).add(id);
      };
      variants.forEach((v) => addSku(v.sku, v.id));

      const found = [];
      for (const v of variants) {
        const sku = String(v.sku || "").trim();
        if (!isNumericSku(sku)) continue;
        const p = products.get(v.__parentId) || {};
        found.push({
          id: v.id,
          productId: v.__parentId,
          productTitle: p.title || "(sem título)",
          productStatus: p.status || "",
          variantTitle: v.title === "Default Title" ? "" : v.title || "",
          sku,
          codprod: normCod(sku),
          status: "pendente",
          newSku: "",
          origem: "",
          descricao: "",
          note: "",
        });
      }
      setScanInfo({ products: products.size, variants: variants.length, search });
      current = found;
      setRows(found);
      setSelected(new Set());
      setPage(0);
      if (!found.length) {
        toast(`Busca concluída: nenhuma variante com SKU numérico em ${variants.length.toLocaleString("pt-BR")} lidas.`);
        return;
      }

      if (checarLoja) {
        const all = await runQueryBulk("skus", "Etapa 2 de 3 · Checando SKUs da loja inteira");
        index.clear();
        for (const line of all.split("\n")) {
          if (!line.trim()) continue;
          const o = JSON.parse(line);
          addSku(o.sku, o.id);
        }
      }
      skuIndexRef.current = index;

      current = await lookup(found, `Etapa ${steps} de ${steps} · Consultando o Sankhya`);
      setRows(current);
      setSelected(preselect(current));
      toast(`Busca concluída: ${current.length.toLocaleString("pt-BR")} variante(s) com SKU numérico.`);
    } catch (e) {
      setError(e?.message || String(e));
      toast("A busca terminou com erro.", true);
      if (current) setRows(current);
    } finally {
      setJob(null);
    }
  }, [runQueryBulk, lookup, checarLoja, search, toast]);

  const retryLookup = useCallback(async () => {
    setError("");
    try {
      const out = await lookup(rows);
      setRows(out);
      setSelected(preselect(out));
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setJob(null);
    }
  }, [lookup, rows]);

  // ── Gravação (aplicar e reverter usam o mesmo caminho) ──

  // `items`: [{ productId, id, sku }]. Retorna Map(variantId -> { ok, message }).
  const runMutation = useCallback(async (items, title) => {
    const groups = toGroups(items);
    updateJob({ title: `Etapa 1 de 3 · ${title}`, detail: `Enviando ${groups.length.toLocaleString("pt-BR")} produto(s)…`, cancelable: false });
    const target = await api({ intent: "stage" });
    const path = await uploadStaged(target, mutationJsonl(groups));
    const { id } = await api({ intent: "runMutation", path });
    const op = await waitBulk(id, `Etapa 2 de 3 · ${title}`, false);
    updateJob({ title: `Etapa 3 de 3 · ${title}`, detail: "Lendo o resultado…", cancelable: false });
    const text = await downloadJsonl(op.url || op.partialDataUrl);

    const result = new Map();
    const lines = text.split("\n").filter((l) => l.trim());
    lines.forEach((line, idx) => {
      const o = JSON.parse(line);
      const n = Number.isInteger(o.__lineNumber) ? o.__lineNumber : idx;
      const g = groups[n];
      if (!g) return;
      const r = o.data?.productVariantsBulkUpdate;
      const msg = o.errors?.length
        ? o.errors.map((e) => e.message).join("; ")
        : r?.userErrors?.length
          ? r.userErrors.map((e) => e.message).join("; ")
          : !r ? "Resposta vazia da Shopify" : "";
      for (const v of g.variants) result.set(v.id, { ok: !msg, message: msg });
    });
    for (const g of groups) {
      for (const v of g.variants) {
        if (!result.has(v.id)) result.set(v.id, { ok: false, message: `Sem retorno da Shopify (operação ${op.status})` });
      }
    }
    return result;
  }, [api, waitBulk, updateJob]);

  const toApply = useMemo(
    () => (rows || []).filter((r) => selected.has(r.id) && r.newSku && !LOCKED.has(r.status)),
    [rows, selected]
  );
  const toApplyProducts = useMemo(() => new Set(toApply.map((r) => r.productId)).size, [toApply]);

  const apply = useCallback(async () => {
    setConfirmApply(false);
    setError("");
    setNotice(null);
    const items = toApply.map((r) => ({ productId: r.productId, id: r.id, sku: r.newSku, row: r }));
    // Backup ANTES de gravar: é o arquivo usado em "Reverter".
    downloadCsv(
      `backup-skus-${stamp()}.csv`,
      ["product_id", "variant_id", "produto", "variante", "sku_antigo", "sku_novo"],
      items.map(({ row: r }) => [r.productId, r.id, r.productTitle, r.variantTitle, r.sku, r.newSku])
    );
    try {
      const result = await runMutation(items, "Gravando os SKUs na Shopify");
      const bad = [...result.values()].filter((v) => !v.ok).length;
      const ok = result.size - bad;
      setRows((cur) => cur.map((r) => {
        const res = result.get(r.id);
        if (!res) return r;
        if (res.ok) return { ...r, status: "atualizado", skuAntigo: r.sku, sku: r.newSku, note: `Antes: ${r.sku}` };
        return { ...r, status: "erro", note: res.message };
      }));
      setSelected(new Set());
      toast(bad ? `${ok} atualizada(s), ${bad} com erro.` : `${ok} variante(s) atualizada(s).`, Boolean(bad));
      setNotice({
        tone: bad ? "warning" : "success",
        title: `${ok.toLocaleString("pt-BR")} variante(s) atualizada(s)${bad ? `, ${bad.toLocaleString("pt-BR")} com erro` : ""}.`,
        lines: ["O backup foi baixado antes da gravação; use-o em \"Reverter\" se precisar desfazer."],
      });
    } catch (e) {
      setError(`${e?.message || e} O backup já foi baixado; escaneie de novo para ver o estado atual.`);
    } finally {
      setJob(null);
    }
  }, [toApply, runMutation, toast]);

  // ── Reverter a partir do CSV de backup ──

  const onRevertFile = useCallback(async (_drop, accepted) => {
    const file = accepted?.[0];
    if (!file) return;
    setError("");
    const table = parseCsv(await file.text());
    const header = (table.shift() || []).map((h) => h.trim().toLowerCase());
    const col = (n) => header.indexOf(n);
    const [ip, iv, io] = [col("product_id"), col("variant_id"), col("sku_antigo")];
    if (ip < 0 || iv < 0 || io < 0) {
      setRevert(null);
      setError("CSV inválido: precisa das colunas product_id, variant_id e sku_antigo (o backup baixado ao aplicar).");
      return;
    }
    const items = [];
    let invalid = 0;
    for (const r of table) {
      const productId = (r[ip] || "").trim();
      const id = (r[iv] || "").trim();
      const sku = (r[io] || "").trim();
      if (/^gid:\/\/shopify\/Product\/\d+$/.test(productId) && /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id) && sku) {
        items.push({ productId, id, sku });
      } else invalid++;
    }
    setRevert({ items, invalid, products: new Set(items.map((i) => i.productId)).size, fileName: file.name, confirm: false });
  }, []);

  const runRevert = useCallback(async () => {
    const items = revert.items;
    setRevert(null);
    setError("");
    setNotice(null);
    try {
      const result = await runMutation(items, "Revertendo os SKUs na Shopify");
      const errs = [...result.entries()].filter(([, v]) => !v.ok);
      toast(errs.length ? `Reversão com ${errs.length} erro(s).` : `${result.size} variante(s) revertida(s).`, Boolean(errs.length));
      setNotice({
        tone: errs.length ? "warning" : "success",
        title: `${(result.size - errs.length).toLocaleString("pt-BR")} variante(s) revertida(s)${errs.length ? `, ${errs.length} com erro` : ""}.`,
        lines: [
          ...errs.slice(0, 10).map(([id, v]) => `Variante ${numId(id)}: ${v.message}`),
          "Escaneie de novo para ver o estado atual na tabela.",
        ],
      });
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setJob(null);
    }
  }, [revert, runMutation, toast]);

  // ── Tabela: filtro, paginação e seleção ──

  const counts = useMemo(() => {
    const c = {};
    for (const r of rows || []) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows || []).filter((r) => {
      if (statusFilter !== "todos" && r.status !== statusFilter) return false;
      if (!q) return true;
      return `${r.productTitle} ${r.variantTitle} ${r.sku} ${r.newSku} ${r.skuAntigo || ""}`.toLowerCase().includes(q);
    });
  }, [rows, statusFilter, query]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pages - 1);
  const pageRows = filtered.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const pageSelected = pageRows.filter((r) => selected.has(r.id)).length;

  const onSelectionChange = useCallback((type, toggle, selection) => {
    setSelected((cur) => {
      const next = new Set(cur);
      const set = (r) => {
        if (LOCKED.has(r.status)) return;
        if (toggle) next.add(r.id);
        else next.delete(r.id);
      };
      if (type === "single") {
        const r = pageRows.find((x) => x.id === selection);
        if (r) set(r);
      } else if ((type === "multi" || type === "range") && Array.isArray(selection)) {
        const [a, b] = selection;
        pageRows.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(set);
      } else {
        pageRows.forEach(set); // "page"/"all": a página atual
      }
      return next;
    });
  }, [pageRows]);

  const selectFiltered = (onlyReady) => setSelected((cur) => {
    const next = new Set(cur);
    for (const r of filtered) if (!LOCKED.has(r.status) && (!onlyReady || r.status === "pronto")) next.add(r.id);
    return next;
  });

  const exportFiltered = () => downloadCsv(
    `skus-sankhya-${stamp()}.csv`,
    ["product_id", "variant_id", "produto", "variante", "status_produto", "sku_atual", "sku_novo", "origem", "status", "observacao", "descricao_sankhya"],
    filtered.map((r) => [r.productId, r.id, r.productTitle, r.variantTitle, r.productStatus, r.sku, r.newSku, r.origem, STATUS[r.status]?.label, r.note, r.descricao])
  );

  const statusOptions = [
    { label: `Todos (${(rows || []).length.toLocaleString("pt-BR")})`, value: "todos" },
    ...Object.entries(STATUS)
      .filter(([k]) => counts[k])
      .map(([k, s]) => ({ label: `${s.label} (${counts[k].toLocaleString("pt-BR")})`, value: k })),
  ];

  return (
    <Page fullWidth title="SKUs Sankhya" backAction={{ content: "Início", url: "/app" }}>
      <style>{`@keyframes skuIndet { 0% { left: -35%; } 100% { left: 100%; } }`}</style>
      <Layout>
        {job && (
          <Layout.Section>
            <div style={{ position: "sticky", top: 0, zIndex: 400 }}>
              <Card>
                <BlockStack gap="200">
                  <InlineStack gap="200" blockAlign="center" align="space-between" wrap={false}>
                    <InlineStack gap="300" blockAlign="center">
                      <Spinner size="small" />
                      <BlockStack gap="050">
                        <Text as="span" fontWeight="semibold">{job.title}</Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {`${job.detail} · ${Math.floor((Date.now() - job.startedAt) / 1000)} s`}
                        </Text>
                      </BlockStack>
                    </InlineStack>
                    {job.cancelable && (
                      <Button size="slim" onClick={() => { cancelRef.current.cancel = true; }}>Cancelar</Button>
                    )}
                  </InlineStack>
                  {job.progress != null ? (
                    <ProgressBar progress={job.progress} size="small" />
                  ) : (
                    <div style={{ position: "relative", height: 6, borderRadius: 3, overflow: "hidden", background: "var(--p-color-bg-fill-tertiary, #e3e3e3)" }}>
                      <div style={{ position: "absolute", top: 0, bottom: 0, width: "35%", borderRadius: 3, background: "var(--p-color-bg-fill-brand, #303030)", animation: "skuIndet 1.2s ease-in-out infinite" }} />
                    </div>
                  )}
                  <Text as="p" variant="bodySm" tone="subdued">
                    Processando nos servidores da Shopify. Mantenha esta página aberta até terminar.
                  </Text>
                </BlockStack>
              </Card>
            </div>
          </Layout.Section>
        )}

        {!hasSankhya && (
          <Layout.Section>
            <Banner tone="critical" title="Credenciais do Sankhya não configuradas no Worker">
              <p>Sem elas a consulta do SKU original não funciona.</p>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">1. Filtrar produtos</Text>
                <Text as="p" tone="subdued">
                  Lê os produtos do filtro em massa e lista as variantes cujo SKU tem só números (CODPROD do Sankhya).
                  Nada é gravado até você revisar e confirmar.
                </Text>
              </BlockStack>
              <InlineStack gap="300" wrap>
                <div style={{ minWidth: 220, flex: 1 }}>
                  <TextField label="Título começa com" value={filters.titulo} onChange={setFilter("titulo")} placeholder="Ex.: Camis" autoComplete="off" disabled={busy} />
                </div>
                <div style={{ minWidth: 160 }}>
                  <Select
                    label="Status do produto"
                    options={[
                      { label: "Todos", value: "" },
                      { label: "Ativo", value: "active" },
                      { label: "Rascunho", value: "draft" },
                      { label: "Arquivado", value: "archived" },
                    ]}
                    value={filters.status}
                    onChange={setFilter("status")}
                    disabled={busy}
                  />
                </div>
                <div style={{ minWidth: 180, flex: 1 }}>
                  <TextField label="Tipo de produto" value={filters.tipo} onChange={setFilter("tipo")} autoComplete="off" disabled={busy} />
                </div>
                <div style={{ minWidth: 160, flex: 1 }}>
                  <TextField label="Tag" value={filters.tag} onChange={setFilter("tag")} autoComplete="off" disabled={busy} />
                </div>
                <div style={{ minWidth: 160, flex: 1 }}>
                  <TextField label="Fornecedor" value={filters.fornecedor} onChange={setFilter("fornecedor")} autoComplete="off" disabled={busy} />
                </div>
              </InlineStack>
              <TextField
                label="Busca avançada (sintaxe de busca da Shopify, opcional)"
                value={filters.avancada}
                onChange={setFilter("avancada")}
                placeholder='Ex.: created_at:>2025-01-01 OR tag:"Camisa Agro"'
                autoComplete="off"
                disabled={busy}
              />
              <Checkbox
                label="Checar SKU duplicado na loja inteira"
                helpText="Faz uma segunda leitura com todos os SKUs da loja para marcar como Conflito o SKU novo que já existe em outro produto."
                checked={checarLoja}
                onChange={setChecarLoja}
                disabled={busy}
              />
              <Text as="p" variant="bodySm" tone="subdued">
                Busca na Shopify: <code>{search || "(todos os produtos da loja)"}</code>
              </Text>
              <InlineStack gap="200">
                <Button variant="primary" onClick={scan} loading={busy} disabled={busy}>
                  Buscar produtos
                </Button>
                <Button onClick={() => setFilters(EMPTY_FILTERS)} disabled={busy}>Limpar filtros</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {error && (
          <Layout.Section>
            <Banner tone="critical" title="Erro" onDismiss={() => setError("")}>
              <p>{error}</p>
            </Banner>
          </Layout.Section>
        )}

        {notice && (
          <Layout.Section>
            <Banner tone={notice.tone} title={notice.title} onDismiss={() => setNotice(null)}>
              <List>
                {notice.lines.map((l, i) => <List.Item key={i}>{l}</List.Item>)}
              </List>
            </Banner>
          </Layout.Section>
        )}

        {rows && (
          <Layout.Section>
            <Card padding="0">
                <div style={{ padding: "16px" }}>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center" wrap>
                      <BlockStack gap="100">
                        <Text as="h2" variant="headingMd">2. Revisar e aplicar</Text>
                        {scanInfo && (
                          <Text as="p" variant="bodySm" tone="subdued">
                            {scanInfo.products.toLocaleString("pt-BR")} produto(s) e {scanInfo.variants.toLocaleString("pt-BR")} variante(s) lidos ·{" "}
                            {rows.length.toLocaleString("pt-BR")} com SKU numérico
                          </Text>
                        )}
                      </BlockStack>
                      <InlineStack gap="200">
                        {Object.entries(STATUS).filter(([k]) => counts[k]).map(([k, s]) => (
                          <Badge key={k} tone={s.tone}>{`${s.label}: ${counts[k].toLocaleString("pt-BR")}`}</Badge>
                        ))}
                      </InlineStack>
                    </InlineStack>

                    {counts.pendente > 0 && !busy && (
                      <Banner tone="warning" title={`${counts.pendente} variante(s) sem consulta ao Sankhya`}>
                        <Button onClick={retryLookup}>Consultar o Sankhya de novo</Button>
                      </Banner>
                    )}

                    <InlineStack gap="300" blockAlign="end" wrap>
                      <div style={{ minWidth: 200 }}>
                        <Select label="Status" options={statusOptions} value={statusFilter} onChange={(v) => { setStatusFilter(v); setPage(0); }} />
                      </div>
                      <div style={{ minWidth: 120 }}>
                        <Select
                          label="Itens por página"
                          options={PAGE_SIZES.map((n) => ({ label: String(n), value: String(n) }))}
                          value={String(pageSize)}
                          onChange={(v) => { setPageSize(Number(v)); setPage(0); }}
                        />
                      </div>
                      <div style={{ minWidth: 240, flex: 1 }}>
                        <TextField
                          label="Procurar na lista"
                          value={query}
                          onChange={(v) => { setQuery(v); setPage(0); }}
                          placeholder="Produto, variante ou SKU"
                          autoComplete="off"
                          clearButton
                          onClearButtonClick={() => setQuery("")}
                        />
                      </div>
                    </InlineStack>

                    <InlineStack gap="200" wrap blockAlign="center">
                      <Button onClick={() => selectFiltered(true)} disabled={busy}>Selecionar "Pronto" do filtro</Button>
                      <Button onClick={() => selectFiltered(false)} disabled={busy}>Selecionar tudo do filtro</Button>
                      <Button onClick={() => setSelected(new Set())} disabled={busy || !selected.size}>Limpar seleção</Button>
                      <Button onClick={exportFiltered} disabled={!filtered.length}>Exportar CSV</Button>
                      <Button variant="primary" onClick={() => setConfirmApply(true)} disabled={busy || !toApply.length}>
                        {`Aplicar SKUs (${toApply.length.toLocaleString("pt-BR")})`}
                      </Button>
                    </InlineStack>

                    {confirmApply && toApply.length > 0 && (
                      <Banner
                        tone="warning"
                        title={`Trocar o SKU de ${toApply.length.toLocaleString("pt-BR")} variante(s) em ${toApplyProducts.toLocaleString("pt-BR")} produto(s)?`}
                        action={{ content: "Confirmar e gravar", onAction: apply }}
                        secondaryAction={{ content: "Cancelar", onAction: () => setConfirmApply(false) }}
                        onDismiss={() => setConfirmApply(false)}
                      >
                        <p>
                          Antes de gravar, será baixado um CSV de backup com o SKU antigo de cada variante. Guarde-o: é ele
                          que desfaz a troca em "Reverter". Só o SKU é alterado; nada mais no produto muda.
                        </p>
                      </Banner>
                    )}
                  </BlockStack>
                </div>

                <IndexTable
                  resourceName={{ singular: "variante", plural: "variantes" }}
                  itemCount={pageRows.length}
                  selectedItemsCount={pageSelected}
                  onSelectionChange={onSelectionChange}
                  selectable={!busy}
                  headings={[
                    { title: "Produto" },
                    { title: "SKU atual" },
                    { title: "SKU novo" },
                    { title: "Status" },
                  ]}
                  emptyState={<div style={{ padding: 16 }}><Text as="p" tone="subdued">Nenhuma variante neste filtro.</Text></div>}
                >
                  {pageRows.map((r, i) => (
                    <IndexTable.Row
                      id={r.id}
                      key={r.id}
                      position={i}
                      selected={selected.has(r.id)}
                      disabled={LOCKED.has(r.status)}
                    >
                      <IndexTable.Cell>
                        <div style={{ whiteSpace: "normal", minWidth: 240, maxWidth: 520 }}>
                        <BlockStack gap="050">
                          <Link url={`shopify://admin/products/${numId(r.productId)}`} target="_blank" removeUnderline>
                            {r.productTitle}
                          </Link>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {[r.variantTitle, r.productStatus && r.productStatus.toLowerCase()].filter(Boolean).join(" · ")}
                          </Text>
                        </BlockStack>
                        </div>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" fontWeight="medium">{r.sku}</Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="050">
                          <Text as="span" fontWeight="semibold">{r.newSku || "—"}</Text>
                          {r.origem && <Text as="span" variant="bodySm" tone="subdued">{r.origem}</Text>}
                        </BlockStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <BlockStack gap="050" inlineAlign="start">
                          <Badge tone={STATUS[r.status]?.tone}>{STATUS[r.status]?.label}</Badge>
                          {r.note && (
                            <div style={{ minWidth: 180, maxWidth: 360, whiteSpace: "normal" }}>
                              <Text as="span" variant="bodySm" tone="subdued">{r.note}</Text>
                            </div>
                          )}
                        </BlockStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>

                <div style={{ padding: "12px 16px" }}>
                  <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {`${selected.size.toLocaleString("pt-BR")} selecionada(s) no total · ${filtered.length.toLocaleString("pt-BR")} no filtro · página ${safePage + 1} de ${pages}`}
                    </Text>
                    <InlineStack gap="300" blockAlign="center">
                    <Select
                      label="Por página"
                      labelInline
                      options={PAGE_SIZES.map((n) => ({ label: String(n), value: String(n) }))}
                      value={String(pageSize)}
                      onChange={(v) => { setPageSize(Number(v)); setPage(0); }}
                    />
                    <Pagination
                      hasPrevious={safePage > 0}
                      onPrevious={() => setPage(safePage - 1)}
                      hasNext={safePage < pages - 1}
                      onNext={() => setPage(safePage + 1)}
                    />
                    </InlineStack>
                  </InlineStack>
                </div>
            </Card>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="100">
                <Text as="h2" variant="headingMd">Reverter a partir de um backup</Text>
                <Text as="p" tone="subdued">
                  Envie o CSV de backup baixado ao aplicar: cada variante volta para o "sku_antigo". Use o arquivo como foi
                  baixado (se abrir e salvar no Excel, SKUs só com números podem perder zeros à esquerda).
                </Text>
              </BlockStack>
              <DropZone accept=".csv,text/csv" type="file" allowMultiple={false} onDrop={onRevertFile} disabled={busy}>
                <DropZone.FileUpload actionTitle="Escolher CSV de backup" actionHint="ou arraste o arquivo aqui" />
              </DropZone>
              {revert && (
                <Banner
                  tone={revert.items.length ? "warning" : "critical"}
                  title={
                    revert.items.length
                      ? `Reverter ${revert.items.length.toLocaleString("pt-BR")} variante(s) em ${revert.products.toLocaleString("pt-BR")} produto(s)?`
                      : "Nenhuma linha válida no arquivo"
                  }
                  action={revert.items.length ? { content: "Confirmar reversão", onAction: runRevert } : undefined}
                  secondaryAction={{ content: "Cancelar", onAction: () => setRevert(null) }}
                  onDismiss={() => setRevert(null)}
                >
                  <p>
                    Arquivo: {revert.fileName}
                    {revert.invalid ? ` · ${revert.invalid} linha(s) ignorada(s) por estarem incompletas` : ""}
                  </p>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
