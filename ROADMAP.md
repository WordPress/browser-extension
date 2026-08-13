# Roadmap

> ⚠️ **Working draft — not a commitment.** This document reflects current maintainer thinking on direction and priorities. Phases, features, v1.0 gates, and even the store list will evolve as community input lands, browser-store realities surface, and WordPress Foundation alignment progresses. Everything below is open to be challenged — propose changes in [Discussions](https://github.com/WordPress/browser-extension/discussions) or via Issues.

A milestone-level view of where this project is heading. Day-to-day work is tracked in [Issues](https://github.com/WordPress/browser-extension/issues) and proposals in [Discussions](https://github.com/WordPress/browser-extension/discussions).

| Phase | What | Status |
|---|---|---|
| **v0.8.x** | Public scaffold under the WordPress org. React popup architecture, Site Information panel, Block Inspector, host detection, developer tools. | shipped |
| **v0.9.x** | **Features:** account menu in the popup header (display name, role, profile / Gravatar); extension options page with browser-wide preferences (admin bar default, Site Information opt-in, clear-data); toolbar icon redesigned for contrast on any browser chrome; admin bar attribution comment when the extension is hiding it. **Build:** popup bundle migrated from `10up-toolkit` to `@wordpress/scripts`. **Security:** REST root and profile URL validated against same-origin so a hostile page can't redirect the extension's authenticated calls. (The Xcode project / display-name rename to "WordPress Browser Extension" shipped in v0.8.3.) | shipped |
| **v0.10.x** | **Features:** "My Sites" launcher, a global popup section listing the WordPress sites you are signed in to, with site icons, rename, and remove ([#43](https://github.com/WordPress/browser-extension/pull/43)); Edit button for template-backed pages on block themes, such as the blog index and archives, deep-linked into the site editor ([#22](https://github.com/WordPress/browser-extension/issues/22)); Chrome i18n localization scaffold via `_locales` ([#28](https://github.com/WordPress/browser-extension/issues/28)); toolbar icon redesigned into a solid three-state mark shared by Chrome and Safari, improving contrast on any browser chrome ([#15](https://github.com/WordPress/browser-extension/issues/15), [#31](https://github.com/WordPress/browser-extension/issues/31)); Edit and WordPress Admin actions gated by the signed-in user's capabilities ([#34](https://github.com/WordPress/browser-extension/issues/34)); modifier-click and middle-click open links in a new tab ([#29](https://github.com/WordPress/browser-extension/issues/29)). **Fixes:** admin and login links on subdirectory installs ([#33](https://github.com/WordPress/browser-extension/issues/33)); service-worker `runtime.lastError` noise that lit the extension Errors badge ([#37](https://github.com/WordPress/browser-extension/issues/37)). **Hardening:** a packaging integrity check, stricter admin-bar URL validation, and a degradation / security / accessibility pass ([#45](https://github.com/WordPress/browser-extension/pull/45), [#46](https://github.com/WordPress/browser-extension/pull/46)). | shipped |
| **v0.11.x** | **Chrome store-readiness phase. No new features.** Permissions audit with per-permission rationale in `SECURITY.md`; the packaged Chrome build drops the redundant `activeTab` permission ([#61](https://github.com/WordPress/browser-extension/issues/61)). Privacy policy published via GitHub Pages. Chrome Web Store listing copy and promotional images. Chrome publisher account resolved (WordPress Foundation). Correctness linting wired into CI. Ships as the unlisted Chrome Web Store release-candidate submission. | readiness complete; CWS submission approved, publication pending |
| **Safari store readiness** | Safari / Mac App Store submission prep, decoupled from the Chrome track so neither gated the other. Bundle identifiers moved to `org.wordpress.browserextension` under the WordPress Foundation Apple Developer account; App Store Connect record, listing assets, and App Review completed. The `activeTab` re-evaluation on Safari ([#61](https://github.com/WordPress/browser-extension/issues/61)) moves to post-1.0. Safari mobile preview window sizing in fullscreen Spaces ([#13](https://github.com/WordPress/browser-extension/issues/13)) remains tracked. | shipped |
| **v1.0** | Initial official directory releases under the WordPress publisher account: [**Chrome Web Store**](https://chromewebstore.google.com/detail/wordpress-browser-extensi/apaakgfongbkeecchhhjocpgjchbdenl) and [**Mac App Store**](https://apps.apple.com/app/id6794460913). API and permissions surface frozen; deprecation policy locked. | shipped ([v1.0.1](https://github.com/WordPress/browser-extension/releases/tag/v1.0.1), 2026-08-13) |
| **post-1.0** | Expansion to additional browser directories — **Firefox Add-ons (AMO)** (requires a manifest v2/v3 compatibility audit; Firefox's WebExtension surface diverges from Chromium in a few places) and **Edge Add-ons** (typically rides the Chrome Web Store submission, but the WordPress publisher-account question may differ). Re-evaluation of `activeTab` in the shared manifest on Safari ([#61](https://github.com/WordPress/browser-extension/issues/61)). Ongoing host-detection additions as managed-WordPress platforms ship new signatures. | next |

## v0.11.x checklist (Chrome)

The Chrome store-readiness gates, all landing with the v0.11.0 release:

- [x] Audit `manifest.json` `permissions` and `host_permissions` for least-privilege. Rationale for each entry documented in `SECURITY.md`; the packaged Chrome build strips the redundant `activeTab` ([#61](https://github.com/WordPress/browser-extension/issues/61)).
- [x] Privacy policy URL, served from `docs/` via GitHub Pages. Both Chrome Web Store and Apple require one even when the extension stores nothing remotely.
- [x] Chrome Web Store listing copy, screenshots, and promotional images.
- [x] Chrome Web Store publisher account (WordPress Foundation).
- [x] Correctness linting (`npm run lint`) wired into CI.

## Safari store-readiness checklist (follows v0.11.x)

- [x] Xcode project rename: project paths, scheme name, bundle identifier prefix (`org.wordpress.browserextension`, [#72](https://github.com/WordPress/browser-extension/pull/72)). Tracked in [`SAFARI.md`](SAFARI.md).
- [x] Apple App Store Connect publisher account (WordPress Foundation). Firefox / Edge publisher questions remain deferred to post-1.0.
- [x] Safari / Mac App Store listing assets.
- [x] App Review passed; app live on the Mac App Store. (The `activeTab` re-evaluation, [#61](https://github.com/WordPress/browser-extension/issues/61), moved to post-1.0.)

## Intentionally out of scope (for now)

- **A per-site settings page.** Today's model is browser-wide defaults on the extension options page plus per-feature toggles in the popup. A dedicated per-site settings page is a possible v2 feature gated by demonstrated demand.
- **Bundled analytics or telemetry.** The extension is a developer/maintainer tool, not a tracking surface. No remote analytics are shipped.
- **Mobile browsers** (Chrome Android, Safari iOS). Mobile WebExtension support is patchy and the use cases are weaker. Possible post-1.0.
- **Multi-account / profile switching.** Out of scope at v1.0; the extension uses whatever WordPress login the current browser session has.

## Stretch / discussion-stage

Ideas that have surfaced but don't yet have an acceptance criterion live in [Discussions](https://github.com/WordPress/browser-extension/discussions). Promotion to this roadmap follows a maintainer call after discussion stabilizes.
