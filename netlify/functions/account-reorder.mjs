// 3DPX — customer portal: start a reorder.
// POST { a: <account token>, from: <original quote id>, parts: [...current line items], total }
//
// Clones the original saved quote into a NEW quote that reflects the reorder exactly, and returns its id.
// The widget then places the order against the new quote with the normal flow (promote-quote copies its
// files onto the order). Doing it this way means:
//   • pricing is the same as last time — rep overrides, additional discount, tax status and cert waiver
//     are carried from the original quote, never taken from the browser;
//   • a part whose file the customer REPLACED is re-measured and priced automatically (its old fixed
//     price no longer applies to the new geometry);
//   • the next reorder shows the file actually used this time, because the order points at this quote.
// Two things deliberately do NOT carry over: an old fixed due date (it would be in the past — the lead
// time still applies), and engineering-services hours (design work isn't repeated on a reorder).
import { getStore } from "@netlify/blobs";
import { findAccount, emailInAccount, json } from "./_accounts.mjs";
import { logQuote } from "./_quotelog.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body; try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  const acct = findAccount(body.a);
  if (!acct) return json({ error: "This account link isn't valid." }, 403);
  const from = String(body.from || "");
  if (!/^Q-[A-Za-z0-9]{4,12}$/.test(from)) return json({ error: "Bad quote." }, 400);
  const cur = Array.isArray(body.parts) ? body.parts.slice(0, 300) : [];
  if (!cur.length) return json({ error: "Add at least one part." }, 400);

  const store = getStore("orders");
  const prev = await store.get("Q-QUOTES/" + from + ".json", { type: "json" }).catch(() => null);
  if (!prev) return json({ error: "Original quote not found." }, 404);
  if (!emailInAccount(prev.cust && prev.cust.email, acct)) return json({ error: "Original quote not found." }, 404);

  // New quote id (never collide with an existing one).
  let id = null;
  for (let k = 0; k < 6 && !id; k++) {
    const cand = "Q-" + Math.random().toString(36).slice(2, 8).toUpperCase();
    const ex = await store.get("Q-QUOTES/" + cand + ".json", { type: "json" }).catch(() => null);
    if (!ex) id = cand;
  }
  if (!id) return json({ error: "Please try again." }, 503);

  const int1 = v => Math.max(1, parseInt(v) || 1);
  const num = v => (Number.isFinite(+v) && +v >= 0) ? +v : 0;
  const prevParts = Array.isArray(prev.parts) ? prev.parts : [];

  const parts = cur.map(c => {
    const src = Number.isInteger(c.src) && prevParts[c.src] ? prevParts[c.src] : null;
    const fresh = !src || !!c.replaced;          // geometry + file come from the browser
    return {
      name: String((fresh ? c.name : src.name) || "part").slice(0, 120),
      x: fresh ? num(c.x) : num(src.x), y: fresh ? num(c.y) : num(src.y), z: fresh ? num(c.z) : num(src.z),
      vol: fresh ? num(c.vol) : num(src.vol),
      qty: int1(c.qty),
      // finishes are the customer's choice on the reorder
      color: String(c.color || "natural"), dye: !!c.dye, vs: !!c.vs, tumble: !!c.tumble,
      inserts: !!c.inserts, insertQty: int1(c.insertQty), tapped: !!c.tapped, tapQty: int1(c.tapQty),
      inspect: !!c.inspect, inspQty: int1(c.inspQty),
      notes: String(c.notes || "").slice(0, 600),
      drawingName: src ? (src.drawingName || "") : "",
      file: String((fresh ? c.file : src.file) || "").slice(0, 160),
      thumb: fresh ? ((c.thumb && String(c.thumb).startsWith("data:image")) ? String(c.thumb).slice(0, 400000) : "") : (src.thumb || ""),
      // rep pricing stays with the line ONLY while it's the same geometry
      override: (!fresh && +src.override > 0) ? +src.override : null,
      vsPrice: (!fresh && +src.vsPrice > 0) ? +src.vsPrice : null,
      manual: fresh ? !!c.manual : !!src.manual,
    };
  });

  const record = {
    ...prev,
    id, created: new Date().toISOString(), parts,
    dueDate: "",          // an old fixed date would be in the past; leadDays (if any) still applies
    engHours: 0,          // design work isn't charged again on a reorder
    status: "Sent", reorderOf: from, quoteRowId: null,
  };

  // Files: don't copy them here. A 43-file reorder copied twice (here, then again when the order is
  // placed) risks the function time limit. Instead the clone records a FILE MAP — for each line that
  // came from the original quote, where its stored files physically live — and promote-quote copies
  // from those locations straight onto the order, once. Original keys look like "Q-ORIG/<i>__<name>"
  // (a line's part file AND its drawing share the index). A replaced line keeps only its drawing; the
  // browser uploads the new part file into this clone's own folder. Maps never chain: if the original
  // was itself a reorder, its map entries are followed back to the physical key.
  const prevMap = Array.isArray(prev.fileMap) ? prev.fileMap : [];
  const listing = await store.list({ prefix: from + "/" }).catch(() => ({ blobs: [] }));
  const byIndex = {};
  const add = (i, name, key) => (byIndex[i] = byIndex[i] || []).push({ name, key });
  for (const b of listing.blobs || []) {
    const rest = b.key.slice((from + "/").length);
    const m = rest.match(/^(\d+)__(.+)$/);
    if (m && !rest.startsWith(".part-")) add(m[1], m[2], b.key);
  }
  for (const e of prevMap) {
    const m = String(e.to || "").match(/^(\d+)__(.+)$/);
    if (m && e.from) add(m[1], m[2], String(e.from));
  }
  const fileMap = [];
  cur.forEach((c, j) => {
    if (!Number.isInteger(c.src) || !prevParts[c.src]) return;
    const seen = new Set();
    for (const f of byIndex[String(c.src)] || []) {
      if (seen.has(f.name)) continue; seen.add(f.name);     // a physical file beats a mapped one of the same name
      if (c.replaced && !f.name.startsWith("drawing-")) continue;
      fileMap.push({ to: j + "__" + f.name, from: f.key });
    }
  });
  record.fileMap = fileMap;

  await store.setJSON("Q-QUOTES/" + id + ".json", record);

  // Track it in SLS Quotes like any other quote (best-effort), then remember the row for "Ordered".
  try {
    const pieces = parts.reduce((s, p) => s + p.qty, 0);
    const origin = req.headers.get("origin") || "https://3dpx-quote.netlify.app";
    const rowId = await logQuote({
      quoteId: id, status: "Sent", source: "Web",
      customer: (prev.cust && prev.cust.name) || "", company: (prev.cust && prev.cust.company) || acct.company,
      email: (prev.cust && prev.cust.email) || "", phone: (prev.cust && prev.cust.phone) || "",
      total: Number.isFinite(+body.total) && +body.total > 0 ? +body.total : "", pieces, items: parts.length,
      delivery: prev.shipSpeed || "", link: origin + "/?quote=" + id, editLink: origin + "/?internal=1&quote=" + id,
      notes: "Reorder of " + from + " via " + acct.company + " customer portal",
    });
    if (rowId) { record.quoteRowId = rowId; await store.setJSON("Q-QUOTES/" + id + ".json", record); }
  } catch (e) { /* tracking only */ }

  return json({ ok: true, id, mapped: fileMap.length });
};
