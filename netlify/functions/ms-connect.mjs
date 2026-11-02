// 3DPX — connect the quote tool's email to a Microsoft 365 mailbox ("sign in once").
//
//   https://3dpx-quote.netlify.app/.netlify/functions/ms-connect?k=<staff code>
//
// Sends you to Microsoft's normal sign-in. Sign in as the mailbox emails should come FROM (e.g.
// sales@3dpx.com, or your own). The tool then sends as that mailbox (delegated Mail.Send) and keeps
// itself signed in with a refresh token stored in Netlify Blobs (MSAUTH/token.json). No Global Admin
// approval needed — only delegated permissions (Mail.Send, offline_access, User.Read).
//
// The app registration needs this exact Web redirect URI:
//   https://3dpx-quote.netlify.app/.netlify/functions/ms-connect
import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { isStaff } from "./_staff.mjs";
import { DELEGATED_SCOPES, TOKEN_KEY } from "./_mail.mjs";

const page = (title, body, ok = true) => new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;color:#1b2330">
<div style="font-size:13px;font-weight:bold;letter-spacing:.5px;color:#1b2a4a">3DPX QUOTE TOOL</div>
<h2 style="color:${ok ? "#1e7d52" : "#b3261e"};border-bottom:3px solid #f26a21;padding-bottom:8px">${title}</h2>${body}</body>`,
  { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
const esc = s => String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export default async (req) => {
  const e = process.env, u = new URL(req.url);
  if (!e.MS_TENANT_ID || !e.MS_CLIENT_ID || !e.MS_CLIENT_SECRET)
    return page("Not set up yet", "<p>Add MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET in Netlify → Environment variables, redeploy, then open this link again.</p>", false);
  const redirect = u.origin + "/.netlify/functions/ms-connect";
  const store = getStore("orders");
  const authBase = "https://login.microsoftonline.com/" + encodeURIComponent(e.MS_TENANT_ID) + "/oauth2/v2.0/";

  // ---- step 2: Microsoft sends the browser back here with ?code ----
  if (u.searchParams.get("code") || u.searchParams.get("error")) {
    if (u.searchParams.get("error"))
      return page("Microsoft didn't connect", "<p>" + esc(u.searchParams.get("error_description") || u.searchParams.get("error")) + "</p>", false);
    const state = u.searchParams.get("state") || "";
    const saved = await store.get("MSAUTH/state-" + state.replace(/[^a-z0-9]/gi, ""), { type: "json" }).catch(() => null);
    if (!saved || Date.now() - saved.t > 15 * 60000) return page("Link expired", "<p>Please open the connect link again.</p>", false);
    await store.delete("MSAUTH/state-" + state.replace(/[^a-z0-9]/gi, "")).catch(() => {});
    const r = await fetch(authBase + "token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: e.MS_CLIENT_ID, client_secret: e.MS_CLIENT_SECRET, grant_type: "authorization_code",
        code: u.searchParams.get("code"), redirect_uri: redirect, scope: DELEGATED_SCOPES }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.refresh_token) return page("Couldn't finish connecting", "<p>" + esc(d.error_description || d.error || r.status) + "</p>", false);
    let who = "";
    try {
      const me = await (await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName", { headers: { Authorization: "Bearer " + d.access_token } })).json();
      who = me.mail || me.userPrincipalName || "";
    } catch (x) {}
    await store.setJSON(TOKEN_KEY, { refresh_token: d.refresh_token, account: who, connected: new Date().toISOString(), refreshed: new Date().toISOString() });
    return page("Email connected ✓", `<p>The quote tool will now send customer emails from <b>${esc(who || "this mailbox")}</b>. Replies go to the sales inbox.</p>
      <p>You can close this tab. To switch mailboxes later, open the connect link again and sign in as the other account.</p>`);
  }

  // ---- step 1: staff opens the link → off to Microsoft sign-in ----
  if (!isStaff(u.searchParams.get("k"))) return page("Staff link required", "<p>Open this with <code>?k=</code> and the staff code from the rep link.</p>", false);
  const state = crypto.randomBytes(16).toString("hex");
  await store.setJSON("MSAUTH/state-" + state, { t: Date.now() });
  const q = new URLSearchParams({ client_id: e.MS_CLIENT_ID, response_type: "code", redirect_uri: redirect, response_mode: "query",
    scope: DELEGATED_SCOPES, state, prompt: "select_account" });
  return Response.redirect(authBase + "authorize?" + q, 302);
};
