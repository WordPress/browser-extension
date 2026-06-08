import { useEffect, useState } from 'react';
import { Collapsible, Icon } from '@wordpress/ui';
import { chevronDown, code, mobile, update, trash, search, layout } from '@wordpress/icons';
import { ActionRow } from './ActionRow';
import { ToggleRow } from './ToggleRow';
import { InlineConfirm } from './InlineConfirm';
import { usePrefs } from '../hooks/usePrefs';
import { runAction, toggleQueryMonitor, applyBlockInspectorPref } from '../lib/actions';

const OPEN_KEY = 'wp_devtools_open';

export function DevTools({ origin, url, hasQueryMonitor = false, qmOpen = false }) {
	const [open, setOpen] = useState(false);
	const [hydrated, setHydrated] = useState(false);
	const [prefs, savePref] = usePrefs(origin);
	// Local mirror of QM panel state — `qmOpen` from props is the snapshot
	// at popup-open time; clicks update optimistically.
	const [qmChecked, setQmChecked] = useState(qmOpen);
	useEffect(() => { setQmChecked(qmOpen); }, [qmOpen]);

	useEffect(() => {
		chrome.storage.local.get(OPEN_KEY).then((data) => {
			if (data[OPEN_KEY]) setOpen(true);
			setHydrated(true);
		});
	}, []);

	const handleOpenChange = (next) => {
		setOpen(next);
		chrome.storage.local.set({ [OPEN_KEY]: next });
	};

	const toggleBlockInspector = async (enabled) => {
		await savePref('blockInspectorEnabled', enabled);
		await applyBlockInspectorPref(enabled);
	};

	// Wait for the persisted open/closed state to load so the panel doesn't
	// flicker open-then-closed.
	if (!hydrated) return null;

	return (
		<Collapsible.Root open={open} onOpenChange={handleOpenChange} className="wpd-devtools">
			<Collapsible.Trigger className="wpd-devtools__trigger">
				<span className="wpd-devtools__label-group">
					<Icon icon={code} size={16} />
					<span className="wpd-devtools__label">{chrome.i18n.getMessage('dev_tools_label') /* "Developer Tools" */}</span>
				</span>
				<span className={`wpd-devtools__chevron ${open ? 'is-open' : ''}`} aria-hidden="true">
					<Icon icon={chevronDown} size={14} />
				</span>
			</Collapsible.Trigger>
			<Collapsible.Panel className="wpd-devtools__panel">
				<div className="wpd-devtools__items">
					<ToggleRow
						icon={layout}
						label={chrome.i18n.getMessage('highlight_blocks_toggle') /* "Highlight Blocks" */}
						checked={!!prefs.blockInspectorEnabled}
						onChange={toggleBlockInspector}
					/>
					<ActionRow
						icon={mobile}
						label={chrome.i18n.getMessage('mobile_preview_action') /* "Mobile Preview" */}
						onClick={() => runAction('mobile-preview', { origin, url })}
					/>
					<ActionRow
						icon={update}
						label={chrome.i18n.getMessage('bypass_page_cache_action') /* "Bypass Page Cache" */}
						onClick={() => runAction('cachebust', { origin, url })}
					/>
					{hasQueryMonitor && (
						<ToggleRow
							icon={search}
							label={chrome.i18n.getMessage('query_monitor_toggle') /* "Query Monitor" */}
							checked={qmChecked}
							onChange={(next) => { setQmChecked(next); toggleQueryMonitor(); }}
						/>
					)}
					<InlineConfirm
						icon={trash}
						label={chrome.i18n.getMessage('clear_site_data_action') /* "Clear Site Data (Keep Login)" */}
						onConfirm={() => runAction('clear-data', { origin, url })}
						destructive
					/>
				</div>
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}