import { useEffect, useState } from 'react';

// Poll the content script for live detection until it answers or a short
// budget elapses. Content scripts inject at document_idle, so a popup opened
// mid-load on a first visit can beat the content script and get no response.
// The caller only reaches here when there's also no cached entry (a genuine
// first visit), so without this a still-silent content script reads as a
// definitive "Not a WordPress site". ~1.2s ceiling (6 × 200ms); the content
// script normally injects within a few hundred ms and answers authoritatively
// (WordPress or not) as soon as it does.
async function probeLiveDetection(tabId, isCancelled) {
	for (let i = 0; i < 6; i++) {
		await new Promise((resolve) => setTimeout(resolve, 200));
		if (isCancelled()) return null;
		try {
			const res = await chrome.tabs.sendMessage(tabId, { type: 'GET_LIVE_DETECTION' });
			if (res) return res;
		} catch (_) {
			/* content script still not injected — keep waiting */
		}
	}
	return null;
}

/**
 * Resolves the popup's view state from the active tab:
 *   1. Ask the content script for live detection (freshest context).
 *   2. Always fetch cached entry from the background (it carries host info,
 *      which the content script doesn't have).
 *   3. Reconcile — live takes priority; cached fills in the gaps.
 */
export function useDetection() {
	const [state, setState] = useState({ status: 'loading' });

	useEffect(() => {
		let cancelled = false;

		(async () => {
			try {
				const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

				if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
					if (!cancelled) setState({ status: 'unsupported' });
					return;
				}

				const url = new URL(tab.url);
				const origin = url.origin;

				// Live (content script) and cached (background) detection are
				// independent, so fetch them together rather than in series to shave a
				// message round-trip off first paint. Live rejects when the content
				// script is not injected yet; treat that as null.
				const [liveResult, cached] = await Promise.all([
					chrome.tabs.sendMessage(tab.id, { type: 'GET_LIVE_DETECTION' }).catch(() => null),
					chrome.runtime.sendMessage({ type: 'GET_CACHED_DETECTION', origin }),
				]);
				let result = liveResult;

				if (!result && cached && cached.isWordPress) {
					result = {
						url: tab.url,
						origin,
						pathname: url.pathname,
						detection: {
							isWordPress: true,
							confidence: cached.confidence,
							signals: cached.signals,
							context: {},
						},
					};
				}

				// No live answer and nothing cached: the background caches an entry
				// for every origin it sees (WordPress or not), so a null cache means
				// a genuine first visit. Combined with a silent content script, this
				// is the one case where the page is still loading and a definitive
				// "Not a WordPress site" would be a race, not a fact — poll briefly
				// for the content script's real answer before concluding.
				if (!result && !cached) {
					result = await probeLiveDetection(tab.id, () => cancelled);
				}

				if (cancelled) return;

				if (!result || !result.detection.isWordPress) {
					setState({ status: 'not-wordpress', hostname: url.hostname });
					return;
				}

				// Direct DOM probe via chrome.scripting — runs fresh in the page
				// context, bypassing whatever content script happens to be loaded
				// (which may be orphaned post-extension-reload, holding a stale
				// captured detection from before the user logged in). Cheap: one
				// IPC, a few selector lookups. Authoritative for "is the admin bar
				// actually in this DOM right now?"
				try {
					const [out] = await chrome.scripting.executeScript({
						target: { tabId: tab.id },
						func: async () => {
							// Race guard: popups opened before DOMContentLoaded see a
							// half-parsed <body>, and WordPress prints the admin bar
							// via wp_footer near the *end* of <body>. body.logged-in
							// is set on the body tag itself (parsed first), so we can
							// observe "logged in but no admin bar" purely because the
							// admin bar markup hasn't streamed in yet. Wait for the
							// body to finish parsing before probing. Cap the wait so
							// a stalled page doesn't hang the popup.
							if (document.readyState === 'loading') {
								await new Promise((resolve) => {
									const t = setTimeout(resolve, 1500);
									document.addEventListener('DOMContentLoaded', () => {
										clearTimeout(t);
										resolve();
									}, { once: true });
								});
							}
							const ab = document.getElementById('wpadminbar');
							const body = document.body;
							const bodyLoggedIn = body?.classList?.contains('logged-in') || false;
							// Site icon — same priority order and same scheme allowlist
							// as detect.js. Captured here too so the popup still has
							// it when the content script is unavailable (extension
							// reload race).
							const iconLink =
								document.querySelector('link[rel="icon"][sizes="192x192"]')
								|| document.querySelector('link[rel="apple-touch-icon"]')
								|| document.querySelector('link[rel="icon"][sizes="32x32"]');
							let siteIconUrl = null;
							if (iconLink && iconLink.getAttribute('href')) {
								try {
									const p = new URL(iconLink.href).protocol;
									if (p === 'http:' || p === 'https:' || p === 'data:') {
										siteIconUrl = iconLink.href;
									}
								} catch (_) { /* malformed href, skip */ }
							}
							const qmPanel = document.getElementById('query-monitor-main');
							// QM has two visible states: `qm-show` (full panel) and
							// `qm-peek` (mini bar at bottom). Either counts as "open."
							const qmOpen = !!qmPanel && (
								qmPanel.classList.contains('qm-show') ||
								qmPanel.classList.contains('qm-peek')
							);
							if (!ab) return {
								hasAdminBar: false,
								bodyLoggedIn,
								hasQueryMonitor: !!qmPanel,
								qmOpen,
								siteIconUrl,
							};
							const edit    = ab.querySelector('#wp-admin-bar-edit a[href]');
							const view    = ab.querySelector('#wp-admin-bar-view a[href]');
							const preview = ab.querySelector('#wp-admin-bar-preview a[href]');
							const logout  = ab.querySelector('#wp-admin-bar-logout a[href]');
							// Admin screens only (the node does not exist on the front
							// end); carries home_url — validated at point of use.
							const visitSite = ab.querySelector('#wp-admin-bar-view-site a[href]');
							const userInfoImg = ab.querySelector('#wp-admin-bar-user-info img.avatar');
							const fallbackImg = ab.querySelector('#wp-admin-bar-my-account img.avatar');
							const avatarImg = userInfoImg || fallbackImg;
							let userAvatarUrl = null;
							if (avatarImg && avatarImg.getAttribute('src')) {
								try {
									const p = new URL(avatarImg.src).protocol;
									if (p === 'http:' || p === 'https:' || p === 'data:') {
										userAvatarUrl = avatarImg.src;
									}
								} catch (_) { /* malformed avatar URL, skip */ }
							}
							const displayNameEl =
								ab.querySelector('#wp-admin-bar-user-info .display-name')
								|| ab.querySelector('#wp-admin-bar-my-account .display-name');
							const userDisplayName = (displayNameEl?.textContent || '').trim() || null;
							const editProfile = ab.querySelector('#wp-admin-bar-edit-profile a[href]');
							const isSuperAdmin = !!ab.querySelector('#wp-admin-bar-network-admin');
							const newLinks = ab.querySelectorAll('#wp-admin-bar-new-content .ab-submenu > li[id] > a[href]');
							// Same-origin + /wp-admin/ guard: hrefs come from page DOM
							// and a malicious page could fake the admin bar with
							// off-origin links the popup would then navigate to.
							const newContentItems = Array.from(newLinks).map((a) => {
								const li = a.closest('li[id]');
								const id = li ? li.id.replace(/^wp-admin-bar-new-/, '') : '';
								const label = (a.textContent || '').trim();
								if (!id || !label) return null;
								try {
									const u = new URL(a.href);
									if (u.origin !== location.origin) return null;
									// Subdir installs serve /wp-admin/ under a prefix
									// (e.g. /wordpress/wp-admin/) — match anywhere (#33).
									if (!/\/wp-admin\//.test(u.pathname)) return null;
								} catch (_) { return null; }
								return { id, label, href: a.href };
							}).filter(Boolean);
							return {
								hasAdminBar: true,
								bodyLoggedIn,
								adminBarEditHref: edit?.href || null,
								adminBarViewHref: view?.href || preview?.href || null,
								adminBarLogoutHref: logout?.href || null,
								adminBarVisitSiteHref: visitSite?.href || null,
								userAvatarUrl,
								userDisplayName,
								userEditProfileHref: editProfile?.href || null,
								isSuperAdmin,
								postStatus: view ? 'publish' : (preview ? 'draft' : null),
								newContentItems,
								hasQueryMonitor: !!qmPanel || !!ab.querySelector('#wp-admin-bar-query-monitor'),
								qmOpen,
								siteIconUrl,
							};
						},
					});
					const live = out?.result;
					if (live) {
						const lc = result.detection.context;
						// `bodyLoggedIn` reflects WP's `body.logged-in` body class —
						// i.e., the page render came from an authenticated request.
						// Distinct from `isLoggedIn`, which can be true via the
						// cookie API even when the page DOM is logged-out HTML.
						lc.bodyLoggedIn = !!live.bodyLoggedIn;
						if (live.siteIconUrl) lc.siteIconUrl = live.siteIconUrl;
						if (live.hasAdminBar) {
							lc.hasAdminBar = true;
							lc.isLoggedIn = true;
							if (live.adminBarEditHref) lc.adminBarEditHref = live.adminBarEditHref;
							if (live.adminBarViewHref) lc.adminBarViewHref = live.adminBarViewHref;
							if (live.adminBarLogoutHref) lc.adminBarLogoutHref = live.adminBarLogoutHref;
							if (live.adminBarVisitSiteHref) lc.adminBarVisitSiteHref = live.adminBarVisitSiteHref;
							if (live.userAvatarUrl) lc.userAvatarUrl = live.userAvatarUrl;
							if (live.userDisplayName) lc.userDisplayName = live.userDisplayName;
							if (live.userEditProfileHref) lc.userEditProfileHref = live.userEditProfileHref;
							lc.isSuperAdmin = !!live.isSuperAdmin;
							if (live.postStatus) lc.postStatus = live.postStatus;
							if (live.newContentItems?.length) lc.newContentItems = live.newContentItems;
							if (live.hasQueryMonitor) lc.hasQueryMonitor = true;
							lc.qmOpen = !!live.qmOpen;
						} else if (live.bodyLoggedIn) {
							lc.isLoggedIn = true;
						}
					}
				} catch (_) { /* page disallows scripting (chrome://, etc.) */ }

				// Cookie-API check — for cases where even the live DOM doesn't have
				// the admin bar (BFCache restore, page-cached HTML for a freshly
				// authenticated user). Reads the HttpOnly `wordpress_logged_in_<hash>`
				// cookie that document.cookie can't see.
				let loggedInByCookie = false;
				if (!result.detection.context.isLoggedIn) {
					try {
						const cookies = await chrome.cookies.getAll({ url: tab.url });
						if (cookies.some((c) => /^wordpress_logged_in_/.test(c.name))) {
							result.detection.context.isLoggedIn = true;
							loggedInByCookie = true;
						}
					} catch (_) { /* cookies permission unavailable */ }
				}

				if (cancelled) return;

				// Push the popup's final resolution back to the background so the
				// toolbar icon and cache reflect any login override that DOM-based
				// detection missed (cookie API). Fire-and-forget.
				chrome.runtime.sendMessage({
					type: 'POPUP_DETECTION_RESOLVED',
					origin,
					tabId: tab.id,
					isWordPress: true,
					isLoggedIn: !!result.detection.context.isLoggedIn,
					baseUrl: result.detection.context.baseUrl || null,
					siteIconUrl: result.detection.context.siteIconUrl || null,
				}).catch(() => {});

				// Render now with what we have. The fresh-fetch below can take
				// hundreds of ms (full HTTP fetch + HTML parse) and was previously
				// blocking this render — kicked off in the background instead so
				// the popup appears instantly.
				const host = cached?.host || null;
				setState({ status: 'detected', result, host });

				// Body class says logged-out but cookie says logged-in: the page
				// is BFCache-restored or page-cached HTML from a logged-out
				// request. Re-fetch with credentials and merge admin-bar-derived
				// fields (edit href, +New menu, sign-out nonce, etc.) so the
				// popup gets richer over time. We don't overwrite hasAdminBar —
				// the live DOM still lacks the bar.
				if (loggedInByCookie && !result.detection.context.hasAdminBar) {
					try {
						const fresh = await Promise.race([
							chrome.tabs.sendMessage(tab.id, { type: 'GET_FRESH_DETECTION' }),
							new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
						]);
						if (cancelled) return;
						const fc = fresh?.detection?.context;
						if (fresh?.detection?.isWordPress && fc && !fc.isLoggedIn) {
							// The credentialed re-fetch came back as logged-out HTML:
							// the cookie that asserted login is stale (expired or
							// invalidated session), and this is what the user actually
							// gets from the site. Downgrade instead of enriching, and
							// re-push the resolution so the cache and toolbar icon
							// correct immediately too (#59). A null/failed fresh fetch
							// never lands here — no downgrade without fresh evidence.
							const lc = result.detection.context;
							lc.isLoggedIn = false;
							chrome.runtime.sendMessage({
								type: 'POPUP_DETECTION_RESOLVED',
								origin,
								tabId: tab.id,
								isWordPress: true,
								isLoggedIn: false,
								baseUrl: lc.baseUrl || null,
								siteIconUrl: lc.siteIconUrl || null,
							}).catch(() => {});
							setState({
								status: 'detected',
								result: {
									...result,
									detection: { ...result.detection, context: { ...lc } },
								},
								host,
							});
						} else if (fc) {
							// Merge fresh fields in, then setState a deep-cloned context:
							// a shallow { ...result } reuses detection.context, so
							// ctx-keyed useMemo caches (e.g. the Edit URL) stay stale.
							const lc = result.detection.context;
							if (fc.adminBarEditHref) lc.adminBarEditHref = fc.adminBarEditHref;
							if (fc.adminBarViewHref) lc.adminBarViewHref = fc.adminBarViewHref;
							if (fc.adminBarLogoutHref) lc.adminBarLogoutHref = fc.adminBarLogoutHref;
							if (fc.adminBarVisitSiteHref) lc.adminBarVisitSiteHref = fc.adminBarVisitSiteHref;
							if (fc.userAvatarUrl) lc.userAvatarUrl = fc.userAvatarUrl;
							if (fc.userDisplayName) lc.userDisplayName = fc.userDisplayName;
							if (fc.userEditProfileHref) lc.userEditProfileHref = fc.userEditProfileHref;
							lc.isSuperAdmin = !!fc.isSuperAdmin;
							if (fc.postStatus) lc.postStatus = fc.postStatus;
							if (fc.updateCount != null) lc.updateCount = fc.updateCount;
							if (fc.commentCount != null) lc.commentCount = fc.commentCount;
							if (fc.newContentItems?.length) lc.newContentItems = fc.newContentItems;
							if (fc.hasQueryMonitor) lc.hasQueryMonitor = true;
							setState({
								status: 'detected',
								result: {
									...result,
									detection: { ...result.detection, context: { ...lc } },
								},
								host,
							});
						}
					} catch (_) { /* fresh fetch failed; partial state retained */ }
				}
			} catch (err) {
				console.error('WordPress Browser Extension popup error:', err);
				if (!cancelled) setState({ status: 'error' });
			}
		})();

		return () => {
			cancelled = true;
		};
	}, []);

	return state;
}
