#!/usr/bin/env node
/**
 * Produces the Chrome-store manifest from the repository manifest.
 *
 * The Chrome package ships the narrowest permission set that supports its
 * functionality: `activeTab` is dropped because it is redundant next to the
 * broad http and https host_permissions the extension already declares.
 * Chrome's restricted "on click" site-access mode is implemented by the
 * browser withholding and re-granting those host permissions on invocation —
 * it does not rely on `activeTab` — so removing it changes no runtime behavior
 * while shrinking the surface the Chrome Web Store reviews and the listing has
 * to justify. See issue #61 and SECURITY.md.
 *
 * This transform is the ONLY point where the shipped Chrome manifest diverges
 * from the repository manifest. The repository manifest — which the Safari
 * build mirrors verbatim — keeps `activeTab` for now; a prior
 * permission-narrowing experiment broke Safari detection, so Safari-side
 * removal is deferred to the Safari / App Store store-readiness pass.
 *
 * Usage:  node scripts/stage-chrome-manifest.js <src-manifest> <dest-manifest>
 * Also exported (chromeManifest / CHROME_DROP_PERMISSIONS) for the test suite.
 */
const fs = require('fs');

// Permissions removed from the repository manifest when packaging for Chrome.
const CHROME_DROP_PERMISSIONS = ['activeTab'];

// Return a copy of `manifest` with the Chrome-dropped permissions filtered out.
// Key order and every field value are preserved; the only semantic change is the
// removed permission(s). (The staged file re-serializes, so its JSON whitespace
// is normalized — it is a generated release artifact, never committed, and the
// Chrome Web Store consumes it as parsed JSON.)
function chromeManifest(manifest) {
  const out = { ...manifest };
  if (Array.isArray(out.permissions)) {
    out.permissions = out.permissions.filter((p) => !CHROME_DROP_PERMISSIONS.includes(p));
  }
  return out;
}

if (require.main === module) {
  const [src, dest] = process.argv.slice(2);
  if (!src || !dest) {
    console.error('Usage: node scripts/stage-chrome-manifest.js <src-manifest> <dest-manifest>');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(src, 'utf8'));
  const staged = chromeManifest(manifest);
  fs.writeFileSync(dest, JSON.stringify(staged, null, 2) + '\n');
  const dropped = (manifest.permissions || []).filter(
    (p) => !(staged.permissions || []).includes(p)
  );
  console.log(`✓ staged Chrome manifest (dropped: ${dropped.join(', ') || 'none'})`);
}

module.exports = { chromeManifest, CHROME_DROP_PERMISSIONS };
