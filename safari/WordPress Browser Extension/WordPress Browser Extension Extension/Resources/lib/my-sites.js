/**
 * "My Sites" — a persistent, user-curated list of WordPress sites the user
 * has logged into. Framework-free pure helpers over a plain store object
 * (`{ [siteKey]: { origin, baseUrl, addedAt, lastLoggedInAt, customName? } }`),
 * attached to globalThis so the background service worker (importScripts) and
 * the popup (classic <script> → window.WPMySites) share one implementation.
 * The chrome.storage.local read/write wrapping lives with each caller.
 *
 * The store key is the install base (origin plus install path), not the bare
 * origin: two subdirectory installs sharing one origin — localhost/siteA and
 * localhost/siteB, subdirectory multisite networks, agency layouts like
 * example.com/client1 — are distinct sites and keep distinct records (#94).
 * Stores persisted by pre-#94 builds were keyed by origin; migrateStore
 * re-keys them from each record's own stored baseUrl.
 *
 * Removal is sticky: once the user dismisses a record, passive detection
 * never re-adds it. Restoring a removed site is an explicit future feature,
 * not an inference from browsing. (Guaranteed for records identified under
 * this scheme; ambiguous legacy records carry a caveat — see migrateStore.)
 */
(function () {
  'use strict';

  const STORE_KEY = 'wp_my_sites_v1';
  const MAX_ICON_URL_LEN = 2048;

  // A stored baseUrl is the install base: a same-origin http(s) URL,
  // returned in CANONICAL form — origin + normalized pathname, with query,
  // fragment, credentials, and trailing slash runs dropped. Anything else
  // (cross-origin, or a scheme like blob: whose parsed origin can still
  // equal the page origin) is forged/poisoned input: drop it and let
  // callers fall back to the origin.
  function sanitizeBaseUrl(baseUrl, origin) {
    if (typeof baseUrl !== 'string' || !baseUrl) return null;
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (u.origin !== origin) return null;
      // RFC 3986 §6.2.2 normalization so URI-equivalent paths share one key:
      // decode percent-encoded unreserved characters (/%73iteA ≡ /siteA) and
      // uppercase the hex of any that stay encoded.
      const path = u.pathname.replace(/\/+$/, '').replace(/%([0-9a-fA-F]{2})/g, (m, hex) => {
        const c = String.fromCharCode(parseInt(hex, 16));
        return /[A-Za-z0-9\-._~]/.test(c) ? c : `%${hex.toUpperCase()}`;
      });
      return path ? `${u.origin}${path}` : u.origin;
    } catch (_) {
      return null;
    }
  }

  // Keep only http/https icon URLs within a sane length. Drops data: blobs (a
  // logged-into site could otherwise lodge unbounded data in storage) and any
  // other scheme; cross-origin http(s) is allowed since WP site icons are often
  // CDN-served.
  function sanitizeIconUrl(iconUrl) {
    if (typeof iconUrl !== 'string' || !iconUrl || iconUrl.length > MAX_ICON_URL_LEN) return null;
    try {
      const p = new URL(iconUrl).protocol;
      return p === 'http:' || p === 'https:' ? iconUrl : null;
    } catch (_) {
      return null;
    }
  }

  // Install path of a record's base, with any trailing slash run trimmed:
  // '' for a root install, '/siteA' for a subdirectory one. Also '' when the
  // base is unknown or fails sanitization, collapsing those records to the
  // origin — the same fallback callers already apply.
  function installPath(site) {
    const safe = sanitizeBaseUrl(site && site.baseUrl, site && site.origin);
    if (!safe) return '';
    try {
      return new URL(safe).pathname.replace(/\/+$/, '');
    } catch (_) {
      return '';
    }
  }

  // Canonical store key for an install: origin + install path (query/fragment
  // dropped), or the bare origin when no valid same-origin base is known.
  // Deterministic from record fields, so every caller derives the same key a
  // write under this scheme produced.
  function siteKey(site) {
    if (!site || !site.origin) return '';
    try {
      return new URL(site.origin).origin + installPath(site);
    } catch (_) {
      return site.origin;
    }
  }

  /**
   * Re-key a store persisted by a pre-#94 build (keyed by bare origin) onto
   * install-base keys, using each record's own stored baseUrl. Pure and
   * idempotent. The background runs it in front of every write (plus once on
   * extension update), and the popup runs it over its read snapshot — so
   * both sides of a curation op speak one canonical key, and keys never
   * change again after this pass (popup keys are stable).
   *
   * Lossless migration of legacy data is impossible: pre-#94 builds
   * collapsed every install on an origin into one origin-keyed record, and
   * a subdirectory install seen only via wp-admin was stored with the bare
   * origin as its base — indistinguishable from a root install. The policy
   * is deterministic instead of guessing:
   *   - a record whose stored base carries a non-root path re-keys to that
   *     install;
   *   - a root-looking or base-less record stays PINNED to the origin key
   *     forever — nothing ever moves its name or tombstone to a
   *     later-detected sibling. It may therefore linger as a stale origin
   *     row, and a legacy dismissal cannot always be associated with the
   *     right subdirectory install (the sibling records separately, as
   *     new). Sticky removal is guaranteed for records identified under
   *     this scheme going forward; it cannot be promised for ambiguous
   *     legacy data.
   *
   * Records that can't be interpreted (no valid same-shape http(s) origin)
   * are DROPPED: they are invisible to the popup and unreachable by
   * curation, and dropping them keeps the accumulator free of hostile keys.
   * Should two records land on one key, the most recently logged-into one
   * wins, but a tombstone on either side survives the merge.
   */
  function migrateStore(store) {
    if (!store || typeof store !== 'object') return store;
    let changed = false;
    const next = {};
    for (const [key, rec] of Object.entries(store)) {
      if (!rec || typeof rec !== 'object' || typeof rec.origin !== 'string') {
        changed = true;
        continue;
      }
      let validOrigin = false;
      try {
        const u = new URL(rec.origin);
        validOrigin = (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === rec.origin;
      } catch (_) { /* drop */ }
      if (!validOrigin) {
        changed = true;
        continue;
      }
      const k = siteKey(rec);
      if (k !== key) changed = true;
      const prev = next[k];
      if (!prev || (rec.lastLoggedInAt || 0) >= (prev.lastLoggedInAt || 0)) {
        next[k] = prev && prev.dismissed && !rec.dismissed ? { ...rec, dismissed: true } : rec;
      } else if (rec.dismissed && !prev.dismissed) {
        next[k] = { ...prev, dismissed: true };
      }
    }
    return changed ? next : store;
  }

  // Sites for display: newest login first. Removed sites are tombstoned
  // (dismissed) rather than deleted, so they're filtered out here. baseUrl and
  // iconUrl are re-sanitized on read so records persisted before the write-time
  // guard (or by an older build) can't feed a poisoned URL to the popup. Each
  // entry carries its store key as `key` — the handle curation ops use;
  // callers canonicalize the snapshot with migrateStore first so the key a
  // row round-trips is always the canonical one.
  function listSites(store) {
    const sites = store && typeof store === 'object' ? store : {};
    return Object.entries(sites)
      .filter(([, s]) => s && s.origin && !s.dismissed)
      .map(([key, s]) => ({
        ...s,
        key,
        baseUrl: sanitizeBaseUrl(s.baseUrl, s.origin),
        iconUrl: sanitizeIconUrl(s.iconUrl),
      }))
      .sort((a, b) => (b.lastLoggedInAt || 0) - (a.lastLoggedInAt || 0));
  }

  /**
   * Which existing record does a login with no valid base belong to? A page
   * can lack base evidence entirely (REST discovery link stripped by a
   * security plugin, the admin screens of a root install), and a permalink
   * pathname says nothing reliable about the install base — so credit the
   * existing same-origin record whose install path is the longest
   * segment-exact path-prefix of the visited page. A root record's '' path
   * matches every path as the shortest prefix. Dismissed records
   * participate: they still own their path, which is what keeps their
   * removal sticky instead of letting such logins land somewhere else.
   * Returns null when nothing matches — the caller drops the login rather
   * than minting a speculative bare-origin record.
   */
  function attributeLoginKey(store, origin, pathname) {
    const sites = store && typeof store === 'object' ? store : {};
    const path = typeof pathname === 'string' && pathname.charAt(0) === '/' ? pathname : '/';
    let bestKey = null;
    let bestLen = -1;
    for (const [key, rec] of Object.entries(sites)) {
      if (!rec || typeof rec !== 'object' || rec.origin !== origin) continue;
      const prefix = installPath(rec);
      if (prefix.length <= bestLen) continue;
      if (prefix === '' || path === prefix || path.indexOf(prefix + '/') === 0) {
        bestKey = key;
        bestLen = prefix.length;
      }
    }
    return bestKey;
  }

  /**
   * Record a logged-in WordPress site. Returns a new store object when it
   * changed, or the same reference when it didn't (so callers can skip the
   * write). Records key by install base and keys are stable: nothing here
   * ever moves an existing record. Curation rule:
   *   - absent             → add it. "Absent" reliably means "never seen",
   *                          because removal tombstones rather than deletes.
   *   - present, active    → bump lastLoggedInAt (refresh baseUrl / iconUrl)
   *   - present, dismissed → stays removed. Removal is sticky — passive
   *                          detection never revives a dismissed record.
   *
   * A login with no valid base is attributed to the existing record owning
   * the visited pathname (attributeLoginKey) and DROPPED when nothing
   * matches — an unattributable page must not mint a speculative bare-origin
   * row. Attribution only ever bumps; it never revives.
   *
   * An ambiguous legacy record pinned at the origin key (see migrateStore)
   * is just a record here: sibling evidence keys elsewhere and records
   * separately, never touching the origin record's name or tombstone.
   */
  function upsertOnLogin(store, { origin, baseUrl = null, iconUrl = null, now = 0, pathname = null }) {
    if (!origin) return store;
    // Validate at the storage boundary: never persist a cross-origin or
    // non-canonical baseUrl, nor a non-http(s)/oversized iconUrl, even if a
    // forged detection reported one.
    const safeBaseUrl = sanitizeBaseUrl(baseUrl, origin);
    const safeIconUrl = sanitizeIconUrl(iconUrl);
    const current = store && typeof store === 'object' ? store : {};

    if (!safeBaseUrl) {
      const key = attributeLoginKey(current, origin, pathname);
      if (!key) return store; // unattributable — no speculative row
      const existing = current[key];
      if (!existing || existing.dismissed) return store; // sticky removal
      const next = { ...current };
      next[key] = {
        ...existing,
        lastLoggedInAt: now,
        iconUrl: safeIconUrl || existing.iconUrl || null,
      };
      return next;
    }

    const key = siteKey({ origin, baseUrl: safeBaseUrl });
    const existing = Object.hasOwn(current, key) ? current[key] : undefined;
    if (existing) {
      if (existing.dismissed) return store; // sticky removal
      const next = { ...current };
      next[key] = {
        ...existing,
        lastLoggedInAt: now,
        baseUrl: safeBaseUrl,
        iconUrl: safeIconUrl || existing.iconUrl || null,
      };
      return next;
    }

    const next = { ...current };
    next[key] = {
      origin,
      baseUrl: safeBaseUrl,
      iconUrl: safeIconUrl,
      addedAt: now,
      lastLoggedInAt: now,
    };
    return next;
  }

  // Remove = tombstone (keep the record, hide it) so a still-logged-in site
  // isn't silently re-added on the next page view. listSites filters these
  // out. Own-property check: inherited names ('__proto__', 'constructor', …)
  // must be absent-key no-ops, not prototype reads or writes.
  function removeSite(store, key) {
    if (!store || typeof key !== 'string' || !Object.hasOwn(store, key) || !store[key]) return store;
    const next = { ...store };
    next[key] = { ...next[key], dismissed: true };
    return next;
  }

  // Set/clear a custom display name. Empty/whitespace clears it.
  function renameSite(store, key, name) {
    if (!store || typeof key !== 'string' || !Object.hasOwn(store, key) || !store[key]) return store;
    const trimmed = (name || '').trim();
    const next = { ...store };
    next[key] = { ...next[key] };
    if (trimmed) next[key].customName = trimmed;
    else delete next[key].customName;
    return next;
  }

  // Default label: hostname without scheme or leading www, plus the install
  // path when the base isn't the origin root — two installs on one host must
  // stay tellable apart ('localhost/siteA' vs 'localhost/siteB').
  function defaultLabel(site) {
    if (!site) return '';
    try {
      return new URL(site.origin).host.replace(/^www\./, '') + installPath(site);
    } catch (_) {
      return site.origin || '';
    }
  }

  // Label to show: custom name, else the default host(+path) label.
  function displayName(site) {
    if (!site) return '';
    return site.customName || defaultLabel(site);
  }

  globalThis.WPMySites = {
    STORE_KEY,
    siteKey,
    migrateStore,
    attributeLoginKey,
    listSites,
    upsertOnLogin,
    removeSite,
    renameSite,
    defaultLabel,
    displayName,
    sanitizeBaseUrl,
    sanitizeIconUrl,
  };
})();
