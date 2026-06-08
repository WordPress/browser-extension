/**
 * WordPress Browser Extension — background service worker
 *
 * Responsibilities:
 *   - Cache per-origin detection results in chrome.storage.local
 *   - Refresh cached entries no more than once per REFRESH_INTERVAL
 *   - Purge origins unvisited for longer than PURGE_AFTER
 *   - Update the toolbar icon to reflect WP detection per tab
 *   - Serve cached detection to the popup
 */

const CACHE_KEY = 'wp_detection_cache_v1';
const REFRESH_INTERVAL      = 7 * 24 * 60 * 60 * 1000;  // 1 week
const PURGE_AFTER           = 28 * 24 * 60 * 60 * 1000;  // 4 weeks
const HOST_REFRESH_INTERVAL = 90 * 24 * 60 * 60 * 1000;  // 90 days

// --- Cache helpers --------------------------------------------------------

async function getCache() {
  const data = await chrome.storage.local.get(CACHE_KEY);
  return data[CACHE_KEY] || {};
}

async function writeCache(cache) {
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

async function getEntry(origin) {
  const cache = await getCache();
  return cache[origin] || null;
}

async function upsertEntry(origin, entry) {
  const cache = await getCache();
  cache[origin] = entry;
  await writeCache(cache);
}

async function purgeStale() {
  const cache = await getCache();
  const now = Date.now();
  let changed = false;
  for (const origin of Object.keys(cache)) {
    const entry = cache[origin];
    if (!entry || !entry.lastSeen || now - entry.lastSeen > PURGE_AFTER) {
      delete cache[origin];
      changed = true;
    }
  }
  if (changed) await writeCache(cache);
}

// --- Detection handling ---------------------------------------------------

chrome.runtime.onStartup.addListener(onLoad);
chrome.runtime.onInstalled.addListener(onLoad);

async function onLoad() {
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
  const cache = await getCache();
  for (const tab of tabs) {
    if (!tab.id || !tab.url || !/^https?:/.test(tab.url)) continue;
    try {
      const origin = new URL(tab.url).origin;
      const entry = cache[origin];
      await updateToolbar(
        tab.id,
        entry?.isWordPress || false,
        { isLoggedIn: entry?.isLoggedIn || false },
      );
    } catch (_) { /* invalid URL or tab closed */ }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'WP_DETECTION') {
    if (!sender.tab) return; // only accept from content scripts
    handleDetection(msg, sender).then(() => sendResponse({ ok: true }));
    return true; // keep channel open for async response
  }

  if (msg.type === 'GET_CACHED_DETECTION') {
    getEntry(msg.origin).then(sendResponse);
    return true;
  }

  // Popup pushes back its final detection (which may include the cookie-API
  // login override) so the toolbar icon and cache reflect it without waiting
  // for a navigation.
  if (msg.type === 'POPUP_DETECTION_RESOLVED') {
    handlePopupResolution(msg).then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function handlePopupResolution(msg) {
  const { origin, tabId, isLoggedIn, isWordPress } = msg;
  if (!origin) return;
  const cache = await getCache();
  const existing = cache[origin] || null;
  if (existing) {
    existing.isLoggedIn = !!isLoggedIn;
    existing.lastSeen = Date.now();
    cache[origin] = existing;
    await writeCache(cache);
  }
  if (tabId) await updateToolbar(tabId, !!isWordPress, { isLoggedIn });
}

async function handleDetection(msg, sender) {
  const { origin, detection, hostFromDOM } = msg;
  const now = Date.now();
  const cache = await getCache();
  const existing = cache[origin] || null;

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

  // If WordPress but host is still unknown and we haven't checked
  // recently, ask the content script to inspect response headers.
  // Resolve before the first write so we don't write twice.
  const needsHostCheck = entry.isWordPress && !entry.host &&
    (!entry.hostCheckedAt || (now - entry.hostCheckedAt) > HOST_REFRESH_INTERVAL);

  if (needsHostCheck) {
    try {
      const res = await chrome.tabs.sendMessage(
        sender.tab.id, { type: 'RESOLVE_HOST_HEADERS' },
      );
      entry.host = res?.host || null;
      entry.hostCheckedAt = now;
    } catch (_) { /* content script gone */ }
  }

  cache[origin] = entry;
  await writeCache(cache);
  await updateToolbar(sender.tab.id, entry.isWordPress, detection.context);
}

// --- Toolbar icon + title -------------------------------------------------

async function updateToolbar(tabId, isWordPress, context) {
  // Three states: not WP (gray + slash), WP but not logged in (gray),
  // WP + logged in (blue). The cache doesn't carry isLoggedIn so on a
  // tab-URL-change icon refresh we'll briefly show the gray "WP" variant
  // until the content script reports back with auth context.
  const variant = !isWordPress ? '-inactive'
    : context?.isLoggedIn ? '-active'
    : '';
  try {
    await chrome.action.setIcon({
      tabId,
      path: {
        16: `icons/icon-16${variant}.png`,
        32: `icons/icon-32${variant}.png`,
      },
    });
  } catch (_) { /* icons not shipped yet */ }

  const title = isWordPress
    ? chrome.i18n.getMessage(context?.isLoggedIn ? 'toolbar_title_detected_logged_in' : 'toolbar_title_detected') // "WordPress detected — logged in" / "WordPress detected"
    : chrome.i18n.getMessage('toolbar_title_default'); // "WordPress Browser Extension"
  try {
    await chrome.action.setTitle({ tabId, title });
  } catch (_) { /* tab may have closed */ }
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

  // Try sync resolution first (covers most cases).
  // resolveEditUrlSync isn't available here (it's in lib/rest.js, loaded
  // only in content scripts), so we inline the priority logic.
  let editUrl = null;
  if (ctx.adminBarEditHref) {
    try {
      if (new URL(ctx.adminBarEditHref).origin === origin) editUrl = ctx.adminBarEditHref;
    } catch (_) { /* malformed href — ignore */ }
  }

  if (!editUrl && ctx.postId && ctx.pageType === 'single') {
    editUrl = `${origin}/wp-admin/post.php?post=${ctx.postId}&action=edit`;
  }
  if (!editUrl && ctx.pageType === 'term' && ctx.taxonomy && ctx.termId) {
    editUrl = `${origin}/wp-admin/term.php?taxonomy=${encodeURIComponent(ctx.taxonomy)}&tag_ID=${ctx.termId}`;
  }
  if (!editUrl && ctx.pageType === 'author' && ctx.authorId) {
    editUrl = `${origin}/wp-admin/user-edit.php?user_id=${ctx.authorId}`;
  }

  // If sync didn't resolve, try the REST fallback via content script.
  if (!editUrl) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'RESOLVE_EDIT_URL_REST' });
      editUrl = res?.url || null;
    } catch (_) { /* content script gone */ }
  }

  if (editUrl) {
    chrome.tabs.update(tab.id, { url: editUrl });
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
