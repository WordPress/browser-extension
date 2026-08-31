/**
 * Chrome tab/cookie side effects for the popup action rows. Each action
 * computes a target URL (if any) and either navigates the active tab,
 * opens a new tab, or performs an ambient side effect (clear data,
 * open mobile preview, etc.).
 */

// Ceiling for site fetches issued from the popup process. A hostile or simply
// unresponsive server must not be able to pin a popup request open forever;
// AbortSignal.timeout aborts the fetch (rejects with a TimeoutError the
// existing catch handles) so the UI can settle. Chrome 103+ / Safari 16+.
const REQUEST_TIMEOUT_MS = 10000;

// Byte ceiling for response bodies we buffer + regex in the popup process
// (profile.php is normally well under this). Guards against a hostile origin
// streaming an unbounded body into memory even before the timeout fires.
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;

// Read a response body as text but bail past a byte cap. Throws when exceeded;
// callers already treat any failure as "no nonce".
async function readTextCapped(res, maxBytes) {
	if (!res.body) return res.text();
	const reader = res.body.getReader();
	const chunks = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > maxBytes) {
			try { await reader.cancel(); } catch (_) { /* ignore */ }
			throw new Error('response exceeded size cap');
		}
		chunks.push(value);
	}
	const merged = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

// A followed redirect can move a response to a different origin. When we scrape
// a secret (the REST nonce) out of a response body, the origin that served it
// is the security boundary, so refuse anything that ended up cross-origin.
// Origin only — a same-origin admin→login redirect is legitimate and simply
// carries no nonce. http(s) only, so a redirect to a data:/blob: URL can't slip
// through. Mirrors the res.url gate on the content script's fresh-detection
// fetch (#111).
function isSameOriginResponse(resUrl, expectedOrigin) {
	if (!resUrl) return false;
	try {
		const u = new URL(resUrl);
		return (u.protocol === 'http:' || u.protocol === 'https:')
			&& u.origin === expectedOrigin;
	} catch (_) {
		return false;
	}
}

export async function runAction(action, { origin, baseUrl, url, editUrl, viewUrl, logoutUrl, visitUrl, newTab = false }) {
	// Path-aware install base for synthesized links (carries any subdirectory
	// prefix — issue #33). Callers that predate it pass only `origin`; fall
	// back to that for root installs. `origin` is still used below for the
	// same-origin security checks on DOM-sourced hrefs and for cookie scoping.
	const base = baseUrl || origin;
	let target;
	switch (action) {
		case 'edit':
			target = editUrl || null;
			break;
		case 'view-post':
			target = viewUrl || null;
			break;
		case 'visit-site': {
			// Prefer the admin bar's Visit Site href when the popup captured
			// one (admin screens only): it carries home_url, which can
			// legitimately differ from the synthesized base on installs with
			// a split home/site configuration. DOM-sourced, so it must pass
			// the same-origin http(s) guard; otherwise fall back to the base.
			const rest = typeof window !== 'undefined' ? window.WPRest : null;
			const safeVisit =
				rest && typeof rest.isSameOriginPageUrl === 'function'
					&& rest.isSameOriginPageUrl(visitUrl, origin) ? visitUrl : null;
			target = safeVisit || `${base}/`;
			break;
		}
		case 'admin':
			target = `${base}/wp-admin/`;
			break;
		case 'profile':
			target = `${base}/wp-admin/profile.php`;
			break;
		case 'login':
			target = `${base}/wp-login.php`;
			break;
		case 'login-return':
			target = `${base}/wp-login.php?redirect_to=${encodeURIComponent(url)}`;
			break;
		// Prefer the admin bar's logout link — it carries the `_wpnonce` that
		// makes WP skip its "are you sure?" confirmation. (We do our own
		// inline confirm, so WP's would be a redundant second click.) Same-
		// origin guard: the href came from page DOM and a malicious page
		// could inject a fake admin bar pointing offsite. Fall back to the
		// bare URL when the captured href isn't trustworthy.
		case 'signout': {
			// Trust the admin bar's logout href only if it has the real WP logout
			// shape — same-origin /wp-login.php?action=logout (it carries the
			// _wpnonce that skips WP's confirm). A spoofed admin bar could
			// otherwise aim logout at an arbitrary same-origin URL. Falls back to
			// the synthesized logout (no nonce → WP shows its confirm) when not.
			const rest = typeof window !== 'undefined' ? window.WPRest : null;
			const safeLogout =
				rest && rest.isSameOriginLogoutUrl(logoutUrl, origin) ? logoutUrl : null;
			target = safeLogout || `${base}/wp-login.php?action=logout`;
			break;
		}
		case 'cachebust': {
			const bust = Math.random().toString(36).slice(2, 7);
			const u = new URL(url);
			u.searchParams.set('cachebust', bust);
			target = u.toString();
			break;
		}
		case 'mobile-preview':
			// The background owns the preview window (sizing + reuse). See
			// openMobilePreview.
			await openMobilePreview(url);
			window.close();
			return;
		case 'clear-data':
			await clearSiteData(origin);
			return;
	}
	if (!target) return;
	if (newTab) {
		await chrome.tabs.create({ url: target });
	} else {
		await chrome.tabs.update({ url: target });
	}
	window.close();
}

// The background owns the preview window: one per site, so it reuses the
// window already open for this URL's origin — navigating it to this page —
// instead of stacking a duplicate (the popup can't — it closes the moment it
// dispatches), and it re-asserts the size Safari otherwise ignores (#13).
// navigator.vendor is reliable here (Safari-only), so we detect and pass it on.
async function openMobilePreview(url) {
	try {
		await chrome.runtime.sendMessage({
			type: 'OPEN_MOBILE_PREVIEW',
			url,
			enforceSize: navigator.vendor === 'Apple Computer, Inc.',
		});
	} catch (_) {
		/* background unreachable — nothing opened */
	}
}

/**
 * True when a click on an action row should open its target in a new tab,
 * mirroring the gesture people already use on the WordPress admin bar (#29):
 * a middle-click, Cmd-click on macOS, or Ctrl-click elsewhere.
 *
 * Platform-aware on purpose: on macOS Ctrl+click is a context-menu gesture,
 * not new-tab, so we only honor the Meta (Cmd) key there. Shift (new window)
 * is intentionally unmapped — the popup only ever opens tabs.
 */
export function isNewTabIntent(event) {
	if (!event) return false;
	if (event.button === 1) return true; // middle-click
	const isMac =
		typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || '');
	return isMac ? !!event.metaKey : !!event.ctrlKey;
}

export async function copyToClipboard(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch (_) {
		return false;
	}
}

const WP_COOKIE_PATTERNS = [/^wordpress_/, /^wp-settings-/, /^wp_/];
const isWpCookie = (name) => WP_COOKIE_PATTERNS.some((re) => re.test(name));

async function clearSiteData(origin) {
	// Capture the tab identity up front, before any await. The user's
	// confirmation was for the page the popup opened over; resolving the
	// active tab later (after the cookie round-trips) could hand the
	// storage clear to a different tab.
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	const tabId = tab && tab.id != null ? tab.id : null;

	// 1. Remove cookies scoped to this exact host, except WordPress auth.
	//
	// `chrome.cookies.getAll({ domain })` matches cookies whose effective
	// domain is `domain` OR any parent of it — so on `www.example.com` it
	// would also return cookies set with `Domain=.example.com`. Removing
	// those would silently wipe sibling subdomains (e.g. signing the user
	// out of `mail.example.com`), which is not what "clear data on this
	// site" should do. We filter to host-only cookies whose stored domain
	// matches exactly, leaving parent-domain cookies alone.
	const parsedUrl = new URL(origin);
	const allCookies = await chrome.cookies.getAll({ domain: parsedUrl.hostname });
	const removePromises = allCookies
		.filter((c) => c.hostOnly && c.domain === parsedUrl.hostname && !isWpCookie(c.name))
		.map((c) => {
			const cookieUrl = `${c.secure ? 'https' : 'http'}://${c.domain}${c.path}`;
			return chrome.cookies.remove({ url: cookieUrl, name: c.name });
		});
	await Promise.all(removePromises);

	// 2. Clear localStorage and sessionStorage in the captured tab. The
	// origin re-check runs inside the target document itself: a same-tab
	// navigation keeps the tab id, so checking out here (or trusting the
	// tab's `url` snapshot) would leave a check/use race. If the page has
	// navigated away from the confirmed origin, nothing is cleared.
	let cleared = false;
	if (tabId != null) {
		try {
			const results = await chrome.scripting.executeScript({
				target: { tabId },
				func: (expectedOrigin) => {
					if (location.origin !== expectedOrigin) return false;
					try { localStorage.clear(); } catch (_) { /* ignore */ }
					try { sessionStorage.clear(); } catch (_) { /* ignore */ }
					return true;
				},
				args: [origin],
			});
			cleared = results && results[0] && results[0].result === true;
		} catch (_) {
			/* tab closed or script unreachable — leave cleared false */
		}
	}

	// 3. Reload so the clean state takes effect — only the captured tab,
	// and only when it actually cleared the confirmed origin.
	if (cleared) {
		try {
			await chrome.tabs.reload(tabId);
		} catch (_) {
			/* tab closed between clear and reload */
		}
	}
	window.close();
}

export async function applyAdminBarPref(hidden) {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	try {
		await chrome.tabs.sendMessage(tab.id, {
			type: 'APPLY_ADMIN_BAR_PREF',
			hidden,
		});
	} catch (_) {
		/* content script gone — next load will pick it up */
	}
}

export async function applyBlockInspectorPref(enabled) {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	try {
		await chrome.tabs.sendMessage(tab.id, {
			type: 'APPLY_BLOCK_INSPECTOR',
			enabled,
		});
	} catch (_) {
		/* content script gone — next load will pick it up */
	}
}

export async function requestRestEditUrl() {
	try {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		const res = await chrome.tabs.sendMessage(tab.id, { type: 'RESOLVE_EDIT_URL_REST' });
		return res && res.url ? res.url : null;
	} catch (_) {
		return null;
	}
}

/**
 * Resolves a usable WP REST nonce for the active tab. Tries the live page
 * first (MAIN-world script reads `wpApiSettings` / `_wpApiSettings` / inline
 * config / data-* attributes), then falls back to fetching `wp-admin/profile.php`
 * — admin pages reliably enqueue `wp-api` so the inline config object with
 * the nonce is in the response. Returns the nonce string or null.
 *
 * Returns { nonce, tab } so callers can reuse the tab handle without
 * re-querying.
 */
// Module-scoped memo of the in-flight nonce resolution. The popup process is
// torn down when the popup closes, so this cache lives exactly one popup
// lifetime. Without it every consumer (current user, site info, template edit
// URL) independently re-runs the whole resolution — a MAIN-world script
// injection plus, on frontends that don't enqueue wp-api, a wp-admin/profile.php
// fetch — so a single popup open paid that cost up to three times. All three
// consumers pass the same `ctx.baseUrl || origin`, so keying on tab + base
// collapses them onto one shared promise (a null result is cached too, so a
// nonce-less frontend isn't re-probed three times).
const nonceResolutionCache = new Map();

async function resolveRestNonce(baseUrl = null) {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	const key = `${tab?.id ?? 'no-tab'}::${baseUrl || ''}`;
	let pending = nonceResolutionCache.get(key);
	if (!pending) {
		pending = resolveNonceForTab(tab, baseUrl);
		nonceResolutionCache.set(key, pending);
	}
	return pending;
}

async function resolveNonceForTab(tab, baseUrl) {
	let nonce = null;
	// The origin the nonce was actually read from. A nonce is bound to its
	// source origin; the receiving content document refuses it unless that
	// origin still matches its own, so a mid-resolution tab navigation can't
	// deliver a victim origin's nonce to an attacker document that later
	// occupies the same tab id.
	let nonceOrigin = null;
	let tabOrigin = null;
	try { tabOrigin = new URL(tab.url).origin; } catch (_) { /* missing/odd tab url */ }
	try {
		const [out] = await chrome.scripting.executeScript({
			target: { tabId: tab.id },
			world: 'MAIN',
			func: () => {
				const readNonce = () => {
					if (window.wpApiSettings?.nonce) return window.wpApiSettings.nonce;
					if (window._wpApiSettings?.nonce) return window._wpApiSettings.nonce;
					if (window.wp?.apiFetch?.nonceMiddleware?.nonce) return window.wp.apiFetch.nonceMiddleware.nonce;
					for (const s of document.querySelectorAll('script:not([src])')) {
						const t = s.textContent || '';
						const m = t.match(/(?:wpApiSettings|_wpApiSettings)\s*=\s*\{[^}]*"nonce"\s*:\s*"([a-f0-9]+)"/)
							|| t.match(/wp\.api\.fetch\.use\(\s*wp\.api\.fetch\.createNonceMiddleware\(\s*"([a-f0-9]+)"/);
						if (m) return m[1];
					}
					const el = document.querySelector('[data-rest-nonce], [data-wp-nonce], [data-nonce]');
					return el?.getAttribute('data-rest-nonce')
						|| el?.getAttribute('data-wp-nonce')
						|| el?.getAttribute('data-nonce')
						|| null;
				};
				// Report the origin the nonce was read from so the receiving
				// document can reject it if this tab has since navigated.
				return { nonce: readNonce(), origin: location.origin };
			},
		});
		nonce = out?.result?.nonce || null;
		nonceOrigin = nonce ? (out?.result?.origin || null) : null;
	} catch (_) { /* page disallows scripting */ }

	if (!nonce) {
		try {
			// Subdirectory installs serve wp-admin under a prefix (#33), so
			// prefer the path-aware base when the caller supplies it.
			const base = baseUrl || new URL(tab.url).origin;
			const baseOrigin = new URL(base).origin;
			// Only probe the origin the active tab was on when resolution began;
			// a base that resolves to a different origin is never fetched.
			if (baseOrigin !== tabOrigin) return { tab, nonce: null, nonceOrigin: null };
			const res = await fetch(`${base}/wp-admin/profile.php`, {
				credentials: 'include',
				redirect: 'follow',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			// Only scrape a nonce when the final response is still same-origin
			// with the base we probed. A followed redirect can otherwise land
			// this credentialed fetch on another install — an attacker tab can
			// 302 it to a victim origin where the user is signed in, and that
			// page's real REST nonce would be handed to the content script on
			// THIS (attacker) tab. Fail closed: no nonce beats a foreign one.
			if (res.ok && isSameOriginResponse(res.url, baseOrigin)) {
				const html = await readTextCapped(res, MAX_RESPONSE_BYTES);
				// Reuse the shared scanner (also handles the createNonceMiddleware
				// and data-* forms) instead of a third copy of the nonce regex.
				const rest = typeof window !== 'undefined' ? window.WPRest : null;
				if (rest && rest.findNonceInDocument) {
					const doc = new DOMParser().parseFromString(html, 'text/html');
					nonce = rest.findNonceInDocument(doc) || null;
				} else {
					const m = html.match(/(?:wpApiSettings|_wpApiSettings)\s*=\s*\{[^}]*"nonce"\s*:\s*"([a-f0-9]+)"/);
					if (m) nonce = m[1];
				}
				if (nonce) nonceOrigin = baseOrigin;
			}
		} catch (_) { /* admin fetch failed — give up, will pass null */ }
	}

	return { tab, nonce, nonceOrigin };
}

/**
 * Resolves a template-backed view (blog index, archive) to a block-theme
 * site-editor edit URL. Returns { url, isBlockTheme } — the nonce is needed
 * because /wp/v2/themes and /wp/v2/templates are private endpoints. Falls
 * back to a null result the popup treats as "not resolvable."
 */
export async function requestTemplateEditUrl(baseUrl = null) {
	try {
		const { tab, nonce, nonceOrigin } = await resolveRestNonce(baseUrl);
		const res = await chrome.tabs.sendMessage(tab.id, { type: 'RESOLVE_TEMPLATE_EDIT_URL', nonce, nonceOrigin });
		return res || { url: null, isBlockTheme: null };
	} catch (_) {
		return { url: null, isBlockTheme: null };
	}
}

export async function requestSiteInfo(baseUrl = null) {
	try {
		const { tab, nonce, nonceOrigin } = await resolveRestNonce(baseUrl);
		const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SITE_INFO', nonce, nonceOrigin });
		return res || null;
	} catch (_) {
		return null;
	}
}

export async function requestCurrentUser(baseUrl = null) {
	try {
		const { tab, nonce, nonceOrigin } = await resolveRestNonce(baseUrl);
		// users/me?context=edit needs a valid REST nonce — cookie auth without
		// one is always rejected with a 401. Skip the doomed request when no
		// nonce could be resolved (common on logged-in frontends that don't
		// enqueue wp-api-fetch, e.g. wordpress.org). The popup's capability
		// gates are DOM-first and don't depend on this; the fetch only enriches
		// the role label / caps when a nonce is actually available.
		if (!nonce) return null;
		const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_USER', nonce, nonceOrigin });
		return res?.user || null;
	} catch (_) {
		return null;
	}
}

export async function toggleQueryMonitor() {
	try {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_QUERY_MONITOR' });
	} catch (_) {
		/* content script unreachable — nothing to toggle */
	}
}
