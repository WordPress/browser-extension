import { useCallback, useEffect, useState } from 'react';

const PREFS_KEY = 'wp_preferences_v1';
const GLOBAL_NS = '_global';
const DEFAULT_PREFS = { adminBarHidden: false, blockInspectorEnabled: false, siteInfoEnabled: false };

// Per-origin pref wins. Falls back to whatever the global namespace sets on
// the options page; falls back to the hard-coded defaults if neither exists.
function mergePrefs(globalPrefs, originPrefs) {
	return { ...DEFAULT_PREFS, ...globalPrefs, ...originPrefs };
}

export function usePrefs(origin) {
	// `ready` flips once the stored values have actually been read. Consumers
	// rendering animated state (the toggle switches) use it to keep the
	// settle from defaults to stored values from playing as a transition.
	const [state, setState] = useState({ prefs: DEFAULT_PREFS, ready: false });
	const prefs = state.prefs;
	const setPrefs = (updater) =>
		setState((prev) => ({
			...prev,
			prefs: typeof updater === 'function' ? updater(prev.prefs) : updater,
		}));

	useEffect(() => {
		if (!origin) return;
		(async () => {
			const data = await chrome.storage.local.get(PREFS_KEY);
			const all = data[PREFS_KEY] || {};
			setState({ prefs: mergePrefs(all[GLOBAL_NS] || {}, all[origin] || {}), ready: true });
		})();
	}, [origin]);

	const savePref = useCallback(
		async (key, value) => {
			setPrefs((prev) => ({ ...prev, [key]: value }));
			// The write goes through the background worker, which serializes
			// mutations of the shared preferences object — a second popup
			// instance or the options page writing concurrently would
			// otherwise clobber this update (or be clobbered by it).
			try {
				await chrome.runtime.sendMessage({ type: 'MUTATE_PREF', ns: origin, key, value });
			} catch (_) {
				/* background unreachable (dev preview) — optimistic state stands */
			}
		},
		[origin],
	);

	return [prefs, savePref, state.ready];
}
