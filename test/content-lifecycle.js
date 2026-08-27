/**
 * Admin-bar style lifecycle tests for lib/early.js + content.js.
 *
 * Loads the real scripts under jsdom with a stubbed `chrome`, following the
 * smoke.js new Function() pattern. Focus: ownership of the
 * #wp-detective-adminbar-hide node — the extension must remove only styles
 * it created (marked data-wpd-owned) and never a page-owned element that
 * happens to share the ID (content.js runs on every http(s) page since the
 * 0.10.3 logged-out cleanup).
 *
 *   cd test && npm install && npm test
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const detectSrc = read('lib', 'detect.js');
const restSrc = read('lib', 'rest.js');
const hostSrc = read('lib', 'host.js');
const earlySrc = read('lib', 'early.js');
const contentSrc = read('content.js');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('  FAIL:', msg); }
  else       {             console.log ('  ok  :', msg); }
}

const STYLE_ID = 'wp-detective-adminbar-hide';

/**
 * Runs a script source against a jsdom window with a chrome stub, binding
 * the same free identifiers the content-script world provides.
 */
function runScript(src, ctx, chromeStub, consoleStub) {
  new Function('globalThis', 'document', 'window', 'location', 'chrome', 'console', src)(
    ctx, ctx.document, ctx, ctx.location, chromeStub, consoleStub,
  );
}

/**
 * Builds a page context with the lib modules loaded and a chrome stub whose
 * storage returns `storageData`. Returns hooks into everything the tests
 * observe: runtime messages sent, console.info lines, and the registered
 * onMessage listeners (for driving popup toggles).
 */
function makePage(html, { url = 'https://example.com/', storageData = {} } = {}) {
  const dom = new JSDOM(html, { url });
  const ctx = dom.window;
  runScript(detectSrc, ctx, {}, console);
  runScript(restSrc, ctx, {}, console);
  runScript(hostSrc, ctx, {}, console);

  const sent = [];
  const infos = [];
  const listeners = [];
  const chromeStub = {
    runtime: {
      sendMessage: (msg) => { sent.push(msg); return Promise.resolve(); },
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
    storage: {
      local: { get: async () => storageData },
    },
    i18n: { getMessage: (key) => `[i18n:${key}]` },
  };
  const consoleStub = { ...console, info: (line) => infos.push(line) };

  return {
    ctx,
    chromeStub,
    consoleStub,
    sent,
    infos,
    listeners,
    runEarly: () => runScript(earlySrc, ctx, chromeStub, consoleStub),
    runContent: () => runScript(contentSrc, ctx, chromeStub, consoleStub),
    styleEl: () => ctx.document.getElementById(STYLE_ID),
  };
}

// Async IIFEs (early.js) and loadAdminBarPref settle on the microtask queue
// plus one storage promise; a couple of macrotask turns flushes both.
const settle = () => new Promise((r) => setTimeout(r, 0));

const WP_LOGGED_IN_PAGE = `
  <html><head>
    <link rel="https://api.w.org/" href="https://example.com/wp-json/">
    <meta name="generator" content="WordPress 6.5">
  </head><body class="home logged-in admin-bar">
    <div id="wpadminbar"></div>
  </body></html>
`;

const PLAIN_PAGE_WITH_COLLIDING_DIV = `
  <html><head><title>Not WordPress</title></head>
  <body>
    <div id="${STYLE_ID}">page-owned content</div>
  </body></html>
`;

const PLAIN_PAGE_WITH_COLLIDING_STYLE = `
  <html><head>
    <style id="${STYLE_ID}">.page-owned { color: red; }</style>
  </head><body><p>Not WordPress</p></body></html>
`;

async function main() {
  // --- 29. Page-owned same-ID element survives logged-out cleanup ---------
  {
    console.log('\n[29] page-owned div with the extension style ID survives');
    const page = makePage(PLAIN_PAGE_WITH_COLLIDING_DIV);
    page.runContent();
    await settle();
    const el = page.styleEl();
    assert(!!el, 'element still in the DOM');
    assert(el && el.textContent === 'page-owned content', 'content untouched');
  }

  // --- 30. Page-owned <style> without the marker also survives ------------
  {
    console.log('\n[30] page-owned <style> with the same ID (no marker) survives');
    const page = makePage(PLAIN_PAGE_WITH_COLLIDING_STYLE);
    page.runContent();
    await settle();
    assert(!!page.styleEl(), 'tag type alone does not grant ownership');
  }

  // --- 31. Extension-created early style is cleaned up when logged out ----
  {
    console.log('\n[31] early.js style on a logged-out page is removed by content.js');
    const page = makePage('<html><head></head><body><p>logged out</p></body></html>', {
      storageData: {
        'wp_cache_https://example.com': { isWordPress: true },
        wp_preferences_v1: { 'https://example.com': { adminBarHidden: true } },
      },
    });
    page.runEarly();
    await settle();
    const early = page.styleEl();
    assert(!!early, 'early.js injected the hide style');
    assert(early && early.tagName === 'STYLE' && early.hasAttribute('data-wpd-owned'),
      'early style carries the ownership marker');
    page.runContent();
    await settle();
    assert(!page.styleEl(), 'content.js removed the stale hide on the logged-out page');
    assert(page.infos.length === 0, 'no "admin bar hidden" notice logged');
  }

  // --- 32. Logged-in + hidden pref keeps the style, logs once -------------
  {
    console.log('\n[32] logged-in page with hide pref keeps the style');
    const page = makePage(WP_LOGGED_IN_PAGE, {
      storageData: {
        'wp_cache_https://example.com': { isWordPress: true },
        wp_preferences_v1: { 'https://example.com': { adminBarHidden: true } },
      },
    });
    page.runEarly();
    await settle();
    page.runContent();
    await settle();
    const el = page.styleEl();
    assert(!!el, 'hide style present after reconcile');
    assert(el && el.hasAttribute('data-wpd-owned'), 'style is extension-owned');
    assert(page.infos.length === 1, `notice logged exactly once (got ${page.infos.length})`);
    assert(!page.ctx.document.body.classList.contains('admin-bar'),
      'body.admin-bar removed while hidden');
  }

  // --- 33. Popup toggle restores what the hide removed ---------------------
  {
    console.log('\n[33] toggling the pref off restores body.admin-bar and drops the style');
    const page = makePage(WP_LOGGED_IN_PAGE, {
      storageData: {
        wp_preferences_v1: { 'https://example.com': { adminBarHidden: true } },
      },
    });
    page.runContent();
    await settle();
    assert(!!page.styleEl(), 'style created by content.js applyHide');
    assert(page.listeners.length > 0, 'content script registered a message listener');
    for (const fn of page.listeners) {
      fn({ type: 'APPLY_ADMIN_BAR_PREF', hidden: false }, {}, () => {});
    }
    await settle();
    assert(!page.styleEl(), 'style removed on show');
    assert(page.ctx.document.body.classList.contains('admin-bar'),
      'body.admin-bar restored');
    assert(page.ctx.document.body.classList.contains('logged-in'),
      'unrelated body classes untouched');
  }

  // --- 38. Early login hint fires only on a cached-logged-in mismatch ------
  {
    console.log('\n[38] early.js login hint (#59)');
    const loggedInCache = {
      'wp_cache_https://example.com': { isWordPress: true, isLoggedIn: true },
    };
    const hintsIn = (page) =>
      page.sent.filter((m) => m && m.type === 'WP_LOGIN_HINT');

    // Cache says logged in, DOM says logged out → downgrade hint.
    const out = makePage('<html><head></head><body><p>logged out</p></body></html>', {
      storageData: loggedInCache,
    });
    out.runEarly();
    await settle();
    assert(hintsIn(out).length === 1 && hintsIn(out)[0].loggedIn === false,
      'hint sent for cached-logged-in origin rendering logged-out DOM');

    // DOM agrees it is logged in → no hint.
    const still = makePage(WP_LOGGED_IN_PAGE, { storageData: loggedInCache });
    still.runEarly();
    await settle();
    assert(hintsIn(still).length === 0, 'no hint when the DOM shows logged-in');

    // Cache carries no logged-in claim → nothing to downgrade, no hint.
    const anon = makePage('<html><head></head><body><p>logged out</p></body></html>', {
      storageData: { 'wp_cache_https://example.com': { isWordPress: true } },
    });
    anon.runEarly();
    await settle();
    assert(hintsIn(anon).length === 0, 'no hint without a cached logged-in claim');
  }

  // --- 41. Block inspector pref precedence (per-origin, then _global) ------
  {
    console.log('\n[41] block inspector honours per-origin over _global (#76)');

    // Observes enable/disable instead of loading the real inspector: the
    // harness ctx is content.js's globalThis, so a stub installed before
    // runContent() receives exactly the calls the page would.
    const inspect = (storageData) => {
      const page = makePage(WP_LOGGED_IN_PAGE, { storageData });
      const calls = { enabled: 0, disabled: 0 };
      page.ctx.WPDBlockInspector = {
        enable: () => { calls.enabled++; },
        disable: () => { calls.disabled++; },
      };
      page.runContent();
      return settle().then(() => calls);
    };

    const viaGlobal = await inspect({
      wp_preferences_v1: { _global: { blockInspectorEnabled: true } },
    });
    assert(viaGlobal.enabled === 1, 'a _global default alone enables the inspector');

    const originWins = await inspect({
      wp_preferences_v1: {
        'https://example.com': { blockInspectorEnabled: false },
        _global: { blockInspectorEnabled: true },
      },
    });
    assert(originWins.enabled === 0, 'explicit per-origin false beats a _global true');

    const viaOrigin = await inspect({
      wp_preferences_v1: { 'https://example.com': { blockInspectorEnabled: true } },
    });
    assert(viaOrigin.enabled === 1, 'per-origin true enables with no _global set');

    const unset = await inspect({ wp_preferences_v1: {} });
    assert(unset.enabled === 0, 'nothing set leaves the inspector off');
  }

  // --- 44. pathname threads to detectWordPress at all three callsites ------
  {
    console.log('\n[44] location.pathname reaches detectWordPress at every callsite (#88)');
    const ADMIN_PAGE = '<html><head></head><body class="wp-admin wp-core-ui">'
      + '<div id="wpwrap"><div id="wpadminbar"></div></div></body></html>';
    const ADMIN_PATH = '/en-us/research/wp-admin/index.php';
    const page = makePage(ADMIN_PAGE, { url: `https://example.com${ADMIN_PATH}` });

    // Record the options every call hands the real detector, then delegate.
    const seen = [];
    const orig = page.ctx.WPDetect.detectWordPress;
    page.ctx.WPDetect.detectWordPress = (doc, opts) => { seen.push(opts || {}); return orig(doc, opts); };

    // Callsite 1: initial detection at content-script load.
    page.runContent();
    await settle();
    assert(seen.length >= 1 && seen[0].pathname === ADMIN_PATH,
      'initial detection receives location.pathname');

    // Callsite 2: GET_LIVE_DETECTION re-detection.
    let liveResp = null;
    for (const fn of page.listeners) fn({ type: 'GET_LIVE_DETECTION' }, {}, (r) => { liveResp = r; });
    await settle();
    assert(seen.length >= 2 && seen[1].pathname === ADMIN_PATH,
      'GET_LIVE_DETECTION re-detection receives location.pathname');
    assert(!!liveResp && liveResp.detection.context.baseUrl === 'https://example.com/en-us/research',
      'live re-detection derives the subdirectory base end-to-end');

    // Callsite 3: GET_FRESH_DETECTION parses fetched HTML via DOMParser, so
    // the parsed doc has no defaultView and the callsite must thread the
    // pathname explicitly. content.js resolves fetch/DOMParser as free
    // globals in the Node realm here: stub fetch and lend jsdom's DOMParser
    // for the duration, restoring both after.
    const savedFetch = globalThis.fetch;
    const savedParser = globalThis.DOMParser;
    // `url` is the fetch's final (post-redirect) response URL; the handler
    // refuses to parse a response that doesn't attest to the requested one.
    globalThis.fetch = async () => ({
      ok: true,
      url: `https://example.com${ADMIN_PATH}`,
      text: async () => ADMIN_PAGE,
    });
    globalThis.DOMParser = page.ctx.DOMParser;
    try {
      const fresh = await new Promise((resolve) => {
        for (const fn of page.listeners) fn({ type: 'GET_FRESH_DETECTION' }, {}, resolve);
      });
      const last = seen[seen.length - 1];
      assert(seen.length >= 3 && last.pathname === ADMIN_PATH,
        'GET_FRESH_DETECTION passes location.pathname alongside origin');
      assert(last.origin === 'https://example.com',
        'GET_FRESH_DETECTION passes the live origin');
      assert(!!fresh && !!fresh.detection
        && fresh.detection.context.baseUrl === 'https://example.com/en-us/research',
        'DOMParser-path detection derives the subdirectory base end-to-end');
    } finally {
      globalThis.fetch = savedFetch;
      globalThis.DOMParser = savedParser;
    }
  }

  // --- 45. GET_FRESH_DETECTION refuses redirected responses --------------
  {
    console.log('\n[45] fresh fetch is gated on the final response URL (#109)');
    const PAGE_PATH = '/blog/hello-world/';
    const PAGE_URL = `https://example.com${PAGE_PATH}`;

    // Drives one GET_FRESH_DETECTION round trip against a fetch stub that
    // reports `responseUrl` as its final URL. `beforeResolve` runs while the
    // fetch is still in flight, so a test can move `location` under it.
    async function freshFetch(responseUrl, { html = WP_LOGGED_IN_PAGE, beforeResolve, pageUrl = PAGE_URL } = {}) {
      const page = makePage(html, { url: pageUrl });
      page.runContent();
      await settle();

      const requested = [];
      const savedFetch = globalThis.fetch;
      const savedParser = globalThis.DOMParser;
      globalThis.fetch = async (input) => {
        requested.push(String(input));
        if (beforeResolve) beforeResolve(page);
        const res = { ok: true, text: async () => html };
        // No URL reported is the property missing, not ''.
        if (responseUrl !== undefined) res.url = responseUrl;
        return res;
      };
      globalThis.DOMParser = page.ctx.DOMParser;
      try {
        const resp = await new Promise((resolve) => {
          for (const fn of page.listeners) fn({ type: 'GET_FRESH_DETECTION' }, {}, resolve);
        });
        return { resp, requested };
      } finally {
        globalThis.fetch = savedFetch;
        globalThis.DOMParser = savedParser;
      }
    }

    const same = await freshFetch(PAGE_URL);
    assert(same.requested[0] === PAGE_URL, 'fetches the page it captured');
    assert(!!same.resp.detection && same.resp.detection.isWordPress,
      'an unredirected response is parsed');

    // The login wall a stale session lands on: WordPress markup, so without
    // the gate its admin bar merges straight into this tab's resolution.
    const login = await freshFetch('https://example.com/wp-login.php');
    assert(login.resp.detection === null,
      'a same-origin redirect to another document is refused');

    const offsite = await freshFetch('https://cdn.example.net/blog/hello-world/');
    assert(offsite.resp.detection === null, 'a cross-origin redirect is refused');

    const unattested = await freshFetch(undefined);
    assert(unattested.resp.detection === null,
      'a response with no URL is refused');
    const empty = await freshFetch('');
    assert(empty.resp.detection === null, 'an empty response URL is refused');

    // On plain permalinks the query SELECTS the document: ?p=1 and ?p=2 are
    // different posts, so a response whose query differs is another page and
    // is refused. Only the fragment sits outside a document's identity.
    const otherPost = await freshFetch('https://example.com/index.php?p=2', {
      pageUrl: 'https://example.com/index.php?p=1',
    });
    assert(otherPost.resp.detection === null,
      'a redirect to a different document-selecting query is refused');
    const fragment = await freshFetch(`${PAGE_URL}#comments`);
    assert(!!fragment.resp.detection && fragment.resp.detection.isWordPress,
      'a fragment-only difference is still the same document');

    // A pushState mid-flight must not retarget the gate or detection's input.
    const seen = [];
    const moved = await freshFetch(PAGE_URL, {
      beforeResolve: (page) => {
        const orig = page.ctx.WPDetect.detectWordPress;
        page.ctx.WPDetect.detectWordPress = (doc, opts) => {
          seen.push(opts || {});
          return orig(doc, opts);
        };
        page.ctx.history.pushState({}, '', '/blog/second-post/');
      },
    });
    assert(!!moved.resp.detection && moved.resp.detection.isWordPress,
      'a same-document navigation mid-flight does not invalidate the response');
    assert(seen.length === 1 && seen[0].pathname === PAGE_PATH,
      'detection still receives the pathname captured at request time');
  }

  {
    console.log('\n[46] RESOLVE_HOST_HEADERS is gated on the final response URL (#113)');
    const PAGE_PATH = '/blog/hello-world/';
    const PAGE_URL = `https://example.com${PAGE_PATH}`;

    async function resolveHost(responseUrl, { pageUrl = PAGE_URL, headers = { 'x-powered-by': 'WP Engine' } } = {}) {
      const page = makePage(WP_LOGGED_IN_PAGE, { url: pageUrl });
      page.runContent();
      await settle();

      const requested = [];
      const savedFetch = globalThis.fetch;
      globalThis.fetch = async (input) => {
        requested.push(String(input));
        const res = {
          ok: true,
          headers: new page.ctx.Headers(headers),
        };
        if (responseUrl !== undefined) res.url = responseUrl;
        return res;
      };
      try {
        const resp = await new Promise((resolve) => {
          for (const fn of page.listeners) fn({ type: 'RESOLVE_HOST_HEADERS' }, {}, resolve);
        });
        return { resp, requested };
      } finally {
        globalThis.fetch = savedFetch;
      }
    }

    const same = await resolveHost(PAGE_URL);
    assert(same.requested[0] === PAGE_URL, 'HEAD requests the page URL');
    assert(same.resp.host === 'wpengine', 'an unredirected response resolves the host');

    const login = await resolveHost('https://example.com/wp-login.php');
    assert(login.resp.host === null, 'a same-origin redirect to another document is refused');

    const offsite = await resolveHost('https://cdn.example.net/blog/hello-world/');
    assert(offsite.resp.host === null, 'a cross-origin redirect is refused');

    const unattested = await resolveHost(undefined);
    assert(unattested.resp.host === null, 'a response with no URL is refused');

    const empty = await resolveHost('');
    assert(empty.resp.host === null, 'an empty response URL is refused');

    const otherPost = await resolveHost('https://example.com/index.php?p=2', {
      pageUrl: 'https://example.com/index.php?p=1',
    });
    assert(otherPost.resp.host === null, 'a redirect to a different document-selecting query is refused');

    const fragment = await resolveHost(`${PAGE_URL}#section`);
    assert(fragment.resp.host === 'wpengine', 'a fragment-only difference still resolves host headers');
  }

  console.log(`\n${failures === 0 ? 'Content lifecycle tests passed.' : failures + ' failure(s).'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
