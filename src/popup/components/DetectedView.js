import { useEffect, useMemo, useState } from 'react';
import {
	pencil,
	seen,
	globe,
	dashboard,
	key,
	keyboardReturn,
} from '@wordpress/icons';
import { Header } from './Header';
import { ActionRow } from './ActionRow';
import { ToggleRow } from './ToggleRow';
import { DevTools } from './DevTools';
import { NewContent } from './NewContent';
import { SiteInfoPanel } from './SiteInfoPanel';
import { usePrefs } from '../hooks/usePrefs';
import { runAction, applyAdminBarPref, requestRestEditUrl } from '../lib/actions';
import { editLabel, editDisabledLabel, postTypeLabel } from '../lib/labels';

export function DetectedView({ result, host }) {
	const { detection, origin, url } = result;
	const ctx = detection.context || {};
	const isLoggedIn = !!ctx.isLoggedIn;
	const hostname = useMemo(() => new URL(origin).hostname, [origin]);
	const isWpAdmin = useMemo(() => /\/wp-admin(\/|$)/.test(new URL(url).pathname), [url]);
	const [prefs] = usePrefs(origin);

	const openInNewTab = (url) => {
		chrome.tabs.create({ url });
		window.close();
	};

	const openUrl = (url, newTab = false) => {
		if (newTab) chrome.tabs.create({ url });
		else chrome.tabs.update({ url });
		window.close();
	};

	return (
		<>
			<Header
				hostname={hostname}
				host={host}
				wpVersion={ctx.generatorVersion || null}
				loggedIn={isLoggedIn}
				origin={origin}
				url={url}
				updateCount={ctx.updateCount || null}
				commentCount={ctx.commentCount || null}
				siteIconUrl={ctx.siteIconUrl || null}
				userAvatarUrl={ctx.userAvatarUrl || null}
				userDisplayName={ctx.userDisplayName || null}
				userEditProfileHref={ctx.userEditProfileHref || null}
				isSuperAdmin={!!ctx.isSuperAdmin}
				logoutUrl={ctx.adminBarLogoutHref || null}
				onOpen={openInNewTab}
			/>
			<Section>
				{isLoggedIn ? (
					isWpAdmin ? (
						<WpAdminActions ctx={ctx} origin={origin} url={url} />
					) : (
						<FrontendLoggedInActions ctx={ctx} origin={origin} url={url} />
					)
				) : (
					<LoggedOutActions origin={origin} url={url} />
				)}
			</Section>
			{isLoggedIn && ctx.newContentItems?.length > 0 && (
				<NewContent items={ctx.newContentItems} onOpen={openUrl} />
			)}
			{prefs.siteInfoEnabled && (
				<SiteInfoPanel ctx={ctx} origin={origin} onOpen={openUrl} />
			)}
			{!isWpAdmin && (
				<DevTools origin={origin} url={url} hasQueryMonitor={!!ctx.hasQueryMonitor} qmOpen={!!ctx.qmOpen} />
			)}
		</>
	);
}

function Section({ children }) {
	return (
		<div className="wpd-section">
			<div className="wpd-section__items">{children}</div>
		</div>
	);
}

function WpAdminActions({ ctx, origin, url }) {
	// If the admin bar has a view/preview link, the user is on an edit screen.
	// WordPress provides the correct URL — including the preview nonce for
	// drafts — so we use it directly.
	const viewHrefSafe = (() => {
		if (!ctx.adminBarViewHref) return null;
		try {
			return new URL(ctx.adminBarViewHref).origin === origin ? ctx.adminBarViewHref : null;
		} catch (_) {
			return null;
		}
	})();

	const typeLabel = ctx.postType ? postTypeLabel(ctx.postType) : chrome.i18n.getMessage('post_type_page'); // "Page"
	const verb = chrome.i18n.getMessage(ctx.postStatus === 'publish' ? 'verb_view' : 'verb_preview'); // "View" / "Preview"

	return (
		<>
			{viewHrefSafe && (
				<ActionRow
					icon={seen}
					label={`${verb} ${typeLabel}`}
					onClick={() => runAction('view-post', { origin, url, viewUrl: viewHrefSafe })}
					onNewTab={() =>
						runAction('view-post', { origin, url, viewUrl: viewHrefSafe, newTab: true })
					}
					copyUrl={viewHrefSafe}
				/>
			)}
			<ActionRow
				icon={globe}
				label={chrome.i18n.getMessage('visit_site') /* "Visit Site" */}
				onClick={() => runAction('visit-site', { origin, url })}
				onNewTab={() => runAction('visit-site', { origin, url, newTab: true })}
			/>
			<ActionRow
				icon={dashboard}
				label={chrome.i18n.getMessage('wordpress_admin') /* "WordPress Admin" */}
				onClick={() => runAction('admin', { origin, url })}
				onNewTab={() => runAction('admin', { origin, url, newTab: true })}
			/>
		</>
	);
}

function FrontendLoggedInActions({ ctx, origin, url }) {
	const [prefs, savePref] = usePrefs(origin);
	const { editUrl, resolving } = useEditUrlResolution(ctx, origin);

	const isMac = typeof navigator !== 'undefined' && navigator.platform?.startsWith('Mac');
	const shortcutHint = isMac ? 'Alt⇧E' : 'Alt+Shift+E';

	const toggleAdminBar = async (show) => {
		const hidden = !show;
		await savePref('adminBarHidden', hidden);
		await applyAdminBarPref(hidden);
	};

	const editActionEnabled = !!editUrl;
	const editActionLabel = editActionEnabled
		? editLabel(ctx, true)
		: resolving
			? editLabel(ctx, true)
			: editDisabledLabel(ctx);

	return (
		<>
			<ActionRow
				icon={pencil}
				label={editActionLabel}
				hint={resolving ? null : shortcutHint}
				loading={resolving}
				disabled={!editActionEnabled}
				onClick={() => runAction('edit', { origin, url, editUrl })}
				onNewTab={() => runAction('edit', { origin, url, editUrl, newTab: true })}
				copyUrl={editActionEnabled ? editUrl : null}
			/>
			<ActionRow
				icon={dashboard}
				label={chrome.i18n.getMessage('wordpress_admin') /* "WordPress Admin" */}
				onClick={() => runAction('admin', { origin, url })}
				onNewTab={() => runAction('admin', { origin, url, newTab: true })}
			/>
			<AdminBarSection ctx={ctx} origin={origin} prefs={prefs} onToggle={toggleAdminBar} />
		</>
	);
}

function LoggedOutActions({ origin, url }) {
	return (
		<>
			<ActionRow
				icon={key}
				label={chrome.i18n.getMessage('log_in') /* "Log In" */}
				onClick={() => runAction('login', { origin, url })}
				onNewTab={() => runAction('login', { origin, url, newTab: true })}
			/>
			<ActionRow
				icon={keyboardReturn}
				label={chrome.i18n.getMessage('log_in_return') /* "Log In, Return to Page" */}
				onClick={() => runAction('login-return', { origin, url })}
				onNewTab={() => runAction('login-return', { origin, url, newTab: true })}
			/>
		</>
	);
}

function AdminBarSection({ ctx, origin, prefs, onToggle }) {
	if (ctx.hasAdminBar) {
		return <ToggleRow icon={seen} label={chrome.i18n.getMessage('show_admin_bar') /* "Show Admin Bar" */} checked={!prefs.adminBarHidden} onChange={onToggle} />;
	}
	// Logged-in but no admin bar — could be a profile preference, a theme
	// filter (show_admin_bar(false) or unhooking wp_admin_bar_render), or
	// stale page-cached HTML. The user-visible copy names the two common
	// causes; "appears" hedges honestly across all cases.
	return (
		<>
			<ToggleRow icon={seen} label={chrome.i18n.getMessage('show_admin_bar') /* "Show Admin Bar" */} checked={false} disabled />
			<div className="wpd-toggle-hint">
				{chrome.i18n.getMessage('admin_bar_disabled_info') /* "Admin bar appears to be disabled by your profile or theme, which limits this extension." */}{' '}
				<button
					type="button"
					className="wpd-info-row__link"
					onClick={() => runAction('profile', { origin, url: '' })}
				>
					{chrome.i18n.getMessage('check_profile_link') /* "Check profile →" */}
				</button>
			</div>
		</>
	);
}

/**
 * Two-tier resolution: synchronous first (instant), then REST if the ctx has
 * slugs we can look up. While REST is in flight we expose `resolving: true`
 * so the UI can show a loading state.
 */
function useEditUrlResolution(ctx, origin) {
	const syncUrl = useMemo(() => {
		const wpRest = typeof window !== 'undefined' ? window.WPRest : null;
		return wpRest ? wpRest.resolveEditUrlSync(ctx, origin) : null;
	}, [ctx, origin]);

	const canResolveAsync = useMemo(() => {
		const wpRest = typeof window !== 'undefined' ? window.WPRest : null;
		return wpRest ? wpRest.canResolveViaRest(ctx) : false;
	}, [ctx]);

	const [asyncUrl, setAsyncUrl] = useState(null);
	const [asyncAttempted, setAsyncAttempted] = useState(false);
	const needsAsync = !syncUrl && canResolveAsync;

	useEffect(() => {
		if (!needsAsync || asyncAttempted) return;
		let cancelled = false;
		(async () => {
			const resolved = await requestRestEditUrl();
			if (cancelled) return;
			setAsyncUrl(resolved);
			setAsyncAttempted(true);
		})();
		return () => {
			cancelled = true;
		};
	}, [needsAsync, asyncAttempted]);

	return {
		editUrl: syncUrl || asyncUrl || null,
		resolving: needsAsync && !asyncAttempted,
	};
}
