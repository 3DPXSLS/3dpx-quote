// 3DPX — fill the "Stripe Receipt #" column on the SLS Web Orders Log for past card orders (and any
// the webhook missed because Stripe hadn't sent the receipt yet). Safe to re-run: only fills blanks.
//
//   GET /.netlify/functions/backfill-receipts?k=<staff code>&days=90     (days: 1–365, default 90)
//
// Matches each paid Stripe Checkout session's order_no to the log row's WEB-#### and writes the
// receipt number shown on the customer's Stripe email receipt (e.g. "1290-8729").
import { isStaff } from "./_staff.mjs";
import { LOG_COLS } from "./_orderlog.mjs";

const LOG_SHEET = "5963104906071940";
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const ORDER_RE = /WEB-(?:\d{8}-)?\d{3,6}/;

export default async (req) => {
  const url = new URL(req.url);
  if (!isStaff(url.searchParams.get("k"))) return json({ error: "staff" }, 403);
  const stripeKey = process.env.STRIPE_SECRET_KEY, token = process.env.SMARTSHEET_TOKEN;
  if (!stripeKey || !token) return json({ error: "Not configured." }, 503);
  const sheetId = process.env.ORDERS_LOG_SHEET_ID || LOG_SHEET;
  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get("days")) || 90));
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  // 1) order_no → receipt number, from paid Checkout sessions in the window.
  const receipts = {};
  let after = null, sessions = 0;
  try {
    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ limit: "100", "created[gte]": String(since), status: "complete" });
      qs.append("expand[]", "data.payment_intent.latest_charge");
      if (after) qs.append("starting_after", after);
      const r = await fetch("https://api.stripe.com/v1/checkout/sessions?" + qs, { headers: { Authorization: "Bearer " + stripeKey } });
      const d = await r.json();
      if (!r.ok) return json({ error: "Stripe: " + ((d.error && d.error.message) || r.status) }, 502);
      for (const s of d.data || []) {
        const no = s.metadata && s.metadata.order_no;
        const ch = s.payment_intent && s.payment_intent.latest_charge;
        if (s.payment_status === "paid" && no && ch && ch.receipt_number) { receipts[no] = String(ch.receipt_number); sessions++; }
      }
      if (!d.has_more || !(d.data || []).length) break;
      after = d.data[d.data.length - 1].id;
    }
  } catch (e) { return json({ error: "Stripe error: " + e.message }, 502); }

  // 2) Log rows with a WEB-#### and no receipt yet.
  const r = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "?columnIds=" + LOG_COLS.order + "," + LOG_COLS.receipt,
    { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) return json({ error: "Sheet read failed " + r.status }, 502);
  const sheet = await r.json();
  const updates = [], filled = [];
  for (const row of sheet.rows || []) {
    const val = id => { const c = (row.cells || []).find(c => c.columnId === id); return c && c.value != null ? String(c.value) : ""; };
    if (val(LOG_COLS.receipt)) continue;
    const m = val(LOG_COLS.order).match(ORDER_RE);
    if (m && receipts[m[0]]) {
      updates.push({ id: row.id, cells: [{ columnId: LOG_COLS.receipt, value: receipts[m[0]], strict: false }] });
      filled.push(m[0] + " → " + receipts[m[0]]);
    }
  }
  for (let i = 0; i < updates.length; i += 200) {
    const u = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "/rows", {
      method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(updates.slice(i, i + 200)),
    });
    if (!u.ok) return json({ error: "Sheet update failed " + u.status, filledSoFar: filled.slice(0, i) }, 502);
  }
  return json({ ok: true, days, paidSessionsWithReceipt: sessions, filled: filled.length, rows: filled });
};
