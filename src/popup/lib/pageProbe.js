/**
 * The popup's direct DOM probe, injected with chrome.scripting.executeScript.
 *
 * SELF-CONTAINED BY CONTRACT: executeScript serializes this function and runs
 * it in the page, so its body may reference only page globals (document,
 * location) — never imports or anything from this module's scope. It lives in
 * its own module (rather than inline in useDetection) so tests can drive it
 * against a real DOM.
 *
 * Reports `href` — the probed document's own URL — so the caller can tell
 * whether the tab navigated between capturing its URL and the probe running,
 * and discard results that describe a different document (#103 review).
 */
export const probePageState = async () => {
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
	const href = location.href;
	const ab = document.getElementById('wpadminbar');
	const body = document.body;
	const bodyLoggedIn = body?.classList?.contains('logged-in') || false;
	// An admin document is body.wp-admin AND #wpwrap — the same gate
	// lib/detect.js uses before trusting the pathname (#88). Both are
	// printed by wp-admin/admin-header.php on every core admin screen;
	// the body class alone is too easy for a theme to emit.
	const bodyAdmin = (body?.classList?.contains('wp-admin')
		&& !!document.getElementById('wpwrap')) || false;
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
		href,
		hasAdminBar: false,
		bodyLoggedIn,
		bodyAdmin,
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
		href,
		hasAdminBar: true,
		bodyLoggedIn,
		bodyAdmin,
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
};
