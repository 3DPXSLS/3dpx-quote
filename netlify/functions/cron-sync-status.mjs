// 3DPX — scheduled: keep the SLS Web Orders Log "SLS Jobs Status" current every hour.
// Netlify runs this server-side on the cron below (no app needs to be open).
import { syncStatus } from "./_syncstatus.mjs";

export const config = { schedule: "0 * * * *" };  // top of every hour (UTC)

export default async () => {
  const r = await syncStatus();
  console.log("cron-sync-status:", JSON.stringify(r));
  return new Response("ok");
};
