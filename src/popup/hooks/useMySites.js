import { useCallback, useEffect, useState } from 'react';

// lib/my-sites.js is loaded as a classic script (window.WPMySites), shared with
// the background. Returns null when unavailable (e.g. the dev preview without
// the shim) so callers can no-op.
function wpMySites() {
	return typeof window !== 'undefined' ? window.WPMySites : null;
}

const STORE_KEY = 'wp_my_sites_v1';

/**
 * Reads the persistent "My Sites" store and exposes curation actions. Stays in
 * sync if the background adds a site (or another popup edits the list) via
 * chrome.storage.onChanged. `ready` is false until the first read resolves so
 * the section can stay hidden rather than flash empty.
 */
export function useMySites() {
	const [store, setStore] = useState(null);

	// Canonicalize the snapshot on read: migrateStore (pure, same-reference
	// no-op on already-canonical stores) re-keys any pre-#94 origin-keyed
	// records in memory, so every key this hook renders and sends is the
	// canonical install-base key the background's own migrate-before-write
	// produces. The popup never writes the migrated result itself — the
	// background stays the single writer.
	const canonicalize = (raw) => {
		const lib = wpMySites();
		return lib ? lib.migrateStore(raw) : raw;
	};

	useEffect(() => {
		let cancelled = false;
		chrome.storage?.local?.get(STORE_KEY).then((data) => {
			if (!cancelled) setStore(canonicalize(data?.[STORE_KEY] || {}));
		});
		const onChanged = (changes, area) => {
			if (area === 'local' && changes[STORE_KEY]) {
				setStore(canonicalize(changes[STORE_KEY].newValue || {}));
			}
		};
		chrome.storage?.onChanged?.addListener(onChanged);
		return () => {
			cancelled = true;
			chrome.storage?.onChanged?.removeListener(onChanged);
		};
	}, []);

	// Curation edits update local state optimistically, but the storage write
	// happens in the background worker, which serializes mutations of the
	// shared store — a login recorded while the popup edits would otherwise
	// race this write and one of the two would be lost. The onChanged
	// listener above reconciles state with whatever the background persists.
	const sendMutation = (payload) => {
		try {
			const p = chrome.runtime?.sendMessage?.({ type: 'MUTATE_MY_SITES', ...payload });
			if (p && typeof p.catch === 'function') p.catch(() => {});
		} catch (_) {
			/* background unreachable (dev preview) — optimistic state stands */
		}
	};

	// `key` is the record's canonical store key as reported by listSites over
	// the canonicalized snapshot above; the background migrates before
	// applying, so the same key addresses the record on both sides.
	const remove = useCallback((key) => {
		const lib = wpMySites();
		setStore((cur) => (lib && cur ? lib.removeSite(cur, key) : cur));
		sendMutation({ op: 'remove', key });
	}, []);

	const rename = useCallback((key, name) => {
		const lib = wpMySites();
		setStore((cur) => (lib && cur ? lib.renameSite(cur, key, name) : cur));
		sendMutation({ op: 'rename', key, name });
	}, []);

	const lib = wpMySites();
	const sites = lib && store ? lib.listSites(store) : [];

	return {
		sites,
		remove,
		rename,
		ready: store !== null,
		displayName: lib?.displayName,
		defaultLabel: lib?.defaultLabel,
	};
}
