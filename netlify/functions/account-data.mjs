// 3DPX — customer portal: an account's orders + saved quotes.
// GET /.netlify/functions/account-data?a=<private token>
// Reads the SLS Web Orders Log (orders, with the hourly-synced SLS Jobs status) and the SLS Quotes
// sheet, keeping only rows whose customer email is on one of the account's domains.
import { findAccount, emailInAccount, json } from "./_accounts.mjs";

const LOG = { sheet: "5963104906071940", order: 7031647501586308, email: 839198013951876, quoteId: 2809522850926468,
  logged: 6187222571454340, status: 682718967140228, po: 5061322664611716, pieces: 1965097920794500,
  sales: 578610876682116, type: 1402147967373188, contact: 8157547408428932 };
const QT = { sheet: "8909229715836804", quote: 2297212512276356, status: 6800812139646852, email: 3423112419118980,
  total: 608362652012420, pieces: 5111962279382916, items: 2860162465697668, created: 3986062372540292,
  customer: 1171312605433732 };
// Production status is read LIVE from the source sheets on every page load, not from the Orders Log's
// synced copy — that copy depends on an hourly job, and when it stalled every order showed "Received".
//   SLS Jobs = active work; "SLS Jobs Complete 6 mo" = where finished jobs are moved.
const JOBS = { sheet: "7474902212077444", order: 2573430013880196, status: 3699329920722820 };
const DONE = { sheet: "253549607866244",  order: 8712114298113924, status: 2062069196869508 };
const WEB_RE = /WEB-(?:\d{8}-)?\d{3,6}/i;
const webOf = s => { const m = String(s || "").toUpperCase().match(WEB_RE); return m ? m[0] : ""; };

// SLS Jobs production status → wording a customer should see (no internal states like QA holds).
function customerStatus(s) {
  const v = String(s || "").trim().toLowerCase();
  if (!v || v === "pre sale" || v.startsWith("not in")) return "Received";
  if (v === "waiting for client") return "Waiting on you";
  if (v === "waiting for pickup") return "Ready for pickup";
  if (v === "complete") return "Complete";
  if (v === "cancelled") return "Cancelled";
  return "In production";   // Ready, Production, post-processing, QA hold, design…
}

async function readSheet(token, sheetId, cols) {
  const r = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "?columnIds=" + cols.join(","),
    { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("sheet " + sheetId + " " + r.status);
  const d = await r.json();
  return (d.rows || []).map(row => {
    const m = { _rowId: row.id };
    for (const c of row.cells || []) m[c.columnId] = c.value != null ? c.value : (c.displayValue != null ? c.displayValue : "");
    return m;
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const acct = findAccount(url.searchParams.get("a"));
  if (!acct) return json({ error: "This account link isn't valid. Please contact 3DPX for a new one." }, 403);
  const token = process.env.SMARTSHEET_TOKEN;
  if (!token) return json({ error: "Not configured." }, 503);

  try {
    const [logRows, qRows, jobRows, doneRows] = await Promise.all([
      readSheet(token, LOG.sheet, [LOG.order, LOG.email, LOG.quoteId, LOG.logged, LOG.status, LOG.po, LOG.pieces, LOG.sales, LOG.type, LOG.contact]),
      readSheet(token, QT.sheet, [QT.quote, QT.status, QT.email, QT.total, QT.pieces, QT.items, QT.created, QT.customer]),
      readSheet(token, JOBS.sheet, [JOBS.order, JOBS.status]).catch(() => []),
      readSheet(token, DONE.sheet, [DONE.order, DONE.status]).catch(() => []),
    ]);
    // WEB number → real production status. Active work wins over the archive; on duplicates prefer
    // a row that's still open over one that's Complete/Cancelled.
    const live = new Map(), archived = new Map();
    for (const r of jobRows) { const w = webOf(r[JOBS.order]), s = String(r[JOBS.status] || ""); if (!w || !s) continue;
      const p = live.get(w); if (!p || /^(complete|cancelled)$/i.test(p)) live.set(w, s); }
    for (const r of doneRows) { const w = webOf(r[DONE.order]); if (w && !archived.has(w)) archived.set(w, String(r[DONE.status] || "") || "Complete"); }
    const ageDays = d => { const t = Date.parse(d); return isNaN(t) ? 0 : (Date.now() - t) / 86400000; };

    const orders = logRows.filter(r => emailInAccount(r[LOG.email], acct)).map(r => {
      const raw = String(r[LOG.order] || "");
      const web = webOf(raw);
      const date = String(r[LOG.logged] || "").slice(0, 10);
      // live sheet → archive → Orders Log copy. An order that's in neither sheet and is over 60 days old
      // has been archived past the 6-month sheet (or completed off-system) — call it Complete rather than
      // telling the customer it was only just received.
      let src = live.get(web) || archived.get(web) || String(r[LOG.status] || "");
      if (!live.has(web) && !archived.has(web) && ageDays(date) > 60 && !/cancel/i.test(src)) src = "Complete";
      return {
        row: String(r._rowId),
        orderNo: web || raw,
        po: String(r[LOG.po] || ""),
        date,
        status: customerStatus(src),
        pieces: +r[LOG.pieces] || 0,
        amount: +r[LOG.sales] || 0,
        quoteId: /^Q-[A-Za-z0-9]{4,12}$/.test(String(r[LOG.quoteId] || "")) ? String(r[LOG.quoteId]) : "",
        by: String(r[LOG.contact] || ""),
        cancelled: /cancel/i.test(src),
      };
    }).filter(o => /^WEB-/.test(o.orderNo)).sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.orderNo.localeCompare(a.orderNo));

    // Saved quotes that haven't become orders yet (ordered ones already appear under Orders).
    const orderedQuotes = new Set(orders.map(o => o.quoteId).filter(Boolean));
    const quotes = qRows.filter(r => emailInAccount(r[QT.email], acct)).map(r => ({
      quoteId: String(r[QT.quote] || ""),
      status: String(r[QT.status] || ""),
      created: String(r[QT.created] || "").slice(0, 10),
      total: parseFloat(String(r[QT.total] || "").replace(/[^0-9.]/g, "")) || 0,
      pieces: +r[QT.pieces] || 0,
      items: +r[QT.items] || 0,
      by: String(r[QT.customer] || ""),
    })).filter(q => /^Q-/.test(q.quoteId) && !/ordered|expired/i.test(q.status) && !orderedQuotes.has(q.quoteId))
      .sort((a, b) => (b.created || "").localeCompare(a.created || ""));

    return json({ ok: true, company: acct.company, orders, quotes });
  } catch (e) {
    console.log("account-data failed:", e.message);
    return json({ error: "Couldn't load your account right now. Please try again shortly." }, 502);
  }
};
