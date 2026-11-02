// 3DPX — scheduled: send customers their automatic order-status emails (see _custupdates.mjs).
import { runCustomerUpdates } from "./_custupdates.mjs";
import { keepMailAlive } from "./_mail.mjs";

export default async () => {
  try { await keepMailAlive(); } catch (e) {}   // keeps the Microsoft sign-in from lapsing
  try {
    const r = await runCustomerUpdates({});
    console.log("cron-customer-updates:", JSON.stringify(r).slice(0, 1500));
  } catch (e) { console.log("cron-customer-updates failed:", e.message); }
  return new Response("ok");
};

export const config = { schedule: "*/15 * * * *" };   // every 15 minutes
