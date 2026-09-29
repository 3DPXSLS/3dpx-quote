// 3DPX — scheduled safety net: attach any order files that didn't make it onto their Smartsheet rows.
//
// WHY THIS EXISTS: attachOrderFiles() runs inside submit-po / stripe-webhook, i.e. inside a request
// that has a hard time limit. Downloading each file and uploading it to two rows is the slowest thing
// those functions do, so on a larger order (many parts, or 6MB travelers) the function is cut off
// part-way — some files land, the rest stay in the blob store and production never sees them.
// Rather than racing the clock, this runs every 10 minutes and finishes whatever was left behind.
//
// Safe by construction: a blob is only deleted once it is confirmed on the primary row, so this can
// never lose a file, and re-running never duplicates one (anything already attached is already gone).
// Orders with no row yet (abandoned carts — an order number was allocated and files uploaded, but the
// order was never submitted) are skipped cheaply and left alone.

const SLS_JOBS = "7474902212077444";
const LOG      = "5963104906071940";
const SJ_ORDERNO = 2573430013880196;   // SLS Jobs: PO or Order Number
const LG_ORDERNO = 7031647501586308;   // Web Orders Log: Order #

const BUDGET_MS = 20000;               // leave the rest for the next run rather than getting killed

export const config = { schedule: "*/10 * * * *" };

export default async () => {
  const r = await sweep();
  console.log("cron-attach-sweep:", JSON.stringify(r));
  return new Response("ok");
};

export async function sweep() {
  const token = process.env.SMARTSHEET_TOKEN;
  if (!token) return { error: "SMARTSHEET_TOKEN not set" };
  const sheetId = process.env.SMARTSHEET_SHEET_ID || SLS_JOBS;
  const deadline = Date.now() + BUDGET_MS;

  const { getStore } = await import("@netlify/blobs");
  const store = getStore("orders");

  // 1) Which order prefixes still hold files? (Quote "Q-…" prefixes are not orders — leave them.)
  const pending = new Map();
  const listing = await store.list();
  for (const b of (listing.blobs || [])) {
    const slash = b.key.indexOf("/");
    if (slash < 0) continue;
    const pre = b.key.slice(0, slash);
    if (!/^WEB-(?:\d{8}-)?\d{3,6}$/i.test(pre)) continue;
    const rest = b.key.slice(slash + 1);
    if (!rest || rest.startsWith(".part-")) continue;
    if (!pending.has(pre)) pending.set(pre, []);
    pending.get(pre).push(b.key);
  }
  if (!pending.size) return { pending: 0, attached: 0 };

  // 2) One read of each sheet, reused for every order this run.
  const rowsOf = async (sid, colId) => {
    const r = await fetch("https://api.smartsheet.com/2.0/sheets/" + sid + "?columnIds=" + colId,
      { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.rows || []).map(row => ({ id: row.id, text: (row.cells || []).map(c => String(c.value || "")).join(" ").toUpperCase() }));
  };
  const jobRows = await rowsOf(sheetId, SJ_ORDERNO);
  const logRows = await rowsOf(LOG, LG_ORDERNO);

  let attached = 0, failed = 0, skipped = 0;
  const handled = [];
  for (const [orderNo, keys] of pending) {
    if (Date.now() > deadline) break;                       // next run picks up where we left off
    const u = orderNo.toUpperCase();
    const job = jobRows.find(r => r.text.includes(u));
    const lg  = logRows.find(r => r.text.includes(u));
    if (!job && !lg) { skipped++; continue; }               // not ordered (yet) — leave the files alone

    const targets = [];
    if (job) targets.push({ sheetId, rowId: job.id });
    if (lg) targets.push({ sheetId: LOG, rowId: lg.id });

    let n = 0;
    for (const key of keys) {
      if (Date.now() > deadline) break;
      try {
        const rest = key.slice((orderNo + "/").length);
        const meta = await store.getMetadata(key).catch(() => null);
        const k = rest.indexOf("__");
        const fname = (meta && meta.metadata && meta.metadata.name) || (k >= 0 ? rest.slice(k + 2) : rest);
        if (fname === "manifest.json") { await store.delete(key).catch(() => {}); continue; }
        const bytes = await store.get(key, { type: "arrayBuffer" });
        if (!bytes) continue;
        let primaryOk = false;
        for (let i = 0; i < targets.length; i++) {
          const fd = new FormData();
          fd.append("file", new Blob([bytes], { type: "application/octet-stream" }), fname);
          const ar = await fetch("https://api.smartsheet.com/2.0/sheets/" + targets[i].sheetId + "/rows/" + targets[i].rowId + "/attachments",
            { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
          if (i === 0) primaryOk = ar.ok;
          if (!ar.ok) console.log("sweep attach failed:", orderNo, fname, ar.status, (await ar.text()).slice(0, 200));
        }
        if (primaryOk) { await store.delete(key); attached++; n++; } else failed++;
      } catch (e) { console.log("sweep item failed:", orderNo, e.message); failed++; }
    }
    if (n) handled.push(orderNo + ":" + n);
  }
  return { pending: pending.size, attached, failed, skippedNoRow: skipped, handled };
}
