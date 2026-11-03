// 3DPX — re-attach an order's leftover files to its Smartsheet rows.
// Now a thin wrapper over the sweeper (cron-attach-sweep.mjs) so both use the same SAFE rules:
// PDFs/drawings/PO docs always attach; model files only if the order's saved quote lists them; nothing
// already on the row is attached twice; a blob is deleted only once it's confirmed on the SLS Jobs row.
//   GET /.netlify/functions/reattach-order?order=WEB-1112[&dry=1]
//   GET /.netlify/functions/reattach-order?scan=1[&dry=1]     ← every order with leftovers, newest first
import { sweep } from "./cron-attach-sweep.mjs";

export default async (req) => {
  const url = new URL(req.url);
  const need = process.env.RECONCILE_KEY;
  if (need && url.searchParams.get("key") !== need) return json({ error: "Not authorized" }, 403);
  const one = (url.searchParams.get("order") || "").replace(/[^A-Za-z0-9\-]/g, "").slice(0, 40);
  if (!one && !url.searchParams.get("scan")) return json({ error: "pass ?order=WEB-#### or ?scan=1" }, 400);
  return json(await sweep({ only: one || undefined, dry: !!url.searchParams.get("dry"), budgetMs: 22000 }));
};

function json(o, s = 200) { return new Response(JSON.stringify(o, null, 2), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }); }
