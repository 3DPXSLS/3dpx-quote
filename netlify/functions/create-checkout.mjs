// 3DPX — create a Stripe Checkout session for an SLS order.
// Dependency-free: uses fetch + the Stripe REST API (no npm install needed).
// Env var required: STRIPE_SECRET_KEY (Netlify -> Site settings -> Environment variables).
// The price is recomputed HERE from the part specs + options (never trust the browser).
// All order details go into Stripe metadata so the webhook can create the Smartsheet row.

const RULES = { volRate0:0.65, volRate100:0.55, bboxRate0:0.04, bboxRate100:0.03,
  bbVolThresh:3375, bbMult0:1.10, bbMult100:0.70, shellPrice:3, minPrice:0,
  orderMin:40, marketAdj:0.90,
  density:0.95,
  // Shipping = billable-weight model (keep in sync with the widget):
  packBaseLb:0.6, packPerPartLb:0.05, packFactor:2.0, dimDivisor:139,
  shipRegionMult:{us:1.0, camx:1.6, intl:2.5},
  zoneStep:0.09, zoneMultMin:0.80, zoneMultMax:1.35,
  matCertFee:100 };
// Dest ZIP first digit -> rough ground zone from Chicago (606). Keep in sync with the widget.
const ZIP_ZONE = {'0':5,'1':5,'2':5,'3':4,'4':3,'5':4,'6':2,'7':5,'8':6,'9':7};
function zoneMult(zip, region) {
  if (region && region !== "us") return 1;
  const d = (String(zip||"").match(/\d/)||[])[0];
  const zone = ZIP_ZONE[d] || 4;
  const m = Math.max(RULES.zoneMultMin, Math.min(RULES.zoneMultMax, 1 + (zone-4)*RULES.zoneStep));
  return Math.round(m*1000)/1000;
}
const FINISH = { dyePct:5, vsPct:30, vsMin:15 };
// Delivery speeds — realistic carrier rates: max(min, base + perLb × billable lb) × region. Pickup is free.
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
  // p.ov (rep per-unit override) → fixed line, excluded from all discounts.
  let discGross=0, postQty=0, fixedTot=0, hasNormal=false;
  for (const p of parts) {
    const q = Math.max(1, parseInt(p.qty)||1);
    const ov = (+p.ov>0) ? +p.ov : 0;
    if (ov>0) { fixedTot += ov*q; }
    else { const u = unitPrice(p); discGross += u*q; postQty += u*(1-qd(q)/100)*q; hasNormal=true; }
  }
  const vp = vd(discGross);
  let after = (postQty - postQty*vp/100);
  if (hasNormal) after = after * (1 - Math.max(0, Math.min(100, addl||0))/100);
  after += fixedTot;
  const topUp = Math.max(0, RULES.orderMin - after);
  const sp = SHIP_SPEEDS[speed] ? speed : "ground";
  let shipping = 0;
  if (!(sp==="pickup" || SHIP_SPEEDS[sp].free)) {
    const rm = RULES.shipRegionMult[region] || 1, s = SHIP_SPEEDS[sp];
    shipping = Math.round(Math.max(s.min, s.base + s.perLb*shipWeightLb(parts))*rm*zoneMult(zip, region)*100)/100;
  }
  const cert = matCert ? RULES.matCertFee : 0;
  return after + topUp + shipping + cert;
}

function leadDaysCalc(parts) {
  let tv = 0; for (const p of parts) tv += (p.vol||0)*Math.max(1, parseInt(p.qty)||1);
  let base = tv < 3000 ? 3 : Math.ceil(tv/4500 + 3);
  let fin = 0; for (const p of parts) { const ff = (p.dye?1:0)+(p.vs?1:0); if (ff>fin) fin=ff; }
  return base + fin;
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return json({ error: "Online payment isn't enabled yet." }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const parts = Array.isArray(body.parts) ? body.parts : [];
  if (!parts.length) return json({ error: "No parts in order." }, 400);

  const speed = SHIP_SPEEDS[body.shipSpeed] ? body.shipSpeed : "ground";
  // Additional discount + per-item price overrides: authoritative values come from the saved quote (rep-set).
  for (const p of parts) { if (p.ov != null) delete p.ov; }  // never trust a client-supplied override
  let addlDisc = Math.max(0, +body.addlDisc || 0);
  if (body.quoteId && /^Q-[A-Za-z0-9]{4,12}$/.test(body.quoteId)) {
    try {
      const { getStore } = await import("@netlify/blobs");
      const q = await getStore("orders").get("Q-QUOTES/" + body.quoteId + ".json", { type: "json" });
      if (q && typeof q.addlDisc === "number") addlDisc = Math.max(0, q.addlDisc);
      if (q && Array.isArray(q.parts)) q.parts.forEach((qp, i) => { if (parts[i] && qp && +qp.override > 0) parts[i].ov = +qp.override; });
    } catch (e) { /* keep fallback */ }
  }
  const amount = Math.round(orderTotal(parts, body.region, !!body.matCert, speed, body.zip, addlDisc) * 100);
  if (amount < 50) return json({ error: "Order total too low." }, 400);

  const totalParts = parts.reduce((s,p)=>s+(Math.max(1,parseInt(p.qty)||1)),0);
  const totalVol   = Math.round(parts.reduce((s,p)=>s+(p.vol||0)*(Math.max(1,parseInt(p.qty)||1)),0)*100)/100;
  const dyeAny   = parts.some(p=>p.dye);
  const vaporAny = parts.some(p=>p.vs);
  // Color(s) for the Smartsheet MULTI_PICKLIST (valid options: White/Black/Blue/Yellow/Red/Green). "|"-joined.
  const CLR = { natural:"White", black:"Black", blue:"Blue", green:"Green", red:"Red", yellow:"Yellow" };
  const colorList = [...new Set(parts.map(p => (p.dye && CLR[p.color]) ? CLR[p.color] : "White"))].join("|");
  const summary = parts.map(p => (p.qty + "x " + p.name + " " + p.x + "x" + p.y + "x" + p.z + "mm" + (p.vs?" +vapor":"") + (p.dye?(" +"+(p.color||"dye")):""))).join("; ").slice(0, 460);
  const orderNo = (body.orderNo && /^WEB-[0-9]{8}-[0-9]{3,5}$/.test(body.orderNo)) ? body.orderNo
    : ("WEB-" + new Date().toISOString().slice(0,10).replace(/-/g,"") + "-" + Math.floor(1000+Math.random()*9000));
  const acctInfo = (speed==="account") ? (" — " + ((body.carrier||"carrier") + " acct " + (body.shipAccount||"(not provided)")).slice(0,80)) : "";
  const shipMethodLabel = SHIP_SPEEDS[speed].label + (speed==="pickup" ? " (free)" : "") + acctInfo;
  const notes = (summary + " | " + shipMethodLabel + (body.matCert?" | Material cert":"") + " | Paid via Stripe").slice(0, 495);

  let ret = (body.returnUrl && /^https?:\/\//.test(body.returnUrl)) ? body.returnUrl : (req.headers.get("origin") || "");
  const sep = ret.includes("?") ? "&" : "?";

  const f = new URLSearchParams();
  f.append("mode", "payment");
  const origin = req.headers.get("origin") || (ret ? new URL(ret).origin : "");
  f.append("success_url", (origin || ret) + "/thankyou.html?order=" + encodeURIComponent(orderNo));
  if (ret) f.append("cancel_url", ret + sep + "canceled=1"); else if (origin) f.append("cancel_url", origin + "/?canceled=1");
  // Sales tax: Stripe Tax computes the rate from the customer's address and only charges where
  // you've added a tax registration (e.g. Illinois). Requires Stripe Tax to be activated in the
  // dashboard (Settings -> Tax) with your origin address + an Illinois registration. Per-mode (test/live).
  f.append("automatic_tax[enabled]", "true");
  f.append("billing_address_collection", "required");  // gives Stripe the address it needs for tax
  f.append("line_items[0][price_data][currency]", "usd");
  f.append("line_items[0][price_data][product_data][name]", "3DPX SLS order - Nylon 12 (PA12)");
  f.append("line_items[0][price_data][product_data][description]", summary || "SLS parts");
  f.append("line_items[0][price_data][product_data][tax_code]", "txcd_99999999");  // general tangible goods
  f.append("line_items[0][price_data][tax_behavior]", "exclusive");  // tax added on top of the amount
  f.append("line_items[0][price_data][unit_amount]", String(amount));
  f.append("line_items[0][quantity]", "1");
  f.append("metadata[order_no]", orderNo);
  f.append("metadata[customer_name]", (body.name||"").slice(0,200));
  f.append("metadata[company]", (body.company||"").slice(0,200));
  f.append("metadata[customer_email]", (body.email||"").slice(0,200));
  f.append("metadata[customer_phone]", (body.phone||"").slice(0,60));
  f.append("metadata[region]", (body.region||"us"));
  f.append("metadata[source]", (body.source === "internal" ? "internal" : "web"));
  if (body.quoteId) f.append("metadata[quote_id]", String(body.quoteId).slice(0,20));
  f.append("metadata[ship_speed]", speed);
  f.append("metadata[ship_method]", shipMethodLabel.slice(0,200));
  if (speed === "account") {
    f.append("metadata[ship_carrier]", (body.carrier||"").slice(0,60));
    f.append("metadata[ship_account]", (body.shipAccount||"").slice(0,80));
  }
  f.append("metadata[material_cert]", body.matCert ? "yes" : "no");
  f.append("metadata[total_parts]", String(totalParts));
  f.append("metadata[total_vol]", String(totalVol));
  f.append("metadata[lead_days]", String(leadDaysCalc(parts)));
  f.append("metadata[dye_any]", dyeAny ? "yes" : "no");
  f.append("metadata[vapor_any]", vaporAny ? "yes" : "no");
  f.append("metadata[color]", colorList || "White");
  f.append("metadata[shipping_address]", (body.shipAddress||"").slice(0,480));
  f.append("metadata[notes]", notes);
  if (body.email) f.append("customer_email", body.email);

  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/x-www-form-urlencoded" },
    body: f,
  });
  const data = await r.json();
  if (!r.ok) return json({ error: (data.error && data.error.message) || "Stripe error" }, 500);
  return json({ url: data.url });
};

function json(obj, status=200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
