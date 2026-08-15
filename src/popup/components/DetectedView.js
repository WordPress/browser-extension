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
import { useCurrentUser } from '../hooks/useCurrentUser';
import { runAction, applyAdminBarPref, requestRestEditUrl, requestTemplateEditUrl } from '../lib/actions';
import { editLabel, editDisabledLabel, postTypeLabel } from '../lib/labels';

export function DetectedView({ result, host }) {
	const { detection, origin, url } = result;
	const ctx = detection.context || {};
	// Path-aware install base — carries any subdirectory prefix so every
	// synthesized admin/login link resolves correctly (issue #33). Falls
	// back to the origin for root installs or cache-only detections that
	// predate the field. `origin` is kept separately for same-origin
	// security checks on DOM-sourced hrefs.
	const baseUrl = ctx.baseUrl || origin;
	const isLoggedIn = !!ctx.isLoggedIn;
	const hostname = useMemo(() => new URL(origin).hostname, [origin]);
	const isWpAdmin = useMemo(() => /\/wp-admin(\/|$)/.test(new URL(url).pathname), [url]);
	const [prefs] = usePrefs(origin);
	// Fetched once here and shared with the header's role label and the
	// capability gates below, so the popup makes a single users/me request.
	// baseUrl is threaded so the nonce-fetch fallback respects a subdirectory
	// install (issue #33).
	const user = useCurrentUser(isLoggedIn, baseUrl);

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
				baseUrl={baseUrl}
				url={url}
				updateCount={ctx.updateCount || null}
				commentCount={ctx.commentCount || null}
				siteIconUrl={ctx.siteIconUrl || null}
				userAvatarUrl={ctx.userAvatarUrl || null}
				userDisplayName={ctx.userDisplayName || null}
				userEditProfileHref={ctx.userEditProfileHref || null}
				isSuperAdmin={!!ctx.isSuperAdmin}
				logoutUrl={ctx.adminBarLogoutHref || null}
				user={user}
				onOpen={openInNewTab}
			/>
			<Section>
				{isLoggedIn ? (
					isWpAdmin ? (
						<WpAdminActions ctx={ctx} origin={origin} baseUrl={baseUrl} url={url} user={user} />
					) : (
						<FrontendLoggedInActions ctx={ctx} origin={origin} baseUrl={baseUrl} url={url} user={user} />
					)
				) : (
					<LoggedOutActions origin={origin} baseUrl={baseUrl} url={url} />
				)}
			</Section>
			{isLoggedIn && ctx.newContentItems?.length > 0 && (
				<NewContent items={ctx.newContentItems} onOpen={openUrl} />
			)}
			{prefs.siteInfoEnabled && (
				<SiteInfoPanel ctx={ctx} origin={origin} baseUrl={baseUrl} onOpen={openUrl} />
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

// lib/rest.js is loaded as a classic script in popup.html, exposing its API
// on window.WPRest. Helpers return null ("unknown") when it isn't available.
function wpRest() {
	return typeof window !== 'undefined' ? window.WPRest : null;
}

// Disable "WordPress Admin" only when we definitively know the user can't
// reach wp-admin (false). null/true keep it enabled.
function useAdminEnabled(ctx, user) {
	return useMemo(() => {
		const rest = wpRest();
		return rest ? rest.canAccessAdmin(ctx, user) !== false : true;
	}, [ctx, user]);
}

function WpAdminActions({ ctx, origin, baseUrl, url, user }) {
	const adminEnabled = useAdminEnabled(ctx, user);
	// If the admin bar has a view/preview link, the user is on an edit screen.
	// WordPress provides the correct URL — including the preview nonce for
	// drafts — so we use it directly.
	const viewHrefSafe = (() => {
		if (!ctx.adminBarViewHref) return null;
		try {
			const u = new URL(ctx.adminBarViewHref);
			// Same-origin AND http(s) — a spoofed admin bar can't steer View/Preview
			// (or its Copy URL) at a javascript:/data: target.
			const okScheme = u.protocol === 'http:' || u.protocol === 'https:';
			return okScheme && u.origin === origin ? ctx.adminBarViewHref : null;
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
				onClick={() => runAction('visit-site', { origin, baseUrl, url, visitUrl: ctx.adminBarVisitSiteHref })}
				onNewTab={() => runAction('visit-site', { origin, baseUrl, url, visitUrl: ctx.adminBarVisitSiteHref, newTab: true })}
			/>
			<ActionRow
				icon={dashboard}
				label={chrome.i18n.getMessage('wordpress_admin') /* "WordPress Admin" */}
				disabled={!adminEnabled}
				onClick={() => runAction('admin', { origin, baseUrl, url })}
				onNewTab={() => runAction('admin', { origin, baseUrl, url, newTab: true })}
			/>
		</>
	);
}

const IS_MAC = typeof navigator !== 'undefined' && navigator.platform?.startsWith('Mac');

const MAC_GLYPHS = {
	command: '⌘', cmd: '⌘',
	alt: '⌥', option: '⌥',
	ctrl: '⌃', control: '⌃', macctrl: '⌃',
	shift: '⇧',
};

// Safari reports the raw "Alt+Shift+E" spelling on macOS, which reads as a
// Windows binding there. Splitting on "+" rather than substring-replacing keeps
// "MacCtrl" from being mangled into "Mac⌃", and leaves a value that is already
// glyphs (Chrome's) untouched, since it has no "+" to split on.
function toMacGlyphs(shortcut) {
	return shortcut
		.split('+')
		.map((part) => MAC_GLYPHS[part.trim().toLowerCase()] ?? part.trim())
		.join('');
}

// Live binding for the edit-this-page command. Users can rebind or clear it
// at chrome://extensions/shortcuts. The static suggested-key hint is only the
// fallback for when the API is unavailable (dev preview); a binding the user
// cleared shows no hint rather than a false one.
function useEditShortcutHint() {
	const fallback = IS_MAC ? '⌥⇧E' : 'Alt+Shift+E';
	const [hint, setHint] = useState(fallback);
	useEffect(() => {
		let cancelled = false;
		try {
			chrome.commands?.getAll?.((commands) => {
				if (cancelled || !Array.isArray(commands)) return;
				const cmd = commands.find((c) => c.name === 'edit-this-page');
				if (!cmd) return;
				const shortcut = cmd.shortcut || null;
				setHint(shortcut && IS_MAC ? toMacGlyphs(shortcut) : shortcut);
			});
		} catch (_) {
			/* commands API unavailable — keep the suggested-key fallback */
		}
		return () => {
			cancelled = true;
		};
	}, []);
	return hint;
}

function FrontendLoggedInActions({ ctx, origin, baseUrl, url, user }) {
	const [prefs, savePref, prefsReady] = usePrefs(origin);
	const { editUrl, resolving, isBlockTheme } = useEditUrlResolution(ctx, origin);
	const adminEnabled = useAdminEnabled(ctx, user);
	// false = the user definitively can't edit this object; null/true (unknown
	// or allowed) leave the action enabled so a missing nonce never hides it.
	const editCapAllowed = useMemo(() => {
		const rest = wpRest();
		return rest ? rest.canEditCurrent(ctx, user) !== false : true;
	}, [ctx, user]);

	const shortcutHint = useEditShortcutHint();

	const toggleAdminBar = async (show) => {
		const hidden = !show;
		await savePref('adminBarHidden', hidden);
		await applyAdminBarPref(hidden);
	};

	const editActionEnabled = !!editUrl && editCapAllowed;
	const editActionLabel = editActionEnabled
		? editLabel(ctx, true)
		: resolving
			? editLabel(ctx, true)
			: editDisabledLabel(ctx, { isBlockTheme });

	return (
		<>
			<ActionRow
				icon={pencil}
				label={editActionLabel}
				hint={resolving ? null : shortcutHint}
				loading={resolving}
				disabled={!editActionEnabled}
				onClick={() => runAction('edit', { origin, baseUrl, url, editUrl })}
				onNewTab={() => runAction('edit', { origin, baseUrl, url, editUrl, newTab: true })}
				copyUrl={editActionEnabled ? editUrl : null}
			/>
			<ActionRow
				icon={dashboard}
				label={chrome.i18n.getMessage('wordpress_admin') /* "WordPress Admin" */}
				disabled={!adminEnabled}
				onClick={() => runAction('admin', { origin, baseUrl, url })}
				onNewTab={() => runAction('admin', { origin, baseUrl, url, newTab: true })}
			/>
			<AdminBarSection ctx={ctx} origin={origin} baseUrl={baseUrl} prefs={prefs} prefsReady={prefsReady} onToggle={toggleAdminBar} />
		</>
	);
}

function LoggedOutActions({ origin, baseUrl, url }) {
	return (
		<>
			<ActionRow
				icon={key}
				label={chrome.i18n.getMessage('log_in') /* "Log In" */}
				onClick={() => runAction('login', { origin, baseUrl, url })}
				onNewTab={() => runAction('login', { origin, baseUrl, url, newTab: true })}
			/>
			<ActionRow
				icon={keyboardReturn}
				label={chrome.i18n.getMessage('log_in_return') /* "Log In, Return to Page" */}
				onClick={() => runAction('login-return', { origin, baseUrl, url })}
				onNewTab={() => runAction('login-return', { origin, baseUrl, url, newTab: true })}
			/>
		</>
	);
}

function AdminBarSection({ ctx, origin, baseUrl, prefs, prefsReady, onToggle }) {
	if (ctx.hasAdminBar) {
		return <ToggleRow icon={seen} label={chrome.i18n.getMessage('show_admin_bar') /* "Show Admin Bar" */} checked={!prefs.adminBarHidden} onChange={onToggle} settled={prefsReady} />;
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
					onClick={() => runAction('profile', { origin, baseUrl, url: '' })}
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
 *
 * Three async shapes feed this:
 *   - term/author slug → ID lookup (requestRestEditUrl)
 *   - template-backed views (blog index, archives) → block-theme site-editor
 *     deep link (requestTemplateEditUrl), which also reports `isBlockTheme`
 *     so a disabled row can explain itself honestly.
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

	const isTemplateBacked = useMemo(() => {
		const wpRest = typeof window !== 'undefined' ? window.WPRest : null;
		return wpRest ? wpRest.isTemplateBackedPage(ctx) : false;
	}, [ctx]);

	const [asyncUrl, setAsyncUrl] = useState(null);
	const [asyncAttempted, setAsyncAttempted] = useState(false);
	const [isBlockTheme, setIsBlockTheme] = useState(null);

	const needsTemplateAsync = !syncUrl && !canResolveAsync && isTemplateBacked;
	const needsAsync = !syncUrl && (canResolveAsync || needsTemplateAsync);

	useEffect(() => {
		if (!needsAsync || asyncAttempted) return;
		let cancelled = false;
		(async () => {
			if (needsTemplateAsync) {
				const { url, isBlockTheme: themeFlag } = await requestTemplateEditUrl(ctx.baseUrl || origin);
				if (cancelled) return;
				setAsyncUrl(url || null);
				setIsBlockTheme(themeFlag ?? null);
			} else {
				const resolved = await requestRestEditUrl();
				if (cancelled) return;
				setAsyncUrl(resolved);
			}
			setAsyncAttempted(true);
		})();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- ctx.baseUrl/origin are stable for a popup lifetime; re-running on their identity would refire the resolution requests
	}, [needsAsync, needsTemplateAsync, asyncAttempted]);

	return {
		editUrl: syncUrl || asyncUrl || null,
		resolving: needsAsync && !asyncAttempted,
		isBlockTheme,
	};
}
