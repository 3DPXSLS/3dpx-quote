// 3DPX — scheduled safety net: attach any order files that didn't make it onto their Smartsheet rows.
//
// WHY THIS EXISTS: attachOrderFiles() runs inside submit-po / stripe-webhook, i.e. inside a request
// with a hard time limit. Big part files + five ~1 MB PDFs often don't all fit, so the rest stay in the
// blob store. This runs every 10 minutes and finishes the job.
//
// REWRITTEN 2026-11-02 — the old version had silently stopped attaching anything since ~Oct 30:
//   • it walked orders OLDEST first, so a few old orders whose files could never attach used up the
//     whole time budget on every run and newer orders were never reached → now NEWEST first, and a file
//     that fails 3 times is parked (SWEEP/state.json) instead of retried forever;
//   • it attached every leftover file, including STALE part files the order deliberately skipped (a
//     different order's model left in the folder) → model files now attach only if the order's saved
//     quote lists them; PDFs, drawings and PO documents always attach;
//   • a file already on the row (same name) is never attached twice — the blob is just cleared.
// Never loses a file: a blob is deleted only once it's confirmed on the SLS Jobs row (or already there).
// Orders with no row yet (abandoned carts) are skipped cheaply. ?dry=1 on attach-sweep = report only.
import { getStore } from "@netlify/blobs";

const SLS_JOBS = "7474902212077444";
const LOG      = "5963104906071940";
const SJ_ORDERNO = 2573430013880196;   // SLS Jobs: PO or Order Number
const LG_ORDERNO = 7031647501586308;   // Web Orders Log: Order #
const LG_QUOTE   = 2809522850926468;   // Web Orders Log: Quote ID
const ORDER_RE = /^WEB-(?:\d{8}-)?\d{3,6}$/i;
const STATE_KEY = "SWEEP/state.json";
const MAX_FAILS = 3;

export const config = { schedule: "*/10 * * * *" };

export default async () => {
  const r = await sweep({});
  console.log("cron-attach-sweep:", JSON.stringify(r).slice(0, 2000));
  return new Response("ok");
};

const isDoc = n => /\.pdf$/i.test(n) || /^drawing-/i.test(n);           // order PDFs, drawings, PO docs
const orderNum = o => parseInt(String(o).split("-").pop(), 10) || 0;

// opts: { dry, only: "WEB-1234", budgetMs }
export async function sweep(opts = {}) {
  const token = process.env.SMARTSHEET_TOKEN;
  if (!token) return { error: "SMARTSHEET_TOKEN not set" };
  const sheetId = process.env.SMARTSHEET_SHEET_ID || SLS_JOBS;
  const deadline = Date.now() + (opts.budgetMs || 20000);
  const store = getStore("orders");
  const state = (await store.get(STATE_KEY, { type: "json" }).catch(() => null)) || { fails: {} };
  state.fails = state.fails || {};

  // 1) Order folders that still hold files (only WEB-… prefixes — never quotes).
  const pending = new Map();
  const listing = await store.list({ prefix: opts.only ? opts.only + "/" : "WEB-" });
  for (const b of (listing.blobs || [])) {
    const slash = b.key.indexOf("/");
    if (slash < 0) continue;
    const pre = b.key.slice(0, slash);
    if (!ORDER_RE.test(pre)) continue;
    const rest = b.key.slice(slash + 1);
    if (!rest || rest.startsWith(".part-")) continue;
    if (!pending.has(pre)) pending.set(pre, []);
    pending.get(pre).push(b.key);
  }
  if (!pending.size) return { pending: 0, attached: 0 };

  // 2) One read of each sheet, reused for every order this run.
  const rowsOf = async (sid, cols) => {
    const r = await fetch("https://api.smartsheet.com/2.0/sheets/" + sid + "?columnIds=" + cols.join(","),
      { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.rows || []).map(row => {
      const m = {}; for (const c of row.cells || []) m[c.columnId] = String(c.value || "");
      return { id: row.id, m, text: Object.values(m).join(" ").toUpperCase() };
    });
  };
  const jobRows = await rowsOf(sheetId, [SJ_ORDERNO]);
  const logRows = await rowsOf(LOG, [LG_ORDERNO, LG_QUOTE]);
  const attachedNames = async (sid, rowId) => {
    const r = await fetch("https://api.smartsheet.com/2.0/sheets/" + sid + "/rows/" + rowId + "/attachments?pageSize=500",
      { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) return new Set();
    const d = await r.json();
    return new Set((d.data || []).map(a => String(a.name || "").toLowerCase()));
  };

  let attached = 0, cleared = 0, failed = 0, skippedNoRow = 0;
  const report = [];
  // Newest orders first: what production is waiting on now.
  const orders = [...pending.keys()].sort((a, b) => orderNum(b) - orderNum(a));
  for (const orderNo of orders) {
    if (Date.now() > deadline) { report.push({ order: orderNo, note: "out of time — next run" }); break; }
    const u = orderNo.toUpperCase();
    const job = jobRows.find(r => r.text.includes(u));
    const lg  = logRows.find(r => r.text.includes(u));
    if (!job) { skippedNoRow++; continue; }                  // not ordered (yet) — leave the files alone

    // Which model files really belong to this order: the ones its saved quote lists.
    let allowed = null;
    const qid = lg && /^Q-[A-Za-z0-9]{4,12}$/.test(lg.m[LG_QUOTE] || "") ? lg.m[LG_QUOTE] : "";
    if (qid) {
      try {
        const q = await store.get("Q-QUOTES/" + qid + ".json", { type: "json" });
        if (q) {
          allowed = new Set((q.parts || []).map(p => String(p.file || "").toLowerCase()).filter(Boolean));
          for (const e of (q.fileMap || [])) { const n = String(e.to || "").split("__").pop(); if (n) allowed.add(n.toLowerCase()); }
        }
      } catch (e) {}
    }

    const targets = [{ sheetId, rowId: job.id }];
    if (lg) targets.push({ sheetId: LOG, rowId: lg.id });
    const onRow = await Promise.all(targets.map(t => attachedNames(t.sheetId, t.rowId)));
    const rec = { order: orderNo, files: [] };

    for (const key of pending.get(orderNo)) {
      if (Date.now() > deadline) break;
      const rest = key.slice((orderNo + "/").length);
      const meta = await store.getMetadata(key).catch(() => null);
      const k = rest.indexOf("__");
      const fname = (meta && meta.metadata && meta.metadata.name) || (k >= 0 ? rest.slice(k + 2) : rest);
      const lower = fname.toLowerCase();
      if (fname === "manifest.json") { if (!opts.dry) await store.delete(key).catch(() => {}); continue; }
      if ((state.fails[key] || 0) >= MAX_FAILS) { rec.files.push(fname + ": parked (failed " + MAX_FAILS + "×)"); continue; }
      if (!isDoc(fname) && !(allowed && allowed.has(lower))) {
        rec.files.push(fname + ": left alone (not a part of this order" + (allowed ? "" : " — no saved quote to confirm") + ")");
        continue;
      }
      if (onRow[0].has(lower)) {                               // already on the SLS Jobs row
        if (!opts.dry) { await store.delete(key).catch(() => {}); }
        cleared++; rec.files.push(fname + ": already attached — cleared"); continue;
      }
      if (opts.dry) { rec.files.push(fname + ": WOULD attach"); continue; }
      try {
        const bytes = await store.get(key, { type: "arrayBuffer" });
        if (!bytes) continue;
        let primaryOk = false;
        for (let i = 0; i < targets.length; i++) {
          if (onRow[i].has(lower)) { if (i === 0) primaryOk = true; continue; }
          const fd = new FormData();
          fd.append("file", new Blob([bytes], { type: "application/octet-stream" }), fname);
          const ar = await fetch("https://api.smartsheet.com/2.0/sheets/" + targets[i].sheetId + "/rows/" + targets[i].rowId + "/attachments",
            { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
          if (ar.ok) onRow[i].add(lower);
          if (i === 0) primaryOk = ar.ok;
          if (!ar.ok) console.log("sweep attach failed:", orderNo, fname, ar.status, (await ar.text()).slice(0, 200));
        }
        if (primaryOk) { await store.delete(key); attached++; rec.files.push(fname + ": attached"); delete state.fails[key]; }
        else { failed++; state.fails[key] = (state.fails[key] || 0) + 1; rec.files.push(fname + ": FAILED (" + state.fails[key] + ")"); }
      } catch (e) {
        failed++; state.fails[key] = (state.fails[key] || 0) + 1;
        rec.files.push(fname + ": error " + e.message);
      }
    }
    if (rec.files.length) report.push(rec);
  }
  if (!opts.dry) await store.setJSON(STATE_KEY, state).catch(() => {});
  return { dry: !!opts.dry, pending: pending.size, attached, cleared, failed, skippedNoRow, report };
}
