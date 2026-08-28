// 3DPX — allocate the next sequential web order number (WEB-1001, 1002, ...).
// The widget calls this at the moment an order is placed, then uploads files + creates the order
// under the returned number. See _orderno.mjs for the compare-and-set counter.

import { getStore } from "@netlify/blobs";
import { allocateWebOrderNo } from "./_orderno.mjs";

export default async () => {
  try {
    const orderNo = await allocateWebOrderNo(getStore("orders"));
    return json({ ok: true, orderNo });
  } catch (e) {
    return json({ ok: false, error: "Could not allocate an order number." }, 500);
  }
};

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
}
