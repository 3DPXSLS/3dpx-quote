// 3DPX — shared helper: track every saved quote in the "SLS Quotes" Smartsheet so reps can find
// and re-open a customer's quote by name/email/quote number. Upserts a row keyed by rowId (which
// we store back in the quote's Blob record), so editing a quote updates the SAME row. No-op without
// SMARTSHEET_TOKEN. Sheet id overridable via QUOTES_SHEET_ID env. Never throws.
import { getStore } from "@netlify/blobs";

const QUOTES_SHEET = "8909229715836804";
const C = {
  quote:    2297212512276356,  // primary
  status:   6800812139646852,
  customer: 1171312605433732,
  company:  5674912232804228,
  email:    3423112419118980,
  phone:    7926712046489476,
  total:    608362652012420,
  pieces:   5111962279382916,
  items:    2860162465697668,
  delivery: 7363762093068164,
  source:   1734262558855044,
  link:     6237862186225540,
  editLink: 1889725879455620,
  created:  3986062372540292,
  updated:  8489661999910788,
  notes:    326887675301764,
};

// q: { quoteId, status, customer, company, email, phone, total, pieces, items, delivery, source, link, notes, rowId }
// Returns the row id (existing or newly created) so the caller can persist it, or null.
export async function logQuote(q) {
  const token = process.env.SMARTSHEET_TOKEN;
  if (!token) return q.rowId || null;
  const sheetId = process.env.QUOTES_SHEET_ID || QUOTES_SHEET;
  const today = new Date().toISOString().slice(0, 10);
  const cell = (id, v) => ({ columnId: id, value: v == null ? "" : v, strict: false });
  const base = [
    cell(C.quote, q.quoteId),
    cell(C.status, q.status),
    cell(C.customer, q.customer),
    cell(C.company, q.company),
    cell(C.email, q.email),
    cell(C.phone, q.phone),
    cell(C.total, q.total != null && q.total !== "" ? ("$" + Number(q.total).toFixed(2)) : ""),
    cell(C.pieces, q.pieces),
    cell(C.items, q.items),
    cell(C.delivery, q.delivery),
    cell(C.source, q.source),
    cell(C.link, q.link),
    cell(C.editLink, q.editLink),
    cell(C.notes, q.notes),
    cell(C.updated, today),
  ].filter(c => c.value !== "" && c.value != null);
  const url = "https://api.smartsheet.com/2.0/sheets/" + sheetId + "/rows";
  const hdr = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  try {
    if (q.rowId) {
      const r = await fetch(url, { method: "PUT", headers: hdr, body: JSON.stringify([{ id: q.rowId, cells: base }]) });
      if (r.ok) return q.rowId;
      console.log("quotelog update failed, will add:", r.status, await r.text());
    }
    const r = await fetch(url, { method: "POST", headers: hdr, body: JSON.stringify([{ toTop: true, cells: base.concat([cell(C.created, today)]) }]) });
    if (!r.ok) { console.log("quotelog add failed:", r.status, await r.text()); return q.rowId || null; }
    const j = await r.json().catch(() => null);
    const rowId = j && j.result && j.result[0] && j.result[0].id;
    return rowId || (q.rowId || null);
  } catch (e) { console.log("quotelog error:", e.message); return q.rowId || null; }
}

// When an order is placed off a saved quote, flip that quote's row to "Ordered". Looks up the
// quote's Smartsheet row id from its Blob record (stored by save-quote). Best-effort, never throws.
export async function markQuoteOrdered(quoteId) {
  const token = process.env.SMARTSHEET_TOKEN;
  if (!token || !quoteId || !/^Q-[A-Za-z0-9]{4,12}$/.test(quoteId)) return false;
  let rowId = null;
  try { const q = await getStore("orders").get("Q-QUOTES/" + quoteId + ".json", { type: "json" }); rowId = q && q.quoteRowId; } catch (e) {}
  if (!rowId) return false;
  const sheetId = process.env.QUOTES_SHEET_ID || QUOTES_SHEET;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const r = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "/rows", {
      method: "PUT",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify([{ id: rowId, cells: [{ columnId: C.status, value: "Ordered" }, { columnId: C.updated, value: today }] }]),
    });
    if (!r.ok) { console.log("markQuoteOrdered failed:", r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.log("markQuoteOrdered error:", e.message); return false; }
}
