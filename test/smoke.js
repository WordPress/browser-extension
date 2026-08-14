/**
 * Smoke tests for lib/detect.js and lib/rest.js.
 *
 * These modules are deliberately framework-free and do not call any
 * browser APIs, which means we can exercise them under jsdom without
 * launching a real browser or loading the extension.
 *
 *   cd test
 *   npm install        # first time: installs jsdom
 *   node smoke.js
 *
 * Extend this file as the detection logic grows. The patterns to copy:
 *
 *   - new detection signal   → add an assertion to an existing scenario
 *   - new page type           → add a new scenario with a fresh JSDOM
 *   - new REST endpoint       → add a scenario using a mock fetchImpl
 */
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');

const detectSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'detect.js'), 'utf8');
const restSrc   = fs.readFileSync(path.join(__dirname, '..', 'lib', 'rest.js'),   'utf8');
const hostSrc   = fs.readFileSync(path.join(__dirname, '..', 'lib', 'host.js'),   'utf8');
const mySitesSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'my-sites.js'), 'utf8');
const blockInspectorSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'block-inspector.js'), 'utf8');

function loadModules(dom) {
  const ctx = dom.window;
  // All files are IIFEs that attach to globalThis. Binding the jsdom
  // window as globalThis lets them install WPDetect/WPRest/WPHost there.
  new Function('globalThis', 'document', 'window', detectSrc)(ctx, ctx.document, ctx);
  new Function('globalThis', 'document', 'window', restSrc)(ctx, ctx.document, ctx);
  new Function('globalThis', 'document', 'window', hostSrc)(ctx, ctx.document, ctx);
  new Function('globalThis', 'document', 'window', mySitesSrc)(ctx, ctx.document, ctx);
  // block-inspector attaches WPDBlockInspector (incl. _parseBlockComments,
  // exposed for these tests). Only defines functions at load — the DOM/observer
  // work happens inside enable(), which the tests don't call.
  new Function('globalThis', 'document', 'window', blockInspectorSrc)(ctx, ctx.document, ctx);
  return ctx;
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('  FAIL:', msg); }
  else       {             console.log ('  ok  :', msg); }
}

async function main() {
  // --- 1. Category page with both slug and ID body classes --------------
  {
    console.log('\n[1] Category archive with id+slug body classes');
    const dom = new JSDOM(`
      <html><head>
        <link rel="https://api.w.org/" href="https://example.com/wp-json/">
        <meta name="generator" content="WordPress 6.4.2">
      </head><body class="archive category category-news category-42 logged-in admin-bar">
        <div id="wpadminbar"></div>
      </body></html>
    `);
    const ctx = loadModules(dom);
    const det = ctx.WPDetect.detectWordPress(ctx.document);
    assert(det.isWordPress, 'detects WordPress');
    assert(det.context.pageType === 'term', 'pageType=term');
    assert(det.context.taxonomy === 'category', 'taxonomy=category');
    assert(det.context.termId === 42, 'termId=42 captured from category-42');
    assert(det.context.term === 'news', 'term=news captured from category-news');
    assert(det.context.isLoggedIn === true, 'isLoggedIn=true');

    const url = ctx.WPRest.resolveEditUrlSync(det.context, 'https://example.com');
    assert(url === 'https://example.com/wp-admin/term.php?taxonomy=category&tag_ID=42',
      `sync edit URL = ${url}`);
    assert(ctx.WPRest.canResolveViaRest(det.context) === false,
      'canResolveViaRest=false (ID already present)');
  }

  // --- 2. Category page with ONLY slug (ID stripped by a theme) ---------
  {
    console.log('\n[2] Category archive missing the numeric ID class');
    const dom = new JSDOM(`
      <html><head>
        <link rel="https://api.w.org/" href="https://example.com/wp-json/">
      </head><body class="archive category category-news logged-in admin-bar"></body></html>
    `);
    const ctx = loadModules(dom);
    const det = ctx.WPDetect.detectWordPress(ctx.document);
    assert(det.context.term === 'news', 'slug captured');
    assert(det.context.termId == null, 'no ID captured');
    assert(ctx.WPRest.resolveEditUrlSync(det.context, 'https://example.com') === null,
      'sync resolution returns null');
    assert(ctx.WPRest.canResolveViaRest(det.context) === true,
      'canResolveViaRest=true — REST fallback applicable');
  }

  // --- 3. REST fetchTermId against a mocked endpoint --------------------
  {
    console.log('\n[3] REST fetchTermId against a mocked endpoint');
    const dom = new JSDOM(`<html><body></body></html>`);
    const ctx = loadModules(dom);

    const calls = [];
    const mockFetch = async (url) => {
      calls.push(url);
      return { ok: true, async json() { return [{ id: 42, slug: 'news' }]; } };
    };

    const id = await ctx.WPRest.fetchTermId({
      restApiRoot: 'https://example.com/wp-json/',
      origin: 'https://example.com',
      taxonomy: 'category',
      slug: 'news',
      fetchImpl: mockFetch,
    });
    assert(id === 42, `id=42 (got ${id})`);
    assert(calls[0] === 'https://example.com/wp-json/wp/v2/categories?slug=news',
      `URL used rest_base=categories: ${calls[0]}`);
  }

  // --- 4. resolveEditUrlAsync stitches term lookup into an admin URL ----
  {
    console.log('\n[4] resolveEditUrlAsync for a term with slug only');
    const dom = new JSDOM(`<html><body></body></html>`);
    const ctx = loadModules(dom);
    const mockFetch = async () => ({ ok: true, async json() { return [{ id: 99 }]; } });
    const url = await ctx.WPRest.resolveEditUrlAsync({
      pageType: 'term',
      taxonomy: 'category',
      term: 'news',
      termId: null,
      restApiRoot: 'https://example.com/wp-json/',
    }, 'https://example.com', mockFetch);
    assert(url === 'https://example.com/wp-admin/term.php?taxonomy=category&tag_ID=99',
      `async URL stitched: ${url}`);
  }

  // --- 5. Author archive with numeric ID class --------------------------
  {
    console.log('\n[5] Author archive with author-<id> class');
    const dom = new JSDOM(`
      <html><body class="author author-jake author-7 logged-in admin-bar archive"></body></html>
    `);
    const ctx = loadModules(dom);
    const det = ctx.WPDetect.detectWordPress(ctx.document);
    assert(det.context.pageType === 'author', 'pageType=author');
    assert(det.context.authorSlug === 'jake', 'authorSlug=jake');
    assert(det.context.authorId === 7, 'authorId=7');
    const url = ctx.WPRest.resolveEditUrlSync(det.context, 'https://example.com');
    assert(url === 'https://example.com/wp-admin/user-edit.php?user_id=7',
      `sync URL = ${url}`);
  }

  // --- 6. Singular post — post.php URL ----------------------------------
  {
    console.log('\n[6] Singular post with postid-NNN');
    const dom = new JSDOM(`
      <html><body class="single single-post postid-101 logged-in admin-bar"></body></html>
    `);
    const ctx = loadModules(dom);
    const det = ctx.WPDetect.detectWordPress(ctx.document);
    assert(det.context.postId === 101, 'postId=101');
    const url = ctx.WPRest.resolveEditUrlSync(det.context, 'https://example.com');
    assert(url === 'https://example.com/wp-admin/post.php?post=101&action=edit',
      `sync URL = ${url}`);
  }

  // --- 7. adminBarEditHref takes priority -------------------------------
  {
    console.log('\n[7] adminBarEditHref wins over synthesized URL');
    const dom = new JSDOM(`
      <html><body class="single single-post postid-101 logged-in admin-bar">
        <div id="wpadminbar">
          <div id="wp-admin-bar-edit">
            <a href="https://example.com/wp-admin/post.php?post=101&action=edit&lang=en">Edit</a>
          </div>
        </div>
      </body></html>
    `);
    const ctx = loadModules(dom);
    const det = ctx.WPDetect.detectWordPress(ctx.document);
    const url = ctx.WPRest.resolveEditUrlSync(det.context, 'https://example.com');
    assert(url && url.includes('lang=en'), 'resolver returns the admin bar href');
  }

  // --- 8. Cookie-based logged-in detection ----------------------------
  // wordpress_logged_in_<hash> is the only reliable JS-visible signal:
  // it's cleared on logout. wp-settings-* persists 1 year past logout so
  // it must NOT be treated as "logged in" — produced persistent false
  // positives previously.
  {
    console.log('\n[8] Cookie-based logged-in detection');
    const dom = new JSDOM(`<html><body></body></html>`);
    const ctx = loadModules(dom);
    const check = ctx.WPDetect.detectLoggedInFromCookies;
    assert(check('wordpress_logged_in_abc123=user%7C1234') === true,
      'wordpress_logged_in cookie → logged in');
    assert(check('wp-settings-1=a; wp-settings-time-1=123') === false,
      'wp-settings alone → NOT a logged-in signal');
    assert(check('other=x; wp-settings-42=val') === false,
      'wp-settings among others → NOT a logged-in signal');
    assert(check('some_other_cookie=value') === false,
      'unrelated cookie → not logged in');
    assert(check('') === false, 'empty string → not logged in');
    assert(check(null) === false, 'null → not logged in');
  }

  // --- 9. Host detection from DOM assets --------------------------------
  {
    console.log('\n[9] Host detection from DOM asset URLs');
    const dom = new JSDOM(`
      <html><head>
        <link rel="stylesheet" href="https://example.com/wp-content/themes/theme/style.css">
        <script src="https://example.com.wpenginepowered.com/wp-includes/js/jquery.js"></script>
      </head><body></body></html>
    `);
    const ctx = loadModules(dom);
    assert(ctx.WPHost.detectHostFromDOM(ctx.document) === 'wpengine',
      'WP Engine detected from .wpenginepowered.com asset');

    const dom2 = new JSDOM(`
      <html><head>
        <img src="https://example.files.wordpress.com/2024/01/photo.jpg">
      </head><body></body></html>
    `);
    const ctx2 = loadModules(dom2);
    assert(ctx2.WPHost.detectHostFromDOM(ctx2.document) === 'wpcom',
      'WordPress.com detected from .files.wordpress.com asset');

    const dom3 = new JSDOM(`
      <html><head>
        <link rel="stylesheet" href="/wp-content/themes/theme/style.css">
      </head><body></body></html>
    `);
    const ctx3 = loadModules(dom3);
    assert(ctx3.WPHost.detectHostFromDOM(ctx3.document) === null,
      'no host detected from generic WP assets');
  }

  // --- 10. Local dev detection from origin ------------------------------
  {
    console.log('\n[10] Local dev detection from origin');
    const dom = new JSDOM(`<html><body></body></html>`);
    const ctx = loadModules(dom);
    const check = ctx.WPHost.detectHostFromOrigin;
    assert(check('http://localhost:8080') === 'local', 'localhost with port');
    assert(check('http://127.0.0.1') === 'local', '127.0.0.1');
    assert(check('http://mysite.local') === 'local', '.local TLD');
    assert(check('http://mysite.test') === 'local', '.test TLD');
    assert(check('http://mysite.lndo.site') === 'local', 'Lando');
    assert(check('http://mysite.ddev.site') === 'local', 'DDEV');
    assert(check('https://fueled.com') === null, 'production domain');
  }

  // --- 11. Host detection from response headers -------------------------
  {
    console.log('\n[11] Host detection from response headers');
    const dom = new JSDOM(`<html><body></body></html>`);
    const ctx = loadModules(dom);
    const detect = ctx.WPHost.detectHostFromHeaders;

    // Simulate a Headers-like object with a get() method
    const makeHeaders = (obj) => ({ get: (k) => obj[k.toLowerCase()] ?? null });

    assert(detect(makeHeaders({ 'wpe-backend': 'apache' })) === 'wpengine',
      'WP Engine from wpe-backend header');
    assert(detect(makeHeaders({ 'x-pantheon-styx-hostname': 'endpoint123' })) === 'pantheon',
      'Pantheon from x-pantheon-styx-hostname header');
    assert(detect(makeHeaders({ 'x-kinsta-cache': 'HIT' })) === 'kinsta',
      'Kinsta from x-kinsta-cache header');
    assert(detect(makeHeaders({ 'x-powered-by': 'WordPress VIP <abc>' })) === 'wpvip',
      'VIP from x-powered-by header');
    assert(detect(makeHeaders({ 'x-powered-by': 'WordPress.com' })) === 'wpcom',
      'WordPress.com from x-powered-by header');
    assert(detect(makeHeaders({ 'server': 'nginx', 'x-cache': 'HIT' })) === null,
      'no host from generic nginx headers');
  }

  // --- 12. Theme + plugin slugs from asset paths ------------------------
  {
    console.log('\n[12] Theme + plugin slug extraction');
    const dom = new JSDOM(`
      <html><head>
        <link rel="https://api.w.org/" href="https://example.com/wp-json/">
        <link rel="stylesheet" href="/wp-content/themes/twentytwentyfour/style.css">
        <link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css">
        <script src="/wp-content/plugins/akismet/akismet.js"></script>
        <script src="/wp-content/mu-plugins/vip-helpers/loader.js"></script>
        <script src="/wp-content/plugins/woocommerce/assets/js/cart.js"></script>
      </head><body></body></html>
    `);
    const ctx = loadModules(dom);
    const det = ctx.WPDetect.detectWordPress(ctx.document);
    assert(det.context.themeSlug === 'twentytwentyfour',
      `themeSlug=twentytwentyfour (got ${det.context.themeSlug})`);
    assert(det.context.pluginSlugs.length === 3,
      `3 plugin slugs (got ${det.context.pluginSlugs.length})`);
    assert(det.context.pluginSlugs.includes('woocommerce'),
      'woocommerce slug detected');
    assert(det.context.pluginSlugs.includes('akismet'),
      'akismet slug detected');
    assert(det.context.pluginSlugs.includes('vip-helpers'),
      'vip-helpers from mu-plugins');
    // De-dupe: woocommerce appears twice in the DOM but only once in slugs.
    const wc = det.context.pluginSlugs.filter((s) => s === 'woocommerce');
    assert(wc.length === 1, 'duplicates collapsed');
  }

  // --- 13. REST site-info helper returns parsed JSON --------------------
  {
    console.log('\n[13] REST site-info helper');
    const dom = new JSDOM(`<html><body></body></html>`);
    const ctx = loadModules(dom);

    const fakeFetch = async (_url) => ({
      ok: true,
      json: async () => ({
        name: 'Example', description: 'Just an example',
        namespaces: ['wp/v2', 'wc/v3', 'yoast/v1'],
      }),
    });
    const out = await ctx.WPRest.fetchSiteInfo({
      restApiRoot: 'https://example.com/wp-json/',
      origin: 'https://example.com',
      fetchImpl: fakeFetch,
    });
    assert(out && out.name === 'Example', 'site name parsed');
    assert(out.namespaces.includes('wc/v3'), 'namespaces surfaced');

    const failFetch = async () => ({ ok: false, json: async () => ({}) });
    const none = await ctx.WPRest.fetchSiteInfo({
      restApiRoot: 'https://example.com/wp-json/',
      origin: 'https://example.com',
      fetchImpl: failFetch,
    });
    assert(none === null, 'returns null on !ok response');
  }

  // --- 14. Nonce extraction from inline scripts and data-* attrs --------
  {
    console.log('\n[14] findNonceInDocument — inline wpApiSettings + data-* fallbacks');

    // Pattern 1: WP's standard inline wpApiSettings object.
    const dom1 = new JSDOM(`
      <html><head>
        <script>var wpApiSettings = {"root":"https:\\/\\/example.com\\/wp-json\\/","nonce":"abc123def","versionString":"wp\\/v2\\/"};</script>
      </head><body></body></html>
    `);
    const ctx1 = loadModules(dom1);
    assert(ctx1.WPRest.findNonceInDocument(ctx1.document) === 'abc123def',
      'extracts nonce from wpApiSettings inline script');

    // Pattern 2: _wpApiSettings alias (some setups).
    const dom2 = new JSDOM(`
      <html><head>
        <script>var _wpApiSettings = {"nonce":"deadbeef","root":"x"};</script>
      </head><body></body></html>
    `);
    const ctx2 = loadModules(dom2);
    assert(ctx2.WPRest.findNonceInDocument(ctx2.document) === 'deadbeef',
      'extracts nonce from _wpApiSettings');

    // Pattern 3: createNonceMiddleware call (older API config style).
    const dom3 = new JSDOM(`
      <html><head>
        <script>wp.api.fetch.use( wp.api.fetch.createNonceMiddleware( "feedface" ) );</script>
      </head><body></body></html>
    `);
    const ctx3 = loadModules(dom3);
    assert(ctx3.WPRest.findNonceInDocument(ctx3.document) === 'feedface',
      'extracts nonce from createNonceMiddleware');

    // Pattern 4: data-rest-nonce attribute.
    const dom4 = new JSDOM(`<html><body data-rest-nonce="cafebabe"></body></html>`);
    const ctx4 = loadModules(dom4);
    assert(ctx4.WPRest.findNonceInDocument(ctx4.document) === 'cafebabe',
      'extracts nonce from data-rest-nonce');

    // No nonce anywhere → null.
    const dom5 = new JSDOM(`<html><body><script>console.log('hi');</script></body></html>`);
    const ctx5 = loadModules(dom5);
    assert(ctx5.WPRest.findNonceInDocument(ctx5.document) === null,
      'returns null when nothing matches');
  }

  // --- 15. fetchRawContent sends X-WP-Nonce when given a nonce ----------
  {
    console.log('\n[15] fetchRawContent — X-WP-Nonce wiring');
    const dom = new JSDOM(`<html><body></body></html>`);
    const ctx = loadModules(dom);

    let capturedHeaders = null;
    const mockFetch = async (url, options) => {
      capturedHeaders = options && options.headers;
      return { ok: true, async json() { return { content: { raw: '<!-- wp:paragraph --><p>hi</p><!-- /wp:paragraph -->' } }; } };
    };

    const raw = await ctx.WPRest.fetchRawContent({
      restApiRoot: 'https://example.com/wp-json/',
      origin: 'https://example.com',
      postType: 'post',
      postId: 42,
      nonce: 'beefdead',
      fetchImpl: mockFetch,
    });
    assert(typeof raw === 'string' && raw.includes('wp:paragraph'), 'raw content returned');
    assert(capturedHeaders && capturedHeaders['X-WP-Nonce'] === 'beefdead',
      'X-WP-Nonce header set from nonce option');

    // Without a nonce, the header is omitted (caller's choice — silent
    // 401 will follow, but the helper itself is honest about not
    // fabricating auth).
    capturedHeaders = null;
    await ctx.WPRest.fetchRawContent({
      restApiRoot: 'https://example.com/wp-json/',
      origin: 'https://example.com',
      postType: 'post',
      postId: 42,
      fetchImpl: mockFetch,
    });
    assert(capturedHeaders === undefined, 'no headers object when nonce omitted');
  }

  // --- 16. +New same-origin guard ---------------------------------------
  {
    console.log('\n[16] +New menu filters off-origin + non-/wp-admin/ hrefs');
    const dom = new JSDOM(`
      <html><head>
        <link rel="https://api.w.org/" href="https://example.com/wp-json/">
      </head><body class="logged-in admin-bar">
        <div id="wpadminbar">
          <li id="wp-admin-bar-new-content"><ul class="ab-submenu">
            <li id="wp-admin-bar-new-post"><a href="https://example.com/wp-admin/post-new.php">Post</a></li>
            <li id="wp-admin-bar-new-page"><a href="https://example.com/wp-admin/post-new.php?post_type=page">Page</a></li>
            <li id="wp-admin-bar-new-evil"><a href="https://attacker.example/steal">Evil</a></li>
            <li id="wp-admin-bar-new-offpath"><a href="https://example.com/not-wp-admin/wat.php">Off-path</a></li>
          </ul></li>
        </div>
      </body></html>
    `, { url: 'https://example.com/some-page/' });
    const ctx = loadModules(dom);
    const det = ctx.WPDetect.detectWordPress(ctx.document);
    const items = det.context.newContentItems;
    assert(items.length === 2,
      `2 items survive the filter (got ${items.length}: ${items.map(i => i.id).join(', ')})`);
    assert(items.every((i) => i.href.startsWith('https://example.com/wp-admin/')),
      'all surviving hrefs are same-origin /wp-admin/');
    assert(!items.some((i) => i.id === 'evil'), 'cross-origin attacker entry dropped');
    assert(!items.some((i) => i.id === 'offpath'), 'same-origin but non-/wp-admin/ entry dropped');

    // Explicit origin override (used when doc came from DOMParser).
    const dom2 = new JSDOM(`
      <html><body class="logged-in admin-bar">
        <div id="wpadminbar">
          <li id="wp-admin-bar-new-content"><ul class="ab-submenu">
            <li id="wp-admin-bar-new-post"><a href="https://wp.example/wp-admin/post-new.php">Post</a></li>
          </ul></li>
        </div>
      </body></html>
    `);
    const ctx2 = loadModules(dom2);
    const det2 = ctx2.WPDetect.detectWordPress(ctx2.document, { origin: 'https://wp.example' });
    assert(det2.context.newContentItems.length === 1,
      'explicit options.origin lets DOMParser-style docs validate hrefs');
  }

  // --- 17. DOM-sourced admin-bar URL guards -----------------------------
  // A hostile page can fake an admin bar, so same-origin alone isn't enough:
  // edit/admin URLs must be /wp-admin/, and logout must be the real WP shape.
  {
    console.log('\n[17] isSameOriginAdminUrl / isSameOriginLogoutUrl guards');
    const dom = new JSDOM(`<html><body></body></html>`);
    const ctx = loadModules(dom);
    const O = 'https://example.com';
    const adminUrl = ctx.WPRest.isSameOriginAdminUrl;
    const logoutUrl = ctx.WPRest.isSameOriginLogoutUrl;

    // isSameOriginAdminUrl — same-origin /wp-admin/ required.
    assert(adminUrl('https://example.com/wp-admin/post-new.php', O) === true, 'same-origin /wp-admin/ accepted');
    assert(adminUrl('https://example.com/wordpress/wp-admin/post.php', O) === true, 'subdirectory /wp-admin/ accepted');
    assert(adminUrl('https://attacker.example/wp-admin/post-new.php', O) === false, 'cross-origin rejected');
    assert(adminUrl('https://example.com/random-page', O) === false, 'same-origin non-/wp-admin/ rejected');
    // Malicious same-origin paths a spoofed admin bar might inject:
    assert(adminUrl('https://example.com/account/delete', O) === false, 'same-origin /account/delete rejected');
    assert(adminUrl('https://example.com/not-wp-admin/post.php?action=edit', O) === false, '"not-wp-admin" lookalike rejected');
    assert(adminUrl('not a url', O) === false, 'malformed URL rejected');
    assert(adminUrl(null, O) === false, 'null href rejected');
    assert(adminUrl('https://example.com/wp-admin/x', null) === false, 'null origin rejected');

    // isSameOriginLogoutUrl — same-origin wp-login.php?action=logout required.
    assert(logoutUrl('https://example.com/wp-login.php?action=logout', O) === true, 'logout shape accepted');
    assert(logoutUrl('https://example.com/wp-login.php?action=logout&_wpnonce=abc123', O) === true, 'logout with nonce accepted');
    assert(logoutUrl('https://example.com/wordpress/wp-login.php?action=logout', O) === true, 'subdirectory logout accepted');
    assert(logoutUrl('https://example.com/wp-login.php?action=not-logout', O) === false, 'wrong action rejected');
    assert(logoutUrl('https://example.com/wp-login.php', O) === false, 'missing action rejected');
    assert(logoutUrl('https://example.com/account/delete', O) === false, 'non-login path rejected');
    assert(logoutUrl('https://attacker.example/wp-login.php?action=logout', O) === false, 'cross-origin logout rejected');
    assert(logoutUrl(null, O) === false, 'null logout href rejected');
  }

  // --- 18. Site icon detection from <link> tags -------------------------
  {
    console.log('\n[18] Site icon — priority across <link> tag selectors');

    // 192×192 is preferred when present.
    const dom1 = new JSDOM(`
      <html><head>
        <link rel="https://api.w.org/" href="https://example.com/wp-json/">
        <link rel="icon" sizes="192x192" href="https://example.com/icon-192.png">
        <link rel="apple-touch-icon" href="https://example.com/icon-apple.png">
        <link rel="icon" sizes="32x32" href="https://example.com/icon-32.png">
      </head><body></body></html>
    `);
    const ctx1 = loadModules(dom1);
    const det1 = ctx1.WPDetect.detectWordPress(ctx1.document);
    assert(det1.context.siteIconUrl === 'https://example.com/icon-192.png',
      '192x192 wins when all three are present');

    // Falls back to apple-touch-icon.
    const dom2 = new JSDOM(`
      <html><head>
        <link rel="apple-touch-icon" href="https://example.com/icon-apple.png">
        <link rel="icon" sizes="32x32" href="https://example.com/icon-32.png">
      </head><body></body></html>
    `);
    const ctx2 = loadModules(dom2);
    const det2 = ctx2.WPDetect.detectWordPress(ctx2.document);
    assert(det2.context.siteIconUrl === 'https://example.com/icon-apple.png',
      'apple-touch-icon used when 192x192 absent');

    // Falls back to 32x32.
    const dom3 = new JSDOM(`
      <html><head>
        <link rel="icon" sizes="32x32" href="https://example.com/icon-32.png">
      </head><body></body></html>
    `);
    const ctx3 = loadModules(dom3);
    const det3 = ctx3.WPDetect.detectWordPress(ctx3.document);
    assert(det3.context.siteIconUrl === 'https://example.com/icon-32.png',
      '32x32 used as last resort');

    // Bare <link rel="icon"> without sizes is intentionally ignored —
    // that's where generic theme favicons live.
    const dom4 = new JSDOM(`
      <html><head>
        <link rel="icon" href="https://example.com/favicon.ico">
      </head><body></body></html>
    `);
    const ctx4 = loadModules(dom4);
    const det4 = ctx4.WPDetect.detectWordPress(ctx4.document);
    assert(det4.context.siteIconUrl === null,
      'bare <link rel="icon"> (no sizes) skipped to avoid generic favicons');

    // No icon links at all → null.
    const dom5 = new JSDOM(`<html><head></head><body></body></html>`);
    const ctx5 = loadModules(dom5);
    const det5 = ctx5.WPDetect.detectWordPress(ctx5.document);
    assert(det5.context.siteIconUrl === null, 'null when no icon links present');

    // Scheme allowlist — javascript: rejected even though browsers
    // already block <img src="javascript:...">. Belt-and-suspenders.
    const dom6 = new JSDOM(`
      <html><head>
        <link rel="icon" sizes="192x192" href="javascript:alert(1)">
      </head><body></body></html>
    `);
    const ctx6 = loadModules(dom6);
    const det6 = ctx6.WPDetect.detectWordPress(ctx6.document);
    assert(det6.context.siteIconUrl === null, 'javascript: scheme rejected');

    // data: URIs (legit for inline SVG/PNG icons) accepted.
    const dom7 = new JSDOM(`
      <html><head>
        <link rel="icon" sizes="192x192" href="data:image/png;base64,iVBORw0KGgo=">
      </head><body></body></html>
    `);
    const ctx7 = loadModules(dom7);
    const det7 = ctx7.WPDetect.detectWordPress(ctx7.document);
    assert(det7.context.siteIconUrl?.startsWith('data:image/png'),
      'data: scheme accepted');
  }

  // --- 19. fetchCurrentUser hits /users/me with context=edit + nonce ----
  {
    console.log('\n[19] fetchCurrentUser — URL, headers, response shape');
    const dom = new JSDOM(`<html><body></body></html>`);
    const ctx = loadModules(dom);

    let capturedUrl = null;
    let capturedHeaders = null;
    const mockFetch = async (url, options) => {
      capturedUrl = url;
      capturedHeaders = options && options.headers;
      return {
        ok: true,
        async json() { return { id: 1, name: 'Jane', roles: ['administrator'] }; },
      };
    };

    const user = await ctx.WPRest.fetchCurrentUser({
      restApiRoot: 'https://example.com/wp-json/',
      origin: 'https://example.com',
      nonce: 'deadbeef',
      fetchImpl: mockFetch,
    });
    assert(capturedUrl === 'https://example.com/wp-json/wp/v2/users/me?context=edit',
      'hits /wp/v2/users/me with context=edit');
    assert(capturedHeaders && capturedHeaders['X-WP-Nonce'] === 'deadbeef',
      'X-WP-Nonce header forwarded');
    assert(user && Array.isArray(user.roles) && user.roles[0] === 'administrator',
      'response JSON returned verbatim');

    capturedUrl = null;
    await ctx.WPRest.fetchCurrentUser({
      restApiRoot: 'https://attacker.example/wp-json/',
      origin: 'https://example.com',
      nonce: 'deadbeef',
      fetchImpl: mockFetch,
    });
    assert(capturedUrl === 'https://example.com/wp-json/wp/v2/users/me?context=edit',
      'off-origin REST root falls back to same-origin /wp-json/');

    // Non-2xx → null.
    const nullUser = await ctx.WPRest.fetchCurrentUser({
      restApiRoot: 'https://example.com/wp-json/',
      origin: 'https://example.com',
      fetchImpl: async () => ({ ok: false }),
    });
    assert(nullUser === null, '401 response yields null');
  }

  // --- 20. User info from admin bar -------------------------------------
  // Avatar URL, display name, and edit-profile href come from the
  // My Account / User Info menu items. Drives the popup's user menu.
  {
    console.log('\n[20] User info extracted from admin bar');
    const dom = new JSDOM(`
      <html><body class="logged-in admin-bar">
        <div id="wpadminbar">
          <ul id="wp-admin-bar-top-secondary">
            <li id="wp-admin-bar-my-account">
              <a class="ab-item" href="https://example.com/wp-admin/profile.php">
                Howdy, <span class="display-name">Jane</span>
                <img alt="" src="https://secure.gravatar.com/avatar/abc?s=26" class="avatar avatar-26 photo">
              </a>
              <div class="ab-sub-wrapper">
                <ul id="wp-admin-bar-user-actions" class="ab-submenu">
                  <li id="wp-admin-bar-user-info">
                    <a class="ab-item" href="https://example.com/wp-admin/profile.php">
                      <img alt="" src="https://secure.gravatar.com/avatar/abc?s=64" class="avatar avatar-64 photo">
                      <span class="display-name">Jane Doe</span>
                    </a>
                  </li>
                  <li id="wp-admin-bar-edit-profile">
                    <a class="ab-item" href="https://example.com/wp-admin/profile.php">Edit Profile</a>
                  </li>
                  <li id="wp-admin-bar-logout">
                    <a class="ab-item" href="https://example.com/wp-login.php?action=logout&_wpnonce=abc">Log Out</a>
                  </li>
                </ul>
              </div>
            </li>
          </ul>
        </div>
      </body></html>
    `);
    const ctx = loadModules(dom);
    const det = ctx.WPDetect.detectWordPress(ctx.document, { origin: 'https://example.com' });
    assert(det.context.userAvatarUrl === 'https://secure.gravatar.com/avatar/abc?s=64',
      '64×64 avatar (from user-info submenu) wins over 26×26 top-level');
    assert(det.context.userDisplayName === 'Jane Doe',
      'displayName picked up from user-info submenu');
    assert(det.context.userEditProfileHref === 'https://example.com/wp-admin/profile.php',
      'edit-profile href captured');

    // Top-level fallback when the submenu is missing.
    const dom2 = new JSDOM(`
      <html><body class="logged-in admin-bar">
        <div id="wpadminbar">
          <li id="wp-admin-bar-my-account">
            <a class="ab-item" href="https://example.com/wp-admin/profile.php">
              <span class="display-name">Solo</span>
              <img alt="" src="https://example.com/avatar.png" class="avatar">
            </a>
          </li>
        </div>
      </body></html>
    `);
    const ctx2 = loadModules(dom2);
    const det2 = ctx2.WPDetect.detectWordPress(ctx2.document, { origin: 'https://example.com' });
    assert(det2.context.userAvatarUrl === 'https://example.com/avatar.png',
      'falls back to top-level avatar when user-info submenu absent');
    assert(det2.context.userDisplayName === 'Solo', 'display-name from top-level link');
    assert(det2.context.userEditProfileHref === null, 'no edit-profile href when submenu missing');

    // javascript: URLs in the avatar src must be rejected.
    const dom3 = new JSDOM(`
      <html><body class="logged-in admin-bar">
        <div id="wpadminbar">
          <li id="wp-admin-bar-user-info">
            <img alt="" src="javascript:alert(1)" class="avatar">
          </li>
        </div>
      </body></html>
    `);
    const ctx3 = loadModules(dom3);
    const det3 = ctx3.WPDetect.detectWordPress(ctx3.document, { origin: 'https://example.com' });
    assert(det3.context.userAvatarUrl === null, 'javascript: avatar URL rejected');

    // Super admin signal — multisite renders #wp-admin-bar-network-admin
    // only when the current user is a super admin. Single-site installs
    // (or non-super-admins on multisite) never get the wrapper node.
    const domSuper = new JSDOM(`
      <html><body class="logged-in admin-bar">
        <div id="wpadminbar">
          <li id="wp-admin-bar-my-sites">
            <li id="wp-admin-bar-network-admin">
              <li id="wp-admin-bar-network-admin-d"><a href="/wp-admin/network/">Network Dashboard</a></li>
            </li>
          </li>
        </div>
      </body></html>
    `);
    const ctxSuper = loadModules(domSuper);
    const detSuper = ctxSuper.WPDetect.detectWordPress(ctxSuper.document, { origin: 'https://example.com' });
    assert(detSuper.context.isSuperAdmin === true,
      'super admin detected from #wp-admin-bar-network-admin');

    const domPlain = new JSDOM(`
      <html><body class="logged-in admin-bar">
        <div id="wpadminbar">
          <li id="wp-admin-bar-my-account"><a href="/wp-admin/profile.php">Hi</a></li>
        </div>
      </body></html>
    `);
    const ctxPlain = loadModules(domPlain);
    const detPlain = ctxPlain.WPDetect.detectWordPress(ctxPlain.document, { origin: 'https://example.com' });
    assert(detPlain.context.isSuperAdmin === false,
      'plain logged-in user (no network admin menu) is not flagged as super admin');
  }

  // --- 21. Template-backed views — candidate slugs ----------------------
  {
    console.log('\n[21] templateCandidates — hierarchy per page type');
    const dom = new JSDOM(`<html><body></body></html>`);
    const ctx = loadModules(dom);
    const cand = ctx.WPRest.templateCandidates;

    assert(JSON.stringify(cand({ pageType: 'home' })) === JSON.stringify(['home', 'index']),
      'home → [home, index]');
    assert(JSON.stringify(cand({ pageType: 'archive' })) === JSON.stringify(['archive', 'index']),
      'bare archive → [archive, index]');
    assert(JSON.stringify(cand({ pageType: 'archive', postType: 'book' }))
      === JSON.stringify(['archive-book', 'archive', 'index']),
      'post-type archive → [archive-book, archive, index]');
    assert(cand({ pageType: 'term' }).length === 0,
      'term page type yields no template candidates (handled by term.php)');
    assert(cand({ pageType: 'single' }).length === 0, 'single yields none');

    assert(ctx.WPRest.isTemplateBackedPage({ pageType: 'home' }) === true, 'home is template-backed');
    assert(ctx.WPRest.isTemplateBackedPage({ pageType: 'archive' }) === true, 'archive is template-backed');
    assert(ctx.WPRest.isTemplateBackedPage({ pageType: 'term' }) === false, 'term is NOT template-backed');
  }

  // --- 22. pickTemplate matches the most specific registered slug --------
  {
    console.log('\n[22] pickTemplate — most specific registered template wins');
    const dom = new JSDOM(`<html><body></body></html>`);
    const ctx = loadModules(dom);
    const pick = ctx.WPRest.pickTemplate;

    const templates = [
      { id: 'twentytwentyfour//index', slug: 'index' },
      { id: 'twentytwentyfour//archive', slug: 'archive' },
      { id: 'twentytwentyfour//home', slug: 'home' },
    ];

    assert(pick({ pageType: 'home' }, templates).slug === 'home',
      'home view picks the home template over index');
    assert(pick({ pageType: 'archive' }, templates).slug === 'archive',
      'archive view picks the archive template');
    // No archive-book registered → falls back to archive.
    assert(pick({ pageType: 'archive', postType: 'book' }, templates).slug === 'archive',
      'post-type archive falls back to archive when archive-book absent');
    // Only index registered → home falls all the way back to index.
    assert(pick({ pageType: 'home' }, [{ id: 'x//index', slug: 'index' }]).slug === 'index',
      'home falls back to index when home template absent');
    assert(pick({ pageType: 'home' }, []) === null, 'no templates → null');
    assert(pick({ pageType: 'home' }, null) === null, 'null templates → null');
    // Templates missing an id are ignored (can't build a postId from them).
    assert(pick({ pageType: 'home' }, [{ slug: 'home' }]) === null,
      'template without id is skipped');
  }

  // --- 23. buildSiteEditorUrl encodes the template id -------------------
  {
    console.log('\n[23] buildSiteEditorUrl — site editor deep link');
    const dom = new JSDOM(`<html><body></body></html>`);
    const ctx = loadModules(dom);
    const build = ctx.WPRest.buildSiteEditorUrl;

    const url = build('https://example.com', { id: 'twentytwentyfour//home', slug: 'home' });
    assert(url === 'https://example.com/wp-admin/site-editor.php?postType=wp_template&postId=twentytwentyfour%2F%2Fhome&canvas=edit',
      `deep link built + id encoded: ${url}`);
    assert(build('https://example.com', null) === null, 'null template → null URL');
    assert(build('https://example.com', { slug: 'home' }) === null, 'template without id → null URL');
  }

  // --- 24. resolveTemplateEditUrlAsync — block vs classic theme ---------
  {
    console.log('\n[24] resolveTemplateEditUrlAsync — full block-theme resolution');
    const dom = new JSDOM(`<html><body></body></html>`);
    const ctx = loadModules(dom);

    // Block theme: /themes?status=active reports is_block_theme, then
    // /templates lists the registered templates.
    const blockFetch = async (url, _options) => {
      if (url.includes('/wp/v2/themes')) {
        return { ok: true, async json() { return [{ stylesheet: 'twentytwentyfour', is_block_theme: true }]; } };
      }
      if (url.includes('/wp/v2/templates')) {
        return {
          ok: true,
          async json() {
            return [
              { id: 'twentytwentyfour//index', slug: 'index' },
              { id: 'twentytwentyfour//home', slug: 'home' },
            ];
          },
        };
      }
      return { ok: false };
    };

    const blogHome = await ctx.WPRest.resolveTemplateEditUrlAsync({
      ctx: { pageType: 'home', restApiRoot: 'https://example.com/wp-json/' },
      origin: 'https://example.com',
      nonce: 'deadbeef',
      fetchImpl: blockFetch,
    });
    assert(blogHome.isBlockTheme === true, 'block theme detected via is_block_theme');
    assert(blogHome.url === 'https://example.com/wp-admin/site-editor.php?postType=wp_template&postId=twentytwentyfour%2F%2Fhome&canvas=edit',
      `blog index resolves to the home template: ${blogHome.url}`);

    // Archive on the same block theme → falls back to the index template
    // (no archive template registered above).
    const archive = await ctx.WPRest.resolveTemplateEditUrlAsync({
      ctx: { pageType: 'archive', restApiRoot: 'https://example.com/wp-json/' },
      origin: 'https://example.com',
      nonce: 'deadbeef',
      fetchImpl: blockFetch,
    });
    assert(archive.url && archive.url.includes('postId=twentytwentyfour%2F%2Findex'),
      `archive falls back to index template: ${archive.url}`);

    // Classic theme: is_block_theme false → no URL, honest flag.
    const classicFetch = async (url) => {
      if (url.includes('/wp/v2/themes')) {
        return { ok: true, async json() { return [{ stylesheet: 'twentytwentyone', is_block_theme: false }]; } };
      }
      return { ok: false };
    };
    const classic = await ctx.WPRest.resolveTemplateEditUrlAsync({
      ctx: { pageType: 'home', restApiRoot: 'https://example.com/wp-json/' },
      origin: 'https://example.com',
      nonce: 'deadbeef',
      fetchImpl: classicFetch,
    });
    assert(classic.isBlockTheme === false && classic.url === null,
      'classic theme → no URL, isBlockTheme=false');

    // Theme lookup fails (non-admin / REST off) → isBlockTheme null.
    const unauthFetch = async () => ({ ok: false });
    const unknown = await ctx.WPRest.resolveTemplateEditUrlAsync({
      ctx: { pageType: 'home', restApiRoot: 'https://example.com/wp-json/' },
      origin: 'https://example.com',
      fetchImpl: unauthFetch,
    });
    assert(unknown.isBlockTheme === null && unknown.url === null,
      'undeterminable theme → isBlockTheme=null, url=null');

    // Non-template-backed page short-circuits without any fetch.
    let touched = false;
    const guardFetch = async () => { touched = true; return { ok: false }; };
    const term = await ctx.WPRest.resolveTemplateEditUrlAsync({
      ctx: { pageType: 'term', restApiRoot: 'https://example.com/wp-json/' },
      origin: 'https://example.com',
      fetchImpl: guardFetch,
    });
    assert(term.url === null && touched === false,
      'term page short-circuits — no REST calls made');
  }

  // --- 25. Subdirectory install — base URL derivation (issue #33) -------
  {
    console.log('\n[25] Subdirectory install base URL + admin link resolution');

    // deriveBaseUrl across the URL shapes WordPress emits.
    const dom = new JSDOM(`<html><body></body></html>`);
    const ctx = loadModules(dom);
    const derive = ctx.WPDetect.deriveBaseUrl;

    assert(
      derive('https://example.com', 'https://example.com/wordpress/wp-json/')
        === 'https://example.com/wordpress',
      'pretty permalinks: /wordpress/wp-json/ → /wordpress base');
    assert(
      derive('https://example.com', 'https://example.com/wordpress/?rest_route=/')
        === 'https://example.com/wordpress',
      'plain permalinks: /wordpress/?rest_route=/ → /wordpress base');
    assert(
      derive('https://example.com', 'https://example.com/wp-json/')
        === 'https://example.com',
      'root install: /wp-json/ → bare origin');
    assert(
      derive('https://example.com', 'https://example.com/?rest_route=/')
        === 'https://example.com',
      'root install, plain permalinks → bare origin');
    assert(
      derive('https://example.com', 'https://attacker.example/wp-json/')
        === 'https://example.com',
      'off-origin REST root ignored → falls back to origin');
    assert(
      derive('https://example.com', null) === 'https://example.com',
      'missing REST root → falls back to origin');

    // End-to-end: a subdir install's detection context carries the base,
    // and the sync edit-URL resolver builds links under it.
    const dom2 = new JSDOM(`
      <html><head>
        <link rel="https://api.w.org/" href="https://example.com/wordpress/wp-json/">
      </head><body class="single single-post postid-55 logged-in admin-bar"></body></html>
    `, { url: 'https://example.com/wordpress/hello-world/' });
    const ctx2 = loadModules(dom2);
    const det2 = ctx2.WPDetect.detectWordPress(ctx2.document, { origin: 'https://example.com' });
    assert(det2.context.baseUrl === 'https://example.com/wordpress',
      `context.baseUrl carries the subdirectory (got ${det2.context.baseUrl})`);
    const editUrl = ctx2.WPRest.resolveEditUrlSync(det2.context, 'https://example.com');
    assert(editUrl === 'https://example.com/wordpress/wp-admin/post.php?post=55&action=edit',
      `sync edit URL is subdirectory-aware: ${editUrl}`);

    // Same-origin admin guard accepts /wp-admin/ under a subdirectory.
    assert(
      ctx2.WPRest.isSameOriginAdminUrl(
        'https://example.com/wordpress/wp-admin/post-new.php', 'https://example.com') === true,
      'isSameOriginAdminUrl accepts subdirectory /wp-admin/');
  }

  // --- 26. Not a WordPress site -----------------------------------------
  {
    console.log('\n[26] Non-WordPress page');
    const dom = new JSDOM(`<html><head><title>Not WP</title></head><body>hello</body></html>`);
    const ctx = loadModules(dom);
    const det = ctx.WPDetect.detectWordPress(ctx.document);
    assert(det.isWordPress === false, 'isWordPress=false');
    assert(det.confidence === 0, 'confidence=0');
  }

  // --- 27. Capability gating for Edit / WordPress Admin -----------------
  {
    console.log('\n[27] WPRest.canAccessAdmin / canEditCurrent capability gates');
    const dom = new JSDOM('<html><body></body></html>');
    const ctx = loadModules(dom);
    const { canAccessAdmin, canEditCurrent } = ctx.WPRest;

    const subscriber = { capabilities: { read: true, subscriber: true } };
    const contributor = { capabilities: { read: true, edit_posts: true } };
    const editor = {
      capabilities: {
        read: true, edit_posts: true, edit_pages: true,
        edit_others_posts: true, manage_categories: true,
      },
    };
    const admin = { capabilities: { ...editor.capabilities, edit_users: true } };

    // --- canAccessAdmin: caps path — gates on meaningful (editing) access,
    //     not bare `read`, so a subscriber-tier account is disabled.
    const noBar = { isLoggedIn: true, hasAdminBar: true };
    assert(canAccessAdmin(noBar, subscriber) === false, 'subscriber (read only) → admin disabled');
    assert(canAccessAdmin(noBar, contributor) === true, 'contributor → admin enabled');
    assert(canAccessAdmin(noBar, editor) === true, 'editor → admin enabled');
    assert(canAccessAdmin({}, null) === null, 'no caps, no admin bar → null (do not gate)');
    assert(canAccessAdmin({}, {}) === null, 'caps map absent + no DOM signal → null');

    // --- canAccessAdmin: DOM-first path (no caps / REST 401). The admin bar
    //     WordPress rendered is the signal.
    const barWithNew = { isLoggedIn: true, hasAdminBar: true, newContentItems: [{ id: 'post' }] };
    const barBare = { isLoggedIn: true, hasAdminBar: true, newContentItems: [] };
    assert(canAccessAdmin(barWithNew, null) === true, 'no caps but "+ New" menu → admin enabled');
    assert(canAccessAdmin(barBare, null) === false, 'no caps, bare admin bar → admin disabled');

    // --- canEditCurrent: caps path -------------------------------------
    // Single page — requires edit_pages.
    const pageCtx = { pageType: 'single', postType: 'page' };
    assert(canEditCurrent(pageCtx, subscriber) === false, 'subscriber cannot edit a page');
    assert(canEditCurrent(pageCtx, contributor) === false, 'contributor cannot edit a page');
    assert(canEditCurrent(pageCtx, editor) === true, 'editor can edit a page');

    // Single post — requires the edit_posts family.
    const postCtx = { pageType: 'single', postType: 'post' };
    assert(canEditCurrent(postCtx, subscriber) === false, 'subscriber cannot edit a post');
    assert(canEditCurrent(postCtx, contributor) === true, 'contributor can edit a post (no bar to read → caps fallback)');

    // Per-object beats general caps: the same contributor on a published post
    // they don't own (admin bar rendered, no Edit link) is gated even though
    // their edit_posts cap is set — WP already ran current_user_can for the bar.
    assert(
      canEditCurrent(
        { pageType: 'single', postType: 'post', isLoggedIn: true, hasAdminBar: true },
        contributor,
      ) === false,
      'contributor on a non-editable single post (bar shown, no edit link) → disabled despite caps',
    );

    // Author archive — admin-only (edit_users).
    const authorCtx = { pageType: 'author', authorId: 7 };
    assert(canEditCurrent(authorCtx, editor) === false, 'editor cannot edit a user');
    assert(canEditCurrent(authorCtx, admin) === true, 'admin can edit a user');

    // Term archive — requires manage_categories.
    const termCtx = { pageType: 'term', taxonomy: 'category', termId: 3 };
    assert(canEditCurrent(termCtx, contributor) === false, 'contributor cannot edit a term');
    assert(canEditCurrent(termCtx, editor) === true, 'editor can edit a term');

    // Authoritative admin-bar Edit link short-circuits the heuristic.
    assert(
      canEditCurrent({ ...pageCtx, adminBarEditHref: 'https://x/wp-admin/post.php?post=1&action=edit' }, subscriber) === true,
      'admin-bar Edit link is trusted even when caps would gate',
    );

    // --- canEditCurrent: DOM-first path (no caps / REST 401). This is the
    //     wordpress.org case: logged in, admin bar shown, no edit link.
    assert(
      canEditCurrent({ pageType: 'single', postType: 'post', postId: 28583, isLoggedIn: true, hasAdminBar: true }, null) === false,
      'no caps + admin bar present + no edit link on a single post → edit disabled',
    );
    assert(
      canEditCurrent({ pageType: 'single', postType: 'post', isLoggedIn: true, hasAdminBar: false }, null) === null,
      'admin bar hidden → unknown (do not gate)',
    );
    assert(
      canEditCurrent({ pageType: 'term', taxonomy: 'category', isLoggedIn: true, hasAdminBar: true }, null) === null,
      'no caps on a term archive stays unknown (bar edit link is unreliable there)',
    );

    // Unsupported page type → null (caller does not gate).
    assert(canEditCurrent({ pageType: 'archive' }, editor) === null, 'archive has no edit decision');
  }

  // --- 28. My Sites store helpers ---------------------------------------
  {
    console.log('\n[28] WPMySites store helpers (add on login / curation / sort)');
    const dom = new JSDOM('<html><body></body></html>');
    const { WPMySites } = loadModules(dom);
    const A = 'https://acme.com', B = 'https://blog.example.com', C = 'https://shop.example.com';
    const listed = (store) => WPMySites.listSites(store).map((s) => s.origin);

    // Fresh login adds; second login bumps recency, not a duplicate.
    let store = {};
    store = WPMySites.upsertOnLogin(store, { origin: A, baseUrl: A, wasLoggedIn: false, now: 100 });
    assert(!!store[A], 'fresh login adds the site');
    assert(store[A].addedAt === 100 && store[A].lastLoggedInAt === 100, 'timestamps set on add');
    store = WPMySites.upsertOnLogin(store, { origin: A, baseUrl: A, wasLoggedIn: true, now: 200 });
    assert(Object.keys(store).length === 1 && store[A].lastLoggedInAt === 200, 'revisit bumps recency, no dupe');

    // Already-logged-in site (no transition) still gets added when absent.
    store = WPMySites.upsertOnLogin(store, { origin: C, baseUrl: C, wasLoggedIn: true, now: 250 });
    assert(listed(store).includes(C), 'already-logged-in absent site is added regardless of transition');

    // Remove tombstones (hidden, not deleted) so still-logged-in browsing
    // does NOT silently re-add it.
    store = WPMySites.removeSite(store, A);
    assert(store[A] && store[A].dismissed === true, 'remove tombstones the record');
    assert(!listed(store).includes(A), 'removed site is hidden from the list');
    store = WPMySites.upsertOnLogin(store, { origin: A, baseUrl: A, wasLoggedIn: true, now: 300 });
    assert(!listed(store).includes(A), 'still-logged-in browsing does not re-add a removed site');
    // A genuine logged-out → logged-in transition un-dismisses it.
    store = WPMySites.upsertOnLogin(store, { origin: A, baseUrl: A, wasLoggedIn: false, now: 400 });
    assert(listed(store).includes(A), 'fresh login transition re-adds a removed site');

    // Sort: newest login first.
    store = WPMySites.upsertOnLogin(store, { origin: B, baseUrl: B, wasLoggedIn: false, now: 500 });
    assert(listed(store)[0] === B, 'listSites sorts by lastLoggedInAt desc');

    // Rename + display label, set and clear.
    assert(WPMySites.displayName(store[A]) === 'acme.com', 'default label is the hostname (www-stripped)');
    store = WPMySites.renameSite(store, A, '  Acme — Staging  ');
    assert(store[A].customName === 'Acme — Staging', 'rename trims and sets customName');
    assert(WPMySites.displayName(store[A]) === 'Acme — Staging', 'custom name wins for the label');
    store = WPMySites.renameSite(store, A, '   ');
    assert(store[A].customName === undefined, 'blank rename clears the custom name');

    // Storage-boundary sanitization: a forged detection must not persist a
    // cross-origin baseUrl or a data:/oversized/non-http(s) iconUrl.
    const poisoned = WPMySites.upsertOnLogin({}, {
      origin: A, baseUrl: 'https://evil.example/wp',
      iconUrl: 'data:image/svg+xml,' + 'x'.repeat(5000), wasLoggedIn: false, now: 1,
    });
    assert(poisoned[A].baseUrl === null, 'cross-origin baseUrl is not persisted');
    assert(poisoned[A].iconUrl === null, 'data:/oversized iconUrl is not persisted');

    // A same-origin subdirectory base and a CDN (cross-origin http) icon are kept.
    const kept = WPMySites.upsertOnLogin({}, {
      origin: A, baseUrl: A + '/blog', iconUrl: 'https://cdn.example/i.png', wasLoggedIn: false, now: 1,
    });
    assert(kept[A].baseUrl === A + '/blog', 'same-origin subdirectory baseUrl is kept');
    assert(kept[A].iconUrl === 'https://cdn.example/i.png', 'http(s) iconUrl (incl. CDN) is kept');

    // listSites re-sanitizes records persisted before the write-time guard.
    const legacy = { [A]: { origin: A, baseUrl: 'https://evil.example', iconUrl: 'javascript:alert(1)', lastLoggedInAt: 5 } };
    const cleaned = WPMySites.listSites(legacy)[0];
    assert(cleaned.baseUrl === null, 'listSites drops a persisted cross-origin baseUrl');
    assert(cleaned.iconUrl === null, 'listSites drops a persisted non-http(s) iconUrl');
  }

  // --- 29. Package integrity — referenced runtime files exist -----------
  {
    console.log('\n[29] verify-package — every referenced runtime file is present');
    const { collectReferenced, verify } = require('../scripts/verify-package.js');
    const root = path.join(__dirname, '..');
    const refs = collectReferenced(root);
    const missing = verify(root);
    assert(missing.length === 0, `no referenced runtime files missing (missing: ${missing.join(', ') || 'none'})`);
    // Guard the exact class of regression this check exists for: new runtime
    // files that the packaging list could forget.
    assert(refs.includes('_locales/en/messages.json'), '_locales catalog tracked (manifest default_locale)');
    assert(refs.includes('lib/my-sites.js'), 'lib/my-sites.js tracked (background importScripts)');
    assert(refs.includes('lib/rest.js') && refs.includes('dist/popup.js'),
      'popup classic scripts + bundle tracked (popup.html)');
  }

  // --- 30. Block inspector: block-comment parsing + ReDoS resistance -----
  {
    console.log('\n[30] block-inspector _parseBlockComments (structure + ReDoS guard)');
    const dom = new JSDOM('<html><body></body></html>');
    const { WPDBlockInspector } = loadModules(dom);
    const parse = WPDBlockInspector._parseBlockComments;

    // Names are namespaced: bare names get the implicit `core/` prefix, and
    // explicit namespaces are preserved.
    const flat = parse('<!-- wp:paragraph -->x<!-- /wp:paragraph -->');
    assert(flat.length === 1 && flat[0].name === 'core/paragraph', 'bare block name gets core/ prefix');
    const ns = parse('<!-- wp:acme/card -->y<!-- /wp:acme/card -->');
    assert(ns.length === 1 && ns[0].name === 'acme/card', 'namespaced block name preserved');

    // Nesting: the tree mirrors open/close pairing.
    const nested = parse(
      '<!-- wp:columns --><!-- wp:column {"width":"50%"} -->' +
      '<!-- wp:paragraph -->hi<!-- /wp:paragraph -->' +
      '<!-- /wp:column --><!-- /wp:columns -->'
    );
    assert(nested.length === 1 && nested[0].name === 'core/columns', 'nesting: one top-level block');
    assert(nested[0].children[0].name === 'core/column', 'nesting: column under columns');
    assert(nested[0].children[0].children[0].name === 'core/paragraph', 'nesting: paragraph under column');
    assert(nested[0].children[0].attrs.width === '50%', 'attrs JSON parsed onto the block');

    // Self-closing (voids like spacer/nextpage) create no open frame.
    const selfClosed = parse('<!-- wp:spacer {"height":"20px"} /--><!-- wp:paragraph -->z<!-- /wp:paragraph -->');
    assert(selfClosed.length === 2, 'self-closing block does not swallow siblings');

    // Malformed attribute JSON must not throw — the block is kept with {} attrs.
    let threw = false;
    let malformed;
    try { malformed = parse('<!-- wp:image {this is not json} -->'); } catch (_) { threw = true; }
    assert(!threw, 'malformed attrs JSON does not throw');
    assert(malformed && malformed[0] && malformed[0].name === 'core/image', 'malformed-attrs block still parsed');

    // ReDoS regression: a long `<!-- wp:name` + whitespace run that never
    // closes with `-->` used to backtrack catastrophically (tens of seconds
    // at n=8000). The de-ambiguated regex keeps it linear — assert it parses
    // near-instantly. Guards against a future edit reintroducing the ambiguity.
    const evil = '<!-- wp:a' + ' '.repeat(50000) + 'X';
    const t0 = process.hrtime.bigint();
    parse(evil);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert(elapsedMs < 50, `unterminated whitespace run parses in <50ms (was ${elapsedMs.toFixed(1)}ms)`);

    // Oversized input is bounded out rather than parsed.
    assert(parse('x'.repeat(2 * 1024 * 1024 + 1)).length === 0, 'oversized input returns no blocks');
  }

  // --- 42. baseUrl from the wp-admin pathname when no REST link (#88) -----
  {
    console.log('\n[42] wp-admin pages derive baseUrl from their own pathname');
    // Admin screens never emit the REST discovery link, so the pathname
    // prefix before /wp-admin is the only base signal available there.
    const adminDom = new JSDOM(`
      <html><head></head><body class="wp-admin wp-core-ui">
        <div id="wpadminbar"></div>
      </body></html>
    `);
    const adminCtx = loadModules(adminDom);
    const multi = adminCtx.WPDetect.detectWordPress(adminCtx.document, {
      origin: 'https://www.example.com',
      pathname: '/en-us/research/wp-admin/index.php',
    });
    assert(multi.context.baseUrl === 'https://www.example.com/en-us/research',
      `multi-segment admin base = ${multi.context.baseUrl}`);

    const root = adminCtx.WPDetect.detectWordPress(adminCtx.document, {
      origin: 'https://www.example.com',
      pathname: '/wp-admin/index.php',
    });
    assert(root.context.baseUrl === 'https://www.example.com',
      `root-install admin base stays bare origin (${root.context.baseUrl})`);

    const bare = adminCtx.WPDetect.detectWordPress(adminCtx.document, {
      origin: 'https://www.example.com',
      pathname: '/en-us/research/some-page/',
    });
    assert(bare.context.baseUrl === 'https://www.example.com',
      `non-admin page without REST link keeps bare origin (${bare.context.baseUrl})`);

    // A REST discovery link still wins over the pathname heuristic.
    const restDom = new JSDOM(`
      <html><head>
        <link rel="https://api.w.org/" href="https://www.example.com/en-us/research/wp-json/">
      </head><body class="home"></body></html>
    `);
    const restCtx = loadModules(restDom);
    const rest = restCtx.WPDetect.detectWordPress(restCtx.document, {
      origin: 'https://www.example.com',
      pathname: '/en-us/research/',
    });
    assert(rest.context.baseUrl === 'https://www.example.com/en-us/research',
      `REST-derived base unchanged (${rest.context.baseUrl})`);
  }

  console.log(`\n${failures === 0 ? 'All tests passed.' : failures + ' failure(s).'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
