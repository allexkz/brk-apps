// Regras puras dos kits Camisa + Botina (sem rede) — usadas por app.kits_.api.jsx.

export const BOOTS = {
  "9587666616617": "Botina Couro Legítimo Chocolate",
  "10091739676969": "Botina Feminina Stella Chocolate",
};

// ── Regras puras (preço, título) ──

// Preço do kit: soma × (1 − desconto), arredondado PARA BAIXO para terminar em 9,90
// (ex.: 350,82 → 349,90), garantindo desconto ≥ o percentual configurado.
export function kitPrice(sum, pct) {
  const raw = sum * (1 - pct / 100);
  const p = Math.floor(raw / 10) * 10 - 0.1;
  return (p > 0 ? p : raw).toFixed(2);
}

// Preço de uma variante do kit: o preço FIXO (por botina) quando ele é menor que a soma
// camisa + botina; senão (ex.: camiseta de 99,90, em que o fixo sairia mais caro que
// comprar separado) cai no desconto percentual.
export function kitVariantPrice(sum, pct, fixed) {
  const f = Number(fixed);
  return f > 0 && f < sum ? f.toFixed(2) : kitPrice(sum, pct);
}

// "Camisa Agro Brk Brasil com Proteção Solar UV50+" → "Camisa Agro Brk Brasil"
export function shortName(title) {
  return String(title || "").replace(/\s+com\s+(prote[çc][ãa]o|uv\s*50).*$/i, "").trim();
}

export function kitTitle(shirt, boot) {
  return `Kit ${shortName(shirt.title)} + ${BOOTS[boot.legacyResourceId] || shortName(boot.title)}`;
}

