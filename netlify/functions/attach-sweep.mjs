// 3DPX — on-demand trigger for the attachment sweeper (same logic the 10-minute cron runs).
//   GET /.netlify/functions/attach-sweep              → sweep now, report what it attached
//   GET /.netlify/functions/attach-sweep?dry=1        → report what it WOULD attach (changes nothing)
//   GET /.netlify/functions/attach-sweep?order=WEB-1234 → just that order
import { sweep } from "./cron-attach-sweep.mjs";

export default async (req) => {
  const u = new URL(req.url);
  const only = (u.searchParams.get("order") || "").replace(/[^A-Za-z0-9\-]/g, "").slice(0, 40);
  const r = await sweep({ dry: !!u.searchParams.get("dry"), only: only || undefined, budgetMs: 22000 });
  return new Response(JSON.stringify(r, null, 2), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
};
