// 3DPX — customer portal: the files on one order, and downloading them.
//   GET ?a=<token>&row=<Orders Log row id>             → list of customer-visible files
//   GET ?a=<token>&row=<row id>&att=<attachment id>    → 302 redirect to a short-lived download URL
// The files are the ones actually attached to the order in the SLS Web Orders Log — i.e. exactly what
// was printed, including any file the customer substituted. Internal documents (traveler, inventory,
// accounting) and arbitrary uploads are never listed or downloadable (see customerVisibleFile).
import { findAccount, emailInAccount, customerVisibleFile, json } from "./_accounts.mjs";

const LOG_SHEET = "5963104906071940", LOG_EMAIL = 839198013951876;
const API = "https://api.smartsheet.com/2.0/sheets/" + LOG_SHEET;

export default async (req) => {
  const url = new URL(req.url);
  const acct = findAccount(url.searchParams.get("a"));
  if (!acct) return json({ error: "This account link isn't valid." }, 403);
  const row = String(url.searchParams.get("row") || "").replace(/\D/g, "");
  const att = String(url.searchParams.get("att") || "").replace(/\D/g, "");
  if (!row) return json({ error: "Missing order." }, 400);
  const token = process.env.SMARTSHEET_TOKEN;
  if (!token) return json({ error: "Not configured." }, 503);
  const hdr = { Authorization: "Bearer " + token };

  try {
    // The row must belong to this account (customer email on one of its domains).
    const r = await fetch(API + "/rows/" + row + "?include=attachments", { headers: hdr });
    if (!r.ok) return json({ error: "Order not found." }, 404);
    const d = await r.json();
    const emailCell = (d.cells || []).find(c => c.columnId === LOG_EMAIL);
    if (!emailInAccount(emailCell && (emailCell.value || emailCell.displayValue), acct)) return json({ error: "Order not found." }, 404);

    if (att) {
      const a = await fetch(API + "/attachments/" + att, { headers: hdr });
      if (!a.ok) return json({ error: "File not found." }, 404);
      const ad = await a.json();
      if (String(ad.parentId) !== row || !customerVisibleFile(ad.name) || !ad.url) return json({ error: "File not found." }, 404);
      return new Response(null, { status: 302, headers: { Location: ad.url, "Cache-Control": "no-store" } });
    }

    const order = { part: 0, drawing: 1, doc: 2 };
    const files = (d.attachments || [])
      .filter(x => x.attachmentType === "FILE" && customerVisibleFile(x.name))
      .map(x => ({ id: String(x.id), name: x.name, kind: customerVisibleFile(x.name), kb: x.sizeInKb || 0 }))
      .sort((a, b) => (order[a.kind] - order[b.kind]) || a.name.localeCompare(b.name));
    return json({ ok: true, files });
  } catch (e) {
    console.log("account-files failed:", e.message);
    return json({ error: "Couldn't load the files right now." }, 502);
  }
};
