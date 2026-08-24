// 3DPX — save a quote (rep-built OR customer self-saved) so it can be sent as a link and found later.
// Stores line items + options as JSON in Netlify Blobs under "Q-QUOTES/<id>.json"; STL(s)/drawings
// upload separately (upload-stl with order=Q-<id>). Also tracks the quote in the "SLS Quotes"
// Smartsheet via _quotelog so reps can search by customer/email and re-open to edit.
//
// AUTH: optional INTERNAL_CODE env. If set and body.token matches → "authed" (rep): may overwrite an
// existing quote id (edit-in-place) and may carry rep-only pricing (per-part override, extra discount).
// Otherwise the save is treated as PUBLIC (customer): always a NEW id (never clobbers a rep quote),
// and rep-only pricing fields are stripped so a customer can't inject a discount.
import { getStore } from "@netlify/blobs";
import { logQuote } from "./_quotelog.mjs";
import { sendQuoteEmail } from "./_notify.mjs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  const need = process.env.INTERNAL_CODE;
  const authed = !need || String(body.token || "") === String(need);

  const parts = Array.isArray(body.parts) ? body.parts : [];
  // Allow a parts-less quote only for a rep billing engineering services alone (never for public saves).
  if (!parts.length && !(authed && +body.engHours > 0)) return json({ error: "Nothing to save — add a part or engineering hours." }, 400);

  const store = getStore("orders");
  const rand = () => "Q-" + Math.random().toString(36).slice(2, 8).toUpperCase();
  const proposed = (body.id && /^Q-[A-Za-z0-9]{4,12}$/.test(body.id)) ? body.id : null;

  // Resolve the quote id. Reps (authed) may overwrite an existing id (edit-in-place). Customers may
  // use the id they minted (so their pre-uploaded files match) ONLY if it's unused — never clobbering
  // an existing (possibly rep-owned) quote.
  let id, reuse = false, prev = null;
  if (proposed) {
    try { prev = await store.get("Q-QUOTES/" + proposed + ".json", { type: "json" }); } catch (e) {}
    if (authed) { id = proposed; reuse = !!prev; }
    else { id = prev ? rand() : proposed; prev = null; }   // public: only reuse an unused id; never inherit a record
  } else { id = rand(); }

  const record = {
    id, created: (prev && prev.created) || new Date().toISOString(),
    parts: parts.map(p => ({
      name: String(p.name || "part").slice(0,120),
      x: +p.x || 0, y: +p.y || 0, z: +p.z || 0, vol: +p.vol || 0,
      qty: Math.max(1, parseInt(p.qty) || 1),
      color: String(p.color || "natural"), dye: !!p.dye, vs: !!p.vs, tumble: !!p.tumble,
      inserts: !!p.inserts, insertQty: Math.max(1, parseInt(p.insertQty) || 1),
      tapped: !!p.tapped, tapQty: Math.max(1, parseInt(p.tapQty) || 1),
      inspect: !!p.inspect, inspQty: Math.max(1, parseInt(p.inspQty) || 1),
      notes: String(p.notes || "").slice(0, 600),
      drawingName: p.drawingName ? String(p.drawingName).slice(0,120) : "",
      file: p.file ? String(p.file).slice(0,160) : "",
      thumb: (p.thumb && String(p.thumb).startsWith("data:image")) ? String(p.thumb).slice(0, 400000) : "",
      override: authed && (+p.override > 0) ? +p.override : null,   // rep-only; stripped from public saves
      vsPrice: authed && (+p.vsPrice > 0) ? +p.vsPrice : null,      // rep-only hard-coded vapor-smooth price
      manual: !!p.manual,
    })),
    region: String(body.region || "us"),
    zip: String(body.zip || "").slice(0,12),
    shipSpeed: String(body.shipSpeed || "ground"),
    matCert: !!body.matCert,
    addlDisc: authed ? Math.max(0, +body.addlDisc || 0) : 0,        // rep-only; stripped from public saves
    engHours: authed ? Math.max(0, +body.engHours || 0) : 0,        // rep-only engineering-services hours @ $124/hr
    taxExempt: authed ? !!body.taxExempt : false,                   // rep-only; a web customer can never mark themselves tax exempt
    certWaive: authed ? !!body.certWaive : false,                   // rep-only; waives the $100 material-cert fee
    promo: String(body.promo || "").trim().toUpperCase().slice(0,24),
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(body.dueDate || "")) ? body.dueDate : "",
    note: String(body.note || "").slice(0, 600),
    cust: {
      name: String(body.name || "").slice(0,200),
      company: String(body.company || "").slice(0,200),
      email: String(body.email || "").slice(0,200),
      phone: String(body.phone || "").slice(0,60),
    },
    quoteRowId: (prev && prev.quoteRowId) || null,
  };

  try {
    await store.setJSON("Q-QUOTES/" + id + ".json", record);
  } catch (e) {
    console.log("save-quote failed:", e.message);
    return json({ error: "Could not save quote." }, 500);
  }

  // Build the customer link + track in the SLS Quotes sheet (best-effort; never fails the save).
  const origin = /^https?:\/\/[^\s]+$/.test(String(body.origin || "")) ? String(body.origin).replace(/\/+$/, "") : "";
  const link = origin ? (origin + "/?quote=" + id) : ("/?quote=" + id);
  const editLink = origin ? (origin + "/?internal=1&quote=" + id) : ("/?internal=1&quote=" + id);  // rep one-click edit
  const pieces = parts.reduce((s, p) => s + Math.max(1, parseInt(p.qty) || 1), 0);
  let summary = parts.map(p => (Math.max(1, parseInt(p.qty) || 1) + "× " + (p.name || "part"))).join("; ").slice(0, 240);
  if (!parts.length && record.engHours > 0) summary = "Engineering services · " + record.engHours + " hr";
  const status = reuse ? "Revised" : (authed ? "Sent" : "Draft");
  try {
    const rowId = await logQuote({
      quoteId: id, status, source: body.source === "internal" ? "Internal" : "Web",
      customer: record.cust.name, company: record.cust.company, email: record.cust.email, phone: record.cust.phone,
      total: (body.total != null && body.total !== "") ? +body.total : "",
      pieces, items: parts.length, delivery: record.shipSpeed, link, editLink, notes: summary,
      rowId: record.quoteRowId,
    });
    if (rowId && rowId !== record.quoteRowId) {
      record.quoteRowId = rowId;
      try { await store.setJSON("Q-QUOTES/" + id + ".json", record); } catch (e) {}
    }
    // Attach this quote's uploaded files + quote PDF to its SLS Quotes row (best-effort; never deletes blobs).
    const sm = process.env.SMARTSHEET_TOKEN;
    if (sm && record.quoteRowId) {
      try {
        const { attachQuoteFiles } = await import("./_attach.mjs");
        await attachQuoteFiles(sm, id, process.env.QUOTES_SHEET_ID || "8909229715836804", record.quoteRowId);
      } catch (e) { console.log("save-quote attach error:", e.message); }
    }
  } catch (e) { console.log("save-quote log error:", e.message); }

  // Email the customer their quote (best-effort; only on public/customer saves with an email).
  if (body.source !== "internal" && record.cust.email) {
    try { await sendQuoteEmail({ to: record.cust.email, quoteId: id, link, total: body.total, }); } catch (e) {}
  }

  return json({ ok: true, id, link });
};

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }
