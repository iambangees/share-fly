# Share Fly

Send files between your PC and your phone — without leaving the browser, without an app, without uploading them anywhere.

## How it works

- **Send tab:** pick files (tap or drag & drop, multiple allowed) → "Get a share code" → a 6-letter code appears with a QR code and a shareable link.
- **Receive tab:** type the 6-letter code (or open the link / scan the QR — the code fills itself in and connects) → files arrive with per-file progress → tap Download on each to save it.
- Files travel **directly browser-to-browser over WebRTC** (PeerJS 1.5.4, free cloud signalling on 0.peerjs.com — it only introduces the two peers). No file ever touches a server and nothing is stored anywhere. Transfer is chunked at 16 KiB with per-file progress and a screen wake-lock while sending/receiving.

## Files

- `site/index.html` — the page (Send/Receive tabs, drop zone, code + QR share box)
- `site/app.js` — transfer logic; pure helpers (code gen, chunking, reassembly, deep-link parsing) are Node-testable via `module.exports`
- `site/qrcode.min.js` — vendored qrcode-generator 1.4.4 (same copy as QR Maker)
- `site/manifest.webmanifest`, `site/sw.js` — PWA installable; service worker caches same-origin files only, PeerJS CDN/signalling always go to the network
- icons + banner drawn with PIL (sky-blue paper plane on navy)

## Verified (2026-11-21, before publishing)

- `node --check` clean on app.js and sw.js; manifest parses.
- Node test harness (`/tmp/test_sharefly.js`, not shipped): 200 generated codes all match the unambiguous alphabet; peer-id round-trip; chunk ranges for 0 / 100 / 16,384 / 16,385 / 100,000 bytes; a **250,000-byte random file chunked and reassembled byte-identical**; deep-link `?code=` parsing; every DOM id the script touches exists in index.html (24 ids).
- PeerJS 1.5.4 confirmed live on jsDelivr (fetched 2026-11-21 ~20:22 UTC); the page falls back to unpkg if jsDelivr fails.

## Still owed (after publishing, like Agent Cards' live check)

- A real two-device test: PC → phone and phone → PC, including scanning the QR with a phone camera. WebRTC needs two live browsers, which this build environment cannot do.

## Honest limits (stated on the page)

- Both devices must have the page open at the same time; there is no store-and-forward.
- Strict office/school networks can block direct P2P; home Wi-Fi and mobile data normally work.
- Each received file downloads separately (no zip bundling).

## Publish

Create an empty public GitHub repo named `share-fly` (no README), push `site/` to `gh-pages`, then add the Share Fly link to the other 12 sites' "More from Bangees" footers (same routine as QR Maker / Scan to 3D).
