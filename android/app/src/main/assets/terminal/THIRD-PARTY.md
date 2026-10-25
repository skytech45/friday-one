# Vendored third-party assets — provenance

The terminal WebView loads these files from APK assets. They are vendored
(copied, not served) so the terminal works with no network beyond the API.

Provenance recorded 2026-10-25 for audit finding F-21. **CI asserts the
SHA-256 hashes below** — if you replace or touch a vendored file, re-record
its hash here in the same commit, ideally re-vendoring from a pinned upstream
release URL.

| File | Upstream | Version | SHA-256 |
|---|---|---|---|
| `xterm.js` | [xterm.js](https://github.com/xtermjs/xterm.js) (MIT) | **unknown** — vendored pre-audit; the minified bundle carries no version string | `7a88e46a58847d3f17109e3d48cc8aa056a01997d00ceb76035f63370712d858` |
| `addon-fit.js` | [@xterm/addon-fit](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-fit) (MIT) | **unknown** — same bundle generation as `xterm.js` | `3e9ae6f6965ee1269d5574b905cf1bf559c2f44c784255b0034a71387e7719c9` |
| `xterm.css` | xterm.js (MIT) | matches `xterm.js` | `ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6` |
| `index.html` | project-owned | — | `6bdd65a8316498f87b4d86bba6cdcf90fd613963755660f272a61cefd6ad8c6d` |

**Known gap, recorded honestly:** the exact upstream versions could not be
identified from the minified bundles. When the terminal surface is next
touched, re-vendor from a pinned upstream tag (e.g. `xterm@5.5.0`,
`@xterm/addon-fit@0.10.0`) and update this table with the real versions.

**`sourceMappingURL` comments were stripped** (F-21): the referenced `.map`
files were never vendored, so the comments pointed at absent files. Browser
devtools warnings only, but there was no reason to ship them.

### CI check

`scripts/check-vendor-hashes.sh` recomputes the hashes and fails on drift;
it runs in CI and in the local pre-push gate (`scripts/ci.sh`).
