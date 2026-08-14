/**
 * WordPress Browser Extension — REST API helpers
 *
 * Pure async functions for resolving context → admin URL via the WP REST
 * API. Runs inside the content script (same-origin as the page), so cookies
 * flow naturally and there is no CORS involvement.
 *
 * `fetch` is injected for testability: any of these can be unit-tested
 * under jsdom with a mocked fetch that returns canned WP responses.
 */
(function () {
  'use strict';

  // Default fetch wrapper: adds an abort timeout so a hostile or simply
  // unresponsive site can't hold a request open indefinitely. These run in the
  // page's renderer, but the popup awaits their results over message
  // round-trips, so a stalled fetch would leave the popup spinning. Injected as
  // the default `fetchImpl`; the smoke tests pass their own mock and bypass it.
  // AbortSignal.timeout: Chrome 103+ / Safari 16+.
  const REQUEST_TIMEOUT_MS = 10000;
  function timedFetch(url, options = {}) {
    if (typeof AbortSignal !== 'undefined'
        && typeof AbortSignal.timeout === 'function'
        && !options.signal) {
      return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    }
    return fetch(url, options);
  }

  // Built-in taxonomy → REST base. Custom taxonomies usually expose
  // rest_base equal to their taxonomy slug, which is what we fall back
  // to when there's no entry here.
  const TAX_REST_BASE = {
    category: 'categories',
    post_tag: 'tags',
  };

  // REST responses are attacker-influenced. IDs get interpolated into wp-admin
  // URLs, so require a real positive integer; a rest_base gets interpolated into
  // a fetch path, so require a plain slug.
  function positiveIntOrNull(value) {
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  function isRestBaseSlug(value) {
    return typeof value === 'string' && /^[a-z0-9_-]+$/i.test(value);
  }

  /**
   * Normalizes a same-origin REST root to end with '/'. Accepts the value
   * captured from <link rel="https://api.w.org/">, or an empty/missing/
   * untrusted value in which case we synthesize the conventional
   * `${origin}/wp-json/`.
   */
  function normalizeRoot(restApiRoot, origin) {
    const fallback = `${origin}/wp-json/`;
    try {
      const originUrl = new URL(origin);
      const rootUrl = new URL(restApiRoot || fallback, originUrl);
      const safeProtocol = rootUrl.protocol === 'http:' || rootUrl.protocol === 'https:';
      if (safeProtocol && rootUrl.origin === originUrl.origin) {
        const href = rootUrl.href;
        return href.endsWith('/') ? href : href + '/';
      }
    } catch (_) { /* invalid root or origin */ }
    return fallback;
  }

  /**
   * Best-effort extraction of the WP REST nonce from a Document. Content
   * scripts can't reach page-context globals like `window.wpApiSettings`
   * directly, so we scan the DOM surface that mirrors them: inline
   * `<script>` blocks (where wp_enqueue_script(`wp-api`) prints the
   * config object) and a couple of well-known data-* attributes. Returns
   * the nonce string or null.
   *
   * The popup has a richer path that injects MAIN-world script to read
   * the live globals (see src/popup/lib/actions.js → requestSiteInfo);
   * this is the content-script-side fallback that handles the common
   * case of WP-emitted inline config.
   */
  function findNonceInDocument(doc) {
    if (!doc || !doc.querySelectorAll) return null;

    // wpApiSettings / _wpApiSettings inline object literal. The pattern
    // tolerates whitespace differences but assumes nonce is a hex string
    // (output of wp_create_nonce) and appears as a top-level key.
    const scripts = doc.querySelectorAll('script:not([src])');
    for (let i = 0; i < scripts.length; i++) {
      const t = scripts[i].textContent || '';
      const m = t.match(/(?:wpApiSettings|_wpApiSettings)\s*=\s*\{[^}]*"nonce"\s*:\s*"([a-f0-9]+)"/);
      if (m) return m[1];
      const m2 = t.match(/wp\.api\.fetch\.use\(\s*wp\.api\.fetch\.createNonceMiddleware\(\s*"([a-f0-9]+)"/);
      if (m2) return m2[1];
    }

    // Gutenberg + some plugins emit the nonce on a root element.
    const el = doc.querySelector('[data-rest-nonce], [data-wp-nonce], [data-nonce]');
    if (el) {
      return el.getAttribute('data-rest-nonce')
        || el.getAttribute('data-wp-nonce')
        || el.getAttribute('data-nonce')
        || null;
    }
    return null;
  }

  /**
   * Same-origin + /wp-admin/ guard for URLs sourced from page DOM. Used
   * to validate hrefs extracted from the admin bar before the popup
   * navigates to them — a compromised or hostile page can construct a
   * fake admin bar with off-origin links that the toolbar would
   * otherwise carry forward as if they were trusted.
   */
  function isSameOriginAdminUrl(href, origin) {
    if (!href || !origin) return false;
    try {
      const u = new URL(href);
      // /wp-admin/ may sit under a subdirectory (e.g. /wordpress/wp-admin/)
      // on subdir installs (issue #33), so match it anywhere in the path.
      return u.origin === origin && /\/wp-admin\//.test(u.pathname);
    } catch (_) {
      return false;
    }
  }

  /**
   * Same-origin http(s) guard for DOM-sourced page links with no required
   * path shape — used for the admin bar's Visit Site href, whose target
   * (home_url) can be any path on the origin. Stricter shape guards exist
   * for admin and logout URLs above and below.
   */
  function isSameOriginPageUrl(href, origin) {
    if (!href || !origin) return false;
    try {
      const u = new URL(href);
      const safeProtocol = u.protocol === 'http:' || u.protocol === 'https:';
      return safeProtocol && u.origin === origin;
    } catch (_) {
      return false;
    }
  }

  /**
   * Same-origin WordPress logout guard for the admin bar's logout href. We
   * only trust that href to skip WP's "are you sure?" confirm (it carries the
   * `_wpnonce`); a spoofed admin bar could otherwise point logout at an
   * arbitrary same-origin URL. Require the real shape —
   * `<base>/wp-login.php?action=logout` — with the path allowed under a
   * subdirectory install (#33).
   */
  function isSameOriginLogoutUrl(href, origin) {
    if (!href || !origin) return false;
    try {
      const u = new URL(href);
      return u.origin === origin
        && /\/wp-login\.php$/.test(u.pathname)
        && new URLSearchParams(u.search).get('action') === 'logout';
    } catch (_) {
      return false;
    }
  }

  async function fetchTermId({ restApiRoot, origin, taxonomy, slug, fetchImpl = timedFetch }) {
    if (!taxonomy || !slug) return null;
    const root = normalizeRoot(restApiRoot, origin);
    const base = TAX_REST_BASE[taxonomy] || taxonomy;
    const url  = `${root}wp/v2/${encodeURIComponent(base)}?slug=${encodeURIComponent(slug)}`;
    try {
      const res = await fetchImpl(url, { credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) return null;
      return positiveIntOrNull(data[0].id);
    } catch (_) {
      return null;
    }
  }

  async function fetchAuthorId({ restApiRoot, origin, slug, fetchImpl = timedFetch }) {
    if (!slug) return null;
    const root = normalizeRoot(restApiRoot, origin);
    const url  = `${root}wp/v2/users?slug=${encodeURIComponent(slug)}`;
    try {
      const res = await fetchImpl(url, { credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) return null;
      return positiveIntOrNull(data[0].id);
    } catch (_) {
      return null;
    }
  }

  // Base for synthesized wp-admin URLs. Prefers the detection context's
  // path-aware baseUrl (carries any subdirectory prefix — issue #33) and
  // falls back to the bare origin for root installs / contexts that predate
  // the field.
  function adminBase(ctx, origin) {
    return (ctx && ctx.baseUrl) || origin;
  }

  /**
   * Given a detection context, returns an edit URL or null. Async path
   * only — call resolveEditUrlSync first and fall back to this when it
   * returns null AND the context has slugs that need resolving.
   */
  async function resolveEditUrlAsync(ctx, origin, fetchImpl = timedFetch) {
    const base = adminBase(ctx, origin);

    // Term archive without a numeric ID — resolve via REST.
    if (ctx.pageType === 'term' && ctx.taxonomy && !ctx.termId && ctx.term) {
      const id = await fetchTermId({
        restApiRoot: ctx.restApiRoot, origin,
        taxonomy: ctx.taxonomy, slug: ctx.term, fetchImpl,
      });
      if (id) {
        return `${base}/wp-admin/term.php?taxonomy=${encodeURIComponent(ctx.taxonomy)}&tag_ID=${id}`;
      }
    }

    // Author archive without a numeric ID — resolve via REST.
    if (ctx.pageType === 'author' && !ctx.authorId && ctx.authorSlug) {
      const id = await fetchAuthorId({
        restApiRoot: ctx.restApiRoot, origin,
        slug: ctx.authorSlug, fetchImpl,
      });
      if (id) {
        return `${base}/wp-admin/user-edit.php?user_id=${id}`;
      }
    }

    return null;
  }

  // --- Template-backed views (block themes) -------------------------------

  /**
   * Page types that are rendered from a block-theme template/template-part
   * rather than a single editable post: the blog index and archives. These
   * have no post.php / term.php destination — they resolve to a site-editor
   * deep link instead. Category/tag (`pageType === 'term'`) and author
   * archives are intentionally excluded: they have their own editable
   * record (the term / user) and resolve via the sync/REST paths above.
   */
  function isTemplateBackedPage(ctx) {
    return ctx.pageType === 'home' || ctx.pageType === 'archive';
  }

  /**
   * Ordered template-slug candidates for a template-backed view, following
   * WordPress's template hierarchy from most to least specific. The caller
   * picks the first candidate that the active theme actually registers.
   *
   *   home    → home, index            (blog posts index)
   *   archive → archive-{postType}?, archive, index
   *
   * A static front page or posts page is a real Page (pageType 'single')
   * and never reaches here — it resolves to post.php upstream.
   */
  function templateCandidates(ctx) {
    if (ctx.pageType === 'home') {
      return ['home', 'index'];
    }
    if (ctx.pageType === 'archive') {
      const candidates = [];
      if (ctx.postType) candidates.push(`archive-${ctx.postType}`);
      candidates.push('archive', 'index');
      return candidates;
    }
    return [];
  }

  /**
   * Given the registered-template list from /wp/v2/templates, returns the
   * most specific template matching the current view, or null. Each template
   * object carries an `id` of the form `{stylesheet}//{slug}`, which is
   * exactly what the site editor's `postId` expects.
   */
  function pickTemplate(ctx, templates) {
    if (!Array.isArray(templates)) return null;
    const bySlug = new Map();
    for (const t of templates) {
      if (t && typeof t.slug === 'string' && t.id) bySlug.set(t.slug, t);
    }
    for (const slug of templateCandidates(ctx)) {
      if (bySlug.has(slug)) return bySlug.get(slug);
    }
    return null;
  }

  /**
   * Builds the site-editor deep link for a resolved template. `canvas=edit`
   * opens straight into edit mode rather than the template's preview screen.
   * The template `id` is already `{stylesheet}//{slug}`; encode it so the
   * `//` survives as the postId value.
   */
  function buildSiteEditorUrl(origin, template) {
    if (!template || !template.id) return null;
    const postId = encodeURIComponent(template.id);
    return `${origin}/wp-admin/site-editor.php?postType=wp_template&postId=${postId}&canvas=edit`;
  }

  /**
   * Lists the active theme's registered templates. Private endpoint —
   * requires edit_theme_options (admins) and a valid X-WP-Nonce. Returns
   * an array (possibly empty) or null on failure / insufficient caps.
   */
  async function fetchTemplates({ restApiRoot, origin, nonce, fetchImpl = timedFetch }) {
    const root = normalizeRoot(restApiRoot, origin);
    try {
      const res = await fetchImpl(`${root}wp/v2/templates`, {
        credentials: 'include',
        headers: nonce ? { 'X-WP-Nonce': nonce } : undefined,
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data) ? data : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Resolves a template-backed view to a site-editor edit URL. Returns
   * `{ url, isBlockTheme }` so the popup can label the disabled state
   * honestly:
   *
   *   - isBlockTheme false → classic theme; templates are PHP files, no URL.
   *   - isBlockTheme true, url null → block theme but no matching template.
   *   - isBlockTheme null → couldn't determine (not an admin, REST off).
   *
   * Reads the active theme's `is_block_theme` flag first (cheap gate) and
   * only lists templates when it's a block theme.
   */
  async function resolveTemplateEditUrlAsync({ ctx, origin, nonce, fetchImpl = timedFetch }) {
    if (!isTemplateBackedPage(ctx)) return { url: null, isBlockTheme: null };

    const theme = await fetchActiveTheme({
      restApiRoot: ctx.restApiRoot, origin, nonce, fetchImpl,
    });
    const isBlockTheme = theme ? !!theme.is_block_theme : null;
    if (isBlockTheme !== true) return { url: null, isBlockTheme };

    const templates = await fetchTemplates({
      restApiRoot: ctx.restApiRoot, origin, nonce, fetchImpl,
    });
    // Build the site-editor link off the path-aware base so it's correct on
    // subdirectory installs (#33); falls back to the origin for root installs.
    const base = (ctx && ctx.baseUrl) || origin;
    const url = buildSiteEditorUrl(base, pickTemplate(ctx, templates));
    return { url: url || null, isBlockTheme: true };
  }

  /**
   * Sync-only resolution — no network. Returns the best admin URL given
   * whatever IDs we already have in context, or null.
   */
  function resolveEditUrlSync(ctx, origin) {
    // Require same-origin /wp-admin/, not just same-origin: a spoofed admin bar
    // could otherwise point the Edit action at an arbitrary same-origin path.
    if (ctx.adminBarEditHref && isSameOriginAdminUrl(ctx.adminBarEditHref, origin)) {
      return ctx.adminBarEditHref;
    }

    const base = adminBase(ctx, origin);

    // Single post / page / CPT
    if (ctx.postId && ctx.pageType === 'single') {
      return `${base}/wp-admin/post.php?post=${ctx.postId}&action=edit`;
    }

    // Term archive — ID already in context
    if (ctx.pageType === 'term' && ctx.taxonomy && ctx.termId) {
      return `${base}/wp-admin/term.php?taxonomy=${encodeURIComponent(ctx.taxonomy)}&tag_ID=${ctx.termId}`;
    }

    // Author archive — ID already in context
    if (ctx.pageType === 'author' && ctx.authorId) {
      return `${base}/wp-admin/user-edit.php?user_id=${ctx.authorId}`;
    }

    return null;
  }

  /**
   * True when sync resolution failed but we have enough context for a
   * REST round-trip to succeed. Popup uses this to decide whether to
   * show a "resolving…" state vs. a flat "coming soon".
   */
  function canResolveViaRest(ctx) {
    if (ctx.pageType === 'term' && ctx.taxonomy && !ctx.termId && ctx.term) return true;
    if (ctx.pageType === 'author' && !ctx.authorId && ctx.authorSlug) return true;
    return false;
  }

  /**
   * Capability gating for the popup's Edit / WordPress Admin actions.
   *
   * DOM-first by design. The most reliable capability signal is the admin bar
   * WordPress already rendered for the current user — it reflects their real
   * permissions and is present synchronously, with no REST call. We lean on
   * it first because the obvious alternative — /wp/v2/users/me?context=edit —
   * needs a REST nonce that logged-in *frontend* pages frequently don't emit
   * (e.g. wordpress.org), so that fetch 401s and yields nothing to gate on.
   * The fetched capabilities map is used only as an enhancement when present.
   *
   * Every decision is tri-state:
   *   true  — enable the action
   *   false — definitively gate it (user can't use it)
   *   null  — unknown; caller should not gate, so we never hide a valid
   *           action when we simply lack a signal.
   */
  function capsOf(user) {
    return user && typeof user.capabilities === 'object' && user.capabilities
      ? user.capabilities
      : null;
  }

  /**
   * Whether the admin bar WordPress rendered for this user shows any
   * editing-level access: an Edit link for the current object, or a "+ New"
   * menu (each sub-item is a content type the user can create). Subscribers
   * get neither; contributors and up get at least one. A synchronous,
   * REST-free proxy for "this account is more than a bare subscriber".
   */
  function adminBarShowsEditingAccess(ctx) {
    if (!ctx) return false;
    return !!ctx.adminBarEditHref
      || (Array.isArray(ctx.newContentItems) && ctx.newContentItems.length > 0);
  }

  /**
   * Whether to enable "WordPress Admin". Gates on *meaningful* dashboard
   * access — the ability to create/edit/manage something — rather than the
   * bare `read` cap, so a subscriber-tier account (which only bounces to its
   * own profile) doesn't get an active link. Prefers the rendered admin bar;
   * falls back to the capabilities map when DOM signals are absent.
   */
  function canAccessAdmin(ctx, user) {
    const caps = capsOf(user);
    if (caps) {
      return adminBarShowsEditingAccess(ctx)
        || !!(caps.edit_posts || caps.edit_pages || caps.upload_files
          || caps.publish_posts || caps.edit_others_posts || caps.moderate_comments
          || caps.manage_categories || caps.manage_options || caps.edit_theme_options);
    }
    // No capabilities map (nonce/REST unavailable) — read it off the admin bar
    // WordPress rendered. Only decisive when the bar is actually present.
    if (ctx && ctx.isLoggedIn && ctx.hasAdminBar) {
      return adminBarShowsEditingAccess(ctx);
    }
    return null;
  }

  /**
   * Whether to enable the Edit action for the current page.
   *
   * The admin-bar Edit link is authoritative — WordPress only renders it when
   * `current_user_can('edit_post', $id)` for the resolved object — so its
   * presence enables the action outright. Its *absence*, when WP rendered the
   * admin bar for a logged-in user on a singular object, is equally telling:
   * WP decided this user can't edit it, so we don't synthesize a dead link.
   * The capabilities map is a fallback, used only when no admin bar is present
   * to read (the allcaps map is general, not per-object, so the rendered bar
   * is preferred whenever it's available).
   */
  function canEditCurrent(ctx, user) {
    if (!ctx) return null;
    if (ctx.adminBarEditHref) return true;

    // The admin bar is per-object authoritative for a singular object: when WP
    // rendered the bar for a logged-in user but omitted the Edit link,
    // current_user_can('edit_post', $id) came back false, so they can't edit
    // THIS object — even when their general caps would suggest otherwise (a
    // contributor's edit_posts covers only their own drafts, not someone
    // else's published post; an author can't edit others' posts). Trust the
    // bar over allcaps. Checked before the caps fallback so we never re-enable
    // a dead Edit link for those mid-tier roles. Scoped to `single` because
    // core reliably renders the bar's Edit link for editable posts/pages/CPTs;
    // term/author archives are less consistent, so those fall through to caps.
    if (ctx.isLoggedIn && ctx.hasAdminBar && ctx.pageType === 'single') {
      return false;
    }

    const caps = capsOf(user);
    if (caps) {
      switch (ctx.pageType) {
        case 'single':
          // Reached only when no admin bar was present to read (e.g. the user
          // hid it). Pages need edit_pages; posts, attachments, and most CPTs
          // map to the edit_posts family (the default capability_type). We
          // can't know an arbitrary CPT's custom caps from allcaps, so
          // edit_posts || edit_pages is the practical floor — it gates
          // subscribers (who have neither) while leaving capable roles enabled.
          if (ctx.postType === 'page') return !!caps.edit_pages;
          return !!(caps.edit_posts || caps.edit_pages);
        case 'term':
          // term.php editing requires manage_categories for built-in
          // taxonomies; custom taxonomies use manage_<tax>_terms, but
          // manage_categories is a reliable proxy across standard roles.
          return !!caps.manage_categories;
        case 'author':
          // user-edit.php requires edit_users (administrator-only).
          return !!caps.edit_users;
        default:
          // archive/home/search/404 — edit isn't offered for these anyway.
          return null;
      }
    }

    return null;
  }

  /**
   * Public site-info endpoint (/wp-json/). Returns name, description, url,
   * home, gmt_offset, timezone_string, namespaces, site_logo, site_icon_url.
   * Works without authentication — most useful fact is `namespaces`, which
   * reveals plugins that register their own REST routes (wc/v3, yoast/v1,
   * contact-form-7/v1, etc.) even when DOM scanning misses them.
   */
  async function fetchSiteInfo({ restApiRoot, origin, nonce, fetchImpl = timedFetch }) {
    const root = normalizeRoot(restApiRoot, origin);
    try {
      const res = await fetchImpl(root, {
        credentials: 'include',
        headers: nonce ? { 'X-WP-Nonce': nonce } : undefined,
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  /**
   * Active theme — requires edit_theme_options capability (admins have it).
   * The collection endpoint returns an array; `?status=active` filters to
   * the one currently serving the site. Returns the first entry or null.
   */
  async function fetchActiveTheme({ restApiRoot, origin, nonce, fetchImpl = timedFetch }) {
    const root = normalizeRoot(restApiRoot, origin);
    try {
      const res = await fetchImpl(`${root}wp/v2/themes?status=active`, {
        credentials: 'include',
        headers: nonce ? { 'X-WP-Nonce': nonce } : undefined,
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data) || data.length === 0) return null;
      return data[0];
    } catch (_) {
      return null;
    }
  }

  /**
   * Full plugin list — requires activate_plugins capability (admins have it).
   * Returns an array of plugin objects with { plugin, name, version, author,
   * status, plugin_uri, ... } or null when unauthorized / REST is disabled.
   */
  async function fetchPluginsDetail({ restApiRoot, origin, nonce, fetchImpl = timedFetch }) {
    const root = normalizeRoot(restApiRoot, origin);
    try {
      const res = await fetchImpl(`${root}wp/v2/plugins`, {
        credentials: 'include',
        headers: nonce ? { 'X-WP-Nonce': nonce } : undefined,
      });
      if (!res.ok) return null;
      const data = await res.json();
      return Array.isArray(data) ? data : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Current user — `/wp/v2/users/me?context=edit`. Cookie auth + nonce.
   * `edit` context is what exposes the `roles` field (default `view`
   * context omits it); WP always allows the current user to read their
   * own record in edit context, so any logged-in user works. Returns the
   * user object or null on any failure (logged out, missing nonce, etc.).
   */
  async function fetchCurrentUser({ restApiRoot, origin, nonce, fetchImpl = timedFetch }) {
    const root = normalizeRoot(restApiRoot, origin);
    try {
      const res = await fetchImpl(`${root}wp/v2/users/me?context=edit`, {
        credentials: 'include',
        headers: nonce ? { 'X-WP-Nonce': nonce } : undefined,
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  /**
   * Raw post content — requires the user to be able to edit the given post
   * (WP returns 401 otherwise). Returns the content string with block
   * comments intact, or null on any failure. Used by the block inspector
   * to recover full namespaced names, metadata.name labels, and
   * template-part slugs that the frontend HTML doesn't carry.
   *
   * Tries the well-known REST base first and falls back to the /types
   * endpoint for custom post types.
   */
  async function fetchRawContent({ restApiRoot, origin, postType, postId, nonce, fetchImpl = timedFetch }) {
    if (!postId) return null;
    const root = normalizeRoot(restApiRoot, origin);
    // `?context=edit` requires `edit_post` capability; WP rejects cookie
    // auth without X-WP-Nonce even when the user is authenticated.
    const headers = nonce ? { 'X-WP-Nonce': nonce } : undefined;

    const COMMON = {
      post: 'posts',
      page: 'pages',
      attachment: 'media',
    };
    let base = COMMON[postType] || null;

    if (!base && postType) {
      try {
        // /types is publicly readable; nonce not required, but pass it
        // along when we have one — costs nothing.
        const res = await fetchImpl(
          `${root}wp/v2/types/${encodeURIComponent(postType)}`,
          { credentials: 'include', headers },
        );
        if (res.ok) {
          const info = await res.json();
          if (info && isRestBaseSlug(info.rest_base)) base = info.rest_base;
        }
      } catch (_) { /* fall through */ }
    }
    if (!base) return null;

    try {
      const res = await fetchImpl(
        `${root}wp/v2/${encodeURIComponent(base)}/${encodeURIComponent(postId)}?context=edit`,
        { credentials: 'include', headers },
      );
      if (!res.ok) return null;
      const data = await res.json();
      return (data && data.content && data.content.raw) || null;
    } catch (_) {
      return null;
    }
  }

  globalThis.WPRest = {
    fetchTermId,
    fetchAuthorId,
    resolveEditUrlSync,
    resolveEditUrlAsync,
    canResolveViaRest,
    canAccessAdmin,
    canEditCurrent,
    isTemplateBackedPage,
    templateCandidates,
    pickTemplate,
    buildSiteEditorUrl,
    fetchTemplates,
    resolveTemplateEditUrlAsync,
    fetchSiteInfo,
    fetchActiveTheme,
    fetchPluginsDetail,
    fetchCurrentUser,
    fetchRawContent,
    findNonceInDocument,
    isSameOriginAdminUrl,
    isSameOriginPageUrl,
    isSameOriginLogoutUrl,
  };
})();
