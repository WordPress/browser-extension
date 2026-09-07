/**
 * Storage-write serialization tests for background.js.
 *
 * Loads the real background service worker under a stubbed chrome whose
 * storage.local yields to the event loop between get and set — the same
 * window in which a concurrent writer clobbers a read-modify-write pair.
 * Every mutation of the shared My Sites / preferences objects must funnel
 * through the background's serialized write queue and survive races.
 *
 *   cd test && npm install && npm test
 */
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const mySitesSrc = read('lib', 'my-sites.js');
const restSrc = read('lib', 'rest.js');
const backgroundSrc = read('background.js');

/** The popup's own base-recovery helper, wired to the REAL lib/detect.js, so
 * the frontend seam and the background gate are exercised as one pipeline
 * rather than two separately-mocked halves. */
function loadAdminBaseFromProbe() {
  const detectCtx = {};
  new Function('globalThis', read('lib', 'detect.js'))(detectCtx);
  const src = read('src', 'popup', 'lib', 'adminBase.js').replace(/^export /gm, '');
  return new Function('window', `${src}\nreturn adminBaseFromProbe;`)({ WPDetect: detectCtx.WPDetect });
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('  FAIL:', msg); }
  else       {             console.log ('  ok  :', msg); }
}

const EXT_URL = 'chrome-extension://test-extension-id/';
const POPUP_SENDER = { url: `${EXT_URL}dist/popup.html` };
const OPTIONS_SENDER = {
  url: `${EXT_URL}options/options.html`,
  tab: { id: 12, url: `${EXT_URL}options/options.html` }, // options opens in a real tab
};
const CONTENT_SENDER = { url: 'https://evil.example/page', tab: { id: 3, url: 'https://evil.example/page' } };

const MY_SITES_KEY = 'wp_my_sites_v1';
const PREFS_KEY = 'wp_preferences_v1';

/** chrome.storage stub (local + session): async, deep-copying, with an
 * event-loop yield inside get and set so unserialized read-modify-write pairs
 * interleave. session mirrors local so the Mobile Preview window map — which
 * lives in storage.session — runs against its real code path. */
function makeStorage(initial = {}) {
  const tick = () => new Promise((r) => setImmediate(r));
  const areaFor = (store) => ({
    get: async (key) => {
      await tick();
      if (key === null || key === undefined) return structuredClone(store.data);
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (k in store.data) out[k] = structuredClone(store.data[k]);
      return out;
    },
    set: async (obj) => {
      await tick();
      for (const [k, v] of Object.entries(obj)) store.data[k] = structuredClone(v);
    },
    remove: async (keys) => {
      await tick();
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store.data[k];
    },
  });
  const local = { data: structuredClone(initial) };
  const session = { data: {} };
  return {
    local: areaFor(local),
    session: areaFor(session),
    read: (k) => structuredClone(local.data[k]),
  };
}

/** Loads background.js with stubs; returns the captured onMessage listener
 * plus the storage handle. */
function loadBackground(storage, overrides = {}) {
  // The lib IIFEs attach to the passed globalThis object.
  const libCtx = {};
  new Function('globalThis', mySitesSrc)(libCtx);
  new Function('globalThis', 'document', 'window', restSrc)(libCtx, undefined, undefined);
  new Function('globalThis', read('lib', 'detect.js'))(libCtx);

  const listeners = { message: [] };
  const iconCalls = [];
  const noopEvent = { addListener: () => {} };

  // Stateful windows stub: models open/closed windows so the Mobile Preview
  // reuse path (create once, navigate + focus on repeat, reopen after close)
  // can be observed. get() throws for a window the test has closed, exactly
  // like the real API when openOrFocusPreview probes a stale id. Each window
  // carries one tab (id + 5000) so the populate/tabs.update navigation path
  // runs against its real shape.
  const winState = { nextId: 1000, open: new Set(), created: [], focused: [], navigated: [] };
  const chromeStub = {
    runtime: {
      getURL: (p) => EXT_URL + p,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onStartup: noopEvent,
      onInstalled: noopEvent,
      lastError: undefined,
    },
    storage,
    tabs: {
      onUpdated: noopEvent,
      query: async () => [],
      sendMessage: overrides.sendMessage || (async () => ({})),
      update: async (tabId, opts) => {
        if (typeof tabId === 'number' && opts && opts.url) {
          winState.navigated.push({ tabId, url: opts.url });
        }
        return { id: tabId };
      },
    },
    action: {
      setIcon: (opts, cb) => { iconCalls.push(opts); cb && cb(); },
      setTitle: (_o, cb) => cb && cb(),
    },
    i18n: { getMessage: (key) => `[i18n:${key}]` },
    commands: { onCommand: noopEvent },
    windows: {
      create: async ({ url }) => {
        const id = winState.nextId++;
        winState.open.add(id);
        winState.created.push({ id, url });
        return { id };
      },
      get: async (id, opts) => {
        if (!winState.open.has(id)) throw new Error('no such window');
        const win = { id, state: 'normal', width: 393 };
        if (opts && opts.populate) win.tabs = [{ id: id + 5000, windowId: id }];
        return win;
      },
      update: async (id, opts) => {
        if (opts && opts.focused) winState.focused.push(id);
        return { id };
      },
    },
  };

  new Function('globalThis', 'chrome', 'importScripts', 'WPMySites', 'WPRest', 'WPDetect', backgroundSrc)(
    {}, chromeStub, () => {}, libCtx.WPMySites, libCtx.WPRest, libCtx.WPDetect,
  );

  assert(listeners.message.length === 1, 'background registered one onMessage listener');
  const listener = listeners.message[0];

  // Drives the listener the way the browser does: resolves with whatever
  // sendResponse gets, or undefined when the message was ignored.
  const send = (msg, sender) =>
    new Promise((resolve) => {
      const keptOpen = listener(msg, sender, resolve);
      if (keptOpen !== true) resolve(undefined);
    });

  // Simulates the user closing a window: drops it from the open set so a later
  // windows.get(id) throws, the way the real API does for a gone window.
  const closeWindow = (id) => winState.open.delete(id);

  return { send, WPMySites: libCtx.WPMySites, iconCalls, winState, closeWindow };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

async function main() {
  // --- 34. Concurrent My Sites curation edits both persist ----------------
  {
    console.log('\n[34] concurrent renames of two sites both persist');
    const seedLib = {};
    new Function('globalThis', mySitesSrc)(seedLib);
    let seed = seedLib.WPMySites.upsertOnLogin({}, { origin: 'https://a.example', baseUrl: 'https://a.example', now: 1000 });
    seed = seedLib.WPMySites.upsertOnLogin(seed, { origin: 'https://b.example', baseUrl: 'https://b.example', now: 2000 });
    const storage = makeStorage({ [MY_SITES_KEY]: seed });
    const { send } = loadBackground(storage);

    const [resA, resB] = await Promise.all([
      send({ type: 'MUTATE_MY_SITES', op: 'rename', key: 'https://a.example', name: 'Site A' }, POPUP_SENDER),
      send({ type: 'MUTATE_MY_SITES', op: 'rename', key: 'https://b.example', name: 'Site B' }, POPUP_SENDER),
    ]);
    await settle();
    const store = storage.read(MY_SITES_KEY);
    assert(resA?.ok === true && resB?.ok === true, 'both mutations acknowledged');
    assert(store['https://a.example']?.customName === 'Site A', 'first rename persisted');
    assert(store['https://b.example']?.customName === 'Site B', 'second rename persisted (not clobbered)');
  }

  // --- 35. Popup pref racing an options-page pref both persist ------------
  {
    console.log('\n[35] concurrent per-origin and _global pref writes both persist');
    const storage = makeStorage({});
    const { send } = loadBackground(storage);

    const [r1, r2] = await Promise.all([
      send({ type: 'MUTATE_PREF', ns: 'https://a.example', key: 'adminBarHidden', value: true }, POPUP_SENDER),
      send({ type: 'MUTATE_PREF', ns: '_global', key: 'siteInfoEnabled', value: true }, OPTIONS_SENDER),
    ]);
    await settle();
    const prefs = storage.read(PREFS_KEY);
    assert(r1?.ok === true && r2?.ok === true, 'both writes acknowledged');
    assert(prefs['https://a.example']?.adminBarHidden === true, 'per-origin pref persisted');
    assert(prefs._global?.siteInfoEnabled === true, 'global default persisted (not clobbered)');
  }

  // --- 36. Login recording racing a curation removal -----------------------
  {
    console.log('\n[36] background login racing a popup removal preserves both');
    const seedLib = {};
    new Function('globalThis', mySitesSrc)(seedLib);
    const seed = seedLib.WPMySites.upsertOnLogin({}, { origin: 'https://old.example', baseUrl: 'https://old.example', now: 1000 });
    const storage = makeStorage({ [MY_SITES_KEY]: seed });
    const { send } = loadBackground(storage);

    await Promise.all([
      send({
        type: 'POPUP_DETECTION_RESOLVED',
        origin: 'https://new.example',
        isWordPress: true,
        isLoggedIn: true,
        baseUrl: 'https://new.example',
        // A bare-origin base needs the page's REST root as evidence (#94).
        restApiRoot: 'https://new.example/wp-json/',
      }, POPUP_SENDER),
      send({ type: 'MUTATE_MY_SITES', op: 'remove', key: 'https://old.example' }, POPUP_SENDER),
    ]);
    await settle();
    const store = storage.read(MY_SITES_KEY);
    assert(!!store['https://new.example'], 'freshly logged-in site recorded');
    // Removal tombstones (dismissed: true) rather than deleting the record.
    assert(store['https://old.example']?.dismissed === true, 'removed site stays removed');
  }

  // --- 37. Sender and payload validation -----------------------------------
  {
    console.log('\n[37] mutation messages from content scripts are ignored');
    const storage = makeStorage({ [MY_SITES_KEY]: {} });
    const { send } = loadBackground(storage);

    const res = await send(
      { type: 'MUTATE_MY_SITES', op: 'rename', key: 'https://a.example', name: 'x' },
      CONTENT_SENDER,
    );
    await settle();
    assert(res === undefined, 'content-script sender gets no response');
    assert(Object.keys(storage.read(MY_SITES_KEY)).length === 0, 'store untouched');

    const bad = await send(
      { type: 'MUTATE_PREF', ns: '_global', key: 'adminBarHidden', value: { evil: true } },
      POPUP_SENDER,
    );
    assert(bad?.ok === false, 'non-primitive pref value rejected');
    const opts = await send(
      { type: 'MUTATE_PREF', ns: '_global', key: 'adminBarHidden', value: true },
      OPTIONS_SENDER,
    );
    assert(opts?.ok === true, 'options page (extension page in a real tab) is accepted');
  }

  // --- 39. WP_LOGIN_HINT downgrades the cached login state (#59) ----------
  {
    console.log('\n[39] early login hint downgrades cache and icon, and nothing else');
    const CACHE_KEY = 'wp_cache_https://a.example';
    const storage = makeStorage({
      [CACHE_KEY]: { isWordPress: true, isLoggedIn: true, lastSeen: 123 },
      'wp_cache_https://b.example': { isWordPress: true, isLoggedIn: true, lastSeen: 456 },
    });
    const { send, iconCalls } = loadBackground(storage);
    const contentSender = (host) => ({ url: `https://${host}/page`, tab: { id: 5, url: `https://${host}/page` } });

    await send({ type: 'WP_LOGIN_HINT', loggedIn: false }, contentSender('a.example'));
    await settle();
    assert(storage.read(CACHE_KEY).isLoggedIn === false, 'cached isLoggedIn downgraded');
    assert(iconCalls.length === 1, 'toolbar icon repainted once');
    assert(iconCalls[0]?.path?.[16] === 'icons/icon-16.png', 'icon dropped to the logged-out WP variant');

    // Repeat hint: entry already logged-out, nothing to do.
    await send({ type: 'WP_LOGIN_HINT', loggedIn: false }, contentSender('a.example'));
    await settle();
    assert(iconCalls.length === 1, 'idempotent — no second repaint');

    // Upgrade attempts and non-content senders are powerless.
    await send({ type: 'WP_LOGIN_HINT', loggedIn: true }, contentSender('b.example'));
    await send({ type: 'WP_LOGIN_HINT', loggedIn: false }, POPUP_SENDER);
    await send({ type: 'WP_LOGIN_HINT', loggedIn: false }, contentSender('unknown.example'));
    await settle();
    assert(storage.read('wp_cache_https://b.example').isLoggedIn === true,
      'loggedIn:true hint ignored (downgrade-only)');
    assert(iconCalls.length === 1, 'popup sender and unknown origin ignored');
  }

  // --- 40. Mobile Preview keeps one window per site (origin) ---------------
  {
    console.log('\n[40] Mobile Preview: one window per site — reuse navigates, sites stay separate');
    const storage = makeStorage();
    const { send, winState, closeWindow } = loadBackground(storage);
    const pageA = 'https://make.wordpress.org/core/2026/05/22/post/';
    const pageB = 'https://make.wordpress.org/core/2026/06/01/another-post/';

    await send({ type: 'OPEN_MOBILE_PREVIEW', url: pageA, enforceSize: false }, POPUP_SENDER);
    assert(winState.created.length === 1, 'first click opens one preview window');
    const firstWin = winState.created[0].id;

    // A different page on the same site reuses the window: navigate + focus.
    await send({ type: 'OPEN_MOBILE_PREVIEW', url: pageB, enforceSize: false }, POPUP_SENDER);
    assert(winState.created.length === 1, 'another page on the same site opens no new window');
    assert(winState.navigated.length === 1
      && winState.navigated[0].tabId === firstWin + 5000
      && winState.navigated[0].url === pageB,
      'the existing window is navigated to the newly requested page');
    assert(winState.focused.length === 1 && winState.focused[0] === firstWin,
      'and brought to front');

    // A repeat click for the page already showing re-navigates (we cannot read
    // the tab's URL without the tabs permission, and re-pointing is harmless).
    await send({ type: 'OPEN_MOBILE_PREVIEW', url: pageB, enforceSize: false }, POPUP_SENDER);
    assert(winState.created.length === 1 && winState.navigated.length === 2,
      'a repeat click for the same page still reuses and re-navigates');

    // A different site gets its own window, side by side with the first.
    const otherSite = 'https://developer.wordpress.org/reference/';
    await send({ type: 'OPEN_MOBILE_PREVIEW', url: otherSite, enforceSize: false }, POPUP_SENDER);
    assert(winState.created.length === 2, 'a different site opens a separate window');

    // Scheme is part of the site identity (WordPress treats it that way), so
    // http and https of the same host do not share a window.
    await send({ type: 'OPEN_MOBILE_PREVIEW', url: 'http://make.wordpress.org/core/', enforceSize: false }, POPUP_SENDER);
    assert(winState.created.length === 3, 'http and https of the same host are distinct sites');

    // Once the user closes a site's preview, its stored id goes stale; the
    // same site must open a fresh window rather than focus a window that's gone.
    closeWindow(firstWin);
    const navsBefore = winState.navigated.length;
    await send({ type: 'OPEN_MOBILE_PREVIEW', url: pageA, enforceSize: false }, POPUP_SENDER);
    assert(winState.created.length === 4, 'closed preview reopens instead of focusing a gone window');
    assert(winState.navigated.length === navsBefore, 'and nothing tries to navigate the gone window');

    // A content-script sender must not be able to open or steer windows.
    const before = { created: winState.created.length, navigated: winState.navigated.length };
    await send({ type: 'OPEN_MOBILE_PREVIEW', url: 'https://evil.example/x', enforceSize: false }, CONTENT_SENDER);
    assert(winState.created.length === before.created && winState.navigated.length === before.navigated,
      'content-script sender is ignored');
  }

  // --- 41. #94: migration, canonical curation, evidence gate, sticky removal ---
  {
    console.log('\n[41] pre-#94 stores re-key on write; canonical-key curation; no speculative rows; removal sticky');
    const HOST = 'http://localhost';
    const SA = `${HOST}/siteA`, SB = `${HOST}/siteB`;
    // A store as a pre-#94 build persisted it: a subdirectory install keyed
    // by its bare origin, the install base only in the record body.
    const legacy = {
      [HOST]: { origin: HOST, baseUrl: SB, addedAt: 1, lastLoggedInAt: 1, customName: 'Site B' },
    };
    {
      // A login write migrates the legacy record and records the sibling in
      // one pass; no origin-keyed remnant survives.
      const storage = makeStorage({ [MY_SITES_KEY]: structuredClone(legacy) });
      const { send } = loadBackground(storage);
      await send({
        type: 'POPUP_DETECTION_RESOLVED', origin: HOST, isWordPress: true, isLoggedIn: true,
        baseUrl: SA, pathname: '/siteA/wp-admin/',
      }, POPUP_SENDER);
      await settle();
      const store = storage.read(MY_SITES_KEY);
      assert(!store[HOST] && store[SB]?.customName === 'Site B',
        'legacy record re-keyed to its install base with curation intact');
      assert(!!store[SA] && Object.keys(store).length === 2, 'sibling install recorded separately');
    }
    {
      // The popup canonicalizes its snapshot with the same migrateStore, so
      // it sends the canonical key even while the persisted store is still
      // legacy-keyed; the background migrates before applying the op.
      const storage = makeStorage({ [MY_SITES_KEY]: structuredClone(legacy) });
      const { send, WPMySites } = loadBackground(storage);
      const canonical = WPMySites.listSites(WPMySites.migrateStore(structuredClone(legacy)))[0].key;
      assert(canonical === SB, 'popup-side canonicalization yields the canonical key');
      const res = await send({ type: 'MUTATE_MY_SITES', op: 'remove', key: canonical }, POPUP_SENDER);
      await settle();
      const store = storage.read(MY_SITES_KEY);
      assert(res?.ok === true && !store[HOST] && store[SB]?.dismissed === true,
        'canonical-keyed remove lands on the migrated record');
    }
    {
      // Evidence gate + sticky removal end-to-end on the real worker paths.
      const storage = makeStorage({});
      const { send } = loadBackground(storage);
      const detect = (path, ctx) => send({
        type: 'WP_DETECTION',
        detection: { isWordPress: true, confidence: 100, signals: ['rest-api-link'], context: ctx },
        hostFromDOM: 'selfhosted',
      }, { url: HOST + path, origin: HOST, tab: { id: 7, url: HOST + path } });

      // deriveBase reports the bare origin as a FALLBACK for pages with
      // no derivation evidence (wp-login.php, REST-stripped fronts). Such a
      // page must not mint a speculative bare-origin row — and neither must
      // root-EQUIVALENT variants (trailing slash, query/fragment-only) or
      // non-http(s) values whose parsed origin still matches (blob:), with
      // or without a forged non-http(s) REST root.
      await detect('/siteA/wp-login.php', { isLoggedIn: true, baseUrl: HOST });
      await detect('/x/', { isLoggedIn: true, baseUrl: `${HOST}/` });
      await detect('/x/', { isLoggedIn: true, baseUrl: `${HOST}/?p=1` });
      await detect('/x/', { isLoggedIn: true, baseUrl: `${HOST}/#frag` });
      await detect('/x/', { isLoggedIn: true, baseUrl: `blob:${HOST}/some-uuid` });
      await detect('/x/', { isLoggedIn: true, baseUrl: HOST, restApiRoot: `blob:${HOST}/wp-json/` });
      await settle();
      assert(Object.keys(storage.read(MY_SITES_KEY) || {}).length === 0,
        'no base-evidence variant (fallback, root-equivalent, blob:) mints a bare-origin row');
      // …while a REST-confirmed root install records normally.
      await detect('/', { isLoggedIn: true, baseUrl: HOST, restApiRoot: `${HOST}/wp-json/` });
      await settle();
      assert(!!storage.read(MY_SITES_KEY)[HOST], 'a REST-confirmed root install is recorded');

      // Subdirectory evidence records the sibling; its removal is then
      // sticky against every later passive path.
      await detect('/siteA/wp-admin/', { isLoggedIn: true, baseUrl: SA });
      await send({ type: 'MUTATE_MY_SITES', op: 'remove', key: SA }, POPUP_SENDER);
      await settle();
      assert(storage.read(MY_SITES_KEY)[SA]?.dismissed === true, 'sibling recorded and then tombstoned');
      await detect('/siteA/wp-admin/', { isLoggedIn: true, baseUrl: SA });
      await detect('/siteA/2026/hello/', { isLoggedIn: true, baseUrl: HOST });
      await settle();
      const after = storage.read(MY_SITES_KEY);
      assert(after[SA]?.dismissed === true, 'no passive detection revives the removed install');
      assert(Object.keys(after).length === 2, 'and no sibling or origin duplicate was minted');
      assert(after[HOST]?.dismissed === undefined, 'the root record is untouched');
    }
    {
      // #103: a root install browsed only through wp-admin. admin_head prints
      // no REST discovery link, so #94's gate saw the bare-origin base, read
      // it as the no-evidence FALLBACK, and dropped every login — the site
      // never entered My Sites however often it was visited. baseUrlEvidence
      // separates the two, and the browser-attested pathname cross-checks it.
      const storage = makeStorage({});
      const { send } = loadBackground(storage);
      const detect = (path, ctx) => send({
        type: 'WP_DETECTION',
        detection: { isWordPress: true, confidence: 90, signals: ['admin-bar-element'], context: ctx },
        hostFromDOM: 'selfhosted',
      }, { url: HOST + path, origin: HOST, tab: { id: 7, url: HOST + path } });

      await detect('/wp-admin/index.php',
        { isLoggedIn: true, baseUrl: HOST, baseUrlEvidence: 'admin-path' });
      await settle();
      assert(!!storage.read(MY_SITES_KEY)?.[HOST],
        "a root install's wp-admin screen is recorded (#103)");

      // Still no speculative rows: an admin-path CLAIM whose browser-attested
      // path has no wp-admin segment is a lie or an accident (a theme adding
      // `wp-admin` to a front-end body class), and a subdirectory install
      // must not be able to claim the root that way.
      const storage2 = makeStorage({});
      const { send: send2 } = loadBackground(storage2);
      const detect2 = (path, ctx) => send2({
        type: 'WP_DETECTION',
        detection: { isWordPress: true, confidence: 90, signals: ['admin-bar-element'], context: ctx },
        hostFromDOM: 'selfhosted',
      }, { url: HOST + path, origin: HOST, tab: { id: 7, url: HOST + path } });
      await detect2('/blog/hello-world/', { isLoggedIn: true, baseUrl: HOST, baseUrlEvidence: 'admin-path' });
      await detect2('/', { isLoggedIn: true, baseUrl: HOST, baseUrlEvidence: 'admin-path' });
      await detect2('/wp-administration/x', { isLoggedIn: true, baseUrl: HOST, baseUrlEvidence: 'admin-path' });
      await detect2('/sub%2Fdir/wp-admin/', { isLoggedIn: true, baseUrl: HOST, baseUrlEvidence: 'admin-path' });
      await detect2('/wp-admin/index.php', { isLoggedIn: true, baseUrl: HOST, baseUrlEvidence: null });
      await detect2('/wp-admin/index.php', { isLoggedIn: true, baseUrl: HOST, baseUrlEvidence: 'rest' });
      await settle();
      assert(Object.keys(storage2.read(MY_SITES_KEY) || {}).length === 0,
        'an admin-path claim unsupported by the browser-attested path mints nothing');

      // The popup's resolution path applies the same gate (cookie-API logins
      // on an admin screen, and the #88 cache-only fallback).
      const storage3 = makeStorage({});
      const { send: send3 } = loadBackground(storage3);
      await send3({
        type: 'POPUP_DETECTION_RESOLVED', origin: HOST, isWordPress: true, isLoggedIn: true,
        baseUrl: HOST, baseUrlEvidence: 'admin-path', pathname: '/wp-admin/options-general.php',
      }, POPUP_SENDER);
      await settle();
      assert(!!storage3.read(MY_SITES_KEY)?.[HOST],
        'the popup resolution records a root install from its admin screen too');
      await send3({
        type: 'POPUP_DETECTION_RESOLVED', origin: HOST, isWordPress: true, isLoggedIn: true,
        baseUrl: HOST, baseUrlEvidence: 'admin-path', pathname: '/not-admin/',
      }, POPUP_SENDER);
      await settle();
      assert(Object.keys(storage3.read(MY_SITES_KEY)).length === 1,
        'and rejects the same claim from a non-admin path');

      // Sticky removal still holds against the new evidence path.
      const storage4 = makeStorage({});
      const { send: send4 } = loadBackground(storage4);
      const detect4 = (path, ctx) => send4({
        type: 'WP_DETECTION',
        detection: { isWordPress: true, confidence: 90, signals: ['admin-bar-element'], context: ctx },
        hostFromDOM: 'selfhosted',
      }, { url: HOST + path, origin: HOST, tab: { id: 7, url: HOST + path } });
      await detect4('/wp-admin/index.php', { isLoggedIn: true, baseUrl: HOST, baseUrlEvidence: 'admin-path' });
      await send4({ type: 'MUTATE_MY_SITES', op: 'remove', key: HOST }, POPUP_SENDER);
      await settle();
      await detect4('/wp-admin/edit.php', { isLoggedIn: true, baseUrl: HOST, baseUrlEvidence: 'admin-path' });
      await settle();
      const after103 = storage4.read(MY_SITES_KEY);
      assert(after103[HOST]?.dismissed === true && Object.keys(after103).length === 1,
        'a dismissed root install is not revived by a later admin visit');

      // The reporter's scenario: several managed sites, admin-only browsing.
      const storage5 = makeStorage({});
      const { send: send5 } = loadBackground(storage5);
      for (const name of ['a', 'b', 'c', 'd', 'e']) {
        const origin = `https://client-${name}.example`;
        const url = `${origin}/wp-admin/index.php`;
        await send5({
          type: 'WP_DETECTION',
          detection: {
            isWordPress: true, confidence: 90, signals: ['admin-bar-element'],
            context: { isLoggedIn: true, baseUrl: origin, baseUrlEvidence: 'admin-path' },
          },
          hostFromDOM: 'selfhosted',
        }, { url, origin, tab: { id: 7, url } });
      }
      await settle();
      assert(Object.keys(storage5.read(MY_SITES_KEY) || {}).length === 5,
        'five admin-only managed sites all persist (the reported symptom)');

      // The browser-attested path falls back to the sender TAB's url when
      // sender.url is absent (content scripts are top-frame only, so the two
      // agree). Without that fallback the gate — and the pre-existing
      // subdirectory login attribution — would silently lose the path.
      const storage6 = makeStorage({});
      const { send: send6 } = loadBackground(storage6);
      await send6({
        type: 'WP_DETECTION',
        detection: {
          isWordPress: true, confidence: 90, signals: ['admin-bar-element'],
          context: { isLoggedIn: true, baseUrl: HOST, baseUrlEvidence: 'admin-path' },
        },
        hostFromDOM: 'selfhosted',
      }, { origin: HOST, tab: { id: 7, url: `${HOST}/wp-admin/index.php` } });
      await settle();
      assert(!!storage6.read(MY_SITES_KEY)?.[HOST],
        'the path is recovered from sender.tab.url when sender.url is absent');

      // Frontend → backend as one pipeline: the popup's #88 cache-only
      // fallback (orphaned content script, no live baseUrl) recovers the base
      // with the real adminBaseFromProbe, and the resulting payload has to
      // clear the real gate. The hook orchestration itself is driven by
      // actions.mjs [46].
      const adminBaseFromProbe = loadAdminBaseFromProbe();
      const resolveFromProbe = async (send, tabPath, bodyAdmin) => {
        const derived = adminBaseFromProbe(HOST, tabPath, bodyAdmin);
        return send({
          type: 'POPUP_DETECTION_RESOLVED', origin: HOST, isWordPress: true, isLoggedIn: true,
          baseUrl: derived?.baseUrl || null,
          baseUrlEvidence: derived?.evidence || null,
          pathname: tabPath,
        }, POPUP_SENDER);
      };

      const storage7 = makeStorage({});
      const { send: send7 } = loadBackground(storage7);
      await resolveFromProbe(send7, '/wp-admin/index.php', true);
      await settle();
      assert(!!storage7.read(MY_SITES_KEY)?.[HOST],
        'popup fallback → gate: a root install recovered from its admin tab records');

      const storage8 = makeStorage({});
      const { send: send8 } = loadBackground(storage8);
      await resolveFromProbe(send8, '/siteA/wp-admin/edit.php', true);
      await settle();
      assert(!!storage8.read(MY_SITES_KEY)?.[SA],
        'popup fallback → gate: a subdirectory install keys by its install base');

      const storage9 = makeStorage({});
      const { send: send9 } = loadBackground(storage9);
      // Not an admin document (probe unconfirmed), and a fail-closed encoded
      // slash: both must reach the gate with no evidence and mint nothing.
      await resolveFromProbe(send9, '/guides/wp-admin/security/', false);
      await resolveFromProbe(send9, '/sub%2Fdir/wp-admin/', true);
      await settle();
      assert(Object.keys(storage9.read(MY_SITES_KEY) || {}).length === 0,
        'popup fallback → gate: unconfirmed and fail-closed probes mint nothing');
    }
    {
      // Root confirmation is BOUND to what the trustworthy inputs actually
      // derive: the gate re-derives the expected base from the browser-attested
      // pathname (admin evidence) or from the REST root itself (rest evidence)
      // with lib/detect.js's deriveBase, and the claim must MATCH. An admin
      // path under /siteA derives /siteA, so it can never confirm a bare-origin
      // claim; neither can a REST root living under /siteA/wp-json/.
      const mkDetect = (send) => (path, ctx) => send({
        type: 'WP_DETECTION',
        detection: { isWordPress: true, confidence: 90, signals: ['admin-bar-element'], context: ctx },
        hostFromDOM: 'selfhosted',
      }, { url: HOST + path, origin: HOST, tab: { id: 7, url: HOST + path } });

      const storageB = makeStorage({});
      const { send: sendB } = loadBackground(storageB);
      const detectB = mkDetect(sendB);
      // Admin evidence whose attested path derives a SUBDIRECTORY base.
      await detectB('/siteA/wp-admin/edit.php',
        { isLoggedIn: true, baseUrl: HOST, baseUrlEvidence: 'admin-path' });
      // A same-origin REST root that derives a subdirectory base.
      await detectB('/', { isLoggedIn: true, baseUrl: HOST, restApiRoot: `${HOST}/siteA/wp-json/` });
      // Non-string and forged evidence values fail closed.
      await detectB('/wp-admin/index.php', { isLoggedIn: true, baseUrl: HOST, baseUrlEvidence: 123 });
      await detectB('/wp-admin/index.php',
        { isLoggedIn: true, baseUrl: HOST, baseUrlEvidence: { toString: () => 'admin-path' } });
      await settle();
      assert(Object.keys(storageB.read(MY_SITES_KEY) || {}).length === 0,
        'a bare-origin claim is confirmed only by a derivation that matches it');

      // The same mismatched claims through the popup resolution path.
      const storageBP = makeStorage({});
      const { send: sendBP } = loadBackground(storageBP);
      await sendBP({
        type: 'POPUP_DETECTION_RESOLVED', origin: HOST, isWordPress: true, isLoggedIn: true,
        baseUrl: HOST, baseUrlEvidence: 'admin-path', pathname: '/siteA/wp-admin/edit.php',
      }, POPUP_SENDER);
      await sendBP({
        type: 'POPUP_DETECTION_RESOLVED', origin: HOST, isWordPress: true, isLoggedIn: true,
        baseUrl: HOST, restApiRoot: `${HOST}/siteA/wp-json/`, pathname: '/',
      }, POPUP_SENDER);
      await settle();
      assert(Object.keys(storageBP.read(MY_SITES_KEY) || {}).length === 0,
        'the popup path applies the same match requirement');

      // The REST shapes WordPress really prints for a root install still
      // confirm it: pretty permalinks (/wp-json/) and plain (/?rest_route=/).
      const storageBR = makeStorage({});
      const { send: sendBR } = loadBackground(storageBR);
      const detectBR = mkDetect(sendBR);
      await detectBR('/', { isLoggedIn: true, baseUrl: HOST, restApiRoot: `${HOST}/wp-json/` });
      await settle();
      assert(!!storageBR.read(MY_SITES_KEY)?.[HOST], 'a root /wp-json/ REST root still confirms');
      const storageBR2 = makeStorage({});
      const { send: sendBR2 } = loadBackground(storageBR2);
      await mkDetect(sendBR2)('/', { isLoggedIn: true, baseUrl: HOST, restApiRoot: `${HOST}/?rest_route=/` });
      await settle();
      assert(!!storageBR2.read(MY_SITES_KEY)?.[HOST], 'a plain-permalink REST root still confirms');

      // Sticky removal holds through the popup resolution path too.
      const storageBS = makeStorage({});
      const { send: sendBS } = loadBackground(storageBS);
      const popupAdmin = () => sendBS({
        type: 'POPUP_DETECTION_RESOLVED', origin: HOST, isWordPress: true, isLoggedIn: true,
        baseUrl: HOST, baseUrlEvidence: 'admin-path', pathname: '/wp-admin/index.php',
      }, POPUP_SENDER);
      await popupAdmin();
      await sendBS({ type: 'MUTATE_MY_SITES', op: 'remove', key: HOST }, POPUP_SENDER);
      await settle();
      await popupAdmin();
      await settle();
      const afterBS = storageBS.read(MY_SITES_KEY);
      assert(afterBS[HOST]?.dismissed === true && Object.keys(afterBS).length === 1,
        'sticky removal holds through the popup resolution path');

      // v1.0.1 pinning through the popup path: the ambiguous legacy origin
      // record stays pinned with its curation; sibling admin evidence records
      // separately; root admin evidence bumps the pinned record in place.
      const legacyPin = {
        [HOST]: { origin: HOST, baseUrl: HOST, addedAt: 1, lastLoggedInAt: 5, customName: 'Mine' },
      };
      const storageBL = makeStorage({ [MY_SITES_KEY]: structuredClone(legacyPin) });
      const { send: sendBL } = loadBackground(storageBL);
      await sendBL({
        type: 'POPUP_DETECTION_RESOLVED', origin: HOST, isWordPress: true, isLoggedIn: true,
        baseUrl: SA, baseUrlEvidence: 'admin-path', pathname: '/siteA/wp-admin/edit.php',
      }, POPUP_SENDER);
      await settle();
      const storeBL = storageBL.read(MY_SITES_KEY);
      assert(storeBL[HOST]?.customName === 'Mine' && !!storeBL[SA]
        && Object.keys(storeBL).length === 2,
        'popup-path sibling evidence records separately; the pinned record keeps its curation');
      await sendBL({
        type: 'POPUP_DETECTION_RESOLVED', origin: HOST, isWordPress: true, isLoggedIn: true,
        baseUrl: HOST, baseUrlEvidence: 'admin-path', pathname: '/wp-admin/index.php',
      }, POPUP_SENDER);
      await settle();
      const storeBL2 = storageBL.read(MY_SITES_KEY);
      assert(storeBL2[HOST]?.customName === 'Mine' && storeBL2[HOST].lastLoggedInAt > 5
        && Object.keys(storeBL2).length === 2,
        'popup-path root evidence bumps the pinned origin record in place');
    }
    {
      // Slashless REST discovery roots, real pipeline: detectWordPress output
      // feeds the gate unmodified — no hand-built context. rest_url() prints
      // the trailing slash, but filters and hand-written links can omit it,
      // and a terminal segment-exact /wp-json is the API root either way,
      // never part of the install base. The slashless root used to derive
      // <origin>/wp-json as a base and mint a bogus /wp-json row.
      const { JSDOM } = require('jsdom');
      const pipeDetect = {};
      new Function('globalThis', read('lib', 'detect.js'))(pipeDetect);
      const pipeline = async (href) => {
        const storage = makeStorage({});
        const { send } = loadBackground(storage);
        const dom = new JSDOM('<html><head>'
          + `<link rel="https://api.w.org/" href="${href}">`
          + '</head><body class="home logged-in admin-bar">'
          + '<div id="wpadminbar"></div></body></html>');
        const detection = pipeDetect.WPDetect.detectWordPress(dom.window.document, {
          origin: HOST, pathname: '/',
        });
        await send({ type: 'WP_DETECTION', detection, hostFromDOM: 'selfhosted' },
          { url: `${HOST}/`, origin: HOST, tab: { id: 7, url: `${HOST}/` } });
        await settle();
        return storage.read(MY_SITES_KEY) || {};
      };

      const rootSlashed = await pipeline(`${HOST}/wp-json/`);
      assert(!!rootSlashed[HOST] && Object.keys(rootSlashed).length === 1,
        'pipeline: root /wp-json/ records the origin');
      const rootBare = await pipeline(`${HOST}/wp-json`);
      assert(!!rootBare[HOST] && Object.keys(rootBare).length === 1,
        'pipeline: slashless /wp-json records the origin, not a /wp-json row');
      const subSlashed = await pipeline(`${SA}/wp-json/`);
      assert(!!subSlashed[SA] && Object.keys(subSlashed).length === 1,
        'pipeline: subdirectory /siteA/wp-json/ records the /siteA install');
      const subBare = await pipeline(`${SA}/wp-json`);
      assert(!!subBare[SA] && Object.keys(subBare).length === 1,
        'pipeline: slashless /siteA/wp-json records /siteA, not a /siteA/wp-json row');

      // Encoded API-root forms: RFC 3986 unreserved encoding must not
      // smuggle a /wp-json base past the gate. The store canonicalizes
      // %77p-json to wp-json at its boundary, so the derivation has to see
      // the decoded form too. None of these may create a stored base ending
      // in /wp-json.
      for (const enc of ['/%77p-json', '/%77p-json/', '/wp-%6Ason', '/%77%70-%6Ason/']) {
        const store = await pipeline(HOST + enc);
        const keys = Object.keys(store);
        assert(!!store[HOST] && keys.length === 1,
          `pipeline: encoded root ${enc} records the origin`);
        assert(keys.every((k) => !k.endsWith('/wp-json')),
          `pipeline: encoded root ${enc} mints no /wp-json-suffixed key`);
      }
      const encSub = await pipeline(`${HOST}/site%41/wp-json`);
      assert(!!encSub[SA] && Object.keys(encSub).length === 1,
        'pipeline: encoded subdirectory /site%41/wp-json records /siteA');
      const encSlash = await pipeline(`${HOST}/sub%2Fdir/wp-json/`);
      assert(!!encSlash[`${HOST}/sub%2Fdir`] && Object.keys(encSlash).length === 1,
        'pipeline: an encoded slash stays one segment in the stored key');
      // An install genuinely living at /wp-json keeps working — its own
      // discovery link is /wp-json/wp-json, and its row is legitimate. This
      // is also why no blind migration deletes old /wp-json rows.
      const literalWpJson = await pipeline(`${HOST}/wp-json/wp-json`);
      assert(!!literalWpJson[`${HOST}/wp-json`] && Object.keys(literalWpJson).length === 1,
        'pipeline: an install literally based at /wp-json still records its own row');

      // Front-controller REST roots (#107), real pipeline: these used to key
      // a row at <base>/index.php, with admin links through the dispatcher.
      for (const shape of ['/index.php/wp-json/', '/index.php/wp-json', '/index.php?rest_route=/']) {
        const store = await pipeline(HOST + shape);
        const keys = Object.keys(store);
        assert(!!store[HOST] && keys.length === 1,
          `pipeline: root ${shape} records the origin`);
        assert(keys.every((k) => !k.endsWith('/index.php')),
          `pipeline: root ${shape} mints no /index.php-suffixed key`);
      }
      for (const shape of ['/index.php/wp-json/', '/index.php?rest_route=/']) {
        const store = await pipeline(SA + shape);
        assert(!!store[SA] && Object.keys(store).length === 1,
          `pipeline: subdirectory /siteA${shape} records the /siteA install`);
      }
    }
    {
      // #102: the oEmbed link is a detection signal only. A logged-in page
      // whose only discovery markup is the oEmbed link detects as WordPress
      // but carries no install-location evidence, so it must not mutate My
      // Sites — recording stays with the REST link and the admin pathname
      // (#104).
      const { JSDOM } = require('jsdom');
      const oembedDetect = {};
      new Function('globalThis', read('lib', 'detect.js'))(oembedDetect);
      const storage = makeStorage({});
      const { send } = loadBackground(storage);
      const dom = new JSDOM('<html><head>'
        + `<link rel="alternate" type="application/json+oembed" href="${HOST}/wp-json/oembed/1.0/embed?url=x">`
        + '</head><body class="single logged-in admin-bar">'
        + '<div id="wpadminbar"></div></body></html>');
      const detection = oembedDetect.WPDetect.detectWordPress(dom.window.document, {
        origin: HOST, pathname: '/hello-world/',
      });
      assert(detection.isWordPress === true && detection.signals.includes('oembed-link'),
        'an oEmbed-only page detects as WordPress');
      assert(detection.context.restApiRoot === null && detection.context.baseUrlEvidence === null,
        'and carries no REST root and no install-location evidence');
      await send({ type: 'WP_DETECTION', detection, hostFromDOM: 'selfhosted' },
        { url: `${HOST}/hello-world/`, origin: HOST, tab: { id: 7, url: `${HOST}/hello-world/` } });
      await settle();
      assert(Object.keys(storage.read(MY_SITES_KEY) || {}).length === 0,
        'a logged-in oEmbed-only page cannot mutate My Sites');
    }
    {
      // v1.0.1 ambiguity, end to end: a subdirectory install seen only via
      // wp-admin was stored as { key: origin, baseUrl: origin } —
      // indistinguishable from a root install. Deterministic policy: the
      // record stays PINNED at the origin; sibling evidence records
      // separately and never moves or inherits its curation. This is the
      // adversarial case: visiting sibling B must not move an ambiguous
      // legacy record's name or tombstone from the origin to B.
      for (const dismissed of [false, true]) {
        const label = dismissed ? 'dismissed v1.0.1 record' : 'active v1.0.1 record';
        const legacy101 = {
          [HOST]: {
            origin: HOST, baseUrl: HOST, addedAt: 1, lastLoggedInAt: 5,
            customName: 'Mine', ...(dismissed ? { dismissed: true } : {}),
          },
        };
        const storage = makeStorage({ [MY_SITES_KEY]: structuredClone(legacy101) });
        const { send } = loadBackground(storage);
        const detect = (path, ctx) => send({
          type: 'WP_DETECTION',
          detection: { isWordPress: true, confidence: 100, signals: ['rest-api-link'], context: ctx },
          hostFromDOM: 'selfhosted',
        }, { url: HOST + path, origin: HOST, tab: { id: 7, url: HOST + path } });
        await detect('/siteA/wp-admin/', { isLoggedIn: true, baseUrl: SA });
        await settle();
        const store = storage.read(MY_SITES_KEY);
        assert(store[HOST]?.customName === 'Mine' && !!store[HOST]?.dismissed === dismissed,
          `${label}: pinned at the origin with its curation intact`);
        assert(!!store[SA] && store[SA].customName === undefined && store[SA].dismissed === undefined,
          `${label}: the sibling records separately with fresh curation`);
        assert(Object.keys(store).length === 2, `${label}: no record moved, none lost`);
      }
    }
  }

  // --- 42. Host badge re-validation (#121) -------------------------------
  {
    console.log('\n[42] host badge: a cached host re-validates on the 90-day clock; a missing host retries sooner (#121)');
    const DAY = 24 * 60 * 60 * 1000;
    const ORIGIN = 'https://h.example';
    const KEY = `wp_cache_${ORIGIN}`;
    const now = Date.now();
    const seed = (host, hostCheckedAt) => ({
      origin: ORIGIN, isWordPress: true, confidence: 100, signals: ['rest-api-link'],
      isLoggedIn: false, checkedAt: now, lastSeen: now, host, hostCheckedAt,
    });
    // One page load against a seeded cache entry with the header probe
    // stubbed; reports whether the probe ran and what got stored.
    const load = async (entry, probe, hostFromDOM = null) => {
      const probes = [];
      const storage = makeStorage({ [KEY]: entry });
      const { send } = loadBackground(storage, {
        sendMessage: async (_tabId, msg) => {
          if (msg?.type === 'RESOLVE_HOST_HEADERS') probes.push(msg.type);
          return probe();
        },
      });
      await send({
        type: 'WP_DETECTION',
        detection: { isWordPress: true, confidence: 100, signals: ['rest-api-link'], context: { isLoggedIn: false } },
        hostFromDOM,
      }, { url: `${ORIGIN}/page`, origin: ORIGIN, tab: { id: 9, url: `${ORIGIN}/page` } });
      await settle();
      return { probed: probes.length, stored: storage.read(KEY) };
    };

    // A cached host past the refresh interval is re-probed, and the probe's
    // answer replaces it: a wrong badge no longer persists indefinitely.
    let r = await load(seed('wpengine', now - 91 * DAY), async () => ({ host: 'kinsta' }));
    assert(r.probed === 1, 'stale cached host: header probe runs');
    assert(r.stored.host === 'kinsta', 'stale cached host: probe result replaces the cached badge');
    assert(r.stored.hostCheckedAt >= now, 'stale cached host: clock restarts');

    // A fresh cached host is left alone: no probe per page load.
    r = await load(seed('wpengine', now - 1 * DAY), async () => ({ host: 'kinsta' }));
    assert(r.probed === 0 && r.stored.host === 'wpengine', 'fresh cached host: no probe, badge kept');

    // Eight days is past the retry clock but inside the refresh clock: a
    // cached host must still not probe. Guards the 90-day / 7-day
    // distinction (both clocks at seven days would probe here).
    r = await load(seed('wpengine', now - 8 * DAY), async () => ({ host: 'kinsta' }));
    assert(r.probed === 0 && r.stored.host === 'wpengine' && r.stored.hostCheckedAt === now - 8 * DAY,
      'cached host between the two clocks: no probe, host and clock unchanged');

    // Latest probe wins: a null answer on re-validation clears the badge
    // (a site that moved to a host with no header signature).
    r = await load(seed('wpengine', now - 91 * DAY), async () => ({ host: null }));
    assert(r.probed === 1 && r.stored.host === null, 'stale cached host, null probe: badge cleared');

    // A missing host retries on the shorter clock, not the 90-day one, so a
    // one-off probe rejection (#115 gate) doesn't suppress the badge for months.
    r = await load(seed(null, now - 8 * DAY), async () => ({ host: 'kinsta' }));
    assert(r.probed === 1 && r.stored.host === 'kinsta', 'missing host past the retry interval: probe runs and sets the badge');
    r = await load(seed(null, now - 1 * DAY), async () => ({ host: 'kinsta' }));
    assert(r.probed === 0 && r.stored.host === null, 'missing host inside the retry interval: no probe');

    // A DOM/origin host signal on the current page wins outright: no probe.
    r = await load(seed('wpengine', now - 91 * DAY), async () => ({ host: 'kinsta' }), 'selfhosted');
    assert(r.probed === 0 && r.stored.host === 'selfhosted', 'DOM host signal: no probe, DOM host stored');

    // Content script gone mid-probe: entry untouched, so it retries next load.
    r = await load(seed('wpengine', now - 91 * DAY), async () => { throw new Error('no receiver'); });
    assert(r.probed === 1 && r.stored.host === 'wpengine' && r.stored.hostCheckedAt === now - 91 * DAY,
      'probe failure: cached badge and clock left as they were');
  }

  console.log(`\n${failures === 0 ? 'Background storage tests passed.' : failures + ' failure(s).'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
