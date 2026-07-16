// 3DPX — map our order shipping method → SLS Jobs "Ship Via" + "Shipping Speed" picklist cells.
// Our speeds: ground | expedited | overnight | account (customer carrier) | pickup.
// Ship Via options:  FedEx | Customer Provided | Pick-up | 3DPX Internal | Additional Post Processing
// Shipping Speed opts: Next Day 8:30 | Next Day 10:30 | 2 Day | Ground
const COL_SHIP_VIA   = 4684492339210116;
const COL_SHIP_SPEED = 7851220025010052;

export function shipCells(speed) {
  let via = "", spd = "";
  if (speed === "pickup")       { via = "Pick-up"; }
  else if (speed === "account") { via = "Customer Provided"; }
  else {                          via = "FedEx";
    spd = speed === "overnight" ? "Next Day 10:30" : speed === "expedited" ? "2 Day" : "Ground";
  }
  const cells = [];
  if (via) cells.push({ columnId: COL_SHIP_VIA,   value: via, strict: false });
  if (spd) cells.push({ columnId: COL_SHIP_SPEED, value: spd, strict: false });
  return cells;
}
