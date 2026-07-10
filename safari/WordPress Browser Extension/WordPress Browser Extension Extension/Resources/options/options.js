/**
 * Reads and writes the browser-wide defaults that live alongside the
 * per-origin preferences in `wp_preferences_v1._global`. Per-origin
 * values always win over these defaults; this page only affects sites
 * the user has not explicitly toggled.
 */

function localizeUI() {
	document.querySelectorAll('[data-i18n]').forEach((el) => {
		const msg = chrome.i18n.getMessage(el.dataset.i18n);
		if (msg) el.textContent = msg;
	});
}
localizeUI();

const PREFS_KEY = 'wp_preferences_v1';
const GLOBAL_NS = '_global';

const adminBarToggle = document.getElementById('adminBarHiddenDefault');
const listViewDefaultToggle = document.getElementById('listViewDefaultEnabled');
const siteInfoToggle = document.getElementById('siteInfoEnabled');
const resetButton = document.getElementById('resetData');
const resetStatus = document.getElementById('resetStatus');

async function loadGlobalPrefs() {
	try {
		const data = await chrome.storage.local.get(PREFS_KEY);
		return (data[PREFS_KEY] || {})[GLOBAL_NS] || {};
	} catch (_) {
		return {};
	}
}

async function saveGlobalPref(key, value) {
	try {
		// Routed through the background worker, which serializes writes to the
		// shared preferences object — a popup toggle racing this write would
		// otherwise lose one of the two updates.
		await chrome.runtime.sendMessage({ type: 'MUTATE_PREF', ns: GLOBAL_NS, key, value });
	} catch (_) { /* background unreachable; UI stays unsynced until next reload */ }
}

(async () => {
	const globalPrefs = await loadGlobalPrefs();
	adminBarToggle.checked = globalPrefs.adminBarHidden === true;
	listViewDefaultToggle.checked = globalPrefs.listViewDefaultEnabled === true;
	siteInfoToggle.checked = globalPrefs.siteInfoEnabled === true;

	adminBarToggle.addEventListener('change', () => {
		saveGlobalPref('adminBarHidden', adminBarToggle.checked);
	});

	listViewDefaultToggle.addEventListener('change', () => {
		saveGlobalPref('listViewDefaultEnabled', listViewDefaultToggle.checked);
	});

	siteInfoToggle.addEventListener('change', () => {
		saveGlobalPref('siteInfoEnabled', siteInfoToggle.checked);
	});

	// Reflect changes that arrive from another tab or context.
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== 'local' || !changes[PREFS_KEY]) return;
		const incoming = (changes[PREFS_KEY].newValue || {})[GLOBAL_NS] || {};
		adminBarToggle.checked = incoming.adminBarHidden === true;
		listViewDefaultToggle.checked = incoming.listViewDefaultEnabled === true;
		siteInfoToggle.checked = incoming.siteInfoEnabled === true;
	});

	resetButton.addEventListener('click', async () => {
		const ok = window.confirm(chrome.i18n.getMessage('options_clear_confirm')); // "Clear all extension data?\n\nThis removes every saved per-site preference, the global defaults on this page, and the cached WordPress detection results. Cannot be undone."
		if (!ok) return;
		try {
			// Everything in local storage belongs to this extension — per-site
			// prefs, global defaults, detection cache, My Sites, and the DevTools
			// accordion state (wp_devtools_open). A full clear can't silently miss
			// a new key the way the old explicit allowlist did (it left
			// wp_devtools_open behind).
			await chrome.storage.local.clear();
			adminBarToggle.checked = false;
			listViewDefaultToggle.checked = false;
			siteInfoToggle.checked = false;
			resetStatus.textContent = chrome.i18n.getMessage('options_cleared_success'); // "Cleared."
			resetStatus.dataset.tone = 'ok';
		} catch (_) {
			resetStatus.textContent = chrome.i18n.getMessage('options_cleared_error'); // "Could not clear data. Try again."
			resetStatus.dataset.tone = 'error';
		}
		setTimeout(() => {
			resetStatus.textContent = '';
			delete resetStatus.dataset.tone;
		}, 4000);
	});
})();
