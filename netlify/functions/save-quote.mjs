// 3DPX — save an internal (rep-built) quote so it can be sent to a customer as a link.
// Stores the quote's line items + options as JSON in Netlify Blobs under "Q-<id>/_quote.json".
// The rep's STL(s) + drawings are uploaded separately (upload-stl with order=Q-<id>) and stay
// under the same prefix until the customer orders (promote-quote copies them onto the order).
// Optional gate: set INTERNAL_CODE env var; if set, the request token must match it.
import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  const need = process.env.INTERNAL_CODE;
  if (need && String(body.token || "") !== String(need)) return json({ error: "Not authorized" }, 403);

  const parts = Array.isArray(body.parts) ? body.parts : [];
  if (!parts.length) return json({ error: "No parts to save." }, 400);

  const id = (body.id && /^Q-[A-Za-z0-9]{4,12}$/.test(body.id)) ? body.id
    : ("Q-" + Math.random().toString(36).slice(2, 8).toUpperCase());

  const record = {
    id, created: new Date().toISOString(),
    parts: parts.map(p => ({
      name: String(p.name || "part").slice(0,120),
      x: +p.x || 0, y: +p.y || 0, z: +p.z || 0, vol: +p.vol || 0,
      qty: Math.max(1, parseInt(p.qty) || 1),
      color: String(p.color || "natural"), dye: !!p.dye, vs: !!p.vs,
      drawingName: p.drawingName ? String(p.drawingName).slice(0,120) : "",
      thumb: (p.thumb && String(p.thumb).startsWith("data:image")) ? String(p.thumb).slice(0, 400000) : "",
      override: (+p.override > 0) ? +p.override : null,
    })),
    region: String(body.region || "us"),
    zip: String(body.zip || "").slice(0,12),
    shipSpeed: String(body.shipSpeed || "ground"),
    matCert: !!body.matCert,
    addlDisc: Math.max(0, +body.addlDisc || 0),
    note: String(body.note || "").slice(0, 600),
    cust: {
      name: String(body.name || "").slice(0,200),
      company: String(body.company || "").slice(0,200),
      email: String(body.email || "").slice(0,200),
      phone: String(body.phone || "").slice(0,60),
    },
  };

  try {
    const store = getStore("orders");
    await store.setJSON("Q-QUOTES/" + id + ".json", record);
    return json({ ok: true, id });
  } catch (e) {
    console.log("save-quote failed:", e.message);
    return json({ error: "Could not save quote." }, 500);
  }
};

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } }); }
