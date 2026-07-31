// 3DPX - receives an STL/STEP/PDF file (raw binary) and stores it in Netlify Blobs, keyed by order.
// Small files arrive in a single POST. Large files (over the ~4.5MB Netlify function-body cap) are
// uploaded in <3.5MB chunks: each chunk is stored under a temp prefix, then a final "finalize" call
// concatenates them into the real blob (order/idx__name) and deletes the temp chunks. The webhook /
// submit-po attach step later attaches the finished blob.
import { getStore } from "@netlify/blobs";

const CHUNK_MAX = 5 * 1024 * 1024;    // max bytes per single request (one chunk)
const FINAL_MAX = 32 * 1024 * 1024;   // max reassembled file size

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const url = new URL(req.url);
  const order = (url.searchParams.get("order") || "").replace(/[^A-Za-z0-9\-]/g, "").slice(0, 40);
  const name  = (url.searchParams.get("name") || "part.stl").slice(0, 120);
  const idx   = (url.searchParams.get("i") || "0").replace(/[^0-9]/g, "");
  const uid   = (url.searchParams.get("uid") || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 40);
  const chunk = parseInt(url.searchParams.get("chunk") || "-1", 10);
  const chunks = parseInt(url.searchParams.get("chunks") || "1", 10);
  const finalize = url.searchParams.get("finalize");
  if (!order) return json({ error: "missing order" }, 400);

  const store = getStore("orders");

  try {
    // ---- Finalize: reassemble the uploaded chunks into the real blob ----
    if (finalize) {
      if (!uid || !(chunks > 1)) return json({ error: "bad finalize" }, 400);
      const buffers = [];
      let totalLen = 0;
      for (let c = 0; c < chunks; c++) {
        const b = await store.get(order + "/.part-" + uid + "/" + c, { type: "arrayBuffer" });
        if (!b) return json({ error: "missing chunk " + c }, 409);
        buffers.push(new Uint8Array(b));
        totalLen += b.byteLength;
        if (totalLen > FINAL_MAX) return json({ error: "too big" }, 413);
      }
      const merged = new Uint8Array(totalLen);
      let off = 0;
      for (const b of buffers) { merged.set(b, off); off += b.byteLength; }
      await store.set(order + "/" + idx + "__" + name, merged.buffer, { metadata: { name } });
      for (let c = 0; c < chunks; c++) await store.delete(order + "/.part-" + uid + "/" + c).catch(() => {});
      return json({ ok: true, size: totalLen });
    }

    // ---- Body upload (either a whole small file, or one chunk of a big file) ----
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) return json({ error: "empty" }, 400);
    if (buf.byteLength > CHUNK_MAX) return json({ error: "too big" }, 413);

    if (chunks > 1 && chunk >= 0) {
      if (!uid) return json({ error: "missing uid" }, 400);
      await store.set(order + "/.part-" + uid + "/" + chunk, buf, { metadata: { chunk: String(chunk) } });
      return json({ ok: true, chunk });
    }

    // Single-shot small file (unchanged behavior)
    await store.set(order + "/" + idx + "__" + name, buf, { metadata: { name } });
    return json({ ok: true });
  } catch (e) {
    console.log("upload-stl store failed:", e.message);
    return json({ error: "store failed" }, 500);
  }
};

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }
