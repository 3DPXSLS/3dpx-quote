// 3DPX — serve a saved quote's STL by index, so the customer-facing quote link can
// rebuild the interactive 3D preview. Reads the rep-uploaded blob under "Q-<id>/<i>__*.stl".
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const id = (url.searchParams.get("id") || "").replace(/[^A-Za-z0-9\-]/g, "").slice(0, 14);
  const i  = (url.searchParams.get("i") || "").replace(/[^0-9]/g, "");
  if (!/^Q-[A-Za-z0-9]{4,12}$/.test(id)) return new Response("bad id", { status: 400 });
  try {
    const store = getStore("orders");
    const listing = await store.list({ prefix: id + "/" });
    const pref = i + "__";
    const b = (listing.blobs || []).find(x => {
      const rest = x.key.slice((id + "/").length);
      return rest.startsWith(pref) && /\.stl$/i.test(rest);
    });
    let key = b ? b.key : null;
    if (!key) {
      // Customer-portal reorder quotes point at the original files instead of holding copies.
      const rec = await store.get("Q-QUOTES/" + id + ".json", { type: "json" }).catch(() => null);
      const e = (rec && Array.isArray(rec.fileMap) ? rec.fileMap : []).find(x => String(x.to || "").startsWith(pref) && /\.stl$/i.test(String(x.to)));
      if (e && /^Q-[A-Za-z0-9]{4,12}\//.test(String(e.from))) key = String(e.from);
    }
    if (!key) return new Response("not found", { status: 404 });
    const bytes = await store.get(key, { type: "arrayBuffer" });
    if (!bytes) return new Response("empty", { status: 404 });
    return new Response(bytes, { status: 200, headers: { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=3600" } });
  } catch (e) {
    console.log("get-quote-file failed:", e.message);
    return new Response("error", { status: 500 });
  }
};
