// 3DPX — Reconcile / backfill: pull completed Stripe payments and create any SLS Jobs rows
// that are missing (e.g. because the webhook was mispointed). Safe to re-run — it dedupes on the
// order number already present in the sheet, so it never creates a duplicate.
//
// Trigger: GET /.netlify/functions/reconcile-orders?key=<RECONCILE_KEY>&days=21
//   - If env RECONCILE_KEY is set, ?key must match (recommended). If unset, it still runs
//     (the action is idempotent and only ever creates rows for real paid Stripe sessions).
//   - days = how far back to look (default 21, max 90).
//
// Env: STRIPE_SECRET_KEY, SMARTSHEET_TOKEN, SMARTSHEET_SHEET_ID (optional).

import { sendOrderEmail } from "./_notify.mjs";
import { logOrder } from "./_orderlog.mjs";

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
  const url = new URL(req.url);
  const need = process.env.RECONCILE_KEY;
  if (need && url.searchParams.get("key") !== need) return json({ error: "Not authorized" }, 403);

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const token = process.env.SMARTSHEET_TOKEN;
  if (!stripeKey || !token) return json({ error: "Missing STRIPE_SECRET_KEY or SMARTSHEET_TOKEN" }, 503);
  const sheetId = process.env.SMARTSHEET_SHEET_ID || SLS_JOBS_SHEET;

  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("days")) || 21));
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  // 1) Pull completed+paid Stripe checkout sessions in the window (paginate).
  const sessions = [];
  let starting_after = null;
  try {
    for (let page = 0; page < 10; page++) {
      const qs = new URLSearchParams({ limit: "100", "created[gte]": String(since) });
      if (starting_after) qs.append("starting_after", starting_after);
      const r = await fetch("https://api.stripe.com/v1/checkout/sessions?" + qs.toString(), {
        headers: { Authorization: "Bearer " + stripeKey },
      });
      const d = await r.json();
      if (!r.ok) return json({ error: "Stripe list failed: " + ((d.error && d.error.message) || r.status) }, 502);
      for (const s of (d.data || [])) {
        if (s.status === "complete" && s.payment_status === "paid" && s.metadata && s.metadata.order_no) sessions.push(s);
      }
      if (!d.has_more || !d.data.length) break;
      starting_after = d.data[d.data.length - 1].id;
    }
  } catch (e) { return json({ error: "Stripe fetch error: " + e.message }, 502); }

  // 2) Existing order numbers already in the sheet (dedupe).
  let existing = "";
  try {
    const r = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "?columnIds=" + COL.poNumber, {
      headers: { Authorization: "Bearer " + token },
    });
    const d = await r.json();
    if (r.ok) existing = (d.rows || []).map(row => (row.cells || []).map(c => c.value || "").join(" ")).join(" | ");
  } catch (e) { /* if this fails we may create a dup; acceptable vs losing an order */ }

  // 3) Create any missing rows.
  const created = [], skipped = [], failed = [];
  for (const s of sessions) {
    const orderNo = s.metadata.order_no;
    if (existing.includes(orderNo)) { skipped.push(orderNo); continue; }
    try {
      const ok = await createRow(s, sheetId, token);
      if (ok) { created.push(orderNo); existing += " | " + orderNo; }
      else failed.push(orderNo);
    } catch (e) { failed.push(orderNo + " (" + e.message + ")"); }
  }

  return json({ ok: true, windowDays: days, paidSessions: sessions.length, created, skipped, failed });
};

async function createRow(s, sheetId, token) {
  const m = s.metadata || {};
  const subtotal = (s.amount_subtotal != null ? s.amount_subtotal : (s.amount_total || 0)) / 100;
  const taxAmt = (s.total_details && s.total_details.amount_tax != null ? s.total_details.amount_tax : 0) / 100;
  const contactVal = (m.customer_name || "") + (m.customer_email ? " <" + m.customer_email + ">" : "");
  const due = /^\d{4}-\d{2}-\d{2}$/.test(m.due_date || "") ? m.due_date : addBusinessDays(new Date(), parseInt(m.lead_days) || 3).toISOString().slice(0, 10);
  const notes = (taxAmt > 0 ? ((m.notes || "") + " | Tax collected: $" + taxAmt.toFixed(2)) : (m.notes || "")).slice(0, 495);

  const cells = [
    { columnId: COL.orderStatus, value: "Pre Sale", strict: false },
    { columnId: COL.poNumber,    value: m.order_no || "" },
    { columnId: COL.company,     value: m.company || m.customer_name || "Web Order", strict: false },
    { columnId: COL.contact,     value: contactVal || "Web Order", strict: false },
    { columnId: COL.price,       value: subtotal },
    { columnId: COL.volume,      value: parseFloat(m.total_vol) || 0 },
    { columnId: COL.totalParts,  value: parseInt(m.total_parts) || 0 },
    { columnId: COL.dueDate,     value: due },
    { columnId: COL.color,       objectValue: { objectType: "MULTI_PICKLIST", values: ((m.color || "White").split("|").filter(Boolean)) }, strict: false },
    { columnId: COL.dye,         value: m.dye_any === "yes" },
    { columnId: COL.vapor,       value: m.vapor_any === "yes" },
    { columnId: COL.shipAddr,    value: m.shipping_address || "" },
    { columnId: COL.poType,      value: "Standard", strict: false },
    { columnId: COL.notes,       value: notes },
  ];

  const r = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "/rows", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify([{ toBottom: true, cells }]),
  });
  const resp = await r.json().catch(() => ({}));
  if (!r.ok) { console.log("reconcile row failed:", r.status, JSON.stringify(resp)); return false; }
  const rowId = resp.result && resp.result[0] && resp.result[0].id;

  // Attach any stored files for this order (best-effort).
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
          const fname = (meta && meta.metadata && meta.metadata.name) || b.key.split("__").pop() || "file";
          const fd = new FormData();
          fd.append("file", new Blob([bytes], { type: "application/octet-stream" }), fname);
          const ar = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "/rows/" + rowId + "/attachments", {
            method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
          if (ar.ok) await store.delete(b.key);
        } catch (e2) { console.log("reconcile attach item failed:", e2.message); }
      }
    } catch (e) { console.log("reconcile attach step failed:", e.message); }
  }

  await sendOrderEmail({
    kind: "Card order (recovered)", orderNo: m.order_no, company: m.company || m.customer_name,
    contact: contactVal, price: subtotal, tax: taxAmt, pieces: m.total_parts,
    delivery: m.ship_method, due, payment: "Paid via Stripe", notes,
  });
  await logOrder({
    orderNo: m.order_no, type: "Card (recovered)", source: m.source === "internal" ? "Internal" : "Web",
    company: m.company || m.customer_name, contact: m.customer_name, email: m.customer_email,
    phone: m.customer_phone, amount: subtotal, tax: taxAmt, pieces: m.total_parts, volume: m.total_vol,
    colors: m.color, delivery: m.ship_method, payment: "Paid via Stripe", po: "",
    quoteId: m.quote_id, shipTo: m.shipping_address, notes,
  });
  return true;
}

function addBusinessDays(d, n) {
  const r = new Date(d); let added = 0;
  while (added < n) { r.setDate(r.getDate() + 1); const day = r.getDay(); if (day !== 0 && day !== 6) added++; }
  return r;
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
// reconcile-orders: pulls paid Stripe sessions → creates missing SLS Jobs rows (idempotent).
