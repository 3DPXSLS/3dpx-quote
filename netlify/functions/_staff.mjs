// 3DPX — staff check for rep-only data endpoints (customer search).
//
// Reps open the internal tool with the staff link:  https://3dpx-quote.netlify.app/?internal=<staff code>
// The plain ?internal=1 link still opens the rep view, but anything that returns CUSTOMER DATA requires
// the staff code — those endpoints are reachable from the public page's source, so without this anyone
// could pull the customer list (names, emails, phones, addresses).
//
// Only the SHA-256 hash lives here (safe in the repo). To change the code: hash a new one, replace the
// hash below, push, and give the reps the new link. The old link's customer search stops working at once.
import crypto from "node:crypto";

const STAFF_HASHES = new Set([
  "7bb2d4750d5a5d063d7929d0ef9a9269e36f669fed0e0a2c2eae1600cd44f389",   // created 2026-10-19
]);

export function isStaff(code) {
  const c = String(code || "").trim().toUpperCase();
  if (c.length < 8 || c.length > 60) return false;
  return STAFF_HASHES.has(crypto.createHash("sha256").update(c).digest("hex"));
}
