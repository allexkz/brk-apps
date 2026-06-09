const PICKUP_SERVICE_NAME = "Retirada em Loja";
const PICKUP_SERVICE_CODE = "retirada_loja";

function isPickupOption(option) {
  return (
    option.title === PICKUP_SERVICE_NAME ||
    option.code === PICKUP_SERVICE_CODE ||
    option.handle.includes("retirada-em-loja") ||
    option.handle.includes("retirada_loja")
  );
}

export function cartDeliveryOptionsTransformRun(input) {
  const operations = [];

  for (const group of input.cart.deliveryGroups) {
    const pickupOption = group.deliveryOptions.find(isPickupOption);

    if (!pickupOption || group.deliveryOptions.length <= 1) {
      continue;
    }

    operations.push({
      deliveryOptionMove: {
        deliveryOptionHandle: pickupOption.handle,
        index: group.deliveryOptions.length - 1,
      },
    });
  }

  return { operations };
}
