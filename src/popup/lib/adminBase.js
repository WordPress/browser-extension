/**
 * Cache-only fallback for the popup (#88): when the content script is
 * orphaned (extension reloaded or updated under an already-open tab), the
 * popup synthesizes its context from the detection cache, which carries no
 * install base — and synthesized admin links collapsed to the bare origin
 * on subdirectory installs. If the direct DOM probe confirms the page is a
 * real admin document (body.wp-admin), recover the base from the tab's own
 * pathname using lib/detect.js's rules — final segment-exact wp-admin,
 * encoded slashes fail closed, trailing slash runs trimmed, same-origin
 * enforced. A public URL that merely contains /wp-admin/ never derives
 * (the isAdminDoc gate). Returns null when ungated or unavailable.
 */
export function adminBaseFromProbe(origin, pathname, isAdminDoc) {
	const detect = typeof window !== 'undefined' ? window.WPDetect : null;
	if (!isAdminDoc || !detect || typeof detect.deriveBaseUrl !== 'function') return null;
	return detect.deriveBaseUrl(origin, null, pathname);
}
