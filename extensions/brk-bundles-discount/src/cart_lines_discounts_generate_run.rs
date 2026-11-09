//! BRK Bundles — desconto POR ITEM do add-on (versão Rust).
//!
//! Port 1:1 de `cart_lines_discounts_generate_run.js` (mesmas regras, mesmos formatos de
//! config: antigo `bundles`, compacto v2 e v3 com bundles por produto no metafield `fn`).
//! A documentação das regras e dos formatos está no cabeçalho do arquivo JS.
//!
//! Diferença de custo: o input é lido sob demanda (só os campos acessados são
//! desserializados), e a pertinência a collections/tags de um produto só é lida quando
//! alguma regra precisa dela. Por isso não há um `productInfo` montado para o carrinho todo.

use super::schema;
use shopify_function::prelude::*;
use shopify_function::Result;
use std::collections::{BTreeMap, BTreeSet};

type Line = schema::cart_lines_discounts_generate_run::input::cart::Lines;

// ── Config normalizada ──

#[derive(Default)]
struct ItemCfg {
    mode: Option<String>,
    value: f64,   // Number(cfg.value) do JS (NaN = ausente/ inválido)
    max_qty: f64, // Number(cfg.maxQty) do JS
    label: Option<String>,
    apply_trigger: bool,
}

#[derive(Default)]
struct Ids {
    product_ids: Vec<String>,
    collection_ids: Vec<String>,
    tags: Vec<String>,
}

struct Targets {
    kind: String, // "products" | "collections" | "tags" | "fn" | outro (não validável → elegível)
    ids: Ids,
}

struct Bundle {
    enabled: bool,
    items: BTreeMap<String, ItemCfg>,
    targets: Option<Targets>,
    per_trigger: bool,
    exclude: Option<Ids>,
}

/// O que a function usa de cada linha, lido uma única vez do input.
struct LineData<'a> {
    pid: Option<&'a str>,
    qty: i64,
    bundle: Option<&'a str>,
    item: Option<&'a str>,
    trigger: Option<&'a str>,
}

#[shopify_function]
fn cart_lines_discounts_generate_run(
    input: schema::cart_lines_discounts_generate_run::Input,
) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    let empty = || Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] });

    if !input
        .discount()
        .discount_classes()
        .contains(&schema::DiscountClass::Product)
    {
        return empty();
    }

    let config = input.discount().metafield().map(|m| m.json_value());
    let mut bundles = normalize_bundles(config);
    let lines = input.cart().lines();

    // Atributos de bundle só são lidos nas linhas de bundle (as demais não precisam deles).
    let data: Vec<LineData> = lines
        .iter()
        .map(|line| {
            let bundle = attr(line.bundle().and_then(|a| a.value()));
            let (item, trigger) = if bundle.is_some() {
                (
                    attr(line.item().and_then(|a| a.value())),
                    attr(line.trigger().and_then(|a| a.value())),
                )
            } else {
                (None, None)
            };
            LineData {
                pid: line_product(line).map(|p| numeric_id(p.id())),
                qty: *line.quantity() as i64,
                bundle,
                item,
                trigger,
            }
        })
        .collect();

    // Presença de cada produto no carrinho (anti-exploit do trigger) e linhas "normais"
    // (fora de bundle) de cada produto, alvo da isenção.
    let mut product_qty: BTreeMap<&str, i64> = BTreeMap::new();
    let mut product_line: BTreeMap<&str, usize> = BTreeMap::new(); // pid -> 1ª linha
    let mut first_lines: Vec<usize> = Vec::new(); // 1ª linha de cada produto, na ordem do carrinho
    let mut trigger_lines: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    let mut trigger_pids: Vec<&str> = Vec::new(); // pids com linhas normais, na ordem do carrinho
    let mut bundle_triggers: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();

    for (idx, d) in data.iter().enumerate() {
        if let Some(pid) = d.pid {
            *product_qty.entry(pid).or_insert(0) += d.qty;
            product_line.entry(pid).or_insert_with(|| {
                first_lines.push(idx);
                idx
            });
            if d.bundle.is_none() {
                let entry = trigger_lines.entry(pid).or_default();
                if entry.is_empty() {
                    trigger_pids.push(pid);
                }
                entry.push(idx);
            }
        }
        if let (Some(lb), Some(lt)) = (d.bundle, d.trigger) {
            bundle_triggers.entry(lb).or_default().insert(lt);
        }
    }

    // v3: bundles por produto vindos do `fn` dos produtos do carrinho (lido 1x por produto).
    if let Some(cfg) = config {
        if js_number(get(cfg, "v")) == 3.0 {
            add_product_bundles(&mut bundles, cfg, lines, &first_lines);
        }
    }
    let bundles = bundles;

    let mut info = Membership {
        lines,
        product_line: &product_line,
        cache: BTreeMap::new(),
    };

    // `perTrigger`: produtos do carrinho que valem como gatilho do bundle (ver JS).
    let mut eligible_cache: BTreeMap<&str, (Vec<&str>, i64)> = BTreeMap::new();

    let mut budgets: BTreeMap<(&str, &str), f64> = BTreeMap::new();
    let mut candidates: Vec<schema::ProductDiscountCandidate> = Vec::new();
    let mut exemptions: Vec<(Vec<&str>, i64, &str)> = Vec::new(); // (pids, cents, label)

    for (idx, d) in data.iter().enumerate() {
        let Some(bundle_id) = d.bundle else { continue };
        let Some(bundle_cfg) = bundles.get(bundle_id) else { continue };
        if !bundle_cfg.enabled {
            continue;
        }

        let Some(item_key) = d.item else { continue };
        let Some(item_cfg) = bundle_cfg.items.get(item_key) else { continue };

        // Anti-exploit: a linha precisa ser do próprio produto add-on.
        if d.pid != Some(item_key) {
            continue;
        }

        let trig = d.trigger;
        if bundle_cfg.per_trigger && !eligible_cache.contains_key(bundle_id) {
            let e = eligible_triggers(
                bundle_id,
                bundle_cfg,
                &trigger_pids,
                &trigger_lines,
                &bundle_triggers,
                &data,
                &mut info,
            );
            eligible_cache.insert(bundle_id, e);
        }
        let eligible = if bundle_cfg.per_trigger {
            eligible_cache.get(bundle_id)
        } else {
            None
        };

        if let Some((_, units)) = eligible {
            // Limite por produto do bundle: basta haver produto elegível no carrinho.
            if *units <= 0 {
                continue;
            }
        } else {
            // Anti-exploit: produto-gatilho precisa estar no carrinho.
            if let Some(t) = trig {
                if product_qty.get(t).copied().unwrap_or(0) <= 0 {
                    continue;
                }
                // Exclusões: gatilho excluído não recebe o bundle.
                if is_excluded(bundle_cfg.exclude.as_ref(), t, &mut info) {
                    continue;
                }
            }
            // Segmentação: com `targets`, o gatilho é obrigatório e precisa ser elegível.
            if let Some(targets) = &bundle_cfg.targets {
                match trig {
                    Some(t) if is_eligible(targets, t, &mut info) => {}
                    _ => continue,
                }
            }
        }

        let remaining = *budgets.entry((bundle_id, item_key)).or_insert_with(|| {
            let mq = item_cfg.max_qty;
            let per = if mq == 0.0 {
                f64::INFINITY
            } else if mq.is_finite() && mq > 0.0 {
                mq
            } else {
                1.0
            };
            match eligible {
                Some((_, units)) if per != f64::INFINITY => per * (*units as f64),
                _ => per,
            }
        });
        if remaining <= 0.0 {
            continue;
        }

        let qty = (d.qty as f64).min(remaining);
        if qty <= 0.0 {
            continue;
        }

        // Isenção: acumula o valor do desconto no(s) gatilho(s) em vez de descontar o add-on.
        // Com `perTrigger`, o gatilho da própria linha vem primeiro e os outros elegíveis
        // completam (ex.: o produto que puxou o add-on saiu do carrinho).
        let own_trig = trig.filter(|t| trigger_lines.contains_key(t));
        let exempt_pids: Vec<&str> = match eligible {
            Some((pids, _)) => {
                let mut v = Vec::with_capacity(pids.len());
                if let Some(o) = own_trig {
                    if pids.contains(&o) {
                        v.push(o);
                    }
                }
                v.extend(pids.iter().copied().filter(|p| Some(*p) != own_trig));
                v
            }
            None => own_trig.into_iter().collect(),
        };
        let label = item_cfg.label.as_deref().unwrap_or("Bundle");

        if item_cfg.apply_trigger && !exempt_pids.is_empty() {
            let cents = discount_cents_per_unit(item_cfg, unit_cents(&lines[idx])) as f64 * qty;
            if cents <= 0.0 {
                continue;
            }
            budgets.insert((bundle_id, item_key), remaining - qty);
            exemptions.push((exempt_pids, cents.round() as i64, label));
            continue;
        }

        let Some(value) = discount_value(item_cfg) else { continue };

        budgets.insert((bundle_id, item_key), remaining - qty);
        candidates.push(schema::ProductDiscountCandidate {
            associated_discount_code: None,
            message: Some(label.to_string()),
            targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                schema::CartLineTarget {
                    id: lines[idx].id().clone(),
                    quantity: Some(qty as i32),
                },
            )],
            value,
        });
    }

    // Reparte a isenção pelas linhas dos gatilhos, na ordem; cada linha recebe no máximo o
    // próprio subtotal, somando todos os bundles (um candidate por linha).
    let mut on_line: BTreeMap<usize, (i64, Vec<&str>)> = BTreeMap::new();
    let mut line_order: Vec<usize> = Vec::new();
    for (pids, total, label) in &exemptions {
        let mut left = *total;
        for pid in pids {
            for &li in trigger_lines.get(pid).map(|v| v.as_slice()).unwrap_or(&[]) {
                if left <= 0 {
                    break;
                }
                let acc = on_line.entry(li).or_insert_with(|| {
                    line_order.push(li);
                    (0, Vec::new())
                });
                let cap = unit_cents(&lines[li]) * data[li].qty - acc.0;
                let cents = left.min(cap);
                if cents <= 0 {
                    continue;
                }
                left -= cents;
                acc.0 += cents;
                if !acc.1.contains(label) {
                    acc.1.push(label);
                }
            }
            if left <= 0 {
                break;
            }
        }
    }
    for li in line_order {
        let (cents, labels) = &on_line[&li];
        if *cents <= 0 {
            continue;
        }
        candidates.push(schema::ProductDiscountCandidate {
            associated_discount_code: None,
            message: Some(labels.join(" + ")),
            targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                schema::CartLineTarget {
                    id: lines[li].id().clone(),
                    quantity: None,
                },
            )],
            value: schema::ProductDiscountCandidateValue::FixedAmount(
                schema::ProductDiscountCandidateFixedAmount {
                    amount: Decimal(*cents as f64 / 100.0),
                    applies_to_each_item: Some(false),
                },
            ),
        });
    }

    if candidates.is_empty() {
        return empty();
    }

    Ok(schema::CartLinesDiscountsGenerateRunResult {
        operations: vec![schema::CartOperation::ProductDiscountsAdd(
            schema::ProductDiscountsAddOperation {
                selection_strategy: schema::ProductDiscountSelectionStrategy::All,
                candidates,
            },
        )],
    })
}

/// Produtos elegíveis como gatilho do bundle (`perTrigger`) e total de unidades deles.
/// Os gatilhos gravados nas linhas do bundle vêm primeiro (recebem a isenção).
fn eligible_triggers<'a>(
    bundle_id: &str,
    cfg: &Bundle,
    trigger_pids: &[&'a str],
    trigger_lines: &BTreeMap<&str, Vec<usize>>,
    bundle_triggers: &BTreeMap<&str, BTreeSet<&str>>,
    data: &[LineData],
    info: &mut Membership,
) -> (Vec<&'a str>, i64) {
    let t = cfg.targets.as_ref().filter(|t| {
        matches!(t.kind.as_str(), "products" | "collections" | "tags" | "fn")
    });
    let registered = bundle_triggers.get(bundle_id);
    let is_registered = |pid: &str| registered.map_or(false, |s| s.contains(pid));
    let mut first = Vec::new();
    let mut rest = Vec::new();
    let mut units = 0i64;
    for &pid in trigger_pids {
        if cfg.items.contains_key(pid) {
            continue; // o próprio add-on não conta como gatilho
        }
        if is_excluded(cfg.exclude.as_ref(), pid, info) {
            continue;
        }
        let ok = match t {
            Some(t) => is_eligible(t, pid, info),
            None => is_registered(pid),
        };
        if !ok {
            continue;
        }
        if is_registered(pid) {
            first.push(pid);
        } else {
            rest.push(pid);
        }
        for &li in &trigger_lines[pid] {
            units += data[li].qty;
        }
    }
    first.extend(rest);
    (first, units)
}

// ── Pertinência (collections / tags consultadas via variables), lida sob demanda ──

struct Membership<'a> {
    lines: &'a [Line],
    product_line: &'a BTreeMap<&'a str, usize>,
    cache: BTreeMap<&'a str, Option<(BTreeSet<&'a str>, BTreeSet<String>)>>,
}

impl<'a> Membership<'a> {
    /// (collections, tags em minúsculas) do produto, ou `None` se ele não está no carrinho.
    fn of(&mut self, pid: &str) -> Option<&(BTreeSet<&'a str>, BTreeSet<String>)> {
        if !self.cache.contains_key(pid) {
            let (&key, &li) = self.product_line.get_key_value(pid)?;
            let v = line_product(&self.lines[li]).map(|p| {
                let colls = p
                    .in_collections()
                    .iter()
                    .filter(|c| *c.is_member())
                    .map(|c| numeric_id(c.collection_id()))
                    .collect();
                let tags = p
                    .has_tags()
                    .iter()
                    .filter(|t| *t.has_tag())
                    .map(|t| t.tag().to_lowercase())
                    .collect();
                (colls, tags)
            });
            self.cache.insert(key, v);
        }
        self.cache.get(pid).and_then(|v| v.as_ref())
    }
}

/// O produto-gatilho está na segmentação do bundle? Tipo desconhecido → elegível.
fn is_eligible(targets: &Targets, pid: &str, info: &mut Membership) -> bool {
    match targets.kind.as_str() {
        "products" | "fn" => targets.ids.product_ids.iter().any(|id| id == pid),
        "collections" => info.of(pid).map_or(false, |(colls, _)| {
            targets.ids.collection_ids.iter().any(|id| colls.contains(id.as_str()))
        }),
        "tags" => info.of(pid).map_or(false, |(_, tags)| {
            targets
                .ids
                .tags
                .iter()
                .any(|t| tags.contains(&t.to_lowercase()))
        }),
        _ => true,
    }
}

/// O produto está nas exclusões do bundle (produto / collection / tag)?
fn is_excluded(exclude: Option<&Ids>, pid: &str, info: &mut Membership) -> bool {
    let Some(x) = exclude else { return false };
    if x.product_ids.iter().any(|id| id == pid) {
        return true;
    }
    if x.collection_ids.is_empty() && x.tags.is_empty() {
        return false;
    }
    let Some((colls, tags)) = info.of(pid) else { return false };
    x.collection_ids.iter().any(|id| colls.contains(id.as_str()))
        || x.tags.iter().any(|t| tags.contains(&t.to_lowercase()))
}

// ── Valores ──

/// Preço unitário da linha em centavos.
fn unit_cents(line: &Line) -> i64 {
    let n = (line.cost().amount_per_quantity().amount().as_f64() * 100.0).round();
    if n.is_finite() && n > 0.0 {
        n as i64
    } else {
        0
    }
}

/// Valor do desconto do item por unidade, em centavos (para a isenção).
fn discount_cents_per_unit(cfg: &ItemCfg, base_cents: i64) -> i64 {
    let raw = cfg.value;
    let mode = cfg.mode.as_deref();
    if mode == Some("gift") {
        return base_cents;
    }
    if !raw.is_finite() || raw <= 0.0 {
        return 0;
    }
    match mode {
        Some("percent") => ((base_cents as f64 * raw.min(100.0)) / 100.0).round() as i64,
        Some("fixed") => ((raw * 100.0).round() as i64).min(base_cents),
        _ => 0,
    }
}

/// Converte a config do item no value do candidate.
fn discount_value(cfg: &ItemCfg) -> Option<schema::ProductDiscountCandidateValue> {
    let raw = cfg.value;
    match cfg.mode.as_deref() {
        Some("gift") => Some(schema::ProductDiscountCandidateValue::Percentage(
            schema::Percentage { value: Decimal(100.0) },
        )),
        Some("percent") if raw.is_finite() && raw > 0.0 => Some(
            schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
                value: Decimal(raw.min(100.0)),
            }),
        ),
        Some("fixed") if raw.is_finite() && raw > 0.0 => Some(
            schema::ProductDiscountCandidateValue::FixedAmount(
                schema::ProductDiscountCandidateFixedAmount {
                    amount: Decimal((raw * 100.0).round() / 100.0),
                    applies_to_each_item: Some(true),
                },
            ),
        ),
        _ => None,
    }
}

// ── Normalização da config ──

fn v2_mode(m: &JsonValue) -> Option<String> {
    let s = js_string(m)?;
    Some(
        match s.as_str() {
            "g" => "gift",
            "p" => "percent",
            "f" => "fixed",
            other => other,
        }
        .to_string(),
    )
}

/// Ids de uma lista JSON como strings (`String(id)` do JS).
fn id_list(v: Option<&JsonValue>) -> Vec<String> {
    match v {
        Some(JsonValue::Array(a)) => a.iter().filter_map(js_string).collect(),
        _ => Vec::new(),
    }
}

/// Exclusões compactas (`x: { p, c, g }`).
fn compact_exclude(x: Option<&JsonValue>) -> Option<Ids> {
    let x = x.filter(|v| js_truthy(v))?;
    Some(Ids {
        product_ids: id_list(get(x, "p")),
        collection_ids: id_list(get(x, "c")),
        tags: id_list(get(x, "g")),
    })
}

/// Item compacto (`{ m, v, l, q, a }`); `label` já resolvido.
fn compact_item(it: &JsonValue, label: Option<String>) -> ItemCfg {
    ItemCfg {
        mode: get(it, "m").and_then(v2_mode),
        value: js_number(get(it, "v")),
        max_qty: js_number(get(it, "q")),
        label: label.filter(|l| !l.is_empty()),
        apply_trigger: get(it, "a").map_or(false, js_truthy),
    }
}

/// Config da discount (formato antigo `bundles` ou compacto v2/v3) → bundles.
fn normalize_bundles(config: Option<&JsonValue>) -> BTreeMap<String, Bundle> {
    let mut out = BTreeMap::new();
    let Some(config) = config.filter(|c| js_truthy(c)) else { return out };
    let v = js_number(get(config, "v"));
    if v != 2.0 && v != 3.0 {
        if let Some(JsonValue::Object(b)) = get(config, "bundles") {
            for (id, e) in b {
                if let Some(bundle) = legacy_bundle(e) {
                    out.insert(id.clone(), bundle);
                }
            }
        }
        return out;
    }

    let labels: &[JsonValue] = match get(config, "L") {
        Some(JsonValue::Array(a)) => a,
        _ => &[],
    };
    let Some(JsonValue::Object(b)) = get(config, "b") else { return out };
    for (id, e) in b {
        let mut items = BTreeMap::new();
        if let Some(JsonValue::Object(i)) = get(e, "i") {
            for (pid, it) in i {
                let label = get(it, "l")
                    .map(|l| js_number(Some(l)))
                    .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0)
                    .and_then(|n| labels.get(n as usize))
                    .and_then(js_string);
                items.insert(pid.clone(), compact_item(it, label));
            }
        }
        let targets = get(e, "t").and_then(|t| {
            let kind = match js_string(get(t, "k")?)?.as_str() {
                "p" => "products",
                "c" => "collections",
                "g" => "tags",
                _ => return None,
            };
            let list = id_list(get(t, "ids"));
            let mut ids = Ids::default();
            match kind {
                "products" => ids.product_ids = list,
                "collections" => ids.collection_ids = list,
                _ => ids.tags = list,
            }
            Some(Targets { kind: kind.to_string(), ids })
        });
        out.insert(
            id.clone(),
            Bundle {
                enabled: true,
                items,
                targets,
                per_trigger: get(e, "u").map_or(false, js_truthy),
                exclude: compact_exclude(get(e, "x")),
            },
        );
    }
    out
}

/// Bundle no formato antigo (`{ enabled, items, targets, perTrigger, exclude }`).
fn legacy_bundle(e: &JsonValue) -> Option<Bundle> {
    if !js_truthy(e) {
        return None;
    }
    let mut items = BTreeMap::new();
    if let Some(JsonValue::Object(i)) = get(e, "items") {
        for (pid, it) in i {
            if !matches!(it, JsonValue::Object(_)) {
                continue; // item sem objeto nunca gera desconto
            }
            items.insert(
                pid.clone(),
                ItemCfg {
                    mode: get(it, "mode").and_then(js_string),
                    value: js_number(get(it, "value")),
                    max_qty: js_number(get(it, "maxQty")),
                    label: get(it, "label")
                        .filter(|l| js_truthy(l))
                        .and_then(js_string),
                    apply_trigger: matches!(get(it, "applyTo"), Some(JsonValue::String(s)) if s == "trigger"),
                },
            );
        }
    }
    let targets = get(e, "targets").filter(|t| js_truthy(t)).map(|t| Targets {
        kind: get(t, "type").and_then(js_string).unwrap_or_default(),
        ids: Ids {
            product_ids: id_list(get(t, "productIds")),
            collection_ids: id_list(get(t, "collectionIds")),
            tags: id_list(get(t, "tags")),
        },
    });
    let exclude = get(e, "exclude").filter(|x| js_truthy(x)).map(|x| Ids {
        product_ids: id_list(get(x, "productIds")),
        collection_ids: id_list(get(x, "collectionIds")),
        tags: id_list(get(x, "tags")),
    });
    Some(Bundle {
        enabled: !matches!(get(e, "enabled"), Some(JsonValue::Boolean(false))),
        items,
        targets,
        per_trigger: get(e, "perTrigger").map_or(false, js_truthy),
        exclude,
    })
}

/// v3: acrescenta os bundles por produto lidos do metafield `fn` de cada produto do
/// carrinho (só os com `k` em `config.a`). A elegibilidade vira `targets: fn` = os
/// produtos do carrinho que têm o bundle.
fn add_product_bundles(
    bundles: &mut BTreeMap<String, Bundle>,
    config: &JsonValue,
    lines: &[Line],
    first_lines: &[usize],
) {
    let active: Vec<f64> = match get(config, "a") {
        Some(JsonValue::Array(a)) => a.iter().map(|v| js_number(Some(v))).collect(),
        _ => Vec::new(),
    };
    for &li in first_lines {
        let Some(product) = line_product(&lines[li]) else { continue };
        let Some(JsonValue::Object(fn_map)) = product.r#fn().map(|m| m.json_value()) else {
            continue;
        };
        let pid = numeric_id(product.id()).to_string();
        for (bid, e) in fn_map {
            let k = js_number(get(e, "k"));
            // SameValueZero do Set do JS (NaN encontra NaN).
            if !active.iter().any(|a| *a == k || (a.is_nan() && k.is_nan())) {
                continue;
            }
            // id que já é de bundle amplo (com ou sem segmentação): o `fn` não o sobrescreve
            if let Some(b) = bundles.get(bid) {
                if !b.targets.as_ref().map_or(false, |t| t.kind == "fn") {
                    continue;
                }
            } else {
                let mut items = BTreeMap::new();
                if let Some(JsonValue::Object(i)) = get(e, "i") {
                    for (apid, it) in i {
                        let label = get(it, "l").and_then(js_string);
                        items.insert(apid.clone(), compact_item(it, label));
                    }
                }
                bundles.insert(
                    bid.clone(),
                    Bundle {
                        enabled: true,
                        items,
                        targets: Some(Targets { kind: "fn".to_string(), ids: Ids::default() }),
                        per_trigger: get(e, "u").map_or(false, js_truthy),
                        exclude: compact_exclude(get(e, "x")),
                    },
                );
            }
            let t = bundles.get_mut(bid).and_then(|b| b.targets.as_mut()).unwrap();
            if !t.ids.product_ids.contains(&pid) {
                t.ids.product_ids.push(pid.clone());
            }
        }
    }
}

// ── Helpers ──

fn line_product(
    line: &Line,
) -> Option<&schema::cart_lines_discounts_generate_run::input::cart::lines::merchandise::product_variant::Product> {
    match line.merchandise() {
        schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise::ProductVariant(v) => {
            Some(v.product())
        }
        _ => None,
    }
}

/// Valor não vazio de um atributo da linha (`line.x && line.x.value` do JS).
fn attr(v: Option<&String>) -> Option<&str> {
    v.map(|s| s.as_str()).filter(|s| !s.is_empty())
}

/// Extrai o id numérico de um GID.
fn numeric_id(gid: &str) -> &str {
    gid.rsplit('/').next().unwrap_or(gid)
}

fn get<'a>(v: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match v {
        JsonValue::Object(o) => o.get(key),
        _ => None,
    }
}

/// `Number(x)` do JS (ausente → NaN).
fn js_number(v: Option<&JsonValue>) -> f64 {
    match v {
        None => f64::NAN,
        Some(JsonValue::Null) => 0.0,
        Some(JsonValue::Boolean(b)) => *b as u8 as f64,
        Some(JsonValue::Number(n)) => *n,
        Some(JsonValue::String(s)) => {
            let s = s.trim();
            if s.is_empty() {
                0.0
            } else {
                s.parse().unwrap_or(f64::NAN)
            }
        }
        Some(_) => f64::NAN,
    }
}

/// `String(x)` do JS para ids/labels (null/objetos não viram id).
fn js_string(v: &JsonValue) -> Option<String> {
    match v {
        JsonValue::String(s) => Some(s.clone()),
        JsonValue::Number(n) if n.fract() == 0.0 && n.abs() < 1e21 => Some(format!("{}", *n as i64)),
        JsonValue::Number(n) => Some(n.to_string()),
        JsonValue::Boolean(b) => Some(b.to_string()),
        _ => None,
    }
}

fn js_truthy(v: &JsonValue) -> bool {
    match v {
        JsonValue::Null => false,
        JsonValue::Boolean(b) => *b,
        JsonValue::Number(n) => *n != 0.0 && !n.is_nan(),
        JsonValue::String(s) => !s.is_empty(),
        _ => true,
    }
}
