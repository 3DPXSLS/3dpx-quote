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
