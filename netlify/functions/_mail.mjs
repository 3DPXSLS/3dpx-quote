// 3DPX — one place that actually sends email, for every message the quote tool sends.
//
// PREFERRED: Microsoft 365 (Graph API). Mail goes out from a real 3DPX mailbox (e.g. sales@3dpx.com),
// lands in that mailbox's Sent Items, and customer replies arrive in Outlook like any other email.
// Needs these Netlify environment variables (from the Entra ID app registration — see EMAIL-SETUP.md):
//   MS_TENANT_ID       Directory (tenant) ID
//   MS_CLIENT_ID       Application (client) ID
//   MS_CLIENT_SECRET   client secret VALUE
// Two ways to be authorised (the first one available is used):
//   1. "Signed in once" (delegated) — someone opens ms-connect?k=<staff code> and signs in as the
//      sending mailbox; the refresh token is kept in Blobs (MSAUTH/token.json). No Global Admin needed.
//   2. App-only (application Mail.Send, needs Global Admin consent) — sends as MAIL_SENDER.
import { getStore } from "@netlify/blobs";
export const DELEGATED_SCOPES = "offline_access openid profile User.Read Mail.Send";
export const TOKEN_KEY = "MSAUTH/token.json";
//
// FALLBACK: Resend (RESEND_API_KEY + ORDER_ALERT_FROM) — only used if the Microsoft variables aren't set.
// Every send is best-effort: it returns true/false and never throws, so email can't break an order.

let _token = null;   // cached app-only Graph token (reused while this function instance is warm)
let _dtoken = null;  // cached delegated access token

export function mailVia() {
  const e = process.env;
  if (e.MS_TENANT_ID && e.MS_CLIENT_ID && e.MS_CLIENT_SECRET) return "microsoft";
  if (e.RESEND_API_KEY) return "resend";
  return "";
}

async function graphToken() {
  if (_token && _token.exp > Date.now() + 60000) return _token.v;
  const e = process.env;
  const r = await fetch("https://login.microsoftonline.com/" + encodeURIComponent(e.MS_TENANT_ID) + "/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: e.MS_CLIENT_ID, client_secret: e.MS_CLIENT_SECRET,
      grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error("Microsoft sign-in failed: " + (d.error_description || d.error || r.status));
  _token = { v: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return _token.v;
}

// Delegated ("signed in once") access token, refreshed from the stored refresh token. Microsoft rotates
// refresh tokens, so the new one is saved each time. Returns null if nobody has connected yet.
export async function delegatedToken(force = false) {
  if (!force && _dtoken && _dtoken.exp > Date.now() + 60000) return _dtoken;
  const store = getStore("orders");
  const saved = await store.get(TOKEN_KEY, { type: "json" }).catch(() => null);
  if (!saved || !saved.refresh_token) return null;
  const e = process.env;
  const r = await fetch("https://login.microsoftonline.com/" + encodeURIComponent(e.MS_TENANT_ID) + "/oauth2/v2.0/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: e.MS_CLIENT_ID, client_secret: e.MS_CLIENT_SECRET, grant_type: "refresh_token",
      refresh_token: saved.refresh_token, scope: DELEGATED_SCOPES }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) {
    console.log("mail: Microsoft sign-in needs renewing (open ms-connect again):", d.error_description || d.error || r.status);
    return null;
  }
  if (d.refresh_token) { saved.refresh_token = d.refresh_token; saved.refreshed = new Date().toISOString(); await store.setJSON(TOKEN_KEY, saved).catch(() => {}); }
  _dtoken = { v: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000, account: saved.account || "" };
  return _dtoken;
}

// Keep the stored sign-in fresh (refresh tokens lapse after ~90 days unused). Cheap; call from a cron.
export async function keepMailAlive() {
  if (mailVia() !== "microsoft") return;
  const saved = await getStore("orders").get(TOKEN_KEY, { type: "json" }).catch(() => null);
  if (saved && saved.refreshed && Date.now() - Date.parse(saved.refreshed) > 20 * 3600000) await delegatedToken(true);
}

export async function mailAccount() {
  const saved = await getStore("orders").get(TOKEN_KEY, { type: "json" }).catch(() => null);
  return saved ? { account: saved.account || "", connected: saved.connected || "", refreshed: saved.refreshed || "" } : null;
}

const list = v => (Array.isArray(v) ? v : String(v || "").split(",")).map(s => String(s).trim()).filter(Boolean);

// sendMail({ to, cc, bcc, replyTo, subject, html, tag })  → { ok, via, error }
export async function sendMail(m) {
  const to = list(m.to), cc = list(m.cc), bcc = list(m.bcc), replyTo = list(m.replyTo);
  if (!to.length) return { ok: false, error: "no recipient" };
  const via = mailVia();
  try {
    if (via === "microsoft") {
      const addr = a => ({ emailAddress: { address: a } });
      // Prefer the signed-in mailbox; fall back to app-only (needs Global Admin consent + MAIL_SENDER).
      const dt = await delegatedToken();
      let url, tok;
      if (dt) { url = "https://graph.microsoft.com/v1.0/me/sendMail"; tok = dt.v; }
      else if (process.env.MAIL_SENDER) { url = "https://graph.microsoft.com/v1.0/users/" + encodeURIComponent(process.env.MAIL_SENDER) + "/sendMail"; tok = await graphToken(); }
      else return { ok: false, via, error: "Microsoft mailbox not connected yet — open ms-connect?k=<staff code>" };
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject: m.subject, body: { contentType: "HTML", content: m.html },
            toRecipients: to.map(addr), ccRecipients: cc.map(addr), bccRecipients: bcc.map(addr),
            replyTo: replyTo.map(addr),
          },
          saveToSentItems: true,
        }),
      });
      if (r.status === 202 || r.ok) return { ok: true, via };
      const t = await r.text();
      console.log("mail (microsoft) failed [" + (m.tag || "") + "]:", r.status, t.slice(0, 400));
      return { ok: false, via, error: r.status + " " + t.slice(0, 200) };
    }
    if (via === "resend") {
      const from = process.env.ORDER_ALERT_FROM || "3DPX Orders <orders@3dpx.com>";
      const body = { from, to, subject: m.subject, html: m.html };
      if (cc.length) body.cc = cc; if (bcc.length) body.bcc = bcc; if (replyTo.length) body.reply_to = replyTo[0];
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) return { ok: true, via };
      const t = await r.text();
      console.log("mail (resend) failed [" + (m.tag || "") + "]:", r.status, t.slice(0, 400));
      return { ok: false, via, error: r.status + " " + t.slice(0, 200) };
    }
    return { ok: false, error: "email not configured" };
  } catch (e) {
    console.log("mail error [" + (m.tag || "") + "]:", e.message);
    return { ok: false, via, error: e.message };
  }
}

// Where customer replies should go (the sales inbox).
export const salesInbox = () => list(process.env.ORDER_ALERT_TO || "sales@3dpx.com")[0];
