// 3DPX — re-attach an order's leftover files to its Smartsheet rows.
//
// attachOrderFiles() deletes each blob only after it lands on the primary row, so if the order
// function runs out of time mid-way the remaining files simply stay in the blob store. This endpoint
// finishes the job: it finds the order's SLS Jobs row (+ its Web Orders Log row) and re-runs the
// attach for whatever is still stored. Idempotent — anything already attached was already deleted,
// and attaching is skipped for orders with nothing left.
//
// Trigger: GET /.netlify/functions/reattach-order?order=WEB-1112
//          GET /.netlify/functions/reattach-order?scan=1[&max=5]   ← find + fix every stranded order
// If env RECONCILE_KEY is set, ?key must match.

const SLS_JOBS = "7474902212077444";
const LOG      = "5963104906071940";
const SJ_ORDERNO = 2573430013880196;   // SLS Jobs: PO or Order Number
const LG_ORDERNO = 7031647501586308;   // Web Orders Log: Order #

export default async (req) => {
  const url = new URL(req.url);
  const need = process.env.RECONCILE_KEY;
  if (need && url.searchParams.get("key") !== need) return json({ error: "Not authorized" }, 403);

  const token = process.env.SMARTSHEET_TOKEN;
  if (!token) return json({ error: "SMARTSHEET_TOKEN not set" }, 503);
  const sheetId = process.env.SMARTSHEET_SHEET_ID || SLS_JOBS;

  const one = (url.searchParams.get("order") || "").replace(/[^A-Za-z0-9\-]/g, "").slice(0, 40);
  const scan = url.searchParams.get("scan");
  const max = Math.min(10, Math.max(1, parseInt(url.searchParams.get("max")) || 5));
  if (!one && !scan) return json({ error: "pass ?order=WEB-#### or ?scan=1" }, 400);

  const { getStore } = await import("@netlify/blobs");
  const store = getStore("orders");

  // Which orders still have files sitting in storage?
  let orders = [];
  if (one) orders = [one];
  else {
    const listing = await store.list();
    const seen = new Map();
    for (const b of (listing.blobs || [])) {
      const slash = b.key.indexOf("/");
      if (slash < 0) continue;
      const pre = b.key.slice(0, slash);
      if (!/^WEB-(?:\d{8}-)?\d{3,6}$/i.test(pre)) continue;      // only order prefixes, not Q- quotes
      const rest = b.key.slice(slash + 1);
      if (!rest || rest.startsWith(".part-")) continue;
      seen.set(pre, (seen.get(pre) || 0) + 1);
    }
    orders = [...seen.keys()].sort().slice(0, max);
  }

  // Row lookups: one read of each sheet, reused for every order in this call.
  const rowsOf = async (sid, colId) => {
    const r = await fetch("https://api.smartsheet.com/2.0/sheets/" + sid + "?columnIds=" + colId, { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.rows || []).map(row => ({ id: row.id, text: (row.cells || []).map(c => String(c.value || "")).join(" ").toUpperCase() }));
  };
  const jobRows = await rowsOf(sheetId, SJ_ORDERNO);
  const logRows = await rowsOf(LOG, LG_ORDERNO);

  const done = [];
  for (const orderNo of orders) {
    const u = orderNo.toUpperCase();
    const job = jobRows.find(r => r.text.includes(u));
    const lg  = logRows.find(r => r.text.includes(u));
    if (!job) { done.push({ order: orderNo, skipped: "no SLS Jobs row found" }); continue; }

    const before = await countFiles(store, orderNo);
    if (!before) { done.push({ order: orderNo, skipped: "nothing left to attach" }); continue; }

    const targets = [{ sheetId, rowId: job.id }];
    if (lg) targets.push({ sheetId: LOG, rowId: lg.id });

    // Attach inline (rather than via _attach.mjs) so every step is reportable — a silent
    // per-file failure in the shared helper is invisible without Netlify log access.
    const files = [];
    const listing = await store.list({ prefix: orderNo + "/" });
    for (const b of (listing.blobs || [])) {
      const rest = b.key.slice((orderNo + "/").length);
      if (!rest || rest.startsWith(".part-")) continue;
      const rec = { key: b.key };
      try {
        const meta = await store.getMetadata(b.key).catch(() => null);
        const fname = (meta && meta.metadata && meta.metadata.name) || b.key.split("__").pop() || "file";
        rec.name = fname;
        if (fname === "manifest.json") { await store.delete(b.key).catch(() => {}); rec.result = "manifest deleted"; files.push(rec); continue; }
        const bytes = await store.get(b.key, { type: "arrayBuffer" });
        if (!bytes) { rec.result = "blob read returned null"; files.push(rec); continue; }
        rec.bytes = bytes.byteLength;
        let primaryOk = false;
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          const fd = new FormData();
          fd.append("file", new Blob([bytes], { type: "application/octet-stream" }), fname);
          const ar = await fetch("https://api.smartsheet.com/2.0/sheets/" + t.sheetId + "/rows/" + t.rowId + "/attachments",
            { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
          const okTxt = ar.ok ? "ok" : (await ar.text()).slice(0, 200);
          rec["target" + i] = ar.status + " " + okTxt;
          if (i === 0) primaryOk = ar.ok;
        }
        if (primaryOk) { await store.delete(b.key); rec.result = "attached + removed"; }
        else rec.result = "attach failed, blob kept";
      } catch (e) { rec.result = "threw: " + e.message; }
      files.push(rec);
    }

    const after = await countFiles(store, orderNo);
    done.push({ order: orderNo, attached: before - after, remaining: after, targets: targets.length, files });
  }
  return json({ ok: true, processed: done.length, done });
};

async function countFiles(store, orderNo) {
  const l = await store.list({ prefix: orderNo + "/" });
  return (l.blobs || []).filter(b => {
    const r = b.key.slice((orderNo + "/").length);
    return r && !r.startsWith(".part-");
  }).length;
}

function json(o, s = 200) { return new Response(JSON.stringify(o, null, 2), { status: s, headers: { "Content-Type": "application/json" } }); }
