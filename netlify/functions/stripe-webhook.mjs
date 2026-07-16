// 3DPX - Stripe webhook -> create a "Pre Sale" row in the SLS Jobs Smartsheet.
// Fires on checkout.session.completed (a completed payment).
//
// Env vars (Netlify -> Site settings -> Environment variables):
//   STRIPE_WEBHOOK_SECRET  - from the Stripe webhook endpoint (whsec_...)
//   SMARTSHEET_TOKEN       - Smartsheet API access token
//   SMARTSHEET_SHEET_ID    - (optional) target sheet; defaults to SLS Jobs.

import crypto from "node:crypto";
import { sendOrderEmail } from "./_notify.mjs";
import { logOrder } from "./_orderlog.mjs";
import { shipCells } from "./_shipmap.mjs";

const SLS_JOBS_SHEET = "7474902212077444";
const COL = {
  orderStatus: 3699329920722820,
  poNumber:    2573430013880196,
  company:     1447530107037572,
  contact:     2432692525524868,
  price:       3704368460523396,
  volume:      2010480060458884,
  totalParts:  8202929548093316,
  color:       6514079687829380,
  dye:         4262279874144132,
  vapor:       5201233072940932,
  shipAddr:    347271731564420,
  poType:      8601217236946820,
  notes:       438442912337796,
  dueDate:     5951129734408068,
};

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const raw = await req.text();

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

  // Idempotency: Stripe can deliver the same event more than once (automatic retries or a manual
  // resend), and this webhook has no natural dedup — so skip if a row for this order already exists.
  if (m.order_no) {
    try {
      const ex = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "?columnIds=" + COL.poNumber, { headers: { Authorization: "Bearer " + token } });
      const ed = await ex.json();
      if ((ed.rows || []).some(r => (r.cells || []).some(c => String(c.value || "").includes(m.order_no)))) {
        return new Response("duplicate ignored", { status: 200 });
      }
    } catch (e) { /* if the check fails, fall through and create the row */ }
  }

  // With Stripe Tax on, amount_total includes tax. Record the pre-tax order value in Price and note the tax.
  const subtotal = (s.amount_subtotal != null ? s.amount_subtotal : (s.amount_total || 0)) / 100;
  const taxAmt = (s.total_details && s.total_details.amount_tax != null ? s.total_details.amount_tax : 0) / 100;
  const price = subtotal;
  const contactVal = (m.customer_name || "") + (m.customer_email ? " <" + m.customer_email + ">" : "");
  const due = /^\d{4}-\d{2}-\d{2}$/.test(m.due_date||"") ? m.due_date : addBusinessDays(new Date(), parseInt(m.lead_days)||3).toISOString().slice(0,10);
  const notesWithTax = taxAmt > 0 ? ((m.notes || "") + " | Tax collected: $" + taxAmt.toFixed(2)).slice(0,495) : (m.notes || "");

  const cells = [
    { columnId: COL.orderStatus, value: "Pre Sale", strict: false },
    { columnId: COL.poNumber,    value: m.order_no || "" },
    { columnId: COL.company,     value: m.company || m.customer_name || "Web Order", strict: false },
    { columnId: COL.contact,     value: contactVal || "Web Order", strict: false },
    { columnId: COL.price,       value: price },
    { columnId: COL.volume,      value: parseFloat(m.total_vol) || 0 },
    { columnId: COL.totalParts,  value: parseInt(m.total_parts) || 0 },
    { columnId: COL.dueDate,     value: due },
    { columnId: COL.color,       objectValue: { objectType: "MULTI_PICKLIST", values: ((m.color || "White").split("|").filter(Boolean)) }, strict: false },
    { columnId: COL.dye,         value: m.dye_any === "yes" },
    { columnId: COL.vapor,       value: m.vapor_any === "yes" },
    { columnId: COL.shipAddr,    value: m.shipping_address || "" },
    { columnId: COL.poType,      value: "Standard", strict: false },
    { columnId: COL.notes,       value: notesWithTax },
  ];
  cells.push(...shipCells(m.ship_speed));

  const r = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "/rows", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify([{ toBottom: true, cells }]),
  });
  const rowResp = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log("Smartsheet row create failed:", r.status, JSON.stringify(rowResp));
    return new Response("payment ok, sheet write failed", { status: 200 });
  }
  const rowId = rowResp.result && rowResp.result[0] && rowResp.result[0].id;

  // Notify the team + log to the capture-all orders sheet (best-effort).
  await sendOrderEmail({
    kind: "Card order", orderNo: m.order_no, company: m.company || m.customer_name,
    contact: contactVal, price: price, tax: taxAmt, pieces: m.total_parts,
    delivery: m.ship_method, due, payment: "Paid via Stripe", notes: m.notes,
  });
  await logOrder({
    orderNo: m.order_no, type: "Card", source: m.source === "internal" ? "Internal" : "Web",
    company: m.company || m.customer_name, contact: m.customer_name, email: m.customer_email,
    phone: m.customer_phone, amount: price, tax: taxAmt, pieces: m.total_parts, volume: m.total_vol,
    colors: m.color, delivery: m.ship_method, payment: "Paid via Stripe", po: "",
    quoteId: m.quote_id, shipTo: m.shipping_address, notes: m.notes,
  });

  // Attach uploaded STL file(s) to the new row (best-effort; never fails the webhook).
  if (rowId && m.order_no) {
    try {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore("orders");
      const listing = await store.list({ prefix: m.order_no + "/" });
      for (const b of (listing.blobs || [])) {
        try {
          const bytes = await store.get(b.key, { type: "arrayBuffer" });
          if (!bytes) continue;
          const meta = await store.getMetadata(b.key).catch(() => null);
          const fname = (meta && meta.metadata && meta.metadata.name) || b.key.split("__").pop() || "part.stl";
          const fd = new FormData();
          fd.append("file", new Blob([bytes], { type: "application/octet-stream" }), fname);
          const ar = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "/rows/" + rowId + "/attachments", {
            method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
          if (!ar.ok) console.log("attach failed:", ar.status, await ar.text());
          else await store.delete(b.key);
        } catch (e2) { console.log("attach item failed:", e2.message); }
      }
    } catch (e) { console.log("attach step failed:", e.message); }
  }

  return new Response("ok", { status: 200 });
};

function addBusinessDays(d, n) {
  const r = new Date(d); let added = 0;
  while (added < n) { r.setDate(r.getDate()+1); const day = r.getDay(); if (day!==0 && day!==6) added++; }
  return r;
}

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
