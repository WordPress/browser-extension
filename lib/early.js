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
  try {
    // Never touch the admin bar inside wp-admin — it's part of the UI.
    if (/\/wp-admin(\/|$)/.test(location.pathname)) return;

    const origin = location.origin;

    const [cacheData, prefsData] = await Promise.all([
      chrome.storage.local.get('wp_detection_cache_v1'),
      chrome.storage.local.get('wp_preferences_v1'),
    ]);

    const entry = (cacheData.wp_detection_cache_v1 || {})[origin];
    const prefsRoot = prefsData.wp_preferences_v1 || {};
    const prefs = prefsRoot[origin];
    const globalPrefs = prefsRoot._global || {};

    const isKnownWP = entry && entry.isWordPress;
    // Per-origin choice wins. The global "hide by default" option from the
    // options page only fires for sites the user has not explicitly set.
    const hasOriginPref = prefs && typeof prefs.adminBarHidden === 'boolean';
    const shouldHide = hasOriginPref
      ? prefs.adminBarHidden === true
      : globalPrefs.adminBarHidden === true;

    if (!isKnownWP || !shouldHide) return;

    const style = document.createElement('style');
    style.id = 'wp-detective-adminbar-hide';
    style.textContent = `
      /*
       * Admin bar hidden by the WordPress Browser Extension.
       * Toggle "Show Admin Bar" in the extension popup to restore it on
       * this site, or change the default in the extension options page.
       */
      #wpadminbar { display: none !important; }
      html { margin-top: 0 !important; --wp-admin--admin-bar--height: 0px !important; }
      html.admin-bar, html.wp-toolbar { margin-top: 0 !important; --wp-admin--admin-bar--height: 0px !important; }
    `;
    // documentElement exists even before <head>, so this is always safe.
    document.documentElement.appendChild(style);
    console.info(chrome.i18n.getMessage('admin_bar_hidden_notice')); // "[WordPress Browser Extension] Admin bar hidden on this site. Toggle "Show Admin Bar" in the extension popup or the options page."
  } catch (_) {
    // Storage unavailable or extension context invalidated — ignore.
  }
})();
