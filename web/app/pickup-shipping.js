export const PICKUP_SERVICE_NAME = "Retirada em Loja";
export const PICKUP_SERVICE_CODE = "retirada_loja";
export const PICKUP_CEP_START = 38400000;
export const PICKUP_CEP_END = 38439499;
export const PICKUP_CEP_RANGE_LABEL = "38400-000 a 38439-499";
export const PICKUP_ADDRESS = "Rua Francisco Vieira de Paiva, 49 - Uberlândia MG";

export function normalizeCep(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length !== 8) return null;
  return Number.parseInt(digits, 10);
}

export function isPickupCep(value) {
  const cep = normalizeCep(value);
  return cep !== null && cep >= PICKUP_CEP_START && cep <= PICKUP_CEP_END;
}

export function isBrazilDestination(destination = {}) {
  const country = String(
    destination.country_code ?? destination.country ?? ""
  ).toUpperCase();

  return (
    country === "" ||
    country === "BR" ||
    country === "BRA" ||
    country === "BRAZIL" ||
    country === "BRASIL"
  );
}

export function getDestinationCep(destination = {}) {
  return (
    destination.postal_code ??
    destination.postalCode ??
    destination.zip ??
    destination.cep ??
    ""
  );
}

export function isPickupDestination(destination = {}) {
  return (
    isBrazilDestination(destination) &&
    isPickupCep(getDestinationCep(destination))
  );
}

export function buildPickupRate(currency = "BRL") {
  return {
    service_name: PICKUP_SERVICE_NAME,
    service_code: PICKUP_SERVICE_CODE,
    total_price: "0",
    currency: currency || "BRL",
    description: PICKUP_ADDRESS,
  };
}
