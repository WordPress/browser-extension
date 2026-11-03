/**
 * WordPress Browser Extension — early injection
 *
 * Runs at document_start (before the page body has been parsed) so we can
 * hide the admin bar before it paints. Without this, users see a flash
 * of admin bar on every page load when the "hide" preference is on.
 *
 * Only injects CSS if:
 *   - This origin is already known to be WordPress (in the cache), and
 *   - The user has explicitly opted to hide the admin bar for this
 *     origin (or has set the global "Hide admin bar by default" toggle
 *     on the options page). The default behavior is to show the admin
 *     bar — anything else requires an explicit pref.
 *
 * Safe to fail silently — content.js at document_idle will reconcile.
 */
(async function () {
  'use strict';

  // Shared with content.js (both run in the same content-script isolated world;
  // early.js at document_start always runs first) so the admin-bar hide rules
  // live in one place and can't drift between the two files.
  const HIDE_CSS = `
      /*
       * Admin bar hidden by the WordPress Browser Extension.
       * Toggle "Show Admin Bar" in the extension popup to restore it on
       * this site, or change the default in the extension options page.
       */
      #wpadminbar { display: none !important; }
      /*
       * Core prints an inline html { margin-top: 32px !important } bump in
       * <head>. Depending on when the storage read below resolves, this style
       * can precede that rule in document order, so outrank it on specificity
       * with :root rather than relying on source order.
       */
      html:root { margin-top: 0 !important; --wp-admin--admin-bar--height: 0px !important; }
      html:root.admin-bar, html:root.wp-toolbar { margin-top: 0 !important; --wp-admin--admin-bar--height: 0px !important; }
    `;
  globalThis.WPDAdminBarHideCSS = HIDE_CSS;

  try {
    // Never touch the admin bar inside wp-admin — it's part of the UI.
    if (/\/wp-admin(\/|$)/.test(location.pathname)) return;

    const origin = location.origin;

    // Read only this origin's cache entry (wp_cache_<origin>) rather than the
    // whole detection history — keep the prefix in sync with background.js
    // CACHE_PREFIX — plus the prefs, in one storage get.
    const cacheKey = 'wp_cache_' + origin;
    const data = await chrome.storage.local.get([cacheKey, 'wp_preferences_v1']);

    const entry = data[cacheKey];
    const prefsRoot = data.wp_preferences_v1 || {};
    const prefs = prefsRoot[origin];
    const globalPrefs = prefsRoot._global || {};

    const isKnownWP = entry && entry.isWordPress;

    // Early login-state hint (#59). The toolbar icon paints from this cache
    // entry the moment the tab starts loading; when the session has expired,
    // the correction otherwise waits for full detection at document_idle —
    // seconds later on a heavy page. If the cache claims logged-in, check the
    // parsed DOM at DOMContentLoaded and tell the background as soon as the
    // page visibly disagrees. Downgrade-only: upgrades stay with full
    // detection, so recordLogin's logged-out→logged-in transition rule (the
    // My Sites re-add gate) keeps its meaning.
    if (isKnownWP && entry.isLoggedIn) {
      const hintIfLoggedOut = () => {
        const domLoggedIn =
          (document.body && document.body.classList.contains('logged-in')) ||
          !!document.getElementById('wpadminbar');
        if (domLoggedIn) return;
        try {
          chrome.runtime.sendMessage({ type: 'WP_LOGIN_HINT', loggedIn: false })
            .catch(() => { /* background asleep/unreachable — idle report will fix it */ });
        } catch (_) { /* extension context invalidated */ }
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', hintIfLoggedOut, { once: true });
      } else {
        hintIfLoggedOut();
      }
    }

    // Per-origin choice wins. The global "hide by default" option from the
    // options page only fires for sites the user has not explicitly set.
    const hasOriginPref = prefs && typeof prefs.adminBarHidden === 'boolean';
    const shouldHide = hasOriginPref
      ? prefs.adminBarHidden === true
      : globalPrefs.adminBarHidden === true;

    if (!isKnownWP || !shouldHide) return;

    const style = document.createElement('style');
    style.id = 'wp-detective-adminbar-hide';
    // Ownership marker: content.js only adopts (and will only ever remove)
    // elements carrying this attribute, so a page-owned element that happens
    // to share the ID is left alone.
    style.setAttribute('data-wpd-owned', '');
    style.textContent = HIDE_CSS;
    // documentElement exists even before <head>, so this is always safe.
    document.documentElement.appendChild(style);
  } catch (_) {
    // Storage unavailable or extension context invalidated — ignore.
  }
})();
