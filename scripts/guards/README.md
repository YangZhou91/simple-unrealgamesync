# Public submission privacy

`npm run check:privacy` uses Git's NUL-delimited index inventory plus nonignored
untracked files. This covers staged additions, hidden files, scripts, canonical
references and new docs before staging, including a freshly initialized index.
An empty inventory or missing image manifest fails. Run it after `git init` if
preparing a new repository; it does not rewrite or inspect published history.

The generic text policy rejects personal Windows profile paths (both slash
styles and escaped separators), credential-bearing URLs, private-key markers,
recognizable token formats, non-demo depot roots and production-style workspace
names. Profile fixtures may use alice, bob, demo, example, fixture, test, user,
username, you, Public, Default or an angle-bracket placeholder. Depot roots must
be prefixed demo/example/fixture/test, or be generic depot, mygame, project,
mydepot, stream, client, client_name or angle-bracket placeholders. There are no
directory exemptions. Privacy tests build synthetic rejected values at runtime
instead of storing actual sensitive values in the source.

Private configuration filenames (including environment files except
`.env.example`, credential stores and key containers) are blocked even if
force-added to Git. Non-image files containing NUL bytes fail for manual review
rather than silently bypassing text scanning (including UTF-16 text).

Every submitted PNG/JPEG/GIF/WebP/BMP/TIFF/ICO/ICNS/AVIF/SVG needs a unique exact
SHA-256 entry in `reviewed-images.json`. View **every** changed image (and every
frame of icon containers), verify only fictional data is visible, then manually
edit that manifest in the same change. New, changed, missing or duplicate entries
fail. There is no checker option to approve/update hashes automatically. Hashes
attest reviewed bytes, not OCR coverage or exhaustive secret detection.

Regeneration: `node tests/visual/canonical/check-code-preview.cjs` renders design
references; `npm run capture:docs` renders documentation from the real UI with
fixtures. Baseline updates follow `tests/visual/README.md`, with independent
interaction/geometry assertions. No painting-over of existing screenshots.

`npm run check:dev-privacy` probes synthetic files in a disposable external test
root using the real shared Vite config in normal and harness modes. Both direct
and filesystem routes, with and without raw queries, must deny private bytes.
It never probes actual signing keys. Keep local keys/backups outside submissions.
