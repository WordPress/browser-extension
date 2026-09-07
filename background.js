/**
 * WordPress Browser Extension — background service worker
 *
 * Responsibilities:
 *   - Cache per-origin detection results in chrome.storage.local
 *   - Refresh cached entries no more than once per REFRESH_INTERVAL
 *   - Purge origins unvisited for longer than PURGE_AFTER
 *   - Update the toolbar icon to reflect WP detection per tab
 *   - Serve cached detection to the popup
 *   - Maintain the user's "My Sites" list (auto-add on fresh login)
 */

// Pure My Sites store helpers, attached to globalThis.WPMySites — shared with
// the popup, which loads the same file as a classic script.
importScripts('lib/my-sites.js');

// REST helpers (globalThis.WPRest). The edit-this-page keyboard shortcut reuses
// resolveEditUrlSync from here rather than maintaining a second copy of the
// admin-URL priority chain and its same-origin guard.
importScripts('lib/rest.js');

// Detection helpers (globalThis.WPDetect). The My Sites gate re-derives
// install bases with deriveBase rather than keeping a second copy of the
// admin-pathname and REST-root rules (see evidenceBackedBase). detect.js is
// browser-API-free by design, so it loads in the worker as-is.
importScripts('lib/detect.js');

// Detection results are cached one storage key per origin (wp_cache_<origin>)
// rather than a single blob, so a page load reads and writes only its own
// origin's entry instead of the whole browsing history, and concurrent writes
// to different origins can't clobber each other.
const CACHE_PREFIX = 'wp_cache_';
// Pre-0.10.1 single-blob cache; discarded once on upgrade (see wipeLegacyCache).
const LEGACY_CACHE_KEY = 'wp_detection_cache_v1';
const REFRESH_INTERVAL      = 7 * 24 * 60 * 60 * 1000;  // 1 week
const PURGE_AFTER           = 28 * 24 * 60 * 60 * 1000;  // 4 weeks
// Host badge clocks (#121). A cached host is re-validated every
// HOST_REFRESH_INTERVAL so a badge cached wrong (a pre-#115 redirect follow,
// or a site that since moved hosts) doesn't persist indefinitely. A missing
// host retries every HOST_RETRY_INTERVAL: shorter, so a one-off probe
// rejection (the #115 same-document gate) doesn't suppress the badge for
// three months, but not per page load, since most self-hosted sites carry no
// host header at all.
const HOST_REFRESH_INTERVAL = 90 * 24 * 60 * 60 * 1000;  // 90 days
const HOST_RETRY_INTERVAL   = 7 * 24 * 60 * 60 * 1000;   // 7 days

// --- Cache helpers (one storage key per origin) ---------------------------

// Keep this prefix in sync with lib/early.js, which reads its origin's entry
// directly at document_start.
function cacheKey(origin) {
  return CACHE_PREFIX + origin;
}

async function getEntry(origin) {
  const key = cacheKey(origin);
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function putEntry(origin, entry) {
  await chrome.storage.local.set({ [cacheKey(origin)]: entry });
}

// Reads every per-origin entry as { origin: entry }. Cold paths only (startup
// repaint, purge) — never per page load.
async function getAllEntries() {
  const all = await chrome.storage.local.get(null);
  const entries = {};
  for (const key of Object.keys(all)) {
    if (key.startsWith(CACHE_PREFIX)) entries[key.slice(CACHE_PREFIX.length)] = all[key];
  }
  return entries;
}

async function purgeStale() {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const stale = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith(CACHE_PREFIX)) continue;
    const entry = all[key];
    if (!entry || !entry.lastSeen || now - entry.lastSeen > PURGE_AFTER) stale.push(key);
  }
  if (stale.length) await chrome.storage.local.remove(stale);
}

// One-time discard of the pre-0.10.1 single-blob cache. Nothing writes that key
// anymore, so removing it once is permanent. My Sites and preferences live
// under separate keys and are untouched; dropped detection results rebuild as
// the user browses.
async function wipeLegacyCache() {
  await chrome.storage.local.remove(LEGACY_CACHE_KEY);
}

// --- Serialized writes for shared single-object stores ---------------------

// The detection cache dodges read-modify-write races with one key per origin
// (see CACHE_PREFIX above). My Sites and the preferences root stay single
// objects (small, read whole by the popup), so every mutation of them funnels
// through this queue instead: writes run one at a time, each seeing the
// previous one's result. chrome.storage.local gives no atomicity across a
// get/set pair — two concurrent writers would both read the old object and
// the later set() would drop the earlier update. The popup and options pages
// send MUTATE_* messages here rather than writing these keys themselves.
const PREFS_KEY = 'wp_preferences_v1';

let storageWriteChain = Promise.resolve();
function enqueueStorageWrite(mutate) {
  const run = storageWriteChain.then(mutate, mutate);
  // Keep the chain alive past a failed write; the caller still sees the
  // rejection through `run`.
  storageWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

// --- My Sites: persistent list of WP installs the user logs into ----------

// Trustworthy install-base evidence only (#94): deriveBase falls back to the
// bare origin for pages carrying no derivation evidence, and a speculative
// bare-origin My Sites row must never be minted from such a page. A
// subdirectory PATH only ever comes from real evidence; any root-equivalent
// value (the bare origin, or slash/query/fragment variants of it — decided on
// the CANONICALIZED candidate, not string equality) needs the page to CONFIRM
// the install is at the root.
//
// Confirmation is never taken from the message's word for it. The claimed
// `evidence` and the values it rides on reach us through page DOM, so the
// gate RE-DERIVES the base with lib/detect.js's deriveBase — the single
// source of truth for both rules — from inputs it can actually trust, and
// requires the result to MATCH the claim:
//
//   - `evidence: 'admin-path'`: re-derived from `pathname`, the
//     browser-attested sender path. WordPress serves wp-admin at <install
//     base>/wp-admin/, so an admin document at <origin>/wp-admin/… fixes the
//     base at the origin definitionally, as strongly as the REST link does
//     (#103: without this route, a root install browsed solely through
//     wp-admin never entered My Sites — admin_head prints no REST discovery
//     link). The match requirement is what keeps it honest: a path under
//     /siteA/wp-admin/ derives /siteA, never the origin, so a subdirectory
//     install cannot claim the root however its DOM is dressed.
//   - the REST route: re-derived from `restApiRoot` itself, which must
//     derive a root-equivalent base — /wp-json/ at the root or a plain
//     /?rest_route=/. A same-origin REST root living under /siteA/wp-json/
//     derives /siteA and confirms nothing about the root. Re-deriving here
//     also keeps recording alive for content scripts orphaned by the update
//     to this build: they still send the pre-#103 context shape (no evidence
//     field) from front-end pages, where the REST link is the evidence. On
//     admin pages an orphaned script has nothing to offer until its tab
//     navigates or the popup opens (the popup reconciles that shape itself —
//     see reconcileProbeBase in the popup source).
//
// deriveBase enforces http(s) and same-origin internally: schemes like blob:
// can parse to a same-origin `origin` while being nothing of the sort, and
// they come back evidence-less. Everything returned here is re-sanitized at
// the storage boundary.
function evidenceBackedBase(origin, baseUrl, restApiRoot, evidence, pathname) {
  if (!baseUrl || typeof baseUrl !== 'string') return null;
  let canonical;
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.origin !== origin) return null;
    canonical = u.origin + u.pathname.replace(/\/+$/, '');
  } catch (_) {
    return null;
  }
  if (canonical !== origin) return baseUrl; // real subdirectory path
  if (evidence === 'admin-path' && typeof pathname === 'string') {
    const viaAdmin = WPDetect.deriveBase(origin, null, pathname);
    if (viaAdmin.evidence === 'admin-path' && viaAdmin.baseUrl === origin) return origin;
    // An admin claim the attested path can't reproduce gets no shortcut —
    // but the REST route below may still confirm the root on its own terms.
  }
  if (restApiRoot && typeof restApiRoot === 'string') {
    const viaRest = WPDetect.deriveBase(origin, restApiRoot, null);
    if (viaRest.evidence === 'rest' && viaRest.baseUrl === origin) return origin;
  }
  return null;
}

// Record a logged-in WordPress site, applying the curation rule in
// lib/my-sites.js. Removal is sticky — passive detection never re-adds a
// record the user dismissed (restoring is an explicit future feature) — so
// no login-transition state is tracked or needed. `pathname` comes from the
// browser-attested sender URL and lets a login with no base evidence be
// attributed to the existing install owning the path.
async function recordLogin(origin, baseUrl, iconUrl, pathname) {
  if (!origin) return;
  await enqueueStorageWrite(async () => {
    const data = await chrome.storage.local.get(WPMySites.STORE_KEY);
    const orig = data[WPMySites.STORE_KEY] || {};
    // Re-key a pre-#94 origin-keyed store before the upsert so keying and
    // attribution see canonical install-base keys. Idempotent — a
    // same-reference no-op on every store this build has written.
    const store = WPMySites.migrateStore(orig);
    const next = WPMySites.upsertOnLogin(store, {
      origin, baseUrl: baseUrl || null, iconUrl: iconUrl || null,
      now: Date.now(), pathname: pathname || null,
    });
    if (next !== orig) {
      await chrome.storage.local.set({ [WPMySites.STORE_KEY]: next });
    }
  });
}

// Popup curation actions (rename / remove), serialized against recordLogin
// and each other so a login racing a curation edit can't drop either write.
async function mutateMySites({ op, key, name }) {
  if (typeof key !== 'string' || !key) throw new Error('bad key');
  return enqueueStorageWrite(async () => {
    const data = await chrome.storage.local.get(WPMySites.STORE_KEY);
    const orig = data[WPMySites.STORE_KEY] || {};
    // Migrate first, then apply: the popup canonicalizes its snapshot with
    // the same pure migrateStore before rendering, so the key it sends is
    // canonical and addresses the record regardless of whether a queued
    // login re-keyed the persisted store in the meantime.
    let next = WPMySites.migrateStore(orig);
    if (op === 'remove') next = WPMySites.removeSite(next, key);
    else if (op === 'rename') next = WPMySites.renameSite(next, key, name);
    if (next !== orig) {
      await chrome.storage.local.set({ [WPMySites.STORE_KEY]: next });
    }
    return next;
  });
}

// Writes one preference field into `wp_preferences_v1[ns]` (`ns` is an origin
// or the options page's '_global' namespace), serialized so a popup toggle
// can't clobber a concurrent options-page write or vice versa.
async function mutatePref({ ns, key, value }) {
  if (typeof ns !== 'string' || !ns) throw new Error('bad ns');
  if (typeof key !== 'string' || !key) throw new Error('bad key');
  const t = typeof value;
  if (!(value === null || t === 'boolean' || t === 'number' || t === 'string')) {
    throw new Error('bad value');
  }
  return enqueueStorageWrite(async () => {
    const data = await chrome.storage.local.get(PREFS_KEY);
    const root = data[PREFS_KEY] || {};
    const next = { ...root, [ns]: { ...(root[ns] || {}), [key]: value } };
    await chrome.storage.local.set({ [PREFS_KEY]: next });
    return next;
  });
}

// --- Detection handling ---------------------------------------------------

chrome.runtime.onStartup.addListener(onLoad);
chrome.runtime.onInstalled.addListener(onLoad);

async function onLoad() {
  await wipeLegacyCache();
  // Canonicalize a pre-#94 origin-keyed My Sites store proactively so the
  // popup renders canonical keys from its first open after an update; the
  // per-write migrateStore in recordLogin/mutateMySites stays as the
  // defensive backstop.
  await enqueueStorageWrite(async () => {
    const data = await chrome.storage.local.get(WPMySites.STORE_KEY);
    const orig = data[WPMySites.STORE_KEY] || {};
    const next = WPMySites.migrateStore(orig);
    if (next !== orig) {
      await chrome.storage.local.set({ [WPMySites.STORE_KEY]: next });
    }
  });
  await purgeStale();
  await repaintAllTabs();
}

// On SW startup (browser launch) and onInstalled (extension install/reload)
// the content scripts in already-open tabs are orphaned and can no longer
// report to us, so their toolbar icons stay at the default until the user
// navigates. Walk the open tabs and re-paint from cache instead.
async function repaintAllTabs() {
  let tabs;
  try { tabs = await chrome.tabs.query({}); } catch (_) { return; }
  const entries = await getAllEntries();
  for (const tab of tabs) {
    if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) continue;
    try {
      const origin = new URL(tab.url).origin;
      const entry = entries[origin];
      await updateToolbar(
        tab.id,
        entry?.isWordPress || false,
        { isLoggedIn: entry?.isLoggedIn || false },
      );
    } catch (_) { /* invalid URL or tab closed */ }
  }
}

// Origin as attested by the browser rather than taken from the message body:
// sender.origin when present, else the sender tab's URL. Page JS can't forge
// either, so cache and My Sites writes key off this instead of a spoofable
// msg.origin.
function originFromSender(sender) {
  if (sender && sender.origin) return sender.origin;
  try {
    return sender && sender.tab && sender.tab.url ? new URL(sender.tab.url).origin : null;
  } catch (_) {
    return null;
  }
}

// Pathname of the sending document, likewise browser-attested: sender.url
// when present, else the sender tab's URL. Same two-source shape as
// originFromSender, and for the same reason — a My Sites decision must never
// rest on a path the page could choose. Content scripts are top-frame only
// (manifest `all_frames: false`), so the two agree; the tab fallback matters
// where sender.url is unavailable, and both the admin-path evidence check and
// subdirectory login attribution depend on getting a path at all.
function pathnameFromSender(sender) {
  const url = (sender && sender.url)
    || (sender && sender.tab && sender.tab.url)
    || null;
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch (_) {
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'WP_DETECTION') {
    if (!sender.tab) return; // only accept from content scripts
    handleDetection(msg, sender)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true; // keep channel open for async response
  }

  if (msg.type === 'GET_CACHED_DETECTION') {
    // A content script may read only its OWN origin's entry — otherwise the
    // cache doubles as a cross-origin history oracle (ask about any origin,
    // learn whether the user has visited or is logged into it). The popup has
    // no sender.tab and legitimately asks about the active tab's origin.
    if (sender.tab && msg.origin !== originFromSender(sender)) {
      sendResponse(null);
      return true;
    }
    getEntry(msg.origin).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }

  // Popup pushes back its final detection (which may include the cookie-API
  // login override) so the toolbar icon and cache reflect it without waiting
  // for a navigation. Popup-only: a content-script context must not be able to
  // forge a resolution for an arbitrary origin/tab (it carries a sender.tab).
  if (msg.type === 'POPUP_DETECTION_RESOLVED') {
    if (sender.tab) return;
    handlePopupResolution(msg)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  // Mobile Preview opens route through here (not the popup calling
  // windows.create) so a repeat click reuses the site's preview window —
  // navigated to the requested page and focused — instead of stacking a
  // duplicate, and so the Safari size re-assert (issue #13) outlives the
  // popup. Extension pages only — a content script must not be able to open
  // or steer windows.
  if (msg.type === 'OPEN_MOBILE_PREVIEW') {
    if (!isExtensionPageSender(sender)) return;
    openOrFocusPreview(msg.url, msg.enforceSize)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true; // async response
  }

  // Extension pages route their My Sites / preference writes through here so
  // every read-modify-write of those shared objects is serialized (see
  // enqueueStorageWrite). Extension pages only — a content script must not be
  // able to curate My Sites or flip preferences. `sender.tab` can't tell the
  // two apart (the options page opens in a real tab), but the sender URL can.
  if (msg.type === 'MUTATE_MY_SITES') {
    if (!isExtensionPageSender(sender)) return;
    mutateMySites(msg)
      .then((store) => sendResponse({ ok: true, store }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'MUTATE_PREF') {
    if (!isExtensionPageSender(sender)) return;
    mutatePref(msg)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  // Early downgrade hint from lib/early.js at DOMContentLoaded (#59): the
  // icon painted from cache can claim logged-in for seconds before full
  // detection reports the logged-out DOM at document_idle. Content scripts
  // only (origin is browser-attested, like WP_DETECTION), and downgrade-only:
  // a hint can never set logged-in, so a forged hint is powerless beyond
  // hastening what full detection would conclude anyway.
  if (msg.type === 'WP_LOGIN_HINT') {
    if (!sender.tab || msg.loggedIn !== false) return;
    const origin = originFromSender(sender);
    if (!origin) return;
    (async () => {
      const entry = await getEntry(origin);
      if (!entry || !entry.isLoggedIn) return;
      entry.isLoggedIn = false;
      await putEntry(origin, entry);
      await updateToolbar(sender.tab.id, !!entry.isWordPress, { isLoggedIn: false });
    })().catch(() => {});
    return;
  }
});

// True when a message came from one of this extension's own pages (popup, or
// the options page — which opens in a normal tab, so sender.tab is set for
// it). Content scripts carry the web page's URL instead of an extension URL.
function isExtensionPageSender(sender) {
  try {
    return !!(sender && sender.url && sender.url.startsWith(chrome.runtime.getURL('')));
  } catch (_) {
    return false;
  }
}

// --- Mobile Preview windows ------------------------------------------------
//
// One preview window per site: the map keys on the URL's origin, so browsing
// around a site reuses the window already open for it (navigated to the new
// page and focused) while distinct sites keep distinct windows that can sit
// side by side. Origin rather than registrable domain on purpose: WordPress
// treats the scheme as part of the site URL, multisite subdomain installs are
// separate sites, and domain grouping would need public-suffix logic for no
// gain. It also matches how the detection cache is keyed. Tracking our own ids
// (rather than scanning windows.getAll and matching tab.url) needs no host
// access, so it's unaffected by Safari's user-gated host permissions, and it
// only ever touches windows we actually opened.
//
// The map lives in chrome.storage.session so it survives the service worker
// being evicted between clicks — a plain variable would be gone by the next
// click and the duplicate would return. session is cleared on browser restart,
// which is right: a window id means nothing across a restart. Safari added
// storage.session in 16.4; where it's absent we fall back to a module-level
// object, still correct within a single worker lifetime.
const PREVIEW_W = 393;
const PREVIEW_H = 852;
const PREVIEW_WINDOWS_KEY = 'wp_preview_windows';
const sessionStore = chrome.storage && chrome.storage.session ? chrome.storage.session : null;
let previewWindowsFallback = {}; // origin -> windowId, used only when storage.session is absent

async function getPreviewWindows() {
  if (!sessionStore) return { ...previewWindowsFallback };
  try {
    const data = await sessionStore.get(PREVIEW_WINDOWS_KEY);
    return data[PREVIEW_WINDOWS_KEY] || {};
  } catch (_) {
    return {};
  }
}

async function setPreviewWindows(map) {
  if (!sessionStore) { previewWindowsFallback = map; return; }
  try {
    await sessionStore.set({ [PREVIEW_WINDOWS_KEY]: map });
  } catch (_) { /* ignore — worst case is one duplicate window */ }
}

// Reuse the preview already open for this URL's origin — navigate it to the
// requested page and focus it — else open a new one. Navigating on every reuse
// (rather than only when the URL differs) is deliberate: without the tabs
// permission we cannot read what the window currently shows, and always
// pointing it at the requested page keeps it honest even after the user
// browses inside it. A stored id whose window the user has closed makes
// windows.get throw; we drop it and open fresh, so no close listener is needed
// to prune the map. enforceSize is set by the popup on Safari only (see #13).
async function openOrFocusPreview(url, enforceSize) {
  if (typeof url !== 'string' || !url) return;
  let origin;
  try {
    origin = new URL(url).origin;
  } catch (_) {
    return; // not a URL we can key — the popup never sends these
  }

  const windows = await getPreviewWindows();
  const existingId = windows[origin];
  if (existingId != null) {
    try {
      // populate:true exposes the window's tab id (never gated — only url and
      // title need the tabs permission), which tabs.update needs to navigate.
      const win = await chrome.windows.get(existingId, { populate: true });
      const tab = win.tabs && win.tabs[0];
      if (tab && tab.id != null) await chrome.tabs.update(tab.id, { url });
      await chrome.windows.update(existingId, { focused: true });
      return;
    } catch (_) {
      delete windows[origin]; // stale id — fall through and open fresh
    }
  }

  let win;
  try {
    win = await chrome.windows.create({ url, type: 'popup', width: PREVIEW_W, height: PREVIEW_H });
  } catch (err) {
    await setPreviewWindows(windows); // persist the stale-id eviction above
    throw err; // surfaces as { ok: false } to the popup
  }
  if (win && win.id != null) {
    windows[origin] = win.id;
    if (enforceSize) enforcePreviewSize(win.id, PREVIEW_W, PREVIEW_H);
  }
  await setPreviewWindows(windows);
}

// Polls until the window accepts the requested size or closes. Safari ignores
// the size on create and takes a beat before it honors an update, so we
// re-assert on a short interval and stop as soon as it sticks.
async function enforcePreviewSize(winId, width, height) {
  if (winId == null) return;
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    let win;
    try {
      win = await chrome.windows.get(winId);
    } catch (_) {
      return; // window closed
    }
    if (win.state === 'normal' && Math.abs((win.width || 0) - width) <= 40) return; // sized + un-maximized
    try {
      // state:'normal' clears the maximized/zoomed state the window inherited
      // from its parent, so dragging it doesn't snap back to the parent's width.
      await chrome.windows.update(winId, { state: 'normal', width, height });
    } catch (_) {
      return;
    }
  }
}

async function handlePopupResolution(msg) {
  const {
    origin, tabId, isLoggedIn, isWordPress, baseUrl, restApiRoot,
    baseUrlEvidence, siteIconUrl, pathname,
  } = msg;
  if (!origin) return;
  const existing = await getEntry(origin);
  if (existing) {
    existing.isLoggedIn = !!isLoggedIn;
    existing.lastSeen = Date.now();
    await putEntry(origin, existing);
  }
  if (tabId) await updateToolbar(tabId, !!isWordPress, { isLoggedIn });

  // Catches cookie-API logins the page DOM missed (logged-out HTML).
  if (isWordPress && isLoggedIn) {
    const path = typeof pathname === 'string' ? pathname : null;
    await recordLogin(
      origin,
      evidenceBackedBase(origin, baseUrl, restApiRoot, baseUrlEvidence, path),
      siteIconUrl,
      path,
    );
  }
}

async function handleDetection(msg, sender) {
  const { detection, hostFromDOM } = msg;
  // Key off the browser-attested origin, not msg.origin: a compromised renderer
  // could otherwise write or overwrite another origin's cache / My Sites entry.
  const origin = originFromSender(sender);
  if (!origin) return;
  const now = Date.now();
  const existing = await getEntry(origin);

  // Decide whether to trust this detection or the cache.
  // - If the current page strongly suggests WP, use it.
  // - If not, keep the cached answer (the home page may have different
  //   signals than a deep page; headless WP setups especially).
  const freshlyDetected = detection.isWordPress;
  const cacheIsFresh = existing &&
                       existing.isWordPress &&
                       (now - existing.checkedAt) < REFRESH_INTERVAL;

  // Host: prefer a fresh DOM signal, fall back to cached value.
  const host = hostFromDOM || existing?.host || null;
  const hostCheckedAt = hostFromDOM ? now : (existing?.hostCheckedAt || null);

  const entry = {
    origin,
    isWordPress: freshlyDetected || cacheIsFresh || false,
    confidence: Math.max(
      detection.confidence,
      existing ? existing.confidence : 0,
    ),
    signals: detection.signals,
    // Cached so the toolbar repaint after SW startup/install can show the
    // active variant without waiting for fresh detection. May be stale if
    // the user logs out elsewhere; corrected on next page load and by the
    // popup pushing its cookie-API result via POPUP_DETECTION_RESOLVED.
    isLoggedIn: !!detection.context?.isLoggedIn,
    // Only advance checkedAt when we have a confident positive detection,
    // so a single ambiguous page view doesn't reset the clock.
    checkedAt: freshlyDetected
      ? now
      : (existing?.checkedAt || now),
    lastSeen: now,
    host,
    hostCheckedAt,
  };

  // If WordPress and the host badge is due, ask the content script to
  // inspect response headers: a cached host on the refresh clock, a missing
  // one on the shorter retry clock (see the interval constants). The probe's
  // answer replaces whatever was cached, null included, so the badge always
  // reflects the latest probe. Resolve before the first write so we don't
  // write twice.
  const hostInterval = entry.host ? HOST_REFRESH_INTERVAL : HOST_RETRY_INTERVAL;
  const needsHostCheck = entry.isWordPress &&
    (!entry.hostCheckedAt || (now - entry.hostCheckedAt) > hostInterval);

  if (needsHostCheck) {
    try {
      const res = await chrome.tabs.sendMessage(
        sender.tab.id, { type: 'RESOLVE_HOST_HEADERS' },
      );
      entry.host = res?.host || null;
      entry.hostCheckedAt = now;
    } catch (_) { /* content script gone */ }
  }

  await putEntry(origin, entry);
  await updateToolbar(sender.tab.id, entry.isWordPress, detection.context);

  // Add to "My Sites" on a logged-in WordPress install, keyed by the
  // evidence-backed base. With no evidence, upsertOnLogin attributes the
  // login to the existing record owning the pathname (browser-attested
  // sender URL, not the message) or drops it — never a speculative
  // bare-origin row. Removal is sticky, so no prior-state capture is needed.
  if (entry.isWordPress && entry.isLoggedIn) {
    const pathname = pathnameFromSender(sender);
    await recordLogin(
      origin,
      evidenceBackedBase(
        origin,
        detection.context?.baseUrl,
        detection.context?.restApiRoot,
        detection.context?.baseUrlEvidence,
        pathname,
      ),
      detection.context?.siteIconUrl,
      pathname,
    );
  }
}

// --- Toolbar icon + title -------------------------------------------------

// chrome.action.setIcon resolves its promise even when the target tab has
// closed or navigated away — it reports the failure as an unchecked
// chrome.runtime.lastError instead, so an awaited try/catch never catches it
// and it surfaces a red "Errors" badge on the extension card. (setTitle does
// reject and could be awaited, but both use the callback form so each consumes
// its own lastError.) updateToolbar runs on every tabs.onUpdated tick, exactly
// when a tab can vanish mid-navigation; a missing tab here is expected.
const ignoreLastError = () => void chrome.runtime.lastError;

async function updateToolbar(tabId, isWordPress, context) {
  // Three states: not WP (gray + slash), WP but not logged in (gray),
  // WP + logged in (blue). On a tab-URL-change refresh the icon paints from
  // the cached entry (including its isLoggedIn), then corrects when the
  // content script reports in — early.js hints a logged-in→logged-out
  // downgrade at DOMContentLoaded (#59) so a stale blue doesn't linger to
  // document_idle.
  const variant = !isWordPress ? '-inactive'
    : context?.isLoggedIn ? '-active'
    : '';
  chrome.action.setIcon({
    tabId,
    path: {
      16: `icons/icon-16${variant}.png`,
      32: `icons/icon-32${variant}.png`,
    },
  }, ignoreLastError);

  const title = isWordPress
    ? chrome.i18n.getMessage(context?.isLoggedIn ? 'toolbar_title_detected_logged_in' : 'toolbar_title_detected') // "WordPress detected — logged in" / "WordPress detected"
    : chrome.i18n.getMessage('toolbar_title_default'); // "WordPress Browser Extension"
  chrome.action.setTitle({ tabId, title }, ignoreLastError);
}

// --- Keyboard shortcut: edit this page ------------------------------------

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'edit-this-page') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) return;

  // Ask the content script for live detection — it has the freshest context.
  let result;
  try {
    result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_LIVE_DETECTION' });
  } catch (_) { return; /* content script unreachable */ }

  if (!result?.detection?.isWordPress) return;
  const ctx = result.detection.context || {};
  if (!ctx.isLoggedIn) return;

  const origin = result.origin;

  // Sync resolution via the shared resolver: same-origin/wp-admin guard on the
  // admin-bar href, then post.php / term.php / user-edit.php by page type, all
  // path-aware for subdirectory installs (#33). Kept identical to the popup's
  // Edit action by reusing lib/rest.js rather than a hand-copied chain.
  let editUrl = WPRest.resolveEditUrlSync(ctx, origin);

  // If sync didn't resolve, try the REST fallback via content script.
  if (!editUrl) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'RESOLVE_EDIT_URL_REST' });
      editUrl = res?.url || null;
    } catch (_) { /* content script gone */ }
  }

  if (editUrl) {
    // Await + guard: the active tab can close or navigate between resolving
    // the edit URL (which may involve an async REST round-trip above) and this
    // navigation. A fire-and-forget update against a gone tab surfaces an
    // "Unchecked runtime.lastError: No tab with id" in the service worker.
    try {
      await chrome.tabs.update(tab.id, { url: editUrl });
    } catch (_) { /* tab closed before we could navigate it */ }
  }
});

// Re-check cache when a tab changes URL, so the icon reflects cached state
// even before the content script reports in.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'loading') return;
  if (!tab.url || !/^https?:/.test(tab.url)) return;

  try {
    const origin = new URL(tab.url).origin;
    const entry = await getEntry(origin);
    if (entry) await updateToolbar(tabId, entry.isWordPress, {
      isLoggedIn: entry.isLoggedIn || false,
    });
  } catch (_) { /* invalid URL */ }
});
