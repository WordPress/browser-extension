# WordPress Browser Extension

> A browser extension that detects WordPress sites and puts admin shortcuts, hosting info, and developer tools in your toolbar. Chrome is the primary target; Safari is supported via a companion Xcode project.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<p>
  <a href="https://chromewebstore.google.com/detail/wordpress-browser-extensi/apaakgfongbkeecchhhjocpgjchbdenl"><img src=".github/store-badges/chrome-web-store.png" height="50" alt="Available in the Chrome Web Store"></a>
  <a href="https://apps.apple.com/app/id6794460913"><img src=".github/store-badges/mac-app-store.png" height="50" alt="Download on the Mac App Store"></a>
</p>

WordPress's admin bar is convenient — *Edit Post*, the jump-to-admin link, a few plugin add-ons — but it lives inside the website's viewport. That gets in the way when you're checking how a site behaves for a logged-out visitor, especially with sticky navigation, parallax, or designs that key off the full browser height (`100vh` layouts, raindrop scroll effects, anything immersive). The standard workaround, turning the admin bar off in your user profile, fixes the visual interference, but then quick access to wp-admin and content editing becomes a chore.

Plugins layer their own items onto the admin bar too. For most everyday work, *Edit this page*, *jump to admin*, and a handful of host or developer shortcuts cover 80-90% of what most site managers reach for. This extension moves those out of the viewport entirely and into the browser toolbar, leaving the admin bar available when needed, out of the way when it's not.

A few extras follow naturally from sitting at the browser level instead of inside the site. It identifies whether the current webpage is powered by WordPress (and, where the signals allow, which managed host it's on), provides a one-click log-in shortcut, and packages developer tools (mobile preview, cache bypass, cookies/site-data clear, block highlighter) that are genuinely cleaner as a browser overlay than as in-site UI.

<p align="center">
  <a href="screenshots/admin-bar-toggle.gif"><img src="screenshots/admin-bar-toggle.gif" alt="The admin bar hidden and restored from the browser toolbar on a live WordPress site, with the page reflowing to the exact view a visitor sees"></a>
</p>
<p align="center">
  <a href="screenshots/block-outlines-safari.png"><img src="screenshots/block-outlines-safari.png" width="49%" alt="Highlight Blocks outlining template parts, navigation, and content blocks over a live page, with the popup's Developer Tools section open in Safari"></a>
  <a href="screenshots/my-sites-safari.png"><img src="screenshots/my-sites-safari.png" width="49%" alt="Popup on a logged-out WordPress site in Safari — version detected, log in shortcuts, and the My Sites launcher with three saved sites and their icons"></a>
</p>

## Status

**v1.0 launched.** The extension is available on the [**Chrome Web Store**](https://chromewebstore.google.com/detail/wordpress-browser-extensi/apaakgfongbkeecchhhjocpgjchbdenl) for Chrome and Chromium browsers and on the [**Mac App Store**](https://apps.apple.com/app/id6794460913) for Safari on macOS, published by the WordPress Foundation. Permissions are audited against least-privilege with per-entry rationale in [`SECURITY.md`](SECURITY.md) (the packaged Chrome build drops the redundant `activeTab`, [#61](https://github.com/WordPress/browser-extension/issues/61)), the privacy policy is published, and correctness linting gates CI. Firefox and Edge directories are under consideration next; see [`ROADMAP.md`](ROADMAP.md) for what's locked, what's open, and what's ahead.

## Privacy

No telemetry, no analytics, no third-party tracking. The extension does its work locally — reading the page you're on and (when you're signed in as an admin) calling the site's own REST API for theme and plugin information. Nothing leaves your browser for any service outside the WordPress site you're already visiting.

## Install

**From the stores (recommended):**

- **Chrome / Chromium**: install from the [Chrome Web Store](https://chromewebstore.google.com/detail/wordpress-browser-extensi/apaakgfongbkeecchhhjocpgjchbdenl)
- **Safari (macOS)**: install from the [Mac App Store](https://apps.apple.com/app/id6794460913), launch the app once, then enable the extension in **Safari → Settings → Extensions**

Store installs are fully signed and update automatically.

### From GitHub Releases (for testing and development)

**Chrome (load unpacked):**

1. Download the latest zip from [Releases](https://github.com/WordPress/browser-extension/releases)
2. Unzip to a folder
3. Open `chrome://extensions`, enable **Developer mode**
4. Click **Load unpacked** and select the unzipped folder

**Safari (ad-hoc signed):**

1. Download the latest `…-safari.zip` from [Releases](https://github.com/WordPress/browser-extension/releases) and unzip
2. Drag **WordPress Browser Extension.app** to Applications
3. First launch: right-click the app, choose **Open**, and confirm the Gatekeeper prompt (the build is ad-hoc signed, not Developer-ID signed)
4. Quit the app, then enable the extension in **Safari → Settings → Extensions**

To build from source instead (Xcode), see [`SAFARI.md`](SAFARI.md).

## Features

- **Detect WordPress** — Identifies WP sites automatically via REST API links, generator tags, asset paths, and body classes. The toolbar icon has three states: a WordPress-blue disc with a white W and a small green corner dot when you're logged in to a WP site, the same blue disc without the dot when you're logged out, and a muted slate disc for non-WordPress pages. The full-bleed background keeps the icon legible against any browser chrome, Safari included.
- **Site icon in the popup header** — When a site has a WordPress Site Icon configured (Customize → Site Identity), it appears next to the hostname in the popup header for fast visual identification.
- **Edit this page** — Jump straight to the editor for posts, pages, categories, tags, authors, and custom post types — including hyphenated CPT slugs like `case-study`. On block themes, template-backed pages such as the blog index and archives open in the site editor. Keyboard shortcut: `Alt+Shift+E` (`Option+Shift+E` on Mac), customizable at `chrome://extensions/shortcuts`.
- **View / Preview from the editor** — On wp-admin edit screens, see the published page or preview a draft (with nonce) in one click. Works for all post types.
- **+ New content menu** — Mirrors the admin bar's "+ New" dropdown with the post types your role can create.
- **Identify the host** — Detects WP Engine, WordPress VIP, Pantheon, Kinsta, Flywheel, Cloudways, WordPress.com, Pressable, and local dev environments. Cached per origin for 90 days.
- **Toggle the admin bar** — Hide or show the front-end admin bar per site, without flash. Honors your profile setting and surfaces a clear hint when WP itself has the bar disabled.
- **Account menu** — A circular avatar button in the popup header opens an account dropdown with the logged-in user's display name, role (Super Admin / Administrator / Editor / etc.), and one-click links to the WordPress profile and Gravatar (when the avatar comes from gravatar.com). Sourced from the admin bar's My Account menu.
- **One-click sign out** — Inline confirm in the account menu, then logs out via the admin bar's nonce so WordPress's "are you sure?" page is skipped.
- **Developer tools** — Mobile preview window (iPhone-sized), bypass page cache, clear cookies + site data (preserving your WP login), Highlight Blocks (outline `wp-block-*` elements with a breadcrumb tooltip), and a Query Monitor toggle when QM is installed.
- **My Sites** — A launcher for the WordPress sites signed in on this browser. The extension remembers each site as it detects a login, then lists them with their site icons in a global popup section available on any page, for one-click access to any site's admin. Rename or remove entries in an inline edit mode. Saved locally only, and cleared along with the rest of the extension's data.

## Options page

Browser-wide defaults live on a separate options page, surfaced through the browser's extension management UI (Chrome: `chrome://extensions` → Details → Extension options. Safari: Settings → Extensions → preferences pane). No entry point from the popup — these settings are intentionally out of the way.

Current options:

- **Hide admin bar by default** — Flips the per-site default for the admin bar toggle. Per-site choices in the popup always win over this default.
- **Show site information panel (experimental)** — Adds a panel to the popup that surfaces the active theme, installed plugins, site name, and REST namespaces. Detection is heuristic and asset-path inference can produce duplicates or false positives, so it is off by default. Powered by the WP REST API for admins, with DOM-scanned slugs as a graceful fallback.
- **Clear all data** — Wipes per-site preferences, the global defaults above, the cached WordPress detection results, and the saved My Sites list. Useful for testing or starting fresh.

## Development

The popup UI is React + [`@wordpress/ui`](https://www.npmjs.com/package/@wordpress/ui), bundled with [`@wordpress/scripts`](https://www.npmjs.com/package/@wordpress/scripts). The background service worker, content scripts, `lib/*.js`, and the options page (`options/*`) are plain JavaScript — no build step there.

```
npm install
npm run build     # production bundle → dist/
npm start         # watch mode
```

Run smoke tests for `lib/` with `cd test && npm install && npm test`.

UI strings live in `_locales/` and resolve through Chrome's i18n APIs (`__MSG_*__` fields in the manifest, `chrome.i18n.getMessage` in code). English is the only catalog today; translations can be added under `_locales/<locale>/`.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the full contributor flow, conventions, and the permissions-discussion policy.

## Roadmap

See [`ROADMAP.md`](ROADMAP.md) — a **working draft, not a fixed plan**, open to community input. Current v1.0 target: official Chrome Web Store and Safari / Mac App Store releases under the WordPress publisher account, with API and permissions surface frozen. Firefox Add-ons and Edge Add-ons are tracked post-1.0.

## Contributing

Bug reports, design feedback, and PRs all welcome. This project follows the [WordPress Code of Conduct](https://make.wordpress.org/handbook/community-code-of-conduct/).

- **Engineering work**: GitHub Issues + PRs. See [`CONTRIBUTING.md`](CONTRIBUTING.md).
- **UX / design feedback / "should we…?" questions**: [GitHub Discussions](https://github.com/WordPress/browser-extension/discussions).
- **Security issues**: see [`SECURITY.md`](SECURITY.md). Don't open a public issue.

## Maintainers

See [`MAINTAINERS.md`](MAINTAINERS.md). Current maintainer set: [@jakemgold](https://github.com/jakemgold) (Jake Goldman) and [@fabiankaegy](https://github.com/fabiankaegy) (Fabian Kägy) — both at **[Fueled](https://fueled.com/)** (formerly **[10up](https://10up.com/)**).

## License

[MIT](LICENSE). Copyright the contributors. By submitting a contribution you license it under MIT.

## Origin

This project began at [jakemgold/wp-detective](https://github.com/jakemgold/wp-detective) and moved here at v0.8 to become the official WordPress browser extension. The original repository is preserved as the project's archived origin.
