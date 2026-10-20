// 3DPX — list the files actually stored for an order (or quote) prefix.
// The widget calls this right before placing an order so it can confirm EVERY quoted part has its
// file on the server. Checking the server (rather than the browser) is what makes this reliable:
// files copied across from a saved quote by promote-quote.mjs correctly count as present, and a
// silent upload failure can no longer slip through as a paid order with nothing to print.
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const order = (url.searchParams.get("order") || "").replace(/[^A-Za-z0-9\-]/g, "").slice(0, 40);
  if (!order) return json({ error: "missing order" }, 400);

  try {
    const store = getStore("orders");
    const listing = await store.list({ prefix: order + "/" });
    const files = [], entries = [];
    for (const b of (listing.blobs || [])) {
      const rest = b.key.slice((order + "/").length);
      if (!rest) continue;
      if (rest.startsWith(".part-")) continue;          // in-flight chunk temp files aren't real uploads
      const k = rest.indexOf("__");                     // stored as "<idx>__<filename>"
      const name = k >= 0 ? rest.slice(k + 2) : rest;
      files.push(name);
      if (k > 0 && /^\d+$/.test(rest.slice(0, k))) entries.push({ i: +rest.slice(0, k), name });
    }
    // ?idx=1 also returns which line each file belongs to. For a customer-portal reorder quote that
    // points at files elsewhere (fileMap), those count too — they're what the order will receive.
    if (url.searchParams.get("idx") === "1" && /^Q-[A-Za-z0-9]{4,12}$/.test(order)) {
      try {
        const rec = await store.get("Q-QUOTES/" + order + ".json", { type: "json" });
        const have = new Set(entries.map(e => e.i + "__" + e.name));
        for (const e of (rec && Array.isArray(rec.fileMap)) ? rec.fileMap : []) {
          const m = String(e.to || "").match(/^(\d+)__(.+)$/);
          if (m && !have.has(m[0])) { entries.push({ i: +m[1], name: m[2] }); files.push(m[2]); }
        }
      } catch (e) { /* folder contents only */ }
    }
    return json({ ok: true, files, entries });
  } catch (e) {
    console.log("check-files failed:", e.message);
    return json({ error: "list failed" }, 500);
  }
};

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }
