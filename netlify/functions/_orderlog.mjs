// 3DPX — shared helper: log EVERY order (card, PO, approved, recovered; web or internal) to the
// "SLS Web Orders Log" sheet. This is a capture-all record, separate from SLS Jobs. No-op if
// SMARTSHEET_TOKEN is missing. Sheet id overridable via ORDERS_LOG_SHEET_ID env.

const LOG_SHEET = "5963104906071940";
const C = {
  order:   7031647501586308,
  type:    1402147967373188,
  source:  5905747594743684,
  company: 3653947781058436,
  contact: 8157547408428932,
  email:   839198013951876,
  phone:   5342797641322372,
  amount:  3090997827637124,
  tax:     7594597455007620,
  pieces:  1965097920794500,
  volume:  6468697548164996,
  colors:  4216897734479748,
  delivery:8720497361850244,
  payment: 557723037241220,
  po:      5061322664611716,
  quoteId: 2809522850926468,
  shipTo:  7313122478296964,
  notes:   1683622944083844,
  logged:  6187222571454340,
  invoiceDue: 5758808207167364,
};

export async function logOrder(o) {
  const token = process.env.SMARTSHEET_TOKEN;
  if (!token) return false;
  const sheetId = process.env.ORDERS_LOG_SHEET_ID || LOG_SHEET;
  const cell = (id, v) => ({ columnId: id, value: v == null ? "" : v, strict: false });
  const cells = [
    cell(C.order, o.orderNo),
    cell(C.type, o.type),
    cell(C.source, o.source),
    cell(C.company, o.company),
    cell(C.contact, o.contact),
    cell(C.email, o.email),
    cell(C.phone, o.phone),
    cell(C.amount, o.amount != null && o.amount !== "" ? ("$" + Number(o.amount).toFixed(2)) : ""),
    cell(C.tax, o.tax ? ("$" + Number(o.tax).toFixed(2)) : ""),
    cell(C.pieces, o.pieces),
    cell(C.volume, o.volume),
    cell(C.colors, o.colors),
    cell(C.delivery, o.delivery),
    cell(C.payment, o.payment),
    cell(C.po, o.po),
    cell(C.quoteId, o.quoteId),
    cell(C.shipTo, o.shipTo),
    cell(C.notes, o.notes),
    cell(C.invoiceDue, o.invoiceDue),
    cell(C.logged, new Date().toISOString().slice(0, 10)),
  ].filter(c => c.value !== "" && c.value != null);
  try {
    const r = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "/rows", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify([{ toTop: true, cells }]),
    });
    if (!r.ok) { console.log("orderlog failed:", r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.log("orderlog error:", e.message); return false; }
}
