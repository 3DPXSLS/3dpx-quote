// 3DPX — return a saved quote's line items + options by id (for the customer-facing link).
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const id = (url.searchParams.get("id") || "").replace(/[^A-Za-z0-9\-]/g, "").slice(0, 14);
  if (!/^Q-[A-Za-z0-9]{4,12}$/.test(id)) return json({ error: "Bad quote id" }, 400);
  try {
    const store = getStore("orders");
    const rec = await store.get("Q-QUOTES/" + id + ".json", { type: "json" });
    if (!rec) return json({ error: "Quote not found or expired." }, 404);
    return json({ ok: true, quote: rec });
  } catch (e) {
    console.log("get-quote failed:", e.message);
    return json({ error: "Could not load quote." }, 500);
  }
};

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }
