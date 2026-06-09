// @ts-check

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

const DEFAULTS = {
  maxStreet: 40,
  maxNumber: 6,
  maxComplement: 40,
  messageStreet: "O campo Rua deve ter no maximo {max} caracteres.",
  messageNumber: "O campo Numero deve ter no maximo {max} caracteres.",
  messageComplement: "O campo Complemento deve ter no maximo {max} caracteres.",
};

function normalizeConfig(input) {
  const value = input.validation.metafield?.jsonValue;
  const config = value && typeof value === "object" ? value : {};

  function posInt(v, fallback) {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  }

  function str(v, fallback) {
    return typeof v === "string" && v.trim() ? v.trim() : fallback;
  }

  return {
    enabled: config.enabled !== false,
    maxStreet: posInt(config.maxStreet, posInt(config.maxLength, DEFAULTS.maxStreet)),
    maxNumber: posInt(config.maxNumber, DEFAULTS.maxNumber),
    maxComplement: posInt(config.maxComplement, DEFAULTS.maxComplement),
    messageStreet: str(config.messageStreet, str(config.message, DEFAULTS.messageStreet)),
    messageNumber: str(config.messageNumber, DEFAULTS.messageNumber),
    messageComplement: str(config.messageComplement, DEFAULTS.messageComplement),
  };
}

function buildMessage(template, max) {
  return template.replaceAll("{max}", String(max));
}

/**
 * Shopify concatena streetName + streetNumber no address1
 * separados por word joiner (\u2060). Ex: "Rua X, \u206042"
 */
function splitAddress1(address1) {
  const joinerIndex = address1.indexOf("\u2060");
  if (joinerIndex > 0) {
    return {
      street: address1.substring(0, joinerIndex).replace(/,\s*$/, "").trim(),
      number: address1.substring(joinerIndex + 1).trim(),
    };
  }
  return { street: address1, number: "" };
}

/**
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const config = normalizeConfig(input);
  const errors = [];

  if (config.enabled) {
    input.cart.deliveryGroups.forEach((group, index) => {
      const address1 = group.deliveryAddress?.address1 || "";
      const address2 = group.deliveryAddress?.address2 || "";
      const { street, number } = splitAddress1(address1);

      if (street.length > config.maxStreet) {
        errors.push({
          message: buildMessage(config.messageStreet, config.maxStreet),
          target: `$.cart.deliveryGroups[${index}].deliveryAddress.address1`,
        });
      }

      if (number.length > config.maxNumber) {
        errors.push({
          message: buildMessage(config.messageNumber, config.maxNumber),
          target: `$.cart.deliveryGroups[${index}].deliveryAddress.address1`,
        });
      }

      if (address2.length > config.maxComplement) {
        errors.push({
          message: buildMessage(config.messageComplement, config.maxComplement),
          target: `$.cart.deliveryGroups[${index}].deliveryAddress.address2`,
        });
      }
    });
  }

  const operations = [
    {
      validationAdd: {
        errors,
      },
    },
  ];

  return { operations };
}
