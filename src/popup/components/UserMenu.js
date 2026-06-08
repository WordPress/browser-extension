import { useEffect, useRef, useState } from 'react';
import { Icon, Popover, VisuallyHidden } from '@wordpress/ui';
import { people, login, image } from '@wordpress/icons';
import { runAction, requestCurrentUser } from '../lib/actions';

/**
 * Circular avatar button in the header's top-right. Opens a small popover
 * with Profile, Account Settings, and Log Out. Rendered only when signed
 * in — the caller gates on login state.
 *
 * Built on @wordpress/ui's Popover primitives — they own positioning,
 * focus management, click-outside, and Escape handling. Each non-
 * destructive menu item is a Popover.Close so activation auto-dismisses;
 * the destructive logout uses a regular button so its two-click confirm
 * can live inside the open popover.
 */
export function UserMenu({ avatarUrl, displayName, origin, url, logoutUrl, editProfileUrl, isSuperAdmin = false }) {
	const [open, setOpen] = useState(false);
	const [confirmingLogout, setConfirmingLogout] = useState(false);
	const [restRole, setRestRole] = useState(null);
	const confirmTimerRef = useRef(null);

	// Pre-fetch the role on mount so the dropdown opens with the label
	// already in place. Skipped for super admins — the DOM-derived "Super
	// Admin" badge takes priority and a per-site role would be misleading.
	useEffect(() => {
		if (isSuperAdmin) return;
		let cancelled = false;
		requestCurrentUser().then((user) => {
			if (cancelled) return;
			const label = roleLabelFromUser(user);
			if (label) setRestRole(label);
		});
		return () => { cancelled = true; };
	}, [isSuperAdmin]);

	useEffect(() => {
		if (!open) {
			setConfirmingLogout(false);
			clearTimeout(confirmTimerRef.current);
		}
	}, [open]);

	useEffect(() => () => clearTimeout(confirmTimerRef.current), []);

	// Super admin wins. On multisite a super admin's per-site role is
	// commonly just 'subscriber', so REST would mislabel them.
	const roleLabel = isSuperAdmin ? chrome.i18n.getMessage('super_admin_role') /* "Super Admin" */ : restRole;

	const profileUrl = safeProfileUrl(editProfileUrl, origin);
	const buttonLabel = displayName
		? chrome.i18n.getMessage('account_menu_for_user', [displayName]) // "Account menu for {name}"
		: chrome.i18n.getMessage('account_menu_label'); // "Account menu"
	// Admin bar avatars from gravatar.com carry the user's hash in the path.
	// Custom-avatar plugins (User Profile Picture, etc.) point at an upload
	// on the site's own host and won't match — we hide the menu item then.
	const gravatarHash = extractGravatarHash(avatarUrl);
	const gravatarProfileUrl = gravatarHash ? `https://gravatar.com/${gravatarHash}` : null;

	const handleLogoutClick = () => {
		if (!confirmingLogout) {
			setConfirmingLogout(true);
			clearTimeout(confirmTimerRef.current);
			confirmTimerRef.current = setTimeout(() => setConfirmingLogout(false), 4000);
			return;
		}
		clearTimeout(confirmTimerRef.current);
		setOpen(false);
		runAction('signout', { origin, url, logoutUrl });
	};

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger
				className="wpd-user-menu__button"
				aria-label={buttonLabel}
				title={displayName || buttonLabel}
			>
				{avatarUrl ? (
					<img
						className="wpd-user-menu__avatar"
						src={avatarUrl}
						alt=""
						referrerPolicy="no-referrer"
						onError={(e) => {
							e.currentTarget.style.display = 'none';
						}}
					/>
				) : (
					<span className="wpd-user-menu__avatar wpd-user-menu__avatar--placeholder" aria-hidden="true">
						<Icon icon={people} size={16} />
					</span>
				)}
			</Popover.Trigger>
			<Popover.Popup
				className="wpd-user-menu__positioner"
				variant="unstyled"
				align="end"
				sideOffset={8}
			>
				<VisuallyHidden>
					<Popover.Title>{chrome.i18n.getMessage('account_menu_label') /* "Account menu" */}</Popover.Title>
				</VisuallyHidden>
				<div className="wpd-user-menu__dropdown" role="menu">
					{displayName && (
						<div className="wpd-user-menu__header">
							<span className="wpd-user-menu__name" title={displayName}>{displayName}</span>
							{roleLabel && (
								<span className="wpd-user-menu__role" title={roleLabel}>{roleLabel}</span>
							)}
						</div>
					)}
					<MenuLink
						icon={people}
						label={chrome.i18n.getMessage('profile_menu_item') /* "Profile" */}
						onClick={() => {
							chrome.tabs.update({ url: profileUrl });
							window.close();
						}}
					/>
					{gravatarProfileUrl && (
						<MenuLink
							icon={image}
							label={chrome.i18n.getMessage('gravatar_menu_item') /* "Gravatar" */}
							onClick={() => {
								chrome.tabs.create({ url: gravatarProfileUrl });
								window.close();
							}}
						/>
					)}
					<button
						type="button"
						role="menuitem"
						className={`wpd-user-menu__item wpd-user-menu__item--destructive ${confirmingLogout ? 'is-active' : ''}`}
						onClick={handleLogoutClick}
					>
						<span className="wpd-user-menu__item-icon" aria-hidden="true">
							<Icon icon={login} size={16} />
						</span>
						<span className="wpd-user-menu__item-label">
							{confirmingLogout ? chrome.i18n.getMessage('confirm_click_button') /* "Click again to confirm" */ : chrome.i18n.getMessage('log_out_button') /* "Log Out" */}
						</span>
					</button>
				</div>
			</Popover.Popup>
		</Popover.Root>
	);
}

/**
 * Pick a role label for the current user from a `/users/me?context=edit`
 * response. WP doesn't expose role seniority via REST, so we use two
 * signals in order:
 *
 *   1. **Role slug** — `roles[]` preserves `wp_capabilities` insertion
 *      order, so `roles[0]` mislabels anyone added as subscriber and
 *      later elevated. Instead, prefer the highest-rank built-in role
 *      they have; if their only built-in is subscriber, prefer a
 *      non-subscriber custom role (e.g. shop_manager → "Shop Manager");
 *      otherwise return the first listed slug.
 *
 *   2. **Capability fallback** — used when `roles[]` is missing or
 *      empty, which happens on installs where a hardening plugin or
 *      `rest_prepare_user` filter strips the roles field but leaves
 *      `capabilities` intact. Maps the highest-privilege built-in cap
 *      the user has to its corresponding role label.
 *
 * Returns null only if both signals are absent.
 */
const BUILTIN_PRIORITY = ['administrator', 'editor', 'author', 'contributor', 'subscriber'];

const ROLE_BY_CAPABILITY = [
	['manage_options',    'Administrator'],
	['edit_others_posts', 'Editor'],
	['publish_posts',     'Author'],
	['edit_posts',        'Contributor'],
];

function roleLabelFromUser(user) {
	if (!user || typeof user !== 'object') return null;

	const roles = Array.isArray(user.roles) ? user.roles : [];
	if (roles.length > 0) {
		for (const known of BUILTIN_PRIORITY) {
			if (!roles.includes(known)) continue;
			if (known === 'subscriber') {
				const custom = roles.find((r) => !BUILTIN_PRIORITY.includes(r));
				if (custom) return formatRoleSlug(custom);
			}
			return formatRoleSlug(known);
		}
		return formatRoleSlug(roles[0]);
	}

	const caps = user.capabilities || {};
	for (const [cap, label] of ROLE_BY_CAPABILITY) {
		if (caps[cap]) return label;
	}
	return null;
}

/**
 * Pulls the Gravatar hash out of an admin-bar avatar URL. Validates by
 * URL-parsing and checking hostname (vs a substring match on the raw
 * string) so a hostile page can't surface a misleading Gravatar item
 * by embedding `.gravatar.com/avatar/{hex}` in a non-gravatar URL or
 * in a data: payload — `detect.js` accepts data: avatars by design.
 */
function extractGravatarHash(avatarUrl) {
	if (typeof avatarUrl !== 'string') return null;
	try {
		const u = new URL(avatarUrl);
		if (u.hostname !== 'gravatar.com' && !u.hostname.endsWith('.gravatar.com')) return null;
		const m = u.pathname.match(/^\/avatar\/([a-f0-9]+)/i);
		return m ? m[1] : null;
	} catch (_) {
		return null;
	}
}

function safeProfileUrl(editProfileUrl, origin) {
	const fallback = `${origin}/wp-admin/profile.php`;
	if (typeof editProfileUrl !== 'string' || !editProfileUrl) return fallback;
	try {
		const u = new URL(editProfileUrl);
		if (u.origin !== origin) return fallback;
		// Match the path by suffix rather than prefix so WordPress installs
		// under a subdirectory (e.g. /wp/wp-admin/profile.php) aren't sent
		// back to the broken /wp-admin/profile.php fallback.
		if (!u.pathname.endsWith('/wp-admin/profile.php')) return fallback;
		return u.href;
	} catch (_) {
		return fallback;
	}
}

/**
 * Title-cases a WP role slug for display. WP's own `translate_user_role()`
 * runs slugs through i18n; here we just normalize separators and capitalize.
 * "administrator" → "Administrator", "shop_manager" → "Shop Manager".
 */
function formatRoleSlug(slug) {
	if (typeof slug !== 'string' || !slug) return null;
	return slug
		.split(/[-_]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
		.join(' ');
}

/**
 * Menu item that closes the popover on activation. Popover.Close handles the
 * dismissal; the onClick runs after the popover is told to close so the
 * subsequent chrome.tabs / window.close calls don't race the popover's own
 * cleanup.
 */
function MenuLink({ icon, label, onClick }) {
	return (
		<Popover.Close
			role="menuitem"
			className="wpd-user-menu__item"
			onClick={onClick}
		>
			<span className="wpd-user-menu__item-icon" aria-hidden="true">
				<Icon icon={icon} size={16} />
			</span>
			<span className="wpd-user-menu__item-label">{label}</span>
		</Popover.Close>
	);
}
