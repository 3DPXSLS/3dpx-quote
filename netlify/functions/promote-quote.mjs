// 3DPX — when a customer orders from a saved-quote link, copy the rep-uploaded files
// (STLs + drawings, stored under "Q-<id>/") onto the new order prefix "<orderNo>/", so the
// existing webhook / submit-po attach step picks them up unchanged.
import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  const id = String(body.id || "").replace(/[^A-Za-z0-9\-]/g, "");
  const orderNo = String(body.orderNo || "").replace(/[^A-Za-z0-9\-]/g, "");
  if (!/^Q-[A-Za-z0-9]{4,12}$/.test(id)) return json({ error: "Bad quote id" }, 400);
  if (!/^WEB-(?:[0-9]{8}-)?[0-9]{3,6}$/.test(orderNo)) return json({ error: "Bad order no" }, 400);

  try {
    const store = getStore("orders");
    const listing = await store.list({ prefix: id + "/" });
    // jobs: { from: physical blob key, to: "<i>__<name>" under the order }
    const jobs = (listing.blobs || []).map(b => ({ from: b.key, to: b.key.slice((id + "/").length) }))
      .filter(j => j.to && !j.to.startsWith(".part-"));   // skip orphaned chunk temp files from a large upload
    // A customer-portal reorder quote doesn't hold copies of unchanged files — it maps each one back to
    // where it physically lives (see account-reorder). Files actually in this quote's folder win.
    try {
      const rec = await store.get("Q-QUOTES/" + id + ".json", { type: "json" });
      const have = new Set(jobs.map(j => j.to));
      for (const e of (rec && Array.isArray(rec.fileMap)) ? rec.fileMap : []) {
        const to = String(e.to || ""), from = String(e.from || "");
        if (/^\d+__.+/.test(to) && /^Q-[A-Za-z0-9]{4,12}\//.test(from) && !have.has(to)) { jobs.push({ from, to }); have.add(to); }
      }
    } catch (e) { /* no record / no map — folder contents only */ }
    // Copy a few at a time: big quotes (Wildfactory: 43 STEP files) took long enough one-by-one to
    // risk the function's time limit. Same result, much faster.
    let copied = 0;
    for (let k = 0; k < jobs.length; k += 6) {
      await Promise.all(jobs.slice(k, k + 6).map(async jb => {
        const bytes = await store.get(jb.from, { type: "arrayBuffer" });
        if (!bytes) return;
        const meta = await store.getMetadata(jb.from).catch(() => null);
        const name = (meta && meta.metadata && meta.metadata.name) || jb.to.replace(/^\d+__/, "");
        await store.set(orderNo + "/" + jb.to, bytes, { metadata: { ...((meta && meta.metadata) || {}), name } });
        copied++;
      }));
    }
    return json({ ok: true, copied });
  } catch (e) {
    console.log("promote-quote failed:", e.message);
    return json({ error: "Could not attach quote files." }, 500);
  }
};

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }
