// 3DPX — rep "Find customer": search past customers and return each contact's latest details so the
// internal tool can autofill them.   GET ?k=<staff code>&q=<at least 2 characters>
//
// Learns from what's already recorded — no customer list to maintain:
//   • SLS Web Orders Log: name, company, email, phone, ship-to, delivery method/carrier account, last order
//   • SLS Quotes: contacts who've been quoted but haven't ordered yet
//   • the last order's saved quote: tax-exempt status
// One result per contact (email), most recent first.
import { getStore } from "@netlify/blobs";
import { isStaff } from "./_staff.mjs";

const LOG = { sheet: "5963104906071940", order: 7031647501586308, company: 3653947781058436, contact: 8157547408428932,
  email: 839198013951876, phone: 5342797641322372, delivery: 8720497361850244, po: 5061322664611716,
  shipTo: 7313122478296964, logged: 6187222571454340, quoteId: 2809522850926468 };
const QT = { sheet: "8909229715836804", customer: 1171312605433732, company: 5674912232804228, email: 3423112419118980,
  phone: 7926712046489476, created: 3986062372540292, updated: 8489661999910788 };
const MAX = 8;

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function readSheet(token, sheetId, cols) {
  const r = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "?columnIds=" + cols.join(","), { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("sheet " + sheetId + " " + r.status);
  const d = await r.json();
  return (d.rows || []).map(row => { const m = {}; for (const c of row.cells || []) m[c.columnId] = c.value != null ? String(c.value) : ""; return m; });
}

// "Your carrier account — FedEx acct 123456" → { speed:"account", carrier:"FedEx", account:"123456" }
function parseDelivery(s) {
  const v = String(s || "");
  if (/^pickup/i.test(v)) return { speed: "pickup" };
  if (/^your carrier account/i.test(v)) {
    const m = v.match(/—\s*(.+?)\s+acct\s+(.+)$/i);
    const acct = m && !/not provided/i.test(m[2]) ? m[2].trim() : "";
    return { speed: "account", carrier: m ? m[1].trim() : "", account: acct };
  }
  if (/^expedited/i.test(v)) return { speed: "expedited" };
  if (/^overnight/i.test(v)) return { speed: "overnight" };
  if (/^ground/i.test(v)) return { speed: "ground" };
  return {};
}

// "123 Main St, Suite 4, Chicago, IL, 60607, United States" → parts. Rep double-checks before ordering.
function parseShipTo(s) {
  const v = String(s || "").trim();
  if (!v || /^pickup at 3dpx/i.test(v)) return null;
  const bits = v.split(",").map(x => x.trim()).filter(Boolean);
  let region = "us";
  const last = (bits[bits.length - 1] || "").toLowerCase();
  if (last === "united states" || last === "usa" || last === "us") bits.pop();
  else if (last === "canada / mexico" || last === "canada" || last === "mexico") { region = "camx"; bits.pop(); }
  else if (last === "international") { region = "intl"; bits.pop(); }
  const zip = bits.length && /\d/.test(bits[bits.length - 1]) ? bits.pop() : "";
  const state = bits.length > 2 ? bits.pop() : "";
  const city = bits.length > 1 ? bits.pop() : "";
  return { addr: bits.join(", "), city, state, zip, region };
}

export default async (req) => {
  const url = new URL(req.url);
  if (!isStaff(url.searchParams.get("k"))) return json({ error: "staff" }, 403);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  if (q.length < 2) return json({ ok: true, results: [] });
  const token = process.env.SMARTSHEET_TOKEN;
  if (!token) return json({ error: "Not configured." }, 503);

  try {
    const [logRows, qRows] = await Promise.all([
      readSheet(token, LOG.sheet, Object.values(LOG).filter(v => typeof v === "number")),
      readSheet(token, QT.sheet, Object.values(QT).filter(v => typeof v === "number")).catch(() => []),
    ]);
    const hit = (...xs) => xs.some(x => String(x || "").toLowerCase().includes(q));
    const people = new Map();   // email → contact (most recent wins field by field)
    const take = (cur, val) => (val && String(val).trim()) ? String(val).trim() : cur;

    // Orders first, newest last so later rows overwrite with the most recent details.
    logRows.filter(r => r[LOG.email] && hit(r[LOG.contact], r[LOG.company], r[LOG.email]))
      .sort((a, b) => String(a[LOG.logged]).localeCompare(String(b[LOG.logged])))
      .forEach(r => {
        const key = r[LOG.email].trim().toLowerCase();
        const p = people.get(key) || { email: r[LOG.email].trim(), orders: 0 };
        p.name = take(p.name, r[LOG.contact]); p.company = take(p.company, r[LOG.company]); p.phone = take(p.phone, r[LOG.phone]);
        const ship = parseShipTo(r[LOG.shipTo]); if (ship) p.ship = ship;
        const del = parseDelivery(r[LOG.delivery]); if (del.speed) p.delivery = del;
        const m = String(r[LOG.order] || "").match(/WEB-(?:\d{8}-)?\d{3,6}/);
        p.lastOrder = { orderNo: m ? m[0] : "", date: String(r[LOG.logged] || "").slice(0, 10), po: r[LOG.po] || "" };
        p.lastQuoteId = /^Q-[A-Za-z0-9]{4,12}$/.test(r[LOG.quoteId] || "") ? r[LOG.quoteId] : p.lastQuoteId;
        p.last = p.lastOrder.date; p.orders++;
        people.set(key, p);
      });
    // Quoted-but-never-ordered contacts (and phone numbers orders didn't capture).
    qRows.filter(r => r[QT.email] && hit(r[QT.customer], r[QT.company], r[QT.email])).forEach(r => {
      const key = r[QT.email].trim().toLowerCase();
      const p = people.get(key) || { email: r[QT.email].trim(), orders: 0 };
      p.name = p.name || r[QT.customer] || ""; p.company = p.company || r[QT.company] || ""; p.phone = p.phone || r[QT.phone] || "";
      const d = String(r[QT.updated] || r[QT.created] || "").slice(0, 10);
      if (!p.last || (!p.orders && d > p.last)) p.last = d;
      people.set(key, p);
    });

    const results = [...people.values()]
      .filter(p => !/@3dpx\.com$/i.test(p.email))   // our own placeholder emails aren't customers
      .sort((a, b) => (b.orders > 0) - (a.orders > 0) || String(b.last || "").localeCompare(String(a.last || "")))
      .slice(0, MAX);

    // Tax-exempt status from each result's most recent saved quote (rep-set, so trustworthy).
    const store = getStore("orders");
    await Promise.all(results.map(async p => {
      if (!p.lastQuoteId) return;
      try { const rec = await store.get("Q-QUOTES/" + p.lastQuoteId + ".json", { type: "json" }); if (rec) p.taxExempt = !!rec.taxExempt; } catch (e) {}
    }));
    return json({ ok: true, results });
  } catch (e) {
    console.log("customer-lookup failed:", e.message);
    return json({ error: "Search unavailable right now." }, 502);
  }
};
