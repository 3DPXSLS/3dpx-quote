// 3DPX — staff controls for the automatic customer status emails (see _custupdates.mjs).
//   ?k=<staff code>                         status: email setup, baseline, last run, orders tracked
//   ?k=<staff code>&dry=1                   what WOULD be sent right now (sends nothing)
//   ?k=<staff code>&run=1[&force=1]         run now (force = ignore the 25-email safety limit)
//   ?k=<staff code>&preview=production|pickup|shipped&to=you@example.com[&order=WEB-1234]
//                                           send ONE sample email to yourself (uses the order's real
//                                           details if given). Doesn't count as the customer's email.
import { isStaff } from "./_staff.mjs";
import { runCustomerUpdates, customerUpdatesState } from "./_custupdates.mjs";
import { mailVia, sendMail, mailAccount } from "./_mail.mjs";
import { statusEmail, sendCustomerOrderEmail } from "./_notify.mjs";

const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export default async (req) => {
  const u = new URL(req.url), q = k => u.searchParams.get(k);
  if (!isStaff(q("k"))) return json({ error: "staff" }, 403);
  try {
    const preview = q("preview");
    if (preview) {
      const to = String(q("to") || "").trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json({ error: "add &to=your email" }, 400);
      const order = q("order") || "WEB-1234";
      const sample = { to, name: "Sample Customer", orderNo: order, due: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10),
        shipDate: new Date().toISOString().slice(0, 10), shipVia: "FedEx", shipSpeed: "Ground", tracking: q("tracking") || "", pieces: 12 };
      if (preview === "confirmation") {
        // Order confirmation sample: _notify skips @3dpx.com recipients, so use a personal address.
        const ok = await sendCustomerOrderEmail({ kind: "card", to, name: sample.name, orderNo: order, amount: 482.5, tax: 0, pieces: 12,
          delivery: "Ground (3–5 business days)", shipTo: "123 Example St, Chicago, IL, 60607", due: sample.due,
          items: [{ name: "Bracket_v3.stl", qty: 10, finish: "Dyed Black · Tumbled" }, { name: "Cover.stl", qty: 2, finish: "Standard finish" }] });
        return json({ ok, via: mailVia() || "none", note: ok ? "sent" : "not sent (email not set up, or a 3dpx.com address)" });
      }
      if (!["production", "pickup", "shipped"].includes(preview)) return json({ error: "preview must be production, pickup, shipped or confirmation" }, 400);
      const { subject, html } = statusEmail(preview, sample);
      const r = await sendMail({ to, subject: "[SAMPLE] " + subject, html, tag: "sample " + preview });
      return json({ ...r, via: mailVia() || "none", subject });
    }
    if (q("dry")) return json(await runCustomerUpdates({ dry: true }));
    if (q("run")) return json(await runCustomerUpdates({ force: !!q("force") }));
    const st = await customerUpdatesState();
    const orders = st ? Object.entries(st.orders || {}) : [];
    return json({
      emailVia: mailVia() || "NOT SET UP",
      sender: mailVia() === "microsoft" ? ((await mailAccount()) || { account: process.env.MAIL_SENDER ? process.env.MAIL_SENDER + " (app-only)" : "NOT CONNECTED — open ms-connect?k=..." }) : (mailVia() === "resend" ? process.env.ORDER_ALERT_FROM : ""),
      switchedOff: String(process.env.CUSTOMER_UPDATES || "").toLowerCase() === "off",
      baseline: st ? st.baseline : "not yet (first run records current orders and sends nothing)",
      lastRun: st ? (st.lastRun || "") : "",
      tracking: orders.length,
      recentlySent: orders.filter(([, s]) => [s.production, s.pickup, s.shipped].includes("sent"))
        .sort((a, b) => String(b[1].t).localeCompare(String(a[1].t))).slice(0, 15)
        .map(([no, s]) => no + ": " + ["production", "pickup", "shipped"].filter(k => s[k] === "sent").join(", ")),
    });
  } catch (e) { return json({ error: e.message }, 500); }
};
