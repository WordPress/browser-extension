/**
 * WordPress Browser Extension — detection module
 *
 * Pure functions that inspect a Document and return WordPress detection
 * signals and page context. No browser APIs are called here so this
 * module is unit-testable in Node with jsdom.
 *
 * Loaded as a content script before content.js, so it attaches its API
 * to globalThis.WPDetect rather than using ES module exports (content
 * scripts in MV3 do not share a module graph).
 */
(function () {
  'use strict';

  // Confidence thresholds — tune with real-world data.
  const CONFIDENCE_THRESHOLD = 40;
  const MAX_ASSETS_TO_SCAN = 200;

  /**
   * Main entry point. Given a Document, returns:
   *   {
   *     isWordPress: boolean,
   *     confidence: number (0-100),
   *     signals: string[],          // which checks matched
   *     context: { ... }            // page-level info for the popup
   *   }
   *
   * `options.origin` (optional) is the document's real origin, used to
   * validate that admin-bar URLs we extract (in particular the "+ New"
   * menu hrefs) point at the same site. Required when `doc` was produced
   * by DOMParser (no defaultView) and we still want to trust its links.
   * When omitted we fall back to `doc.defaultView.location.origin`.
   */
  function detectWordPress(doc, options) {
    options = options || {};
    const result = {
      isWordPress: false,
      confidence: 0,
      signals: [],
      context: {
        postId: null,
        postType: null,
        pageTemplate: null,
        taxonomy: null,
        term: null,          // slug
        termId: null,        // numeric ID when WP exposes it
        authorSlug: null,
        authorId: null,
        // 'single' | 'archive' | 'term' | 'home' | 'search' | '404' | 'author' | null
        pageType: null,
        postStatus: null,     // publish | draft | pending | future | private
        isLoggedIn: false,
        hasAdminBar: false,
        generatorVersion: null,
        restApiRoot: null,
        // Path-aware base URL the install lives under, e.g.
        // "https://example.com/wordpress" for a subdirectory install (no
        // trailing slash) or just the origin for a root install. This is
        // what wp-admin, wp-login.php, and the front page hang off — using
        // the bare origin breaks every synthesized link on subdir installs
        // (issue #33). See deriveBase below; null until then.
        baseUrl: null,
        // How baseUrl was derived: 'rest' | 'admin-path' | null (bare-origin
        // fallback — a guess, not evidence). A root install's evidence LOOKS
        // like the fallback (both are the bare origin), so anything that must
        // not act on a guess reads this, not baseUrl (#103).
        baseUrlEvidence: null,
        adminBarEditHref: null,
        adminBarViewHref: null,
        adminBarLogoutHref: null,  // includes _wpnonce — bypasses WP's logout confirm
        // Admin bar "Visit Site" link (#wp-admin-bar-view-site) — rendered
        // only on admin screens, always carrying home_url('/'). Preferred
        // Visit Site target because home_url can legitimately differ from
        // the synthesized base (split home/site installs). DOM-sourced, so
        // validated same-origin at point of use, never used as the base.
        adminBarVisitSiteHref: null,
        // Admin-bar status counts. Only populated when logged in and the
        // user has the relevant capability (WP renders the nodes conditionally).
        updateCount: null,     // core + theme + plugin updates aggregated by WP
        commentCount: null,    // pending comment moderation count
        // Items under the admin bar's "+ New" dropdown: typically Post/Page/
        // Media/User plus any public CPTs. Each { id, label, href }.
        newContentItems: [],
        // True when the Query Monitor plugin is active (identified by the
        // floating panel it injects even while hidden).
        hasQueryMonitor: false,
        // Theme + plugin slugs scraped from /wp-content/themes/<slug>/
        // and /wp-content/plugins/<slug>/ asset URLs. Available regardless
        // of login state and without hitting the REST API. The popup
        // enriches these with names/versions via REST when it can.
        themeSlug: null,
        pluginSlugs: [],
        // URL of the WP "Site Icon" (Customize → Site Identity), captured
        // from the high-resolution <link> tags WP emits. Null when no
        // icon is configured — generic theme favicons are intentionally
        // not picked up so the popup header stays meaningful.
        siteIconUrl: null,
        // Current user — populated from the admin bar's My Account menu
        // when present. Avatar comes from #wp-admin-bar-user-info (the
        // 64×64 variant), display name from .display-name, and the
        // edit-profile link from #wp-admin-bar-edit-profile.
        userAvatarUrl: null,
        userDisplayName: null,
        userEditProfileHref: null,
        // Multisite super admin — distinct from any per-site role. Super
        // admins frequently carry only `subscriber` in `wp_capabilities`
        // for a given site, so a REST role lookup mislabels them. The
        // admin bar exposes the network-admin menu only to super admins,
        // which gives us a synchronous, accurate signal.
        isSuperAdmin: false,
      },
    };

    // Site icon — three selectors in descending preference. WP emits the
    // 192×192 link when a Site Icon is set; apple-touch-icon and the 32×32
    // link are weaker but still WP-Site-Icon-typical signals. We skip the
    // bare `<link rel="icon">` (no sizes) because that's where generic
    // theme favicons live.
    //
    // Scheme allowlist: only http/https/data. Browsers already block
    // `javascript:` in <img src>, but capturing one into a popup-rendered
    // URL is the kind of defense-in-depth that costs nothing here.
    const iconLink = doc.querySelector('link[rel="icon"][sizes="192x192"]')
      || doc.querySelector('link[rel="apple-touch-icon"]')
      || doc.querySelector('link[rel="icon"][sizes="32x32"]');
    if (iconLink && iconLink.getAttribute('href')) {
      try {
        const p = new URL(iconLink.href).protocol;
        if (p === 'http:' || p === 'https:' || p === 'data:') {
          result.context.siteIconUrl = iconLink.href;
        }
      } catch (_) { /* malformed href, skip */ }
    }

    // --- Strong signal: REST API discovery link (very hard to hide) ---
    const apiLink = doc.querySelector('link[rel="https://api.w.org/"]');
    if (apiLink && apiLink.href) {
      result.signals.push('rest-api-link');
      result.confidence += 60;
      result.context.restApiRoot = apiLink.href;
    }

    // Resolve the install's base URL as early as possible so every
    // synthesized admin/login link downstream picks up a subdirectory
    // prefix. Uses the same origin we trust admin-bar links against.
    const docOrigin = options.origin
      || (doc.defaultView && doc.defaultView.location && doc.defaultView.location.origin)
      || null;
    const docPathname = options.pathname
      || (doc.defaultView && doc.defaultView.location && doc.defaultView.location.pathname)
      || null;
    // The pathname fallback applies only to documents that are positively
    // admin screens: body.wp-admin AND #wpwrap, both printed by
    // wp-admin/admin-header.php on every core admin screen (network and user
    // admin included; the customizer and wp-login.php print neither). The
    // body class alone is too easy for a theme to emit on a front-end page,
    // so a public permalink that merely contains /wp-admin/ in its slug path
    // (e.g. /guides/wp-admin/security/) keeps the bare-origin base when no
    // REST link is present. A practical correctness gate, not a security
    // boundary — the background re-derives the base from the
    // browser-attested path before trusting any claim built on this.
    const isAdminDoc = !!(doc.body && doc.body.classList
      && doc.body.classList.contains('wp-admin')
      && doc.getElementById('wpwrap'));
    if (docOrigin && docOrigin !== 'null') {
      const derived = deriveBase(
        docOrigin, result.context.restApiRoot, isAdminDoc ? docPathname : null,
      );
      result.context.baseUrl = derived.baseUrl;
      result.context.baseUrlEvidence = derived.evidence;
    }

    // --- Medium signal: generator meta tag ---
    const generator = doc.querySelector('meta[name="generator"]');
    if (generator && /WordPress/i.test(generator.content || '')) {
      result.signals.push('generator-meta');
      result.confidence += 40;
      const m = generator.content.match(/WordPress\s+([\d.]+)/i);
      if (m) result.context.generatorVersion = m[1];
    }

    // --- Medium signal: wp-content / wp-includes in asset URLs ---
    // Scans once and collects theme/plugin slugs as a side effect so we
    // don't walk the DOM twice.
    const assetScan = scanAssetPaths(doc);
    if (assetScan.hasWpPath) {
      result.signals.push('wp-asset-path');
      result.confidence += 30;
    }
    if (assetScan.themeSlug) result.context.themeSlug = assetScan.themeSlug;
    if (assetScan.pluginSlugs.length) result.context.pluginSlugs = assetScan.pluginSlugs;

    // --- Strong signal: admin bar in DOM ---
    const adminBar = doc.getElementById('wpadminbar');
    if (adminBar) {
      result.signals.push('admin-bar-element');
      result.confidence += 40;
      result.context.hasAdminBar = true;
      result.context.isLoggedIn = true; // admin bar rendered = logged in

      const editLink = adminBar.querySelector('#wp-admin-bar-edit a[href]');
      if (editLink) result.context.adminBarEditHref = editLink.href;

      // Visit Site — #wp-admin-bar-view-site exists only on admin screens,
      // so capturing it is self-gating; the front end's site-name node
      // points at wp-admin and must not be used for this.
      const visitSiteLink = adminBar.querySelector('#wp-admin-bar-view-site a[href]');
      if (visitSiteLink) result.context.adminBarVisitSiteHref = visitSiteLink.href;

      // Logout link carries the `_wpnonce` that lets us skip WP's "are you
      // sure?" confirmation page — same nonce the admin bar itself uses.
      const logoutLink = adminBar.querySelector('#wp-admin-bar-logout a[href]');
      if (logoutLink) result.context.adminBarLogoutHref = logoutLink.href;

      // View/Preview links — present on admin edit screens. WordPress
      // renders #wp-admin-bar-view for published posts (permalink) and
      // #wp-admin-bar-preview for drafts (includes the preview nonce).
      const viewLink = adminBar.querySelector('#wp-admin-bar-view a[href]');
      const previewLink = adminBar.querySelector('#wp-admin-bar-preview a[href]');
      if (viewLink) {
        result.context.adminBarViewHref = viewLink.href;
        result.context.postStatus = 'publish';
      } else if (previewLink) {
        result.context.adminBarViewHref = previewLink.href;
        result.context.postStatus = 'draft';
      }

      // Current-user info from the My Account menu. The 64×64 avatar in
      // #wp-admin-bar-user-info is the higher-resolution variant; if it's
      // missing (themes/plugins occasionally remove the submenu) we fall
      // back to the inline 26×26 image on the top-level link.
      const userInfoImg = adminBar.querySelector('#wp-admin-bar-user-info img.avatar');
      const fallbackImg = adminBar.querySelector('#wp-admin-bar-my-account img.avatar');
      const avatarImg = userInfoImg || fallbackImg;
      if (avatarImg && avatarImg.getAttribute('src')) {
        try {
          const p = new URL(avatarImg.src).protocol;
          if (p === 'http:' || p === 'https:' || p === 'data:') {
            result.context.userAvatarUrl = avatarImg.src;
          }
        } catch (_) { /* malformed avatar URL, skip */ }
      }

      const displayNameEl = adminBar.querySelector('#wp-admin-bar-user-info .display-name')
        || adminBar.querySelector('#wp-admin-bar-my-account .display-name');
      if (displayNameEl) {
        const name = (displayNameEl.textContent || '').trim();
        if (name) result.context.userDisplayName = name;
      }

      const editProfileLink = adminBar.querySelector('#wp-admin-bar-edit-profile a[href]');
      if (editProfileLink) result.context.userEditProfileHref = editProfileLink.href;

      // WP only renders the network-admin menu group for super admins
      // (see wp_admin_bar_my_sites_menu()). Use the wrapper id rather
      // than the dashboard child link so we still catch sites that
      // customize the inner items.
      if (adminBar.querySelector('#wp-admin-bar-network-admin')) {
        result.context.isSuperAdmin = true;
      }

      // Status counts. The <li> is only rendered when the user has the
      // capability *and* a count is available; `.ab-label` holds the
      // visible number. Anything non-numeric is ignored.
      result.context.updateCount  = countFromLabel(adminBar, '#wp-admin-bar-updates .ab-label');
      result.context.commentCount = countFromLabel(adminBar, '#wp-admin-bar-comments .ab-label');

      // "+ New" menu items. Each sub-item is a distinct content type the
      // current user can create — extract href + label so the popup can
      // mirror the admin bar menu without hard-coding which types exist.
      //
      // Same-origin + /wp-admin/ guard: a malicious page can fake an admin
      // bar with off-origin hrefs that the popup would then carry into a
      // chrome.tabs navigation. We trust only links pointing at the
      // document's own origin under /wp-admin/.
      const newItems = adminBar.querySelectorAll('#wp-admin-bar-new-content .ab-submenu > li[id] > a[href]');
      result.context.newContentItems = Array.from(newItems)
        .map((a) => {
          const li = a.closest('li[id]');
          const id = li ? li.id.replace(/^wp-admin-bar-new-/, '') : '';
          const label = (a.textContent || '').trim();
          if (!id || !label || !docOrigin) return null;
          try {
            const u = new URL(a.href);
            if (u.origin !== docOrigin) return null;
            // Match /wp-admin/ anywhere in the path, not just at the root —
            // subdirectory installs serve it under e.g. /wordpress/wp-admin/
            // (issue #33). Still same-origin, so the security intent holds.
            if (!/\/wp-admin\//.test(u.pathname)) return null;
          } catch (_) { return null; }
          return { id, label, href: a.href };
        })
        .filter(Boolean);
    }

    // --- Body classes: cheap but rich context ---
    if (doc.body) {
      parseBodyClasses(doc.body.classList, result);
    }

    // --- Query Monitor plugin detection ---
    // The plugin always injects #query-monitor-main (hidden until toggled),
    // even when the admin bar is disabled. Presence of either is enough.
    if (doc.getElementById('query-monitor-main') ||
        doc.getElementById('wp-admin-bar-query-monitor')) {
      result.context.hasQueryMonitor = true;
    }

    result.confidence = Math.min(result.confidence, 100);
    result.isWordPress = result.confidence >= CONFIDENCE_THRESHOLD;

    return result;
  }

  /**
   * Derives the install's base URL — the path-aware root that wp-admin,
   * wp-login.php, and the front page hang off. For a subdirectory install
   * at https://example.com/wordpress/ this returns
   * "https://example.com/wordpress" (no trailing slash); for a root install
   * it returns the bare origin.
   *
   * Sourced from the REST API discovery link, which WordPress emits as
   * home_url('/wp-json/') — so its path carries any subdirectory. Two URL
   * shapes appear in the wild and both reduce to the same base:
   *   - Pretty permalinks: https://example.com/wordpress/wp-json/
   *   - Plain permalinks:   https://example.com/wordpress/?rest_route=/
   * Falls back to the origin when there's no trustworthy same-origin root.
   *
   * Scope note: WordPress separately distinguishes site_url() (the
   * "WordPress Address", where core files live) from home_url() (the public
   * "Site Address"). They're identical in the standard subdirectory install
   * this fixes; the rarer "give WordPress its own directory" split, where
   * they diverge, is intentionally out of scope.
   *
   * wp-admin fallback (#88): the REST discovery link is a front-end signal —
   * admin screens never emit it — so on wp-admin pages the REST-based path
   * is unavailable and the base would silently collapse to the bare origin,
   * breaking every synthesized link on subdirectory installs (Visit Site on
   * a multi-segment install like example.com/en-us/research sent users to
   * the bare origin). wp-admin always hangs directly off the install base,
   * so an admin document's own pathname carries the answer: everything
   * before the admin directory is the base. The caller passes
   * `adminPathname` only for documents positively identified as admin
   * screens (body.wp-admin); it is null otherwise.
   */

  /**
   * Install-base path prefix from an admin document's pathname, or null
   * when none can be derived safely. Segment-exact matching, no substring
   * tests: the LAST path segment that is literally `wp-admin` is taken as
   * the admin directory and everything before it is the base. Last rather
   * than first, because an install can itself live in a directory named
   * wp-admin (/wp-admin/wp-admin/ → base /wp-admin) or carry the name
   * mid-path (/alpha/wp-admin/tools/wp-admin/ → base /alpha/wp-admin/tools).
   * Fails closed on non-rooted paths and on encoded slashes (%2F), which
   * would otherwise make one path read as two.
   */
  function adminPrefixFromPathname(pathname) {
    if (typeof pathname !== 'string' || pathname.charAt(0) !== '/') return null;
    if (/%2f/i.test(pathname)) return null;
    const segments = pathname.split('/');
    for (let i = segments.length - 1; i >= 1; i--) {
      if (segments[i] === 'wp-admin') {
        const prefix = segments.slice(1, i).join('/');
        return prefix ? `/${prefix}` : '';
      }
    }
    return null;
  }

  /**
   * Base URL plus WHERE it came from: `{ baseUrl, evidence }`, evidence being
   *   'rest'       — a same-origin REST discovery root fixed it
   *   'admin-path' — a confirmed admin screen's own pathname fixed it
   *   null         — neither; baseUrl is the bare-origin FALLBACK, a guess
   *
   * The distinction matters because a root install's evidence is
   * indistinguishable from the fallback by value alone: both are the bare
   * origin. Callers that must not act on a guess (the My Sites gate in
   * background.js, #103) can't tell the two apart from `baseUrl` — so say it
   * here, at the one place that knows.
   */
  function deriveBase(origin, restApiRoot, adminPathname) {
    if (!restApiRoot) {
      const prefix = adminPrefixFromPathname(adminPathname);
      if (prefix !== null) {
        // Enforce the result's own safety: the candidate must still be an
        // http(s) URL on the same origin it was derived from.
        try {
          const originUrl = new URL(origin);
          const candidate = new URL(origin + prefix);
          const safeProtocol = candidate.protocol === 'http:' || candidate.protocol === 'https:';
          if (safeProtocol && candidate.origin === originUrl.origin) {
            // Trim the whole trailing slash run: consecutive separators in
            // the source pathname (/sub///wp-admin/) would otherwise leave a
            // base ending in '/' and every synthesized link doubling it.
            const path = candidate.pathname.replace(/\/+$/, '');
            return {
              baseUrl: path ? `${candidate.origin}${path}` : candidate.origin,
              evidence: 'admin-path',
            };
          }
        } catch (_) { /* malformed origin or prefix — fall through */ }
      }
      return { baseUrl: origin, evidence: null };
    }
    try {
      const originUrl = new URL(origin);
      const rootUrl = new URL(restApiRoot, originUrl);
      const safeProtocol = rootUrl.protocol === 'http:' || rootUrl.protocol === 'https:';
      // A REST root that isn't a usable same-origin http(s) URL proves
      // nothing: fall back to the origin WITHOUT claiming evidence.
      if (!safeProtocol || rootUrl.origin !== originUrl.origin) {
        return { baseUrl: origin, evidence: null };
      }
      let path = rootUrl.pathname;
      // Pretty permalinks tack "/wp-json/" onto the base; drop it. Plain
      // permalinks keep the route in the query string, so the path already
      // is the base — just trim its trailing slash.
      if (path.endsWith('/wp-json/')) {
        path = path.slice(0, -'/wp-json/'.length);
      } else {
        path = path.replace(/\/$/, '');
      }
      return {
        baseUrl: path ? `${rootUrl.origin}${path}` : rootUrl.origin,
        evidence: 'rest',
      };
    } catch (_) {
      return { baseUrl: origin, evidence: null };
    }
  }

  function countFromLabel(adminBar, selector) {
    const el = adminBar.querySelector(selector);
    if (!el) return null;
    const n = parseInt((el.textContent || '').trim(), 10);
    return Number.isFinite(n) ? n : null;
  }

  // Slugs that can legally appear at /wp-content/themes/<slug>/ or
  // /wp-content/plugins/<slug>/: lowercase letters, digits, hyphens.
  // Anchored so a path like .../themes/twentytwentyfour/assets/... resolves
  // to "twentytwentyfour" — the first segment after the type directory.
  const THEME_RE  = /\/wp-content\/themes\/([a-z0-9][a-z0-9-]*)\//i;
  const PLUGIN_RE = /\/wp-content\/(?:mu-plugins|plugins)\/([a-z0-9][a-z0-9-]*)\//i;

  function scanAssetPaths(doc) {
    const assets = doc.querySelectorAll('link[href], script[src], img[src]');
    const limit = Math.min(assets.length, MAX_ASSETS_TO_SCAN);
    let hasWpPath = false;
    let themeSlug = null;
    const pluginSet = new Set();

    for (let i = 0; i < limit; i++) {
      const el = assets[i];
      const url = el.getAttribute('href') || el.getAttribute('src') || '';
      if (!url) continue;
      if (!hasWpPath && /\/wp-(content|includes)\//.test(url)) hasWpPath = true;

      // First theme slug wins — WP serves the active theme's stylesheet
      // early in the document, and scanning stops after MAX_ASSETS_TO_SCAN.
      if (!themeSlug) {
        const tm = url.match(THEME_RE);
        if (tm) themeSlug = tm[1];
      }
      const pm = url.match(PLUGIN_RE);
      if (pm) pluginSet.add(pm[1]);
    }

    return {
      hasWpPath,
      themeSlug,
      pluginSlugs: Array.from(pluginSet).sort(),
    };
  }

  function parseBodyClasses(classList, result) {    let sawWpClass = false;
    const ctx = result.context;

    for (const cls of classList) {
      // Auth / chrome signals
      if (cls === 'logged-in') { ctx.isLoggedIn = true; sawWpClass = true; }
      if (cls === 'admin-bar')  { ctx.hasAdminBar = true; sawWpClass = true; }

      // wp-login.php and wp-admin both ship `wp-core-ui`; wp-login.php also
      // adds `login`. Neither page emits the REST link or generator meta
      // (those come from wp_head), so without these we'd fall below the
      // detection threshold on the login screen.
      if (cls === 'login' || cls === 'wp-core-ui') sawWpClass = true;

      // Post IDs
      let m;
      if ((m = cls.match(/^postid-(\d+)$/))) {
        ctx.postId = parseInt(m[1], 10);
        ctx.pageType = 'single';
        sawWpClass = true;
      } else if ((m = cls.match(/^page-id-(\d+)$/))) {
        ctx.postId = parseInt(m[1], 10);
        ctx.pageType = 'single';
        ctx.postType = 'page';
        sawWpClass = true;
      }

      // Page template (block themes use this less, but classic themes rely on it)
      if ((m = cls.match(/^page-template-(.+)$/)) && m[1] !== 'default') {
        ctx.pageTemplate = m[1];
        sawWpClass = true;
      }

      // single-<posttype> — WP writes the whole post-type slug verbatim
      // (including any hyphens in the slug, e.g. `single-case-study`).
      // Skip single-format-* (post formats like single-format-standard).
      if (cls.startsWith('single-') && cls.length > 7 && !cls.startsWith('single-format-')) {
        const slug = cls.slice(7);
        if (slug && !/^\d+$/.test(slug) && !ctx.postType) {
          ctx.postType = slug;
          ctx.pageType = 'single';
          sawWpClass = true;
        }
      } else if (cls === 'single' && !ctx.pageType) {
        ctx.pageType = 'single';
        sawWpClass = true;
      }

      // Term archives. WP emits both slug and numeric-ID classes, e.g.
      // `category`, `category-news`, `category-42` — we capture both when
      // present so sync resolution can skip the REST round-trip.
      if ((m = cls.match(/^tax-([a-z0-9_-]+)$/i))) {
        ctx.taxonomy = m[1];
        ctx.pageType = 'term';
        sawWpClass = true;
      }
      if ((m = cls.match(/^term-(.+)$/))) {
        absorbTermIdOrSlug(ctx, m[1]);
        sawWpClass = true;
      }
      if (cls === 'category' || cls.startsWith('category-')) {
        ctx.taxonomy = 'category';
        ctx.pageType = 'term';
        if (cls !== 'category') absorbTermIdOrSlug(ctx, cls.slice('category-'.length));
        sawWpClass = true;
      }
      if (cls === 'tag' || cls.startsWith('tag-')) {
        ctx.taxonomy = 'post_tag';
        ctx.pageType = 'term';
        if (cls !== 'tag') absorbTermIdOrSlug(ctx, cls.slice('tag-'.length));
        sawWpClass = true;
      }

      // Post type archive
      if ((m = cls.match(/^post-type-archive-(.+)$/))) {
        ctx.pageType = 'archive';
        ctx.postType = m[1];
        sawWpClass = true;
      } else if (cls === 'archive' && !ctx.pageType) {
        ctx.pageType = 'archive';
        sawWpClass = true;
      }

      // WordPress admin pages include post-type-{slug} (without "archive")
      // when editing a specific post type. Negative lookahead avoids
      // matching the front-end post-type-archive-{slug} handled above.
      if (!ctx.postType && (m = cls.match(/^post-type-(?!archive-)(.+)$/))) {
        ctx.postType = m[1];
        sawWpClass = true;
      }

      // Other page types — only set if we haven't already identified one
      if ((cls === 'home' || cls === 'front-page') && !ctx.pageType) {
        ctx.pageType = 'home';
        sawWpClass = true;
      }
      if ((cls === 'search' || cls.startsWith('search-')) && !ctx.pageType) {
        ctx.pageType = 'search';
        sawWpClass = true;
      }
      if (cls === 'error404') {
        ctx.pageType = '404';
        sawWpClass = true;
      }
      // Author archives: `author`, `author-<slug>`, `author-<id>`, plus
      // pagination helpers like `author-paged-2` which we ignore.
      if (cls === 'author' || cls.startsWith('author-')) {
        if (!ctx.pageType) ctx.pageType = 'author';
        if (cls.startsWith('author-')) {
          const rest = cls.slice('author-'.length);
          if (/^\d+$/.test(rest)) {
            ctx.authorId = parseInt(rest, 10);
          } else if (!rest.startsWith('paged')) {
            ctx.authorSlug = rest;
          }
        }
        sawWpClass = true;
      }
    }

    if (sawWpClass) {
      result.signals.push('wp-body-classes');
      result.confidence += 20;
    }
  }

  /**
   * Body classes that look like `category-X` or `term-X` can be either
   * the term's slug or its numeric ID — WP emits both. Numeric wins
   * because the ID is what the admin URL needs.
   */
  function absorbTermIdOrSlug(ctx, rest) {
    if (/^\d+$/.test(rest)) {
      ctx.termId = parseInt(rest, 10);
    } else if (!rest.startsWith('paged')) {
      ctx.term = rest;
    }
  }

  /**
   * Checks a cookie string (document.cookie format) for the WordPress
   * logged-in cookie. Used as a fallback when the admin bar has been
   * hidden by a plugin or theme.
   */
  function detectLoggedInFromCookies(cookieString) {
    if (!cookieString) return false;
    // wordpress_logged_in_<hash> is HttpOnly by default in modern WP, so
    // this rarely fires — kept for hardened-down installs where the cookie
    // is reachable from JS. wp-settings-<id> is deliberately NOT checked:
    // WP sets it with a 1-year expiry and never clears it on logout, so
    // it produces persistent false positives on any previously logged-in site.
    return /wordpress_logged_in_[a-f0-9]+=/.test(cookieString);
  }

  // Expose to content script
  globalThis.WPDetect = {
    detectWordPress,
    detectLoggedInFromCookies,
    deriveBase,
  };
})();
