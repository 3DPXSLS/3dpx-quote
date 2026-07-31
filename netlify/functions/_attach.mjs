// 3DPX — shared helper: attach every stored Blob for an order to one or more Smartsheet rows,
// then delete each blob once it's safely on the PRIMARY row. targets[0] is primary (SLS Jobs);
// any extra targets (e.g. the SLS Web Orders Log row) get a full copy, best-effort. The blob is
// downloaded ONCE and uploaded to each target, so full-copy only doubles the Smartsheet uploads,
// not the Blob reads. No-op without a token / order / targets. Never throws.
import { getStore } from "@netlify/blobs";

export async function attachOrderFiles(token, orderNo, targets) {
  targets = (targets || []).filter(t => t && t.sheetId && t.rowId);
  if (!token || !orderNo || !targets.length) return;
  try {
    const store = getStore("orders");
    const prefix = orderNo + "/";
    const listing = await store.list({ prefix });
    // Manifest (written by the widget) = the filenames of THIS order's actual line-item parts.
    // If present, attach only those part files; skip stale/removed-part files left in the folder.
    // Drawings ("draw…"), doc PDFs, and anything non-numeric-indexed always attach.
    let keep = null;
    for (const b of (listing.blobs || [])) {
      if ((b.key.split("__").pop() || "") === "manifest.json") {
        try { const j = await store.get(b.key, { type: "json" }); if (j && Array.isArray(j.keep)) keep = new Set(j.keep.map(String)); } catch (e) {}
      }
    }
    for (const b of (listing.blobs || [])) {
      try {
        if (b.key.includes("/.part-")) continue;   // orphaned chunk from an interrupted large-file upload — never attach
        const meta = await store.getMetadata(b.key).catch(() => null);
        const fname = (meta && meta.metadata && meta.metadata.name) || b.key.split("__").pop() || "file";
        if (fname === "manifest.json") { await store.delete(b.key).catch(() => {}); continue; }  // internal, never attach
        const isPart = !/^drawing-/i.test(fname) && !/\.pdf$/i.test(fname);  // a model file (STL/STEP), vs a drawing/doc
        if (keep && isPart && !keep.has(fname)) continue;  // stale part file, not on this order — skip (leave in storage)
        const bytes = await store.get(b.key, { type: "arrayBuffer" });
        if (!bytes) continue;
        let primaryOk = false;
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          try {
            const fd = new FormData();
            fd.append("file", new Blob([bytes], { type: "application/octet-stream" }), fname);
            const ar = await fetch("https://api.smartsheet.com/2.0/sheets/" + t.sheetId + "/rows/" + t.rowId + "/attachments",
              { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
            if (i === 0) primaryOk = ar.ok;
            if (!ar.ok) console.log("attach failed:", t.sheetId, ar.status, await ar.text());
          } catch (e3) { console.log("attach target failed:", t.sheetId, e3.message); }
        }
        if (primaryOk) await store.delete(b.key);  // only drop the blob once it's on the primary row
      } catch (e2) { console.log("attach item failed:", e2.message); }
    }
  } catch (e) { console.log("attach step failed:", e.message); }
}

// Attach a saved quote's files (STL/STEP + drawings + the quote PDF) to its row in the SLS Quotes
// sheet. Unlike attachOrderFiles this NEVER deletes the blobs — promote-quote copies them onto the
// order when the customer buys. De-dupes by filename so re-saving a quote doesn't pile up duplicates.
export async function attachQuoteFiles(token, quoteId, sheetId, rowId) {
  if (!token || !quoteId || !sheetId || !rowId) return;
  try {
    const store = getStore("orders");
    const listing = await store.list({ prefix: quoteId + "/" });
    // Existing attachment names on the row → skip anything already there.
    const existing = new Set();
    try {
      const ar = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "/rows/" + rowId + "?include=attachments",
        { headers: { Authorization: "Bearer " + token } });
      if (ar.ok) { const j = await ar.json(); (j.attachments || []).forEach(a => a && a.name && existing.add(a.name)); }
    } catch (e) {}
    for (const b of (listing.blobs || [])) {
      try {
        if (b.key.includes("/.part-")) continue;                 // orphaned upload chunk — skip
        const meta = await store.getMetadata(b.key).catch(() => null);
        const fname = (meta && meta.metadata && meta.metadata.name) || b.key.split("__").pop() || "file";
        if (fname === "manifest.json") continue;                 // internal, never attach
        if (existing.has(fname)) continue;                       // already on the row — don't duplicate on re-save
        const bytes = await store.get(b.key, { type: "arrayBuffer" });
        if (!bytes) continue;
        const fd = new FormData();
        fd.append("file", new Blob([bytes], { type: "application/octet-stream" }), fname);
        const r = await fetch("https://api.smartsheet.com/2.0/sheets/" + sheetId + "/rows/" + rowId + "/attachments",
          { method: "POST", headers: { Authorization: "Bearer " + token }, body: fd });
        if (!r.ok) console.log("quote attach failed:", r.status, await r.text());
        // NOTE: intentionally NOT deleting the blob — the order flow (promote-quote) still needs it.
      } catch (e2) { console.log("quote attach item failed:", e2.message); }
    }
  } catch (e) { console.log("attachQuoteFiles failed:", e.message); }
}
