// 3DPX — shared logic: mirror each web order's real SLS production status onto the
// "SLS Web Orders Log" sheet, run hourly by cron-sync-status.mjs. Deterministic (no LLM).
//
// An order's real status is, in priority order:
//   1) its live "Order Status" in the SLS Jobs sheet (Pre Sale / Production / Ready / etc.), else
//   2) "Complete" if its WEB number is found in the "SLS Jobs Complete 6 Months" sheet
//      (finished jobs MOVE there and disappear from the live sheet — this is the step the old
//      version was missing, which is why completed orders were wrongly stamped "Not in SLS Jobs"), else
//   3) "Not in SLS Jobs" — genuinely not in production anywhere (e.g. approved but no job created yet).
//
// SAFETY (never wipe a good status again):
//   - Match on the extracted WEB order number, so the PO-prefixed "PO 2213 · WEB-1001" log format and
//     the "WEB-1001 (APPROVED)" jobs format line up.
//   - If the Complete-sheet read fails or returns too few matches, we DO NOT write "Not in SLS Jobs"
//     for anything this run (a broken scan can't cause a mass downgrade — it just skips step 3).
//   - Never overwrite an existing Complete / in-production status with "Not in SLS Jobs".
// No-op without SMARTSHEET_TOKEN.

const SLS_JOBS = "7474902212077444";
const LOG      = "5963104906071940";
const COMPLETE = "253549607866244";          // SLS Jobs Complete 6 Months
const SJ_ORDERNO = 2573430013880196;         // SLS Jobs: PO or Order Number
const SJ_STATUS  = 3699329920722820;         // SLS Jobs: Order Status
const CMP_PRIMARY = 8712114298113924;        // Complete sheet: primary (order name) column
const LG_ORDERNO = 7031647501586308;         // Log: Order #
const LG_STATUS  = 682718967140228;          // Log: SLS Jobs Status

const WEB_RE = /WEB-(?:\d{8}-)?\d{3,6}/i;
const webOf = s => { const m = String(s || "").toUpperCase().match(WEB_RE); return m ? m[0] : ""; };
// Statuses that must never be downgraded to "Not in SLS Jobs".
const PROTECTED = new Set(["Complete","Production","Ready","Waiting For Pickup","Outsourced Post Production","In House Secondary Process","QA Issue HOLD","Design"]);

export async function syncStatus() {
  const token = process.env.SMARTSHEET_TOKEN;
  if (!token) return { error: "SMARTSHEET_TOKEN not set" };
  const H = { Authorization: "Bearer " + token };
  const cellVal = (row, id) => { const c = (row.cells || []).find(x => x.columnId === id); return c && c.value != null ? String(c.value) : ""; };

  // 1) LIVE map: WEB number -> Order Status (prefer a non-Complete/Cancelled row on duplicates).
  const sjResp = await fetch("https://api.smartsheet.com/2.0/sheets/" + SLS_JOBS + "?columnIds=" + SJ_ORDERNO + "," + SJ_STATUS, { headers: H });
  if (!sjResp.ok) return { error: "SLS Jobs read failed: " + sjResp.status };
  const sj = await sjResp.json();
  const live = new Map();
  for (const r of (sj.rows || [])) {
    const web = webOf(cellVal(r, SJ_ORDERNO)); if (!web) continue;
    const st = cellVal(r, SJ_STATUS); if (!st) continue;
    const prev = live.get(web);
    if (!prev || prev === "Complete" || prev === "Cancelled") live.set(web, st);
  }

  // 2) COMPLETED set from the Complete 6-Month sheet. If this read is unhealthy, mark completedOk=false
  //    so we skip step 3 entirely (no "Not in SLS Jobs" writes) — a bad scan must never wipe.
  const completed = new Set();
  let completedOk = false;
  try {
    const cResp = await fetch("https://api.smartsheet.com/2.0/sheets/" + COMPLETE + "?columnIds=" + CMP_PRIMARY, { headers: H });
    if (cResp.ok) {
      const c = await cResp.json();
      for (const r of (c.rows || [])) { const web = webOf(cellVal(r, CMP_PRIMARY)); if (web) completed.add(web); }
      completedOk = (c.rows || []).length >= 1000 && completed.size >= 20;   // healthy scan of the ~6000-row sheet
    }
  } catch (e) { /* completedOk stays false */ }

  // 3) Log rows: compute desired status and collect only real changes.
  const lgResp = await fetch("https://api.smartsheet.com/2.0/sheets/" + LOG + "?columnIds=" + LG_ORDERNO + "," + LG_STATUS, { headers: H });
  if (!lgResp.ok) return { error: "Log read failed: " + lgResp.status };
  const lg = await lgResp.json();

  const updates = [];
  for (const r of (lg.rows || [])) {
    const web = webOf(cellVal(r, LG_ORDERNO)); if (!web) continue;
    const cur = cellVal(r, LG_STATUS);
    let desired;
    if (live.has(web)) desired = live.get(web);
    else if (completed.has(web)) desired = "Complete";
    else if (completedOk) desired = "Not in SLS Jobs";
    else continue;                                  // unknown + can't trust the completed scan → leave as-is
    if (desired === "Not in SLS Jobs" && PROTECTED.has(cur)) continue;   // never downgrade a good status
    if (desired !== cur) updates.push({ id: r.id, cells: [{ columnId: LG_STATUS, value: desired }] });
  }

  // 4) Write (batches of 400).
  let updated = 0;
  for (let i = 0; i < updates.length; i += 400) {
    const chunk = updates.slice(i, i + 400);
    const rr = await fetch("https://api.smartsheet.com/2.0/sheets/" + LOG + "/rows", {
      method: "PUT", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify(chunk),
    });
    if (rr.ok) updated += chunk.length;
    else console.log("status sync update failed:", rr.status, await rr.text());
  }
  return { live: live.size, completed: completed.size, completedOk, logRows: (lg.rows || []).length, updated };
}
