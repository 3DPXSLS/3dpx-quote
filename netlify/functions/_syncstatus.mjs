// 3DPX — shared logic: mirror each web order's live SLS Jobs "Order Status" into the
// "SLS Web Orders Log" sheet. Matches the log's Order # inside the SLS Jobs "PO or Order Number"
// cell (so it works for card WEB-… and PO/approved "WEB-… (PO x)"). Orders not present in
// SLS Jobs (deleted / never created) are marked "Not in SLS Jobs". No-op without SMARTSHEET_TOKEN.

const SLS_JOBS = "7474902212077444";
const LOG      = "5963104906071940";
const SJ_ORDERNO = 2573430013880196;   // SLS Jobs: PO or Order Number
const SJ_STATUS  = 3699329920722820;   // SLS Jobs: Order Status
const LG_ORDERNO = 7031647501586308;   // Log: Order #
const LG_STATUS  = 682718967140228;    // Log: SLS Jobs Status

export async function syncStatus() {
  const token = process.env.SMARTSHEET_TOKEN;
  if (!token) return { error: "SMARTSHEET_TOKEN not set" };
  const H = { Authorization: "Bearer " + token };

  const cellVal = (row, id) => {
    const c = (row.cells || []).find(x => x.columnId === id);
    return c && c.value != null ? String(c.value) : "";
  };

  // 1) SLS Jobs: order number + status (only those two columns).
  const sjResp = await fetch("https://api.smartsheet.com/2.0/sheets/" + SLS_JOBS + "?columnIds=" + SJ_ORDERNO + "," + SJ_STATUS, { headers: H });
  if (!sjResp.ok) return { error: "SLS Jobs read failed: " + sjResp.status };
  const sj = await sjResp.json();
  const jobs = (sj.rows || [])
    .map(r => ({ ord: cellVal(r, SJ_ORDERNO), st: cellVal(r, SJ_STATUS) }))
    .filter(j => j.ord);

  // 2) Log rows: order number + current status.
  const lgResp = await fetch("https://api.smartsheet.com/2.0/sheets/" + LOG + "?columnIds=" + LG_ORDERNO + "," + LG_STATUS, { headers: H });
  if (!lgResp.ok) return { error: "Log read failed: " + lgResp.status };
  const lg = await lgResp.json();

  // 3) Build updates (only where the status changed).
  const updates = [];
  for (const r of (lg.rows || [])) {
    const ord = cellVal(r, LG_ORDERNO);
    if (!ord) continue;
    const match = jobs.find(j => j.ord.includes(ord));
    const status = match ? match.st : "Not in SLS Jobs";
    if (cellVal(r, LG_STATUS) !== status) updates.push({ id: r.id, cells: [{ columnId: LG_STATUS, value: status }] });
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
  return { jobs: jobs.length, logRows: (lg.rows || []).length, updated };
}
