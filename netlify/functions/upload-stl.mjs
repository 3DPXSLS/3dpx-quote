// 3DPX - receives an STL file (raw binary) and stores it in Netlify Blobs,
// keyed by order number. The webhook later attaches these to the SLS Jobs row.
import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  const order = (url.searchParams.get("order") || "").replace(/[^A-Za-z0-9\-]/g, "").slice(0, 40);
  const name  = (url.searchParams.get("name") || "part.stl").slice(0, 120);
  const idx   = (url.searchParams.get("i") || "0").replace(/[^0-9]/g, "");
  if (!order) return json({ error: "missing order" }, 400);

  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return json({ error: "empty" }, 400);
  if (buf.byteLength > 6 * 1024 * 1024) return json({ error: "too big" }, 413);

  try {
    const store = getStore("orders");
    await store.set(order + "/" + idx + "__" + name, buf, { metadata: { name } });
    return json({ ok: true });
  } catch (e) {
    console.log("upload-stl store failed:", e.message);
    return json({ error: "store failed" }, 500);
  }
};

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }
