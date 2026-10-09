// 3DPX — customer portal accounts (private-link login).
//
// Each account is reached by a readable private link:
//     https://3dpx-quote.netlify.app/account/<company>/<code>      e.g. /account/wildfactory/ABCD-EFGH
// The page turns that into the token "<company>-<CODE>" (company lower-case, code upper-case). The
// 8-character code is the lock — the company name alone is guessable, so it must never be the only part.
// Only the SHA-256 HASH of each token lives here, never the token itself — so this file can sit in
// the GitHub repo without anyone who reads it being able to open an account.
//
// An account sees every order and quote whose customer email is on one of its domains.
//
// Company slug: letters and digits only (no hyphens).
// To add a customer:  pick an 8-char code (letters/digits, no 0/O/1/I/L), token = "<company>-<XXXX-XXXX>",
//                     sha256 it, add an entry below, push, send them /account/<company>/<XXXX-XXXX>.
// To revoke a link:   delete (or replace) its entry and push. The old link stops working immediately.
import crypto from "node:crypto";

const ACCOUNTS = {
  // Wildfactory — pilot account, created 2026-10-08
  "d88d21f2fa49728fdff9ae9a385210dbb7acc864c7ae5bb4679e88fd6579f1d5": { company: "Wildfactory", domains: ["wildfactory.com"] },
};

export function findAccount(token) {
  const t = String(token || "");
  if (t.length < 12 || t.length > 100) return null;
  const h = crypto.createHash("sha256").update(t).digest("hex");
  return ACCOUNTS[h] || null;
}

export function emailInAccount(email, acct) {
  const d = (String(email || "").trim().toLowerCase().split("@")[1] || "").replace(/[^a-z0-9.\-]/g, "");
  return !!d && !!acct && acct.domains.includes(d);
}

// Files a customer may see/download from an order. Part files, drawings, the quote and the packing
// slip only — never the internal traveler, inventory list or accounting sheet, and not arbitrary
// uploads (POs etc.) whose contents we can't vouch for.
export function customerVisibleFile(name) {
  const n = String(name || "").toLowerCase();
  if (/\.(stl|stp|step)$/.test(n)) return "part";
  if (n.startsWith("drawing-")) return "drawing";
  if (n.startsWith("packing-slip-") && n.endsWith(".pdf")) return "doc";
  if (n.startsWith("quote-") && n.endsWith(".pdf")) return "doc";
  return null;
}

export function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
