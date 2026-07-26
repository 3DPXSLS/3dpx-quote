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
