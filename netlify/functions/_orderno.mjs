// 3DPX — sequential web order-number allocator.
// Hands out WEB-1001, WEB-1002, ... from a single counter stored in Netlify Blobs (store "orders",
// key "COUNTER/web-order-no.json" = { n }). Uses conditional writes (compare-and-set) so two orders
// placed at the same instant can never receive the same number. Gaps are possible (an abandoned
// checkout burns a number) and that's fine — uniqueness is what matters.

const KEY = "COUNTER/web-order-no.json";
const START = 1000;   // first allocated number is START + 1 = WEB-1001

export async function allocateWebOrderNo(store) {
  for (let attempt = 0; attempt < 10; attempt++) {
    let cur = null;
    try { cur = await store.getWithMetadata(KEY, { type: "json" }); } catch (e) { cur = null; }
    const n = (cur && cur.data && Number.isFinite(+cur.data.n)) ? +cur.data.n : START;
    const next = n + 1;
    const opts = cur && cur.etag ? { onlyIfMatch: cur.etag } : { onlyIfNew: true };
    try {
      const res = await store.setJSON(KEY, { n: next, updated: new Date().toISOString() }, opts);
      // Newer @netlify/blobs returns { modified }. If the conditional write lost the race, retry.
      if (res && res.modified === false) continue;
      return "WEB-" + next;
    } catch (e) {
      // 412 precondition failed (another writer won) → retry with fresh etag.
      continue;
    }
  }
  // Extremely unlikely: contention never resolved. Fall back to a random 4-digit number so the order
  // can still be placed (a rare duplicate is far better than blocking the sale).
  return "WEB-" + Math.floor(1000 + Math.random() * 9000);
}

// Accepts BOTH the new WEB-#### form and the legacy WEB-<8digit date>-#### form (so old orders,
// links, and the status sync keep working).
export const ORDER_NO_RE = /^WEB-(?:[0-9]{8}-)?[0-9]{3,6}$/;
