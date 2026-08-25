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

    // deriveBase across the URL shapes WordPress emits (base value only —
    // [45] covers the provenance it reports alongside it).
    const dom = new JSDOM(`<html><body></body></html>`);
    const ctx = loadModules(dom);
    const derive = (...a) => ctx.WPDetect.deriveBase(...a).baseUrl;

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
    // rest_url() prints the trailing slash, but filters and hand-written
    // hardening links can omit it. A terminal, segment-exact /wp-json is the
    // API root either way — never part of the install base.
    assert(
      derive('https://example.com', 'https://example.com/wp-json')
        === 'https://example.com',
      'slashless root: /wp-json → bare origin, not a /wp-json base');
    assert(
      derive('https://example.com', 'https://example.com/wordpress/wp-json')
        === 'https://example.com/wordpress',
      'slashless subdirectory: /wordpress/wp-json → /wordpress base');
    assert(
      derive('https://example.com', 'https://example.com/not-wp-json')
        === 'https://example.com/not-wp-json',
      'a segment merely ending in wp-json is not the API root');
    assert(
      derive('https://example.com', 'https://example.com/wp-jsonish/')
        === 'https://example.com/wp-jsonish',
      'a segment merely starting with wp-json is not the API root either');
    // RFC 3986 §6.2.2: percent-encoded unreserved characters are the same
    // path (%77p-json IS wp-json), and the storage layer canonicalizes them
    // away — so the API-root check must see the decoded form too, or an
    // encoded discovery link smuggles a bogus /wp-json base through to the
    // store. Encoded slashes are reserved and stay encoded (uppercased):
    // one path never reads as two.
    assert(
      derive('https://example.com', 'https://example.com/%77p-json')
        === 'https://example.com',
      'fully encoded slashless root: /%77p-json → bare origin');
    assert(
      derive('https://example.com', 'https://example.com/%77%70-%6Ason/')
        === 'https://example.com',
      'fully encoded slashed root: /%77%70-%6Ason/ → bare origin');
    assert(
      derive('https://example.com', 'https://example.com/wp-%6Ason')
        === 'https://example.com',
      'partially encoded slashless root: /wp-%6Ason → bare origin');
    assert(
      derive('https://example.com', 'https://example.com/site%41/wp-json/')
        === 'https://example.com/siteA',
      'encoded subdirectory decodes to the canonical base the store will key');
    assert(
      derive('https://example.com', 'https://example.com/sub%2fdir/wp-json/')
        === 'https://example.com/sub%2Fdir',
      'an encoded slash stays encoded and uppercased — one segment, never two');
    assert(
      derive('https://example.com', 'https://example.com/wp-json/wp-json/')
        === 'https://example.com/wp-json',
      'an install literally based at /wp-json derives from /wp-json/wp-json/');
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
    store = WPMySites.upsertOnLogin(store, { origin: A, baseUrl: A, now: 100 });
    assert(!!store[A], 'fresh login adds the site');
    assert(store[A].addedAt === 100 && store[A].lastLoggedInAt === 100, 'timestamps set on add');
    store = WPMySites.upsertOnLogin(store, { origin: A, baseUrl: A, now: 200 });
    assert(Object.keys(store).length === 1 && store[A].lastLoggedInAt === 200, 'revisit bumps recency, no dupe');
    store = WPMySites.upsertOnLogin(store, { origin: C, baseUrl: C, now: 250 });
    assert(listed(store).includes(C), 'a site the user was already logged into is added on first sight');

    // Remove is STICKY: the record tombstones (hidden, not deleted) and no
    // passive detection ever re-adds it — neither a keyed logged-in view nor
    // an attributed base-less one. Restoring is an explicit future feature.
    store = WPMySites.removeSite(store, A);
    assert(store[A] && store[A].dismissed === true, 'remove tombstones the record');
    assert(!listed(store).includes(A), 'removed site is hidden from the list');
    assert(WPMySites.upsertOnLogin(store, { origin: A, baseUrl: A, now: 300 }) === store,
      'a later logged-in view of a removed site is a same-reference no-op');
    assert(WPMySites.upsertOnLogin(store, { origin: A, baseUrl: null, pathname: '/post/', now: 310 }) === store,
      'an attributed base-less login cannot re-add it either');

    // Sort: newest login first.
    store = WPMySites.upsertOnLogin(store, { origin: B, baseUrl: B, now: 500 });
    assert(listed(store)[0] === B, 'listSites sorts by lastLoggedInAt desc');

    // Rename + display label, set and clear.
    assert(WPMySites.displayName(store[A]) === 'acme.com', 'default label is the hostname (www-stripped)');
    store = WPMySites.renameSite(store, A, '  Acme — Staging  ');
    assert(store[A].customName === 'Acme — Staging', 'rename trims and sets customName');
    assert(WPMySites.displayName(store[A]) === 'Acme — Staging', 'custom name wins for the label');
    store = WPMySites.renameSite(store, A, '   ');
    assert(store[A].customName === undefined, 'blank rename clears the custom name');

    // Storage-boundary sanitization: a forged cross-origin baseUrl finds no
    // attribution target on an empty store and mints NOTHING (pre-#94 it
    // fell back to a bare-origin record); a poisoned iconUrl is dropped
    // while the record itself persists.
    const forged = WPMySites.upsertOnLogin({}, {
      origin: A, baseUrl: 'https://evil.example/wp', now: 1,
    });
    assert(Object.keys(forged).length === 0, 'cross-origin baseUrl attributes to nothing and mints nothing');
    const poisoned = WPMySites.upsertOnLogin({}, {
      origin: A, baseUrl: A, iconUrl: 'data:image/svg+xml,' + 'x'.repeat(5000), now: 1,
    });
    assert(poisoned[A].iconUrl === null, 'data:/oversized iconUrl is not persisted');

    // A same-origin subdirectory base and a CDN (cross-origin http) icon are
    // kept — and the record keys by its install base, not the origin (#94).
    const kept = WPMySites.upsertOnLogin({}, {
      origin: A, baseUrl: A + '/blog', iconUrl: 'https://cdn.example/i.png', now: 1,
    });
    assert(kept[A + '/blog'] && kept[A + '/blog'].baseUrl === A + '/blog',
      'same-origin subdirectory baseUrl is kept and keys the record');
    assert(kept[A + '/blog'].iconUrl === 'https://cdn.example/i.png', 'http(s) iconUrl (incl. CDN) is kept');

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

    // color-scheme declaration guard (#86). This asserts the declaration
    // ships in both the markup and the compiled stylesheet, and that the
    // Safari mirror carries identical copies. It is a packaging guard, not
    // an automated Safari appearance test — the popover behavior itself is
    // only observable in a live Safari popover and stays manually verified.
    const popupHtml = fs.readFileSync(path.join(root, 'popup/popup.html'), 'utf8');
    const metaAt = popupHtml.indexOf('<meta name="color-scheme" content="light dark">');
    const styleAt = popupHtml.indexOf('<link rel="stylesheet"');
    assert(metaAt !== -1, 'popup.html declares <meta name="color-scheme">');
    assert(styleAt !== -1 && metaAt < styleAt,
      'color-scheme meta precedes the stylesheet link');
    const popupCss = fs.readFileSync(path.join(root, 'dist/popup.css'), 'utf8');
    assert(/color-scheme:\s*light dark/.test(popupCss),
      'compiled dist/popup.css carries the color-scheme declaration');
    const SAFARI_RES = 'safari/WordPress Browser Extension/WordPress Browser Extension Extension/Resources';
    for (const f of ['popup/popup.html', 'dist/popup.css']) {
      const rootCopy = fs.readFileSync(path.join(root, f), 'utf8');
      const mirrorCopy = fs.readFileSync(path.join(root, SAFARI_RES, f), 'utf8');
      assert(rootCopy === mirrorCopy, `${f} byte-identical in the Safari mirror`);
    }
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
    console.log('\n[42] admin documents derive baseUrl from their own pathname');
    const ORIGIN = 'https://www.example.com';
    // Admin screens never emit the REST discovery link; the pathname prefix
    // before the final boundary-delimited /wp-admin segment is the base.
    // The fallback is gated on body.wp-admin AND #wpwrap, both printed by
    // wp-admin/admin-header.php on every core admin screen and never on the
    // front end.
    const adminDom = new JSDOM(`
      <html><head></head><body class="wp-admin wp-core-ui">
        <div id="wpwrap">
          <div id="wpadminbar">
            <li id="wp-admin-bar-view-site"><a href="https://www.example.com/en-us/research/">Visit Site</a></li>
          </div>
        </div>
      </body></html>
    `);
    const adminCtx = loadModules(adminDom);
    const adminBase = (pathname) => adminCtx.WPDetect.detectWordPress(
      adminCtx.document, { origin: ORIGIN, pathname },
    ).context.baseUrl;

    assert(adminBase('/subdir/wp-admin/index.php') === `${ORIGIN}/subdir`,
      'subdirectory admin page');
    assert(adminBase('/subdir/wp-admin') === `${ORIGIN}/subdir`,
      'admin URL without trailing slash');
    assert(adminBase('/wp-admin/index.php') === ORIGIN,
      'root install stays bare origin');
    assert(adminBase('/wp-admin/wp-admin/index.php') === `${ORIGIN}/wp-admin`,
      'install based literally at /wp-admin');
    assert(adminBase('/alpha/wp-admin/tools/wp-admin/index.php') === `${ORIGIN}/alpha/wp-admin/tools`,
      'final boundary-delimited /wp-admin wins over earlier occurrences');
    assert(adminBase('/en-us/research/wp-admin/index.php') === `${ORIGIN}/en-us/research`,
      'multi-segment install base (#88 reported shape)');
    assert(adminBase('/sub///wp-admin/index.php') === `${ORIGIN}/sub`,
      'consecutive separators leave no trailing slash run on the base');
    assert(adminBase('/sub%2Fdir/wp-admin/index.php') === ORIGIN,
      'encoded slash fails closed to the origin');
    assert(adminBase('/sub%2fdir/wp-admin/index.php') === ORIGIN,
      'lowercase encoded slash fails closed too');
    assert(adminBase('relative/wp-admin/') === ORIGIN,
      'non-rooted pathname fails closed to the origin');

    // Visit Site capture rides along on admin screens.
    const cap = adminCtx.WPDetect.detectWordPress(adminCtx.document, {
      origin: ORIGIN, pathname: '/en-us/research/wp-admin/index.php',
    });
    assert(cap.context.adminBarVisitSiteHref === 'https://www.example.com/en-us/research/',
      'admin bar Visit Site href captured');

    // A public permalink whose slug path contains /wp-admin/ is NOT an
    // admin document: no body.wp-admin, no REST link → bare origin.
    const permalinkDom = new JSDOM(`
      <html><head></head><body class="single single-post"></body></html>
    `);
    const permalinkCtx = loadModules(permalinkDom);
    const permalink = permalinkCtx.WPDetect.detectWordPress(permalinkCtx.document, {
      origin: ORIGIN, pathname: '/guides/wp-admin/security/',
    });
    assert(permalink.context.baseUrl === ORIGIN,
      `public permalink containing /wp-admin/ keeps bare origin (${permalink.context.baseUrl})`);

    // A REST discovery link stays authoritative, including on admin docs.
    const restDom = new JSDOM(`
      <html><head>
        <link rel="https://api.w.org/" href="https://www.example.com/en-us/research/wp-json/">
      </head><body class="wp-admin"></body></html>
    `);
    const restCtx = loadModules(restDom);
    const rest = restCtx.WPDetect.detectWordPress(restCtx.document, {
      origin: ORIGIN, pathname: '/somewhere/else/wp-admin/',
    });
    assert(rest.context.baseUrl === 'https://www.example.com/en-us/research',
      `REST-derived base wins over the pathname (${rest.context.baseUrl})`);
  }

  // --- 43. My Sites keys by install base (#94) --------------------------
  {
    console.log('\n[43] My Sites: sibling installs, migration, sticky removal, no speculative rows (#94)');
    const dom = new JSDOM('<html><body></body></html>');
    const { WPMySites } = loadModules(dom);
    const HOST = 'http://localhost';
    const SA = HOST + '/siteA', SB = HOST + '/siteB';

    // The reported repro (issue #94): two subdirectory installs on one
    // origin stay two records, and each curation op touches only its own.
    let store = {};
    store = WPMySites.upsertOnLogin(store, { origin: HOST, baseUrl: SA, now: 1 });
    store = WPMySites.upsertOnLogin(store, { origin: HOST, baseUrl: SB, now: 2 });
    assert(Object.keys(store).length === 2, 'two installs on one origin → two records');
    const listed = WPMySites.listSites(store);
    assert(listed.length === 2 && listed[0].baseUrl === SB && listed[1].baseUrl === SA,
      'both installs listed, newest first, each with its own base');
    assert(listed[0].key === SB && listed[1].key === SA, 'listSites exposes canonical store keys');
    store = WPMySites.removeSite(store, SB);
    assert(WPMySites.listSites(store).length === 1 && WPMySites.listSites(store)[0].baseUrl === SA,
      'removing siteB leaves siteA listed');
    store = WPMySites.renameSite(store, SA, 'Site A');
    assert(store[SA].customName === 'Site A' && store[SB].customName === undefined,
      'rename touches only its own record');
    assert(WPMySites.displayName(store[SA]) === 'Site A', 'custom name wins');
    assert(WPMySites.defaultLabel(store[SA]) === 'localhost/siteA',
      'default label carries the install path');
    assert(WPMySites.defaultLabel({ origin: 'https://www.acme.com', baseUrl: 'https://www.acme.com/' }) === 'acme.com',
      'root install label stays the bare www-stripped host');

    // siteKey: canonical (trailing slashes trimmed, query/fragment dropped);
    // cross-origin, invalid, or missing bases fall back to the bare origin.
    assert(WPMySites.siteKey({ origin: HOST, baseUrl: SA + '///' }) === SA, 'trailing slash run trimmed');
    assert(WPMySites.siteKey({ origin: HOST, baseUrl: SA + '/?p=1#x' }) === SA, 'query/fragment dropped');
    assert(WPMySites.siteKey({ origin: HOST, baseUrl: 'https://evil.example/wp' }) === HOST,
      'cross-origin base falls back to the origin key');
    assert(WPMySites.siteKey({ origin: HOST, baseUrl: null }) === HOST, 'no base → origin key');

    // Root and subdirectory installs coexist; a base-less login attributes
    // to the longest matching install path (segment-exact) and falls to the
    // root record only when no subdirectory owns the path.
    let mixed = {};
    mixed = WPMySites.upsertOnLogin(mixed, { origin: HOST, baseUrl: HOST, now: 1 });
    mixed = WPMySites.upsertOnLogin(mixed, { origin: HOST, baseUrl: SA, now: 2 });
    assert(Object.keys(mixed).length === 2, 'root + subdirectory installs coexist');
    mixed = WPMySites.upsertOnLogin(mixed, { origin: HOST, baseUrl: null, pathname: '/siteA/2026/08/hello/', now: 3 });
    assert(Object.keys(mixed).length === 2 && mixed[SA].lastLoggedInAt === 3 && mixed[HOST].lastLoggedInAt === 1,
      'base-less login bumps the owning install, not the root record');
    mixed = WPMySites.upsertOnLogin(mixed, { origin: HOST, baseUrl: null, pathname: '/siteA', now: 4 });
    assert(mixed[SA].lastLoggedInAt === 4, 'exact base pathname (no trailing slash) attributes too');
    mixed = WPMySites.upsertOnLogin(mixed, { origin: HOST, baseUrl: null, pathname: '/siteAxe/post/', now: 5 });
    assert(mixed[HOST].lastLoggedInAt === 5 && mixed[SA].lastLoggedInAt === 4,
      '/siteAxe is not under /siteA (segment-exact) — the root record absorbs it');

    // No speculative rows: with nothing to attribute to, a base-less login
    // is dropped entirely rather than minting a bare-origin record.
    const dropped = WPMySites.upsertOnLogin({}, { origin: HOST, baseUrl: null, pathname: '/siteA/x/', now: 1 });
    assert(Object.keys(dropped).length === 0, 'unattributable login mints nothing');

    // Sticky removal through every write shape: a keyed logged-in view and
    // an attributed view of the removed install's own path are both
    // same-reference no-ops (nothing revives, nothing else is minted).
    const dism = WPMySites.removeSite(mixed, SA);
    assert(WPMySites.upsertOnLogin(dism, { origin: HOST, baseUrl: SA, now: 6 }) === dism,
      'a keyed logged-in view cannot revive a removed install');
    assert(WPMySites.upsertOnLogin(dism, { origin: HOST, baseUrl: null, pathname: '/siteA/wp-admin/', now: 7 }) === dism,
      'an attributed view of its path cannot revive it — and mints no sibling');

    // Migration: a pre-#94 store re-keys each record by its own stored base,
    // preserving curation state. Root-keyed records (the common case) are a
    // same-reference no-op so callers skip the storage write; idempotent;
    // collisions keep the most recently logged-into record; junk carries.
    const legacyRoot = { [HOST]: { origin: HOST, baseUrl: HOST, addedAt: 1, lastLoggedInAt: 1 } };
    assert(WPMySites.migrateStore(legacyRoot) === legacyRoot, 'origin-keyed root store is a no-op (same ref)');
    const legacySub = {
      [HOST]: { origin: HOST, baseUrl: SB, addedAt: 1, lastLoggedInAt: 9, customName: 'Site B', dismissed: true },
      'https://acme.com': { origin: 'https://acme.com', baseUrl: 'https://acme.com', addedAt: 2, lastLoggedInAt: 3 },
    };
    const migrated = WPMySites.migrateStore(legacySub);
    assert(migrated !== legacySub && !migrated[HOST] && !!migrated[SB],
      'subdirectory record re-keys from origin to its install base');
    assert(migrated[SB].customName === 'Site B' && migrated[SB].dismissed === true && migrated[SB].addedAt === 1,
      'migration preserves customName / dismissed / addedAt');
    assert(migrated['https://acme.com'] === legacySub['https://acme.com'],
      'unaffected records carry through untouched');
    assert(WPMySites.migrateStore(migrated) === migrated, 'migration is idempotent (same ref)');
    const collide = {
      a: { origin: HOST, baseUrl: SA, lastLoggedInAt: 1 },
      b: { origin: HOST, baseUrl: SA, lastLoggedInAt: 7 },
    };
    const winner = WPMySites.migrateStore(collide);
    assert(Object.keys(winner).length === 1 && winner[SA].lastLoggedInAt === 7,
      'a key collision keeps the most recently logged-into record');
    // A collision never drops a tombstone, in either win direction.
    const collideDismissed = WPMySites.migrateStore({
      [SA]: { origin: HOST, baseUrl: SA, lastLoggedInAt: 100, dismissed: true },
      [HOST]: { origin: HOST, baseUrl: SA, lastLoggedInAt: 200 },
    });
    assert(Object.keys(collideDismissed).length === 1
      && collideDismissed[SA].lastLoggedInAt === 200 && collideDismissed[SA].dismissed === true,
      'the newer record wins the collision but inherits the tombstone');
    const collideDismissedOld = WPMySites.migrateStore({
      [SA]: { origin: HOST, baseUrl: SA, lastLoggedInAt: 300 },
      [HOST]: { origin: HOST, baseUrl: SA, lastLoggedInAt: 5, dismissed: true },
    });
    assert(collideDismissedOld[SA].lastLoggedInAt === 300 && collideDismissedOld[SA].dismissed === true,
      'an older dismissed loser still marks the surviving record');
    // Uninterpretable records (no valid same-shape http(s) origin) are
    // DROPPED during migration: invisible to the popup, unreachable by
    // curation, and dropping keeps hostile keys out of the accumulator.
    const j = WPMySites.migrateStore({
      weird: { notASite: true },
      nullish: null,
      poisonedOrigin: { origin: '__proto__', lastLoggedInAt: 9 },
      [HOST]: { origin: HOST, baseUrl: SA, lastLoggedInAt: 1 },
    });
    assert(!j.weird && !j.nullish && !!j[SA] && Object.keys(j).length === 1,
      'uninterpretable records are dropped during migration');
    const junkClobber = WPMySites.migrateStore({
      'https://x.example/': { origin: 'https://x.example', baseUrl: null, lastLoggedInAt: 9, customName: 'real' },
      'https://x.example': null,
    });
    assert(junkClobber['https://x.example']?.customName === 'real' && Object.keys(junkClobber).length === 1,
      "a junk entry is dropped, never contesting a real record's canonical slot");
    const protoStore = WPMySites.migrateStore(JSON.parse(
      `{"__proto__":{"x":1},"${HOST}":{"origin":"${HOST}","baseUrl":"${SA}","lastLoggedInAt":1}}`,
    ));
    assert(!!protoStore[SA] && Object.getPrototypeOf(protoStore) === Object.prototype,
      'a hostile __proto__ entry is dropped, never assigned into the accumulator');

    // Curation lookups are own-property only: inherited names must be
    // absent-key no-ops (same reference back), never prototype reads/writes.
    const guarded = { [SA]: { origin: HOST, baseUrl: SA, lastLoggedInAt: 1 } };
    assert(WPMySites.removeSite(guarded, '__proto__') === guarded, "removeSite('__proto__') is a no-op");
    assert(WPMySites.renameSite(guarded, '__proto__', 'x') === guarded, "renameSite('__proto__') is a no-op");
    assert(WPMySites.removeSite(guarded, 'constructor') === guarded, "removeSite('constructor') is a no-op");
    assert(Object.getPrototypeOf(guarded) === Object.prototype && !Object.prototype.dismissed,
      'the prototype chain is untouched');

    // Non-http(s) schemes fail sanitization even when their parsed origin
    // matches the page origin (blob: URLs do exactly that), and accepted
    // bases come back CANONICAL: origin + normalized pathname only, with
    // query, fragment, credentials, and trailing slash runs dropped.
    assert(WPMySites.sanitizeBaseUrl(`blob:${HOST}/some-uuid`, HOST) === null,
      'a same-origin blob: baseUrl is rejected');
    assert(WPMySites.sanitizeBaseUrl(`${SA}/?p=1#x`, HOST) === SA,
      'query and fragment are dropped at sanitization');
    assert(WPMySites.sanitizeBaseUrl('http://user:pass@localhost/siteA', HOST) === SA,
      'credentials are dropped at sanitization');
    assert(WPMySites.sanitizeBaseUrl(`${SA}///`, HOST) === SA,
      'trailing slash runs are trimmed at sanitization');
    assert(WPMySites.sanitizeBaseUrl(`${HOST}/%73iteA`, HOST) === SA,
      'percent-encoded unreserved characters normalize (RFC 3986): /%73iteA is /siteA');
    const encDupe = WPMySites.upsertOnLogin(
      WPMySites.upsertOnLogin({}, { origin: HOST, baseUrl: `${HOST}/%73iteA`, now: 1 }),
      { origin: HOST, baseUrl: SA, now: 2 },
    );
    assert(Object.keys(encDupe).length === 1 && encDupe[SA].lastLoggedInAt === 2,
      'URI-equivalent encodings share one record, never two keys');
    const canonStored = WPMySites.upsertOnLogin({}, { origin: HOST, baseUrl: `${SA}/?utm=1#frag`, now: 1 });
    assert(!!canonStored[SA] && canonStored[SA].baseUrl === SA,
      'the STORED baseUrl is the canonical form');

    // Ambiguous legacy records (root-looking base, pre-#94 shape) are
    // PINNED to the origin key. Lossless migration of that data is
    // impossible — a subdirectory install seen only via wp-admin was stored
    // as { key: origin, baseUrl: origin } — so the policy is deterministic
    // instead of guessing: sibling evidence records separately and NEVER
    // moves, renames, or inherits the origin record's curation, active or
    // dismissed. (The stale origin row and, for dismissed records, the
    // sibling reappearing as new are the documented cost.)
    const legacyActive = { [HOST]: { origin: HOST, baseUrl: HOST, addedAt: 1, lastLoggedInAt: 5, customName: 'My Site' } };
    const pinnedActive = WPMySites.upsertOnLogin(legacyActive, { origin: HOST, baseUrl: SA, now: 9 });
    assert(!!pinnedActive[HOST] && pinnedActive[HOST].customName === 'My Site'
      && pinnedActive[HOST].lastLoggedInAt === 5,
      'sibling evidence leaves the ambiguous origin record untouched');
    assert(!!pinnedActive[SA] && pinnedActive[SA].customName === undefined && pinnedActive[SA].addedAt === 9,
      'the sibling records separately with fresh curation');
    const legacyDismissed = {
      [HOST]: { origin: HOST, baseUrl: HOST, addedAt: 1, lastLoggedInAt: 5, dismissed: true, customName: 'My Site' },
    };
    const pinnedDismissed = WPMySites.upsertOnLogin(legacyDismissed, { origin: HOST, baseUrl: SA, now: 9 });
    assert(pinnedDismissed[HOST].dismissed === true && pinnedDismissed[HOST].customName === 'My Site',
      "the origin record's tombstone and name never migrate to a sibling");
    assert(!!pinnedDismissed[SA] && pinnedDismissed[SA].dismissed === undefined,
      'the sibling starts fresh (a legacy dismissal cannot be associated with it — documented)');
    const rootBump = WPMySites.upsertOnLogin(legacyActive, { origin: HOST, baseUrl: HOST, now: 9 });
    assert(rootBump[HOST].lastLoggedInAt === 9 && rootBump[HOST].customName === 'My Site' && !rootBump[SA],
      'root evidence bumps the pinned origin record in place; its key never changes');
  }

  // --- 45. baseUrl provenance: evidence vs. bare-origin fallback (#103) ---
  {
    console.log('\n[45] deriveBase reports HOW the base was derived (#103)');
    const ORIGIN = 'https://client-a.example';
    const dom = new JSDOM('<html><body></body></html>');
    const ctx = loadModules(dom);
    const derive = ctx.WPDetect.deriveBase;

    // A root install's base is the bare origin whether it was CONFIRMED or
    // merely guessed. That collision is the whole bug: the value alone can't
    // tell the two apart, so `evidence` has to.
    const restRoot = derive(ORIGIN, `${ORIGIN}/wp-json/`, null);
    const adminRoot = derive(ORIGIN, null, '/wp-admin/index.php');
    const fallback = derive(ORIGIN, null, null);
    assert(restRoot.baseUrl === ORIGIN && adminRoot.baseUrl === ORIGIN && fallback.baseUrl === ORIGIN,
      'all three root cases produce the identical bare-origin value');
    assert(restRoot.evidence === 'rest', 'REST discovery root → evidence "rest"');
    assert(adminRoot.evidence === 'admin-path', "a root install's own admin path → evidence \"admin-path\"");
    assert(fallback.evidence === null, 'no derivation evidence → evidence null (a guess)');

    assert(derive(ORIGIN, `${ORIGIN}/wordpress/wp-json/`, null).evidence === 'rest'
      && derive(ORIGIN, null, '/wordpress/wp-admin/').evidence === 'admin-path',
      'subdirectory bases report their provenance the same way');

    // Values that prove nothing must not claim evidence, or the background's
    // My Sites gate would accept a forged root.
    assert(derive(ORIGIN, 'https://attacker.example/wp-json/', null).evidence === null,
      'off-origin REST root → no evidence (falls back to the origin)');
    assert(derive(ORIGIN, `blob:${ORIGIN}/some-uuid`, null).evidence === null,
      'blob: REST root whose parsed origin matches → still no evidence');
    const permalinkShape = derive(ORIGIN, null, '/guides/wp-admin/security/');
    assert(permalinkShape.evidence === 'admin-path' && permalinkShape.baseUrl === `${ORIGIN}/guides`,
      'deriveBase trusts any adminPathname it is given — the body.wp-admin gate is the caller\'s');
    assert(derive(ORIGIN, null, '/sub%2Fdir/wp-admin/').evidence === null,
      'encoded slash fails closed → no evidence');
    assert(derive(ORIGIN, null, 'relative/wp-admin/').evidence === null,
      'non-rooted pathname → no evidence');

    // End to end through detectWordPress, on markup matching a real admin
    // screen: WP prints `wp-admin` on the body but NOT `logged-in` there, and
    // emits no REST or oEmbed discovery link — verified against a live
    // WordPress 7.1 Dashboard. Login therefore rides on the admin bar alone,
    // and that is the precondition for recording at all.
    const adminDom = new JSDOM(
      '<html><head><link rel="canonical" href="x"></head>'
      + '<body class="wp-admin wp-core-ui index-php">'
      + '<div id="wpwrap"><div id="wpadminbar"></div></div></body></html>',
    );
    const adminCtx = loadModules(adminDom);
    const adminDet = adminCtx.WPDetect.detectWordPress(adminCtx.document, {
      origin: ORIGIN, pathname: '/wp-admin/index.php',
    });
    assert(adminDet.context.isLoggedIn === true,
      'a real admin screen reads as logged in without a `logged-in` body class');
    assert(adminDet.context.restApiRoot === null,
      'and carries no REST root — which is what made #103 invisible to the old gate');
    assert(adminDet.context.baseUrl === ORIGIN && adminDet.context.baseUrlEvidence === 'admin-path',
      "a root install's admin screen reports admin-path evidence (the #103 case)");

    // An admin document is body.wp-admin AND #wpwrap — both printed by
    // wp-admin/admin-header.php on every core admin screen (Dashboard,
    // editor, profile, network and user admin all include it). A front-end
    // page that merely carries a `wp-admin` body class (themes and plugins
    // can add one) is not an admin document, so its pathname derives nothing
    // and no admin-path evidence is claimed. A practical correctness gate,
    // not a security boundary — the background independently re-derives the
    // base from the browser-attested path before trusting any claim.
    const spoofDom = new JSDOM(
      '<html><head><meta name="generator" content="WordPress 6.8"></head>'
      + '<body class="wp-admin logged-in"><div id="wpadminbar"></div></body></html>',
    );
    const spoofCtx = loadModules(spoofDom);
    const spoofDet = spoofCtx.WPDetect.detectWordPress(spoofCtx.document, {
      origin: ORIGIN, pathname: '/press/wp-admin/tour/',
    });
    assert(spoofDet.context.baseUrl === ORIGIN && spoofDet.context.baseUrlEvidence === null,
      'body.wp-admin without #wpwrap is not an admin document — no derivation, no evidence');

    // The same page shape on the front end, REST link stripped: identical
    // baseUrl, no evidence.
    const frontDom = new JSDOM(`
      <html><head><meta name="generator" content="WordPress 6.8"></head>
      <body class="home logged-in admin-bar"><div id="wpadminbar"></div></body></html>
    `);
    const frontCtx = loadModules(frontDom);
    const frontDet = frontCtx.WPDetect.detectWordPress(frontCtx.document, {
      origin: ORIGIN, pathname: '/',
    });
    assert(frontDet.context.baseUrl === ORIGIN && frontDet.context.baseUrlEvidence === null,
      'a REST-stripped front page reports the same base with NO evidence');
  }

  // --- 46. Hardened installs: detection without generator/REST link (#101) --
  {
    console.log('\n[46] Hardened install signals (#101)');

    // The reported shape: <meta generator> and the api.w.org link removed.
    // What core still prints — wp-* body classes, enqueue handle ids, the
    // comment form — has to carry detection on its own.
    const hardened = new JSDOM(`<html><head>
      <link rel='stylesheet' id='theme-styles-css' href='/assets/style.css'>
      <script src='/assets/jquery.js' id='jquery-js'></script>
      <script src='/assets/nav.js' id='nav-js'></script>
      </head><body class="wp-singular single single-post postid-239 wp-custom-logo wp-theme-genesis wp-child-theme-magazine-pro">
      <form action="https://example.com/wp-comments-post.php" method="post" id="commentform">
        <input type="hidden" name="comment_post_ID" value="239">
      </form></body></html>`, { url: 'https://example.com/hello/' });
    const hctx = loadModules(hardened);
    const hd = hctx.WPDetect.detectWordPress(hctx.document);
    assert(hd.isWordPress === true, 'hardened install still detects');
    assert(hd.signals.includes('wp-core-body-class'), 'core wp-* body classes signal');
    assert(hd.signals.includes('wp-enqueue-handles'), 'enqueue handle ids signal');
    assert(hd.signals.includes('wp-comment-form'), 'comment form signal');
    // No /wp-content/ path anywhere above, so the theme slug can only have
    // come from wp-child-theme-* — the child, not the parent.
    assert(hd.context.themeSlug === 'magazine-pro',
      'active (child) theme slug recovered from body classes');

    // Each new signal is individually below the threshold except where it is
    // WordPress-exclusive: core body classes alone must not be conclusive.
    const bodyOnly = new JSDOM('<html><body class="wp-singular wp-theme-twentytwentyfive"></body></html>');
    const bctx = loadModules(bodyOnly);
    const bd = bctx.WPDetect.detectWordPress(bctx.document);
    assert(bd.confidence === 30 && bd.isWordPress === false,
      'core body classes alone stay under the threshold');

    // Asset scan still reports the active theme when both are in the DOM,
    // and the body-class fallback does not overwrite it.
    const both = new JSDOM(`<html><head>
      <link rel='stylesheet' href='/wp-content/themes/magazine-pro/style.css'>
      </head><body class="wp-theme-genesis wp-child-theme-magazine-pro"></body></html>`);
    const bothCtx = loadModules(both);
    const bothD = bothCtx.WPDetect.detectWordPress(bothCtx.document);
    assert(bothD.context.themeSlug === 'magazine-pro', 'asset-scan theme slug wins');

    // oEmbed discovery link: confidence plus a REST root, including the
    // subdirectory path the missing api.w.org link would have carried.
    const oembed = new JSDOM(`<html><head>
      <link rel="alternate" type="application/json+oembed"
        href="https://example.com/blog/wp-json/oembed/1.0/embed?url=https%3A%2F%2Fexample.com%2Fblog%2Fhello%2F">
      </head><body></body></html>`, { url: 'https://example.com/blog/hello/' });
    const octx = loadModules(oembed);
    const od = octx.WPDetect.detectWordPress(octx.document, { origin: 'https://example.com' });
    assert(od.isWordPress === true && od.signals.includes('oembed-link'), 'oEmbed link detects');
    assert(od.context.restApiRoot === 'https://example.com/blog/wp-json/', 'REST root from oEmbed href');
    assert(od.context.baseUrl === 'https://example.com/blog', 'subdirectory base from the oEmbed root');

    // Plain permalinks put the route in the query string.
    const oembedPlain = new JSDOM(`<html><head>
      <link rel="alternate" type="application/json+oembed"
        href="https://example.com/?rest_route=%2Foembed%2F1.0%2Fembed&url=x">
      </head><body></body></html>`, { url: 'https://example.com/?p=1' });
    const opctx = loadModules(oembedPlain);
    const opd = opctx.WPDetect.detectWordPress(opctx.document, { origin: 'https://example.com' });
    assert(opd.context.restApiRoot === 'https://example.com/?rest_route=/',
      'plain-permalink REST root from oEmbed href');

    // Cross-origin oEmbed links are ignored outright: the href feeds
    // restApiRoot, which the popup issues authenticated REST calls against.
    const foreign = new JSDOM(`<html><head>
      <link rel="alternate" type="application/json+oembed"
        href="https://evil.example/wp-json/oembed/1.0/embed?url=x">
      </head><body></body></html>`, { url: 'https://example.com/' });
    const fctx = loadModules(foreign);
    const fd = fctx.WPDetect.detectWordPress(fctx.document, { origin: 'https://example.com' });
    assert(!fd.signals.includes('oembed-link') && fd.context.restApiRoot === null,
      'cross-origin oEmbed link is ignored');

    // A real api.w.org link is authoritative — oEmbed never overwrites it.
    const bothRoots = new JSDOM(`<html><head>
      <link rel="https://api.w.org/" href="https://example.com/wp-json/">
      <link rel="alternate" type="application/json+oembed"
        href="https://example.com/other/wp-json/oembed/1.0/embed?url=x">
      </head><body></body></html>`, { url: 'https://example.com/' });
    const brctx = loadModules(bothRoots);
    const brd = brctx.WPDetect.detectWordPress(brctx.document, { origin: 'https://example.com' });
    assert(brd.context.restApiRoot === 'https://example.com/wp-json/',
      'api.w.org root is not overwritten by oEmbed');

    // Inline handle scripts — the -js-extra/-before/-after naming is WP-only.
    const inline = new JSDOM(`<html><head>
      <script id="contact-form-js-extra">var x = 1;</script>
      </head><body></body></html>`);
    const ictx = loadModules(inline);
    const idet = ictx.WPDetect.detectWordPress(ictx.document);
    assert(idet.signals.includes('wp-inline-script-handle'), 'inline handle script signal');
  }

  // --- 47. Non-WordPress pages must not trip the new signals (#101) --------
  {
    console.log('\n[47] False-positive guards for the new signals (#101)');

    // The riskiest pair: `home` is a body class any site can use (+20), so
    // the enqueue-handle convention must not be loose enough to reach the
    // threshold alongside it. Two handles, one of each kind — under the
    // three-asset floor, so nothing is credited.
    const staticSite = new JSDOM(`<html><head>
      <link rel="stylesheet" id="main-css" href="/css/main.css">
      <script src="/js/app.js" id="app-js"></script>
      </head><body class="home"><h1>A static site</h1></body></html>`,
    { url: 'https://example.com/' });
    const sctx = loadModules(staticSite);
    const sd = sctx.WPDetect.detectWordPress(sctx.document);
    assert(!sd.signals.includes('wp-enqueue-handles'), 'two handles do not credit the convention');
    assert(sd.isWordPress === false, 'static site with a `home` body class is not WordPress');

    // Both kinds are required: five scripts and no stylesheet is a bundler
    // output, not WP's loader, which stamps styles and scripts alike.
    const scriptsOnly = new JSDOM(`<html><head>
      <script src="/a.js" id="a-js"></script><script src="/b.js" id="b-js"></script>
      <script src="/c.js" id="c-js"></script><script src="/d.js" id="d-js"></script>
      <script src="/e.js" id="e-js"></script>
      </head><body class="archive"></body></html>`, { url: 'https://example.com/' });
    const scctx = loadModules(scriptsOnly);
    const scd = scctx.WPDetect.detectWordPress(scctx.document);
    assert(!scd.signals.includes('wp-enqueue-handles'), 'scripts without styles do not credit');

    // rel="preload" is not a stylesheet: preloaded CSS must not be counted
    // toward the both-kinds requirement.
    const preload = new JSDOM(`<html><head>
      <link rel="preload" as="style" id="hero-css" href="/hero.css">
      <script src="/a.js" id="a-js"></script><script src="/b.js" id="b-js"></script>
      </head><body class="single"></body></html>`, { url: 'https://example.com/' });
    const pctx = loadModules(preload);
    const pd = pctx.WPDetect.detectWordPress(pctx.document);
    assert(!pd.signals.includes('wp-enqueue-handles'), 'preloaded CSS is not a stylesheet handle');

    // A page that merely writes about WordPress — the strings appear in
    // text, not in the markup we key on.
    const article = new JSDOM(`<html><head><title>Comparing CMSes</title></head>
      <body class="post"><p>Use /wp-content/ paths and wp-comments-post.php to spot it.</p>
      <code>&lt;meta name="generator" content="WordPress 6.8"&gt;</code></body></html>`,
    { url: 'https://example.com/blog/' });
    const actx = loadModules(article);
    const ad = actx.WPDetect.detectWordPress(actx.document);
    assert(ad.isWordPress === false && ad.confidence === 0,
      'an article about WordPress is not WordPress');
  }

  console.log(`\n${failures === 0 ? 'All tests passed.' : failures + ' failure(s).'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
