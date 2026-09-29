// 3DPX — on-demand trigger for the attachment sweeper (same logic the 10-minute cron runs).
// GET /.netlify/functions/attach-sweep        → sweep now, report what it attached
// Use when you don't want to wait for the schedule (e.g. right after placing a big order).
import { sweep } from "./cron-attach-sweep.mjs";

export default async () => {
  const r = await sweep();
  return new Response(JSON.stringify(r, null, 2), { headers: { "Content-Type": "application/json" } });
};
