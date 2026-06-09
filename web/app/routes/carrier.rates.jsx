import { json } from "@remix-run/cloudflare";

import { buildPickupRate, isPickupDestination } from "../pickup-shipping";

export const loader = async () => {
  return json({ ok: true });
};

export const action = async ({ request }) => {
  let payload;

  try {
    payload = await request.json();
  } catch {
    return json({ rates: [] }, { status: 200 });
  }

  const rateRequest = payload?.rate ?? {};
  const destination = rateRequest.destination ?? {};
  const rates = isPickupDestination(destination)
    ? [buildPickupRate(rateRequest.currency)]
    : [];

  return json(
    { rates },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
};
