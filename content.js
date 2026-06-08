/**
 * WordPress Browser Extension — content script (document_idle)
 *
 * Responsibilities:
 *   1. Run detection against the loaded DOM and report to background.
 *   2. Respond to popup requests for live (fresh) detection.
 *   3. Apply the admin bar visibility preference for this origin,
 *      and toggle in response to popup messages.
 */
(function () {
  'use strict';

  if (!document.body || !document.documentElement) return;

  // -- Detection + reporting -----------------------------------------------

  const detection = globalThis.WPDetect.detectWordPress(document, { origin: location.origin });
  if (!detection.context.isLoggedIn) {
    detection.context.isLoggedIn =
      globalThis.WPDetect.detectLoggedInFromCookies(document.cookie);
  }

  // Host detection: origin check first (catches local dev), then DOM
  // scan (free). Both are sync — include the result so the background
  // can skip the HEAD request when a signal is present.
  const hostFromDOM = detection.isWordPress
    ? (globalThis.WPHost.detectHostFromOrigin(location.origin) ||
       globalThis.WPHost.detectHostFromDOM(document))
    : null;

  try {
    chrome.runtime.sendMessage({
      type: 'WP_DETECTION',
      url: location.href,
      origin: location.origin,
      pathname: location.pathname,
      detection,
      hostFromDOM,
    });
  } catch (_) { /* extension context invalidated */ }

  // -- Admin bar visibility ------------------------------------------------

  let hideStyle = document.getElementById('wp-detective-adminbar-hide');
  let removedClasses = [];

  async function loadAdminBarPref() {
    try {
      const data = await chrome.storage.local.get('wp_preferences_v1');
      const prefsRoot = data.wp_preferences_v1 || {};
      const prefs = prefsRoot[location.origin];
      const globalPrefs = prefsRoot._global || {};
      // Per-origin choice wins; otherwise consult the global "hide by
      // default" option set on the options page; otherwise default to shown.
      if (prefs && typeof prefs.adminBarHidden === 'boolean') {
        return prefs.adminBarHidden === true;
      }
      return globalPrefs.adminBarHidden === true;
    } catch (_) {
      return false;
    }
  }

  function applyHide() {
    if (!hideStyle) {
      hideStyle = document.createElement('style');
      hideStyle.id = 'wp-detective-adminbar-hide';
      hideStyle.textContent = `
        /*
         * Admin bar hidden by the WordPress Browser Extension.
         * Toggle "Show Admin Bar" in the extension popup to restore it on
         * this site, or change the default in the extension options page.
         */
        #wpadminbar { display: none !important; }
        html { margin-top: 0 !important; --wp-admin--admin-bar--height: 0px !important; }
        html.admin-bar, html.wp-toolbar { margin-top: 0 !important; --wp-admin--admin-bar--height: 0px !important; }
      `;
      document.documentElement.appendChild(hideStyle);
      console.info(chrome.i18n.getMessage('admin_bar_hidden_notice')); // "[WordPress Browser Extension] Admin bar hidden on this site. Toggle "Show Admin Bar" in the extension popup or the options page."
    }
    // Remove `body.admin-bar` so themes that key layout off it (e.g.
    // `body.admin-bar .header { padding-top: 32px }`) collapse cleanly
    // alongside the html-margin neutralization above. We deliberately
    // do NOT remove `body.logged-in` — themes use that class for
    // member-only UI (account links, "Welcome, {user}", hide-login-form,
    // etc.), and hiding the admin bar shouldn't simulate a logout.
    if (document.body && document.body.classList.contains('admin-bar')) {
      document.body.classList.remove('admin-bar');
      if (!removedClasses.includes('admin-bar')) removedClasses.push('admin-bar');
    }
  }

  function applyShow() {
    if (hideStyle) {
      hideStyle.remove();
      hideStyle = null;
    }
    if (document.body) {
      removedClasses.forEach((cls) => document.body.classList.add(cls));
      removedClasses = [];
    }
    // Note: the admin bar's own JS initializes on page load. Hover menus,
    // notifications, etc. may not function fully until the page is
    // reloaded. Visually it's correct; interactively it may be partial.
  }

  // Only manage admin bar visibility on the front end — never inside
  // wp-admin, where the toolbar is integral to the admin UI.
  const isWpAdmin = /\/wp-admin(\/|$)/.test(location.pathname);
  if (detection.context.isLoggedIn && !isWpAdmin) {
    loadAdminBarPref().then((hidden) => {
      if (hidden) applyHide();
      else applyShow();
    });
  }

  // -- Block inspector -----------------------------------------------------
  // Outlines `wp-block-*` elements on the frontend. Skipped inside wp-admin
  // because the editor has its own block tooling.
  const blockInspectorSupported = !isWpAdmin;

  async function loadBlockInspectorPref() {
    try {
      const data = await chrome.storage.local.get('wp_preferences_v1');
      const prefs = (data.wp_preferences_v1 || {})[location.origin];
      return !!(prefs && prefs.blockInspectorEnabled);
    } catch (_) {
      return false;
    }
  }

  function applyBlockInspector(enabled) {
    if (!blockInspectorSupported || !globalThis.WPDBlockInspector) return;
    if (enabled) {
      const ctx = detection.context || {};
      globalThis.WPDBlockInspector.enable({
        isLoggedIn: !!ctx.isLoggedIn,
        postId: ctx.postId,
        postType: ctx.postType,
        restApiRoot: ctx.restApiRoot,
        origin: location.origin,
      });
    } else {
      globalThis.WPDBlockInspector.disable();
    }
  }

  if (blockInspectorSupported) {
    loadBlockInspectorPref().then((enabled) => {
      if (enabled) applyBlockInspector(true);
    });
  }

  // -- Popup messaging -----------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === 'GET_LIVE_DETECTION') {
      // Re-run detection on demand. The IIFE-scope `detection` captured at
      // document_idle goes stale when the user logs in elsewhere and returns
      // to a BFCache'd or page-cached version of this URL.
      const fresh = globalThis.WPDetect.detectWordPress(document, { origin: location.origin });
      if (!fresh.context.isLoggedIn) {
        fresh.context.isLoggedIn =
          globalThis.WPDetect.detectLoggedInFromCookies(document.cookie);
      }
      sendResponse({
        url: location.href,
        origin: location.origin,
        pathname: location.pathname,
        detection: fresh,
      });
      return;
    }

    if (msg.type === 'GET_FRESH_DETECTION') {
      // Bypasses the browser HTTP cache and BFCache via cache: 'no-store'
      // and re-runs detection against the freshly fetched HTML. Used by the
      // popup when the live DOM is stale (admin bar missing despite the user
      // being logged in per chrome.cookies). Page caches that vary on the
      // auth cookie return logged-in HTML here; ones that don't return the
      // same stale response, in which case the popup falls back to a reload
      // prompt.
      fetch(location.href, {
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      })
        .then(async (res) => {
          if (!res.ok) return sendResponse({ detection: null });
          const html = await res.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          // Parsed via DOMParser → no defaultView. Pass the live origin
          // explicitly so the +New same-origin filter can validate hrefs.
          const det = globalThis.WPDetect.detectWordPress(doc, { origin: location.origin });
          if (!det.context.isLoggedIn) {
            det.context.isLoggedIn =
              globalThis.WPDetect.detectLoggedInFromCookies(document.cookie);
          }
          sendResponse({ detection: det });
        })
        .catch(() => sendResponse({ detection: null }));
      return true; // async
    }

    if (msg.type === 'APPLY_ADMIN_BAR_PREF') {
      // Never toggle the admin bar inside wp-admin.
      if (!isWpAdmin) {
        if (msg.hidden) applyHide();
        else applyShow();
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'APPLY_BLOCK_INSPECTOR') {
      applyBlockInspector(!!msg.enabled);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'RESOLVE_HOST_HEADERS') {
      // Same-origin HEAD request — cookies flow, no CORS, minimal payload.
      fetch(location.href, { method: 'HEAD', credentials: 'include' })
        .then((res) => {
          const host = globalThis.WPHost.detectHostFromHeaders(res.headers);
          sendResponse({ host });
        })
        .catch(() => sendResponse({ host: null }));
      return true;
    }

    if (msg.type === 'RESOLVE_EDIT_URL_REST') {
      // Async — return true to keep the message channel open while we
      // hit the REST API from the page context (same-origin, cookies
      // flow for free).
      globalThis.WPRest
        .resolveEditUrlAsync(detection.context, location.origin)
        .then((url) => sendResponse({ url: url || null }))
        .catch(() => sendResponse({ url: null }));
      return true;
    }

    if (msg.type === 'GET_SITE_INFO') {
      // Runs from the page context, so cookies flow automatically. The popup
      // pre-reads window.wpApiSettings.nonce via chrome.scripting (MAIN world,
      // which content scripts can't touch directly) and passes it in — WP's
      // /wp/v2/themes and /wp/v2/plugins reject cookie auth without the
      // X-WP-Nonce header even for read-only GETs.
      const ctx = detection.context;
      const nonce = msg.nonce || null;
      Promise.all([
        globalThis.WPRest.fetchSiteInfo({
          restApiRoot: ctx.restApiRoot, origin: location.origin, nonce,
        }),
        globalThis.WPRest.fetchActiveTheme({
          restApiRoot: ctx.restApiRoot, origin: location.origin, nonce,
        }),
        globalThis.WPRest.fetchPluginsDetail({
          restApiRoot: ctx.restApiRoot, origin: location.origin, nonce,
        }),
      ]).then(([siteInfo, activeTheme, plugins]) => {
        sendResponse({ siteInfo, activeTheme, plugins });
      }).catch(() => sendResponse({ siteInfo: null, activeTheme: null, plugins: null }));
      return true;
    }

    if (msg.type === 'GET_CURRENT_USER') {
      // Fetches /wp/v2/users/me?context=edit. The nonce arrives from the
      // popup via the same MAIN-world extraction that GET_SITE_INFO uses.
      const ctx = detection.context;
      const nonce = msg.nonce || null;
      globalThis.WPRest
        .fetchCurrentUser({ restApiRoot: ctx.restApiRoot, origin: location.origin, nonce })
        .then((user) => sendResponse({ user }))
        .catch(() => sendResponse({ user: null }));
      return true;
    }

    if (msg.type === 'TOGGLE_QUERY_MONITOR') {
      // QM toggles its main panel via a click on the admin-bar link, OR
      // directly via the `.qm-show` class on #query-monitor-main. The
      // admin-bar click path is preferred because it also handles the
      // keyboard focus trap QM sets up; we fall back to the class toggle
      // when the admin bar isn't rendered (user hid it).
      const barLink = document.querySelector('#wp-admin-bar-query-monitor > a');
      const panel = document.getElementById('query-monitor-main');
      if (barLink) {
        barLink.click();
      } else if (panel) {
        panel.classList.toggle('qm-show');
        panel.classList.toggle('qm-peek', false);
      }
      sendResponse({ ok: !!(barLink || panel) });
      return;
    }
  });
})();
