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
  if (!/^WEB-[0-9]{8}-[0-9]{3,5}$/.test(orderNo)) return json({ error: "Bad order no" }, 400);

  try {
    const store = getStore("orders");
    const listing = await store.list({ prefix: id + "/" });
    let copied = 0;
    for (const b of (listing.blobs || [])) {
      const rest = b.key.slice((id + "/").length);      // e.g. "0__part.stl"
      if (!rest) continue;
      const bytes = await store.get(b.key, { type: "arrayBuffer" });
      if (!bytes) continue;
      const meta = await store.getMetadata(b.key).catch(() => null);
      await store.set(orderNo + "/" + rest, bytes, { metadata: (meta && meta.metadata) || {} });
      copied++;
    }
    return json({ ok: true, copied });
  } catch (e) {
    console.log("promote-quote failed:", e.message);
    return json({ error: "Could not attach quote files." }, 500);
  }
};

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }
