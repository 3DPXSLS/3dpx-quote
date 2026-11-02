// 3DPX — automatic customer status emails for WEB orders, driven by the SLS Jobs sheet.
//
//   In production        Order Status → Production / Outsourced Post Production / In House Secondary Process
//   Ready for pickup     Order Status → Waiting For Pickup
//   Shipped              "Shipped/ Pick Up" checked (or Order Status Complete) and Ship Via isn't Pick-up.
//                        Includes Ship Date, Ship Via, Shipping Speed and the "Tracking #" column.
//
// Each email goes out ONCE per order (remembered in Netlify Blobs at NOTIFY/state.json). Only the
// furthest stage is sent — an order that jumps straight to shipped doesn't also get "in production".
// A job that's moved to "SLS Jobs Complete 6 mo" before we saw it ship is looked up there.
//
// Safety:
//   • FIRST RUN = baseline: records every current order's stage and sends nothing, so switching this on
//     never emails customers about orders that are already under way or done.
//   • Circuit breaker: if a run would send more than MAX_PER_RUN emails, it sends none and logs why
//     (run it from customer-updates?force=1 after checking).
//   • Kill switch: Netlify env CUSTOMER_UPDATES=off.
//   • Never emails 3dpx.com addresses; only WEB orders (WEB-#### in the order number).
import { getStore } from "@netlify/blobs";
import { sendStatusEmail, customerAddr } from "./_notify.mjs";
import { mailVia } from "./_mail.mjs";

export const JOBS = { sheet: "7474902212077444", order: 2573430013880196, status: 3699329920722820, contact: 2432692525524868,
  due: 5951129734408068, shipVia: 4684492339210116, shipSpeed: 7851220025010052, shipDate: 5442940546901892,
  shipped: 3512383212676996, tracking: 7415802944589700, parts: 8202929548093316 };
const ARCH = { sheet: "253549607866244", order: 8712114298113924, status: 2062069196869508, shipped: 1745409848070020,
  shipDate: 2871309754912644, shipVia: 6811959428861828, shipSpeed: 1182459894648708, tracking: 6464474533629828,
  contact: 4313869010554756, parts: 4736081475620740, due: 2484281661935492 };
const LOG = { sheet: "5963104906071940", order: 7031647501586308, email: 839198013951876, contact: 8157547408428932, po: 5061322664611716 };
const ORDER_RE = /WEB-(?:\d{8}-)?\d{3,6}/;
const PRODUCTION = new Set(["Production", "Outsourced Post Production", "In House Secondary Process"]);
const MAX_PER_RUN = 25;
const STATE_KEY = "NOTIFY/state.json";
const DAY = 86400000;

async function readRows(token, sheet, colObj) {
  const ids = Object.entries(colObj).filter(([k, v]) => k !== "sheet" && typeof v === "number").map(([, v]) => v);
  const r = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheet + "?columnIds=" + ids.join(","), { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("sheet " + sheet + " read " + r.status);
  const d = await r.json();
  return (d.rows || []).map(row => {
    const m = {};
    for (const c of row.cells || []) m[c.columnId] = c.value != null ? c.value : (c.displayValue != null ? c.displayValue : "");
    return m;
  });
}

const yes = v => v === true || String(v).toLowerCase() === "true";
function stageOf(r, C) {
  const status = String(r[C.status] || "");
  if (status === "Cancelled") return null;
  const pickupVia = /pick/i.test(String(r[C.shipVia] || ""));
  if (yes(r[C.shipped]) || status === "Complete") return pickupVia ? "pickedup" : "shipped";
  if (status === "Waiting For Pickup") return "pickup";
  if (PRODUCTION.has(status)) return "production";
  return null;
}
const details = (r, C) => ({
  due: String(r[C.due] || "").slice(0, 10), shipDate: String(r[C.shipDate] || "").slice(0, 10),
  shipVia: String(r[C.shipVia] || ""), shipSpeed: String(r[C.shipSpeed] || ""),
  tracking: String(r[C.tracking] || "").trim(), pieces: r[C.parts] || "",
  contactCell: String(r[C.contact] || ""),
});
// Which email (if any) an order at `stage` still needs, given what it has already been sent.
function due(stage, s) {
  if (stage === "shipped") return s.shipped ? null : "shipped";
  if (stage === "pickup") return (s.pickup || s.shipped || s.pickedup) ? null : "pickup";
  if (stage === "production") return (s.production || s.pickup || s.shipped || s.pickedup) ? null : "production";
  return null;
}
function mark(s, stage, how) {
  const t = new Date().toISOString();
  if (stage === "shipped" || stage === "pickedup") { s.production = s.production || how; s.pickup = s.pickup || (stage === "pickedup" ? how : s.pickup); s[stage] = how; s.done = t; }
  else if (stage === "pickup") { s.production = s.production || how; s.pickup = how; }
  else if (stage === "production") s.production = how;
  s.t = t;
}

// opts: { dry, force }
export async function runCustomerUpdates(opts = {}) {
  if (String(process.env.CUSTOMER_UPDATES || "").toLowerCase() === "off") return { ok: true, off: true };
  const token = process.env.SMARTSHEET_TOKEN;
  if (!token) return { ok: false, error: "no SMARTSHEET_TOKEN" };
  const store = getStore("orders");
  const state = (await store.get(STATE_KEY, { type: "json" }).catch(() => null)) || { orders: {} };
  state.orders = state.orders || {};

  const jobs = await readRows(token, JOBS.sheet, JOBS);
  const live = new Map();   // orderNo → row (first WEB-#### per row; parent row wins over child cards)
  for (const r of jobs) {
    const m = String(r[JOBS.order] || "").match(ORDER_RE);
    if (m && !live.has(m[0])) live.set(m[0], r);
  }

  // ---- first run: baseline, no emails ----
  if (!state.baseline) {
    for (const [no, r] of live) { const st = stageOf(r, JOBS); if (st) { const s = state.orders[no] = {}; mark(s, st, "baseline"); } }
    state.baseline = new Date().toISOString();
    if (!opts.dry) await store.setJSON(STATE_KEY, state);
    return { ok: true, baseline: true, recorded: Object.keys(state.orders).length, dry: !!opts.dry };
  }

  // ---- who needs what ----
  const plan = [], waiting = [];   // waiting = shipped, holding briefly for a tracking #
  for (const [no, r] of live) {
    const st = stageOf(r, JOBS); if (!st) continue;
    const s = state.orders[no] || {};
    const need = due(st, s);
    const d = details(r, JOBS);
    // Shipped ticked but no tracking # yet: give the shipping team up to an hour to paste it in, so the
    // email includes it. After that it goes without (the email says to reply for tracking).
    if (need === "shipped" && !d.tracking) {
      if (!s.shipSeen) { s.shipSeen = new Date().toISOString(); state.orders[no] = s; }
      if (Date.now() - Date.parse(s.shipSeen) < 60 * 60000) { waiting.push(no); continue; }
    }
    if (need) plan.push({ orderNo: no, kind: need, d });
    else if (st === "pickedup" && !s.pickedup) { state.orders[no] = s; mark(s, "pickedup", "no email"); }
  }
  // Orders we were following that left SLS Jobs before we saw them finish → check the 6-month archive.
  const vanished = Object.entries(state.orders).filter(([no, s]) => !live.has(no) && !s.done && (s.production || s.pickup)).map(([no]) => no);
  if (vanished.length) {
    try {
      const arch = await readRows(token, ARCH.sheet, ARCH);
      const found = new Map();
      for (const r of arch) { const m = String(r[ARCH.order] || "").match(ORDER_RE); if (m && vanished.includes(m[0]) && !found.has(m[0])) found.set(m[0], r); }
      for (const no of vanished) {
        const s = state.orders[no], r = found.get(no);
        if (!r) { s.missing = (s.missing || 0) + 1; if (s.missing > 96) { s.done = new Date().toISOString(); s.gone = true; } continue; }
        const st = stageOf(r, ARCH) || "shipped";   // in the Complete sheet = finished
        const need = due(st, s);
        if (need) plan.push({ orderNo: no, kind: need, d: details(r, ARCH), archived: true });
        else if (st === "pickedup") mark(s, "pickedup", "no email");
      }
    } catch (e) { console.log("customer-updates: archive read failed:", e.message); }
  }

  // Customer email/name/PO from the Web Orders Log.
  if (plan.length) {
    try {
      const logRows = await readRows(token, LOG.sheet, LOG);
      const info = new Map();
      for (const r of logRows) { const m = String(r[LOG.order] || "").match(ORDER_RE); if (m) info.set(m[0], r); }
      for (const p of plan) {
        const r = info.get(p.orderNo);
        let email = r ? String(r[LOG.email] || "").trim() : "";
        if (!customerAddr(email)) { const m = p.d.contactCell.match(/[^\s<>,;]+@[^\s<>,;]+\.[a-z]{2,}/i); email = m ? m[0] : email; }
        p.to = email; p.name = r ? String(r[LOG.contact] || "") : ""; p.po = r ? String(r[LOG.po] || "") : "";
      }
    } catch (e) { console.log("customer-updates: log read failed:", e.message); }
  }

  const sendable = plan.filter(p => customerAddr(p.to));
  const summary = plan.map(p => ({ order: p.orderNo, email: p.kind, to: p.to || "(no customer email)", tracking: p.d.tracking || undefined }));
  if (opts.dry) return { ok: true, dry: true, via: mailVia() || "none", wouldSend: summary.filter(x => customerAddr(x.to)), waitingForTracking: waiting, skipped: summary.filter(x => !customerAddr(x.to)) };
  if (!mailVia()) return { ok: false, error: "email not configured", waiting: summary.length };
  if (!plan.length && waiting.length) { await store.setJSON(STATE_KEY, state); return { ok: true, sent: [], failed: [], waitingForTracking: waiting }; }
  if (sendable.length > MAX_PER_RUN && !opts.force) {
    console.log("customer-updates: BLOCKED — " + sendable.length + " emails in one run (limit " + MAX_PER_RUN + "). Check customer-updates?dry=1, then force=1.");
    return { ok: false, blocked: true, wouldSend: sendable.length };
  }

  const sent = [], failed = [];
  for (const p of plan) {
    const s = state.orders[p.orderNo] = state.orders[p.orderNo] || {};
    if (!customerAddr(p.to)) { mark(s, p.kind, "no email"); continue; }   // nothing to send to; don't retry forever
    const res = await sendStatusEmail(p.kind, { to: p.to, name: p.name, orderNo: p.orderNo, po: p.po, ...p.d });
    if (res.ok) { mark(s, p.kind, "sent"); sent.push(p.orderNo + " " + p.kind + " → " + p.to); }
    else { s.fails = (s.fails || 0) + 1; if (s.fails >= 5) mark(s, p.kind, "failed"); failed.push(p.orderNo + " " + p.kind + ": " + res.error); }
  }
  // Prune finished orders after 120 days so the state stays small.
  const cutoff = Date.now() - 120 * DAY;
  for (const [no, s] of Object.entries(state.orders)) if (s.done && Date.parse(s.done) < cutoff && !live.has(no)) delete state.orders[no];
  state.lastRun = new Date().toISOString();
  await store.setJSON(STATE_KEY, state);
  if (sent.length || failed.length) console.log("customer-updates:", JSON.stringify({ sent, failed }));
  return { ok: true, sent, failed, waitingForTracking: waiting };
}

export async function customerUpdatesState() {
  return (await getStore("orders").get(STATE_KEY, { type: "json" }).catch(() => null)) || null;
}
