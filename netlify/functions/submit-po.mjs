// 3DPX — Order by PO (invoice, no card). Creates a "Pre Sale" row in SLS Jobs flagged UNPAID,
// then attaches the uploaded STL(s) + optional PO document. No Stripe involved.
// Env: SMARTSHEET_TOKEN (required), SMARTSHEET_SHEET_ID (optional; defaults to SLS Jobs).
// Pricing is recomputed here (same model as create-checkout.mjs) for the quoted amount on record.

const SLS_JOBS_SHEET = "7474902212077444";
const COL = {
  orderStatus: 3699329920722820,
  poNumber:    2573430013880196,
  company:     1447530107037572,
  contact:     2432692525524868,
  price:       3704368460523396,
  volume:      2010480060458884,
  totalParts:  8202929548093316,
  color:       6514079687829380,
  dye:         4262279874144132,
  vapor:       5201233072940932,
  shipAddr:    347271731564420,
  poType:      8601217236946820,
  notes:       438442912337796,
  dueDate:     5951129734408068,
};

// ---- pricing (keep in sync with create-checkout.mjs) ----
const RULES = { volRate0:0.65, volRate100:0.55, bboxRate0:0.04, bboxRate100:0.03,
  bbVolThresh:3375, bbMult0:1.10, bbMult100:0.70, shellPrice:3, minPrice:0,
  orderMin:40, marketAdj:0.90,
  density:0.95,
  packBaseLb:0.6, packPerPartLb:0.05, packFactor:2.0, dimDivisor:139,
  shipRegionMult:{us:1.0, camx:1.6, intl:2.5},
  zoneStep:0.09, zoneMultMin:0.80, zoneMultMax:1.35,
  matCertFee:100 };
const ZIP_ZONE = {'0':5,'1':5,'2':5,'3':4,'4':3,'5':4,'6':2,'7':5,'8':6,'9':7};
function zoneMult(zip, region) {
  if (region && region !== "us") return 1;
  const d = (String(zip||"").match(/\d/)||[])[0];
  const zone = ZIP_ZONE[d] || 4;
  const m = Math.max(RULES.zoneMultMin, Math.min(RULES.zoneMultMax, 1 + (zone-4)*RULES.zoneStep));
  return Math.round(m*1000)/1000;
}
const FINISH = { dyePct:5, vsPct:30, vsMin:15 };
const SHIP_SPEEDS = {
  ground:    { label:"Ground shipping", base:12.5, perLb:1.15, min:12.5 },
  expedited: { label:"Expedited",       base:26,   perLb:2.60, min:26 },
  overnight: { label:"Overnight",       base:52,   perLb:5.25, min:52 },
  account:   { label:"Your carrier account", free:true },
  pickup:    { label:"Pickup at 3DPX",  free:true },
};
function shipWeightLb(parts) {
  let actualG=0, boxCC=0; const np=parts.length;
  for (const p of parts) { const q=Math.max(1,parseInt(p.qty)||1);
    actualG += (p.vol||0)*q*RULES.density;
    boxCC   += ((p.x*p.y*p.z)/1000)*q;
  }
  const actualLb=actualG/1000*2.20462;
  const packLb=RULES.packBaseLb+RULES.packPerPartLb*np;
  const dimLb=(boxCC*RULES.packFactor/16.387)/RULES.dimDivisor;
  return Math.max(actualLb+packLb, dimLb);
}
const QTY_BREAKS = [{q:1,d:0},{q:2,d:5},{q:10,d:12},{q:50,d:18},{q:100,d:25},{q:250,d:32},{q:500,d:38},{q:1000,d:45}];
const VALUE_BREAKS = [{v:200,d:5},{v:2000,d:10}];
const qd = q => { let d=0; for (const t of QTY_BREAKS) if (q>=t.q) d=t.d; return d; };
const vd = v => { let d=0; for (const t of VALUE_BREAKS) if (v>=t.v) d=t.d; return d; };
function unitPrice(p) {
  const bbox = (p.x*p.y*p.z)/1000;
  const density = bbox>0 ? Math.min(p.vol/bbox,1) : 0;
  const volRate  = RULES.volRate100  + (1-density)*(RULES.volRate0  - RULES.volRate100);
  const bboxRate = RULES.bboxRate100 + (1-density)*(RULES.bboxRate0 - RULES.bboxRate100);
  const bbMult = bbox>RULES.bbVolThresh ? RULES.bbMult100
    : RULES.bbMult100 + (RULES.bbVolThresh-bbox)/RULES.bbVolThresh*(RULES.bbMult0-RULES.bbMult100);
  let u = (volRate*p.vol + bboxRate*bbox)*bbMult + RULES.shellPrice*(p.shells||1);
  u = Math.max(u, RULES.minPrice);
  u *= RULES.marketAdj;
  const base = u;
  if (p.dye) u += base*FINISH.dyePct/100;
  if (p.vs)  u += Math.max(base*FINISH.vsPct/100, FINISH.vsMin);
  return u;
}
function orderTotal(parts, region, matCert, speed, zip, addl) {
  let gross=0, postQty=0;
  for (const p of parts) {
    const q = Math.max(1, parseInt(p.qty)||1);
    const u = unitPrice(p);
    gross += u*q; postQty += u*(1-qd(q)/100)*q;
  }
  const vp = vd(gross);
  const after = (postQty - postQty*vp/100) * (1 - Math.max(0, Math.min(100, addl||0))/100);
  const topUp = Math.max(0, RULES.orderMin - after);
  const sp = SHIP_SPEEDS[speed] ? speed : "ground";
  let shipping = 0;
  if (!(sp==="pickup" || SHIP_SPEEDS[sp].free)) {
    const rm = RULES.shipRegionMult[region] || 1, s = SHIP_SPEEDS[sp];
    shipping = Math.round(Math.max(s.min, s.base + s.perLb*shipWeightLb(parts))*rm*zoneMult(zip, region)*100)/100;
  }
  const cert = matCert ? RULES.matCertFee : 0;
  return Math.round((after + topUp + shipping + cert)*100)/100;
}
function leadDaysCalc(parts) {
  let tv = 0; for (const p of parts) tv += (p.vol||0)*Math.max(1, parseInt(p.qty)||1);
  let base = tv < 3000 ? 3 : Math.ceil(tv/4500 + 3);
  let fin = 0; for (const p of parts) { const ff = (p.dye?1:0)+(p.vs?1:0); if (ff>fin) fin=ff; }
  return base + fin;
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  const parts = Array.isArray(body.parts) ? body.parts : [];
  if (!parts.length) return json({ error: "No parts in order." }, 400);
  const po = (body.po || "").toString().trim();
  if (!po) return json({ error: "A PO number is required." }, 400);

  const token = process.env.SMARTSHEET_TOKEN;
  if (!token) return json({ error: "PO ordering isn't enabled yet." }, 503);
  const sheetId = process.env.SMARTSHEET_SHEET_ID || SLS_JOBS_SHEET;

  const speed = SHIP_SPEEDS[body.shipSpeed] ? body.shipSpeed : "ground";
  let addlDisc = Math.max(0, +body.addlDisc || 0);
  if (body.quoteId && /^Q-[A-Za-z0-9]{4,12}$/.test(body.quoteId)) {
    try { const { getStore } = await import("@netlify/blobs"); const q = await getStore("orders").get("Q-QUOTES/" + body.quoteId + ".json", { type: "json" }); if (q && typeof q.addlDisc === "number") addlDisc = Math.max(0, q.addlDisc); } catch (e) {}
  }
  const price = orderTotal(parts, body.region, !!body.matCert, speed, body.zip, addlDisc);
  const totalParts = parts.reduce((s,p)=>s+(Math.max(1,parseInt(p.qty)||1)),0);
  const totalVol   = Math.round(parts.reduce((s,p)=>s+(p.vol||0)*(Math.max(1,parseInt(p.qty)||1)),0)*100)/100;
  const dyeAny   = parts.some(p=>p.dye);
  const vaporAny = parts.some(p=>p.vs);

  const CLR = { natural:"White", black:"Black", blue:"Blue", green:"Green", red:"Red", yellow:"Yellow" };
  const colorVals = [...new Set(parts.map(p => (p.dye && CLR[p.color]) ? CLR[p.color] : "White"))];

  const summary = parts.map(p => (p.qty + "x " + p.name + " " + p.x + "x" + p.y + "x" + p.z + "mm" + (p.vs?" +vapor":"") + (p.dye?(" +"+(p.color||"dye")):""))).join("; ");
  const acctInfo = (speed==="account") ? (" — " + (body.carrier||"carrier") + " acct " + (body.shipAccount||"(not provided)")) : "";
  const shipMethod = SHIP_SPEEDS[speed].label + (speed==="pickup" ? " (free)" : "") + acctInfo;
  // Keep the WEB- order number as the identifier (like card web orders), tagged with the customer PO.
  const webNo = (body.orderNo && /^WEB-[0-9]{8}-[0-9]{3,5}$/.test(body.orderNo)) ? body.orderNo
    : ("WEB-" + new Date().toISOString().slice(0,10).replace(/-/g,"") + "-" + Math.floor(1000+Math.random()*9000));
  const orderIdent = webNo + " (PO " + po + ")";
  const notes = ("*** WEB PO / INVOICE ORDER — UNPAID — verify credit & confirm price before production *** | Customer PO: "
    + po + " | " + summary + " | " + shipMethod + (body.matCert?" | Material cert":"")).slice(0, 495);

  const contactVal = (body.name || "") + (body.email ? " <" + body.email + ">" : "");
  const due = addBusinessDays(new Date(), leadDaysCalc(parts)).toISOString().slice(0,10);

  const cells = [
    { columnId: COL.orderStatus, value: "Pre Sale", strict: false },
    { columnId: COL.poNumber,    value: orderIdent },
    { columnId: COL.company,     value: body.company || body.name || "Web PO Order", strict: false },
    { columnId: COL.contact,     value: contactVal || "Web PO Order", strict: false },
    { columnId: COL.price,       value: price },
    { columnId: COL.volume,      value: totalVol },
    { columnId: COL.totalParts,  value: totalParts },
    { columnId: COL.dueDate,     value: due },
    { columnId: COL.color,       objectValue: { objectType: "MULTI_PICKLIST", values: colorVals }, strict: false },
    { columnId: COL.dye,         value: dyeAny },
    { columnId: COL.vapor,       value: vaporAny },
    { columnId: COL.shipAddr,    value: body.shipAddress || "" },
    { columnId: COL.poType,      value: "Standard", strict: false },
    { columnId: COL.notes,       value: notes },
  ];

  const r = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "/rows", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify([{ toBottom: true, cells }]),
  });
  const rowResp = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.log("PO row create failed:", r.status, JSON.stringify(rowResp));
    return json({ error: "Couldn't record your PO. Please email your quote + PO to sales@3dpx.com." }, 502);
  }
  const rowId = rowResp.result && rowResp.result[0] && rowResp.result[0].id;

  // Attach uploaded STL(s) + PO doc (best-effort).
  if (rowId && body.orderNo) {
    try {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore("orders");
      const listing = await store.list({ prefix: body.orderNo + "/" });
      for (const b of (listing.blobs || [])) {
        try {
          const bytes = await store.get(b.key, { type: "arrayBuffer" });
          if (!bytes) continue;
          const meta = await store.getMetadata(b.key).catch(() => null);
          const fname = (meta && meta.metadata && meta.metadata.name) || b.key.split("__").pop() || "file";
          const fd = new FormData();
          fd.append("file", new Blob([bytes], { type: "application/octet-stream" }), fname);
          const ar = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "/rows/" + rowId + "/attachments", {
            method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
          if (ar.ok) await store.delete(b.key); else console.log("PO attach failed:", ar.status, await ar.text());
        } catch (e2) { console.log("PO attach item failed:", e2.message); }
      }
    } catch (e) { console.log("PO attach step failed:", e.message); }
  }

  return json({ ok: true, order: po });
};

function addBusinessDays(d, n) {
  const r = new Date(d); let added = 0;
  while (added < n) { r.setDate(r.getDate()+1); const day = r.getDay(); if (day!==0 && day!==6) added++; }
  return r;
}
function json(obj, status=200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
