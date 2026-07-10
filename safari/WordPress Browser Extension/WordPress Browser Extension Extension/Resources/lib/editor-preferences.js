/**
 * WordPress Browser Extension — Block Editor preferences helpers
 *
 * Backs the "Always open List View" option (#32). Modern WordPress persists
 * Block Editor preferences (List View, distraction free, etc.) server-side in
 * user meta — not browser localStorage — and inlines the current snapshot
 * next to the `wp-preferences` script so `wp.data` can hydrate without an
 * extra REST round trip:
 *
 *   ( function() {
 *     var serverData = {"core":{"showListViewByDefault":false}};
 *     var userId = "5";
 *     var persistenceLayer = wp.preferencesPersistence.__unstableCreatePersistenceLayer(...);
 *     ...
 *   } )();
 *
 * (see wp_default_packages_inline_scripts() in WordPress core.) These helpers
 * read that same snapshot from the DOM — content scripts can't reach page
 * globals like `window.wp` directly — so content.js can decide, without any
 * REST call of its own, whether the preference still needs to be turned on.
 *
 * The scope is a single shared `"core"` string, not one per editor surface:
 * both the post editor and the site editor read/write
 * `getPreference( "core", "showListViewByDefault" )` (see edit-post.js and
 * edit-site.js in WordPress core) — there is no separate "core/edit-post" or
 * "core/edit-site" scope for this preference.
 */
(function () {
  'use strict';

  const SCOPE = 'core';
  const PREFERENCE_NAME = 'showListViewByDefault';

  /**
   * Extracts the inlined `serverData` preferences snapshot from a Document.
   * Returns the parsed object, or null if no matching inline script is
   * found or its contents aren't the expected shape (e.g. a brand-new
   * account with no persisted prefs yet, where WordPress inlines `""`).
   */
  function readPersistedPreferences(doc) {
    if (!doc || !doc.querySelectorAll) return null;

    const scripts = doc.querySelectorAll('script:not([src])');
    for (let i = 0; i < scripts.length; i++) {
      const text = scripts[i].textContent || '';
      if (!text.includes('__unstableCreatePersistenceLayer')) continue;

      const match = text.match(/var\s+serverData\s*=\s*(\{[\s\S]*?\});\s*\n?\s*var\s+userId/);
      if (!match) continue;

      try {
        return JSON.parse(match[1]);
      } catch (_) {
        continue; // malformed/unexpected shape — try the next script, if any
      }
    }
    return null;
  }

  /**
   * True unless `serverData` already has the preference set to `true` under
   * the shared "core" scope. Missing data (null/not-yet-persisted) is
   * treated as "needs it" — safe because the actual write is a `wp.data`
   * dispatch that only turns the preference on, never off; a false positive
   * here at worst repeats a no-op set, not a wrong value.
   */
  function needsListViewDefault(serverData) {
    if (!serverData) return true;
    return (serverData[SCOPE] || {})[PREFERENCE_NAME] !== true;
  }

  globalThis.WPEditorPreferences = {
    SCOPE,
    PREFERENCE_NAME,
    readPersistedPreferences,
    needsListViewDefault,
  };
})();
