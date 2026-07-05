// 3DPX — Stripe webhook → create a "Pre Sale" row in the SLS Jobs Smartsheet.
// Fires on checkout.session.completed (a completed payment).
//
// Env vars (Netlify → Site settings → Environment variables):
//   STRIPE_WEBHOOK_SECRET  — from the Stripe webhook endpoint you register (whsec_…)
//   SMARTSHEET_TOKEN       — Smartsheet API access token
//   SMARTSHEET_SHEET_ID    — (optional) target sheet; defaults to SLS Jobs. Set to a
//                            COPY sheet while testing so you don't clutter production.

import crypto from "node:crypto";

const SLS_JOBS_SHEET = "7474902212077444";
// SLS Jobs column IDs (from the sheet schema)
const COL = {
  orderStatus: 3699329920722820,   // PICKLIST
  poNumber:    2573430013880196,   // primary
  company:     1447530107037572,   // contact list
  contact:     2432692525524868,   // contact list
  price:       3704368460523396,
  volume:      2010480060458884,
  totalParts:  8202929548093316,
  color:       6514079687829380,   // multi-picklist
  dye:         4262279874144132,   // checkbox
  vapor:       5201233072940932,   // checkbox
  shipAddr:    347271731564420,
  poType:      8601217236946820,   // picklist
  notes:       438442912337796,
};

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await req.text();

  // Verify Stripe signature (if the secret is configured)
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers.get("stripe-signature") || "";
    if (!verifyStripe(raw, sig, secret)) return new Response("Bad signature", { status: 400 });
  }

  let event;
  try { event = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  if (event.type !== "checkout.session.completed") return new Response("ignored", { status: 200 });

  const s = event.data.object || {};
  const m = s.metadata || {};
  const token = process.env.SMARTSHEET_TOKEN;
  if (!token) { console.log("No SMARTSHEET_TOKEN set; skipping row creation."); return new Response("ok (no token)", { status: 200 }); }

  const sheetId = process.env.SMARTSHEET_SHEET_ID || SLS_JOBS_SHEET;
  const price = (s.amount_total != null ? s.amount_total : 0) / 100;
  const contactVal = (m.customer_name || "") + (m.customer_email ? " <" + m.customer_email + ">" : "");

  const cells = [
    { columnId: COL.orderStatus, value: "Pre Sale", strict: false },
    { columnId: COL.poNumber,    value: m.order_no || "" },
    { columnId: COL.company,     value: m.company || m.customer_name || "Web Order", strict: false },
    { columnId: COL.contact,     value: contactVal || "Web Order", strict: false },
    { columnId: COL.price,       value: price },
    { columnId: COL.volume,      value: parseFloat(m.total_vol) || 0 },
    { columnId: COL.totalParts,  value: parseInt(m.total_parts) || 0 },
    { columnId: COL.color,       value: m.color || "White", strict: false },
    { columnId: COL.dye,         value: m.dye_any === "yes" },
    { columnId: COL.vapor,       value: m.vapor_any === "yes" },
    { columnId: COL.shipAddr,    value: m.shipping_address || "" },
    { columnId: COL.poType,      value: "Standard", strict: false },
    { columnId: COL.notes,       value: m.notes || "" },
  ];

  const r = await fetch(`https://api.smartsheet.com/2.0/sheets/${sheetId}/rows`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify([{ toBottom: true, cells }]),
  });
  if (!r.ok) {
    const errTxt = await r.text();
    console.log("Smartsheet row create failed:", r.status, errTxt);
    // Still return 200 so Stripe doesn't retry forever; the payment already succeeded.
    return new Response("payment ok, sheet write failed", { status: 200 });
  }
  return new Response("ok", { status: 200 });
};

// Verify Stripe's signature header: "t=<ts>,v1=<sig>[,v1=<sig>]"
function verifyStripe(payload, header, secret) {
  try {
    const items = header.split(",").map(p => p.split("="));
    const t = items.find(i => i[0] === "t")?.[1];
    const sigs = items.filter(i => i[0] === "v1").map(i => i[1]);
    if (!t || !sigs.length) return false;
    const expected = crypto.createHmac("sha256", secret).update(t + "." + payload).digest("hex");
    return sigs.some(v1 => {
      try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1)); } catch { return false; }
    });
  } catch { return false; }
}
