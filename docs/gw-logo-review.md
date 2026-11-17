# GW logo replacement — draft review

## Source and preservation

- User attachment: `libfile_cec8604dd7c08191bc04e6f17024c6b8`, version 0.
- The filename/MIME is `logo_m.gif` / `image/gif`, but the actual file is a single-frame **250 × 250 PNG RGBA with transparency**, 9,298 bytes. No animation is present.
- Original SHA-256: `7aa47dd8622a23eecf49e1b46f1073816141161b60d32924f4936860738742c6`.
- `img/logo.svg` embeds these exact original PNG bytes. No cropping, recoloring, redrawing, stretching, or background replacement. Original internal padding is retained, so the symbol appears smaller than the old approximation at equal CSS dimensions.

## Scope

The existing shared path is retained: GW login (`index.html`), common headers (`js/layout.js`), HTML favicons, `manifest.json` and service-worker notification icons already reference it. Dedicated service wordmarks and authentication code are unchanged. This also updates the shared corporate favicon on service pages that already use this asset; no unrelated service logo is redesigned.

Originally reviewed with PR 187; published as an independent logo-only Draft based on main `d7700a719dcda86f814e13abeeab699ab6e9ea83`. No PR 187 authentication or login redesign changes are included.

## Verification (2026-10-24 JST)

- `npm test` on initial PR 187-based review: **205 / 205 passed**, including `test/gwlogo.mjs` original-byte hash, PNG dimensions, aspect ratio, shared references, and no external image resource/script checks.
- Final main-based logo-only tree: `npm test` **204 / 204 passed**; independent reviewer confirmed the three-file scope, original image integrity, no auth change, and no static blocker.
- `git diff --check`: passed.
- Inkscape SVG render at 250 × 250: exact RGBA pixel equality with the supplied PNG.
- Offline comparison board inspected at header 22 px, login 56 px, notice 64 px, plus 250 px and light-background transparency examples. These are **offline rendered layout samples, not browser screenshots**.
- Library comparison artifact: `libfile_54e6ae61eec881919379b1d08741b0d3` (`logo-review.png`).

Cloud browser rejected the local `file://` URL by protocol policy. No bypass was attempted. Actual browser rendering, SVG favicon/PWA compatibility and installed-device icon refresh remain unverified; embedded raster in SVG should receive browser review before publication. Existing `/img/*` cache is one hour, and installed PWA icons can retain the prior asset longer. No cache, CSP, deployment, permission or auth setting was changed.

Draft publication was explicitly approved after local review. No merge or production change is authorized. The separately identified retiree-login regression is not addressed or authorized by this logo request.
