// 3DPX — shared helper: email the team when an order is created.
// No-op unless RESEND_API_KEY is set, so it never breaks an order if email isn't configured yet.
// Env:
//   RESEND_API_KEY   (required to send) — from https://resend.com
//   ORDER_ALERT_TO   (optional) — comma-separated recipients; default sales@3dpx.com
//   ORDER_ALERT_FROM (optional) — must be on a Resend-verified domain; default "3DPX Orders <orders@3dpx.com>"

export async function sendOrderEmail(o) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const to = (process.env.ORDER_ALERT_TO || "sales@3dpx.com").split(",").map(s => s.trim()).filter(Boolean);
  const from = process.env.ORDER_ALERT_FROM || "3DPX Orders <orders@3dpx.com>";
  const kind = o.kind || "Order";
  const esc = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const subject = "New " + kind + " — " + (o.orderNo || "") + (o.company ? (" · " + o.company) : "");
  const rows = [
    ["Order #", o.orderNo],
    ["Type", kind],
    ["Company", o.company],
    ["Contact", o.contact],
    ["Amount", o.price != null ? ("$" + Number(o.price).toFixed(2) + (o.tax ? (" + $" + Number(o.tax).toFixed(2) + " tax") : "")) : ""],
    ["Pieces", o.pieces],
    ["Delivery", o.delivery],
    ["Due date", o.due],
    ["Payment", o.payment],
    ["Notes", o.notes],
  ].filter(r => r[1] != null && r[1] !== "");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1b2330;max-width:560px">
    <h2 style="color:#1b2a4a;border-bottom:3px solid #f26a21;padding-bottom:8px;margin:0 0 14px">New ${esc(kind)} received</h2>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      ${rows.map(r => `<tr><td style="padding:6px 10px;background:#f4f6fa;font-weight:bold;width:130px;border:1px solid #e2e8f2">${esc(r[0])}</td><td style="padding:6px 10px;border:1px solid #e2e8f2">${esc(r[1])}</td></tr>`).join("")}
    </table>
    <p style="font-size:12px;color:#6b7891;margin-top:14px">Full order details + files are in the SLS Jobs sheet.</p>
  </div>`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!r.ok) { console.log("order email failed:", r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.log("order email error:", e.message); return false; }
}

// ---- Customer order confirmation ---------------------------------------------------------------
const _esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const _CLR = { natural: "Natural", black: "Black", blue: "Blue", green: "Green", red: "Red", yellow: "Yellow" };
const _fmtDate = s => { const d = new Date(String(s) + "T12:00:00Z");
  return isNaN(d) ? String(s) : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }); };

// Turn the widget's part objects into short, customer-readable line items.
export function orderItems(parts) {
  return (parts || []).map(p => {
    const f = [];
    if (p.dye && p.color && p.color !== "natural") f.push("Dyed " + (_CLR[p.color] || p.color));
    if (p.vs) f.push("Vapor smoothed");
    if (p.tumble) f.push("Tumbled");
    const ins = (p.inserts && +p.insertQty > 0) ? Math.floor(+p.insertQty) : 0;
    if (ins) f.push(ins + " insert" + (ins === 1 ? "" : "s"));
    const tap = (p.tapped && +p.tapQty > 0) ? Math.floor(+p.tapQty) : 0;
    if (tap) f.push(tap + " tapped hole" + (tap === 1 ? "" : "s"));
    const insp = (p.inspect && +p.inspQty > 0) ? Math.floor(+p.inspQty) : 0;
    if (insp) f.push("Formal inspection (" + insp + " pt" + (insp === 1 ? "" : "s") + ")");
    return { name: String(p.name || "Part").slice(0, 120), qty: Math.max(1, parseInt(p.qty) || 1), finish: f.join(" · ") || "Standard finish" };
  });
}

// Email the CUSTOMER a confirmation when their order is placed. kind: "card" | "po" | "approved".
// Best-effort and never blocks the order. No-op without RESEND_API_KEY, without a valid recipient,
// or when the recipient is a 3dpx.com address (reps sometimes enter sales@ on internal orders, and
// there's no point confirming an order to ourselves). Replies go to sales, not to the no-reply sender.
// NOTE: only delivers once 3dpx.com is a verified sending domain in Resend and ORDER_ALERT_FROM
// uses it — Resend's test sender (onboarding@resend.dev) refuses to email anyone but the account owner.
export async function sendCustomerOrderEmail(o) {
  const key = process.env.RESEND_API_KEY;
  const to = String((o && o.to) || "").trim();
  if (!key || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) || /@3dpx\.com$/i.test(to)) return false;
  const from = process.env.ORDER_ALERT_FROM || "3DPX Orders <orders@3dpx.com>";
  const replyTo = (process.env.ORDER_ALERT_TO || "sales@3dpx.com").split(",")[0].trim();
  const money = n => "$" + Number(n || 0).toFixed(2);
  const kind = o.kind || "card";
  const ref = (o.orderNo || "") + (o.po ? (" (PO " + o.po + ")") : "");
  const subject = (kind === "po" ? "PO received — " : "Order confirmed — ") + ref;
  const headline = kind === "po" ? "Thanks — we've received your PO" : "Thanks — your order is confirmed";
  const lead = kind === "card" ? "Payment received. Your parts are now in our production queue."
             : kind === "po"   ? "Our team will review your order and confirm shortly. We'll invoice you on terms — no card was charged."
             :                   "Your order is in our production queue. We'll invoice you on terms — no card was charged.";
  const total = kind === "card"
    ? (money(o.amount) + " paid" + (o.tax ? (" (incl. " + money(o.tax) + " tax)") : ""))
    : (money(o.amount) + " excl. tax — invoice to follow");
  const items = (o.items || []).slice(0, 60), more = (o.items || []).length - items.length;
  const pieces = (o.pieces != null && o.pieces !== "") ? (o.pieces + " piece" + (+o.pieces === 1 ? "" : "s")) : "";
  const rows = [
    ["Order #", ref], ["Total", total], ["Quantity", pieces], ["Delivery", o.delivery],
    ["Ship to", o.shipTo], ["Est. ship date", o.due ? _fmtDate(o.due) : ""],
  ].filter(r => r[1] != null && r[1] !== "");
  const td = "padding:7px 10px;border:1px solid #e2e8f2;font-size:14px";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1b2330;max-width:600px">
    <div style="font-size:13px;font-weight:bold;letter-spacing:.5px;color:#1b2a4a;margin-bottom:6px">3DPX ADDITIVE MANUFACTURING</div>
    <h2 style="color:#1b2a4a;border-bottom:3px solid #f26a21;padding-bottom:8px;margin:0 0 14px">${_esc(headline)}</h2>
    <p style="font-size:14px;line-height:1.5;margin:0 0 16px">${o.name ? ("Hi " + _esc(String(o.name).split(" ")[0]) + ", ") : ""}${_esc(lead)}</p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:18px">
      ${rows.map(r => `<tr><td style="${td};background:#f4f6fa;font-weight:bold;width:140px">${_esc(r[0])}</td><td style="${td}">${_esc(r[1])}</td></tr>`).join("")}
    </table>
    ${items.length ? `<table style="border-collapse:collapse;width:100%">
      <tr><th style="${td};background:#1b2a4a;color:#fff;text-align:left">Part</th><th style="${td};background:#1b2a4a;color:#fff;width:60px">Qty</th><th style="${td};background:#1b2a4a;color:#fff;text-align:left">Finish</th></tr>
      ${items.map(it => `<tr><td style="${td}">${_esc(it.name)}</td><td style="${td};text-align:center">${_esc(it.qty)}</td><td style="${td}">${_esc(it.finish)}</td></tr>`).join("")}
      ${more > 0 ? `<tr><td colspan="3" style="${td};color:#6b7891">…and ${more} more part${more === 1 ? "" : "s"}</td></tr>` : ""}
    </table>
    <p style="font-size:12px;color:#6b7891;margin:6px 0 0">Material: SLS · Nylon 12 (PA12)</p>` : ""}
    <p style="font-size:13px;line-height:1.5;margin:20px 0 0">Questions or changes? Just reply to this email, or call <b>(312) 896-3399</b> and mention <b>${_esc(o.orderNo || "")}</b>.</p>
    <p style="font-size:12px;color:#6b7891;margin:14px 0 0">The ship date is an estimate and is confirmed when your parts enter production.</p>
  </div>`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, html }),
    });
    if (!r.ok) { console.log("customer order email failed:", r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.log("customer order email error:", e.message); return false; }
}

// Email a saved quote to the customer (and copy sales). No-op unless RESEND_API_KEY is set and a
// customer email is provided. Best-effort — never blocks the save.
export async function sendQuoteEmail(q) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !q || !q.to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(q.to))) return false;
  const from = process.env.ORDER_ALERT_FROM || "3DPX Orders <orders@3dpx.com>";
  const salesTo = (process.env.ORDER_ALERT_TO || "sales@3dpx.com").split(",").map(s => s.trim()).filter(Boolean);
  const esc = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const subject = "Your 3DPX quote " + (q.quoteId || "");
  const total = (q.total != null && q.total !== "") ? ("$" + Number(q.total).toFixed(2)) : "";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#1b2330;max-width:560px">
    <h2 style="color:#1b2a4a;border-bottom:3px solid #f26a21;padding-bottom:8px;margin:0 0 14px">Your 3DPX quote is saved</h2>
    <p style="font-size:14px">Reference <b>${esc(q.quoteId)}</b>${total ? (" · estimated total <b>" + esc(total) + "</b>") : ""}.</p>
    <p style="font-size:14px">Reopen or place your order any time:</p>
    <p><a href="${esc(q.link)}" style="background:#f26a21;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">View my quote</a></p>
    <p style="font-size:12px;color:#6b7891;margin-top:14px">Need a change? Reply to this email or call (312) 896-3399 and reference ${esc(q.quoteId)} — we can update it for you.</p>
  </div>`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [q.to], cc: salesTo, subject, html }),
    });
    if (!r.ok) { console.log("quote email failed:", r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.log("quote email error:", e.message); return false; }
}
