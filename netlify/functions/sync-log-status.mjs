// 3DPX — on-demand: refresh the SLS Web Orders Log "SLS Jobs Status" column from SLS Jobs.
// Hit https://3dpx-quote.netlify.app/.netlify/functions/sync-log-status to run it anytime.
import { syncStatus } from "./_syncstatus.mjs";

export default async () => {
  const r = await syncStatus();
  return new Response(JSON.stringify(r, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
};
