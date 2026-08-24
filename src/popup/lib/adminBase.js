/**
 * Cache-only fallback for the popup (#88): when the content script is
 * orphaned (extension reloaded or updated under an already-open tab), the
 * popup synthesizes its context from the detection cache, which carries no
 * install base — and synthesized admin links collapsed to the bare origin
 * on subdirectory installs. If the direct DOM probe confirms the page is a
 * real admin document (body.wp-admin plus #wpwrap), recover the base from the
 * tab's own pathname using lib/detect.js's rules — segment-exact wp-admin,
 * encoded slashes fail closed, trailing slash runs trimmed, same-origin
 * enforced. A public URL that merely contains /wp-admin/ never derives
 * (the isAdminDoc gate).
 *
 * Returns `{ baseUrl, evidence }` — deriveBase's own provenance, passed
 * through rather than re-inferred, so the background's My Sites gate can tell
 * a root install confirmed by its admin path from the bare-origin fallback
 * (#103). Null when ungated or unavailable.
 */
export function adminBaseFromProbe(origin, pathname, isAdminDoc) {
	const detect = typeof window !== 'undefined' ? window.WPDetect : null;
	if (!isAdminDoc || !detect || typeof detect.deriveBase !== 'function') return null;
	return detect.deriveBase(origin, null, pathname);
}

/**
 * Reconcile the probe derivation against a context's current base, returning
 * `{ baseUrl, evidence }` to apply or null to leave the context untouched.
 *
 * Two shapes need it (#103): a cache-synthesized context with no base at all
 * (#88 — adopt the derivation), and a context from an orphaned 1.0.2 content
 * script, which always carries a base (deriveBaseUrl never returned null)
 * but predates the evidence field — for those, derive from the tab and
 * upgrade the evidence ONLY when the derived base agrees with the stored one
 * (canonical form, so a trailing slash doesn't block it). A disagreeing
 * derivation never replaces a stored base, and a context that already
 * carries evidence is never rewritten.
 */
export function reconcileProbeBase(currentBaseUrl, currentEvidence, origin, pathname, isAdminDoc) {
	if (currentBaseUrl && currentEvidence != null) return null;
	const derived = adminBaseFromProbe(origin, pathname, isAdminDoc);
	if (!derived) return null;
	if (!currentBaseUrl) return derived;
	const canon = (s) => String(s).replace(/\/+$/, '');
	return canon(currentBaseUrl) === canon(derived.baseUrl) ? derived : null;
}

/**
 * Is the probed document the tab the popup captured? The probe runs after
 * async work, so the tab can have navigated since its URL was captured — in
 * which case the probe's DOM facts describe a different document and must be
 * discarded (#103 review). Same origin and pathname is a match; query and
 * hash may differ (wp-admin navigates list tables by query string within one
 * document path). Unparsable input never matches.
 */
export function probeMatchesTab(probeHref, tabUrl) {
	try {
		const p = new URL(probeHref);
		const t = new URL(tabUrl);
		return p.origin === t.origin && p.pathname === t.pathname;
	} catch (_) {
		return false;
	}
}
