/**
 * Development preview — renders every popup state side-by-side against canned
 * fixtures so we can visually iterate without loading the extension in Chrome.
 * Not shipped in the extension; built as a separate entry point.
 */
import { createRoot } from 'react-dom/client';
import { DetectedView } from './components/DetectedView';
import { NotWordPressView } from './components/NotWordPressView';
import { NotSupportedView } from './components/NotSupportedView';
import { LoadingView } from './components/LoadingView';
import { MySites } from './components/MySites';
import './popup.scss';
import enMessages from '../../_locales/en/messages.json';
// Side-effect: installs window.WPMySites (the classic-script store helpers the
// popup reads), so the My Sites section renders in the dev preview too.
import '../../lib/my-sites.js';

// Canned "My Sites" list for the preview, keyed exactly like the real store
// (install base, not bare origin — see #94). The two agency entries share an
// origin so the path-qualified default labels are visible in the preview.
const PREVIEW_MY_SITES = {
	'https://acme.com': { origin: 'https://acme.com', baseUrl: 'https://acme.com', addedAt: 1, lastLoggedInAt: 4 },
	'https://shop.example.com': { origin: 'https://shop.example.com', baseUrl: 'https://shop.example.com', addedAt: 1, lastLoggedInAt: 3, customName: 'Client Store — Staging' },
	'https://agency.example/clienta': { origin: 'https://agency.example', baseUrl: 'https://agency.example/clienta', addedAt: 1, lastLoggedInAt: 2 },
	'https://agency.example/clientb': { origin: 'https://agency.example', baseUrl: 'https://agency.example/clientb', addedAt: 1, lastLoggedInAt: 1 },
};

// Faithful-enough chrome.i18n.getMessage shim for the dev preview (the real
// API only exists in the extension runtime). Resolves named placeholders
// ($NAME$ → its content) then positional $1..$9 substitutions, matching
// Chrome's order. Returns '' for unknown keys, like the real API.
function previewGetMessage(key, substitutions) {
	const entry = enMessages[key];
	if (!entry) return '';
	let msg = entry.message;
	const subs =
		substitutions == null ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
	if (entry.placeholders) {
		for (const [name, def] of Object.entries(entry.placeholders)) {
			msg = msg.replace(new RegExp(`\\$${name}\\$`, 'gi'), def.content || '');
		}
	}
	return msg.replace(/\$(\d)/g, (_, d) => subs[Number(d) - 1] ?? '');
}

// Shim the content-script globals the popup reads from window.
window.WPRest = {
	resolveEditUrlSync: (ctx, origin) =>
		ctx.postId ? `${origin}/wp-admin/post.php?post=${ctx.postId}&action=edit` : null,
	canResolveViaRest: (ctx) => !!ctx.postSlug,
	// Mirrors lib/rest.js isTemplateBackedPage — pure, no backend needed.
	// DetectedView calls this during render; without it the logged-in
	// front-end fixtures throw and render blank (#53).
	isTemplateBackedPage: (ctx) => ctx.pageType === 'home' || ctx.pageType === 'archive',
	// Capability gates default to "allowed" in the preview — the canned user
	// above is a full administrator, so the real lib logic would agree.
	canAccessAdmin: () => true,
	canEditCurrent: () => true,
};
window.WPHost = {
	HOST_NAMES: { wpengine: 'WP Engine', pantheon: 'Pantheon' },
};

// Minimal chrome.* shim so usePrefs / useEffect-driven handlers don't crash.
// sendMessage returns a canned current-user response so the UserMenu role
// line renders in the dev preview without a real WP backend.
window.chrome = {
	tabs: {
		query: async () => [{ id: 1, url: 'https://example.test/' }],
		sendMessage: async (_tabId, msg) => {
			if (msg?.type === 'GET_CURRENT_USER') {
				return {
					user: {
						id: 1,
						name: 'Jane Doe',
						roles: ['administrator'],
						// allcaps map — gives the capability gates (Edit /
						// WordPress Admin) a representative capable user.
						capabilities: {
							read: true,
							edit_posts: true,
							edit_pages: true,
							edit_others_posts: true,
							manage_categories: true,
							edit_users: true,
							manage_options: true,
							administrator: true,
						},
					},
				};
			}
			return {};
		},
	},
	runtime: { sendMessage: async () => null },
	storage: {
		local: {
			get: async (key) => (key === 'wp_my_sites_v1' ? { wp_my_sites_v1: PREVIEW_MY_SITES } : {}),
			set: async () => {},
		},
		onChanged: { addListener: () => {}, removeListener: () => {} },
	},
	scripting: { executeScript: async () => [{ result: 'fake-nonce' }] },
	i18n: { getMessage: previewGetMessage },
};

const fixtures = [
	{
		id: 'logged-in',
		label: 'Logged in · front-end',
		render: () => (
			<DetectedView
				host="wpengine"
				result={{
					url: 'https://myblog.test/hello-world/',
					origin: 'https://myblog.test',
					detection: {
						isWordPress: true,
						context: {
							isLoggedIn: true,
							hasAdminBar: true,
							postId: 42,
							postType: 'post',
							pageType: 'single',
							generatorVersion: '6.4.2',
							updateCount: 3,
							commentCount: 2,
							hasQueryMonitor: true,
							userAvatarUrl: 'https://secure.gravatar.com/avatar/00000000000000000000000000000000?d=mp&s=64',
							userDisplayName: 'Jane Doe',
							userEditProfileHref: 'https://myblog.test/wp-admin/profile.php',
							isSuperAdmin: true,
							adminBarLogoutHref: 'https://myblog.test/wp-login.php?action=logout&_wpnonce=abc',
							newContentItems: [
								{ id: 'post', label: 'Post', href: 'https://myblog.test/wp-admin/post-new.php' },
								{ id: 'page', label: 'Page', href: 'https://myblog.test/wp-admin/post-new.php?post_type=page' },
								{ id: 'media', label: 'Media', href: 'https://myblog.test/wp-admin/media-new.php' },
								{ id: 'user', label: 'User', href: 'https://myblog.test/wp-admin/user-new.php' },
								{ id: 'product', label: 'Product', href: 'https://myblog.test/wp-admin/post-new.php?post_type=product' },
							],
						},
					},
				}}
			/>
		),
	},
	{
		id: 'wp-admin',
		label: 'Logged in · wp-admin editor',
		render: () => (
			<DetectedView
				host="pantheon"
				result={{
					url: 'https://myblog.test/wp-admin/post.php?post=42&action=edit',
					origin: 'https://myblog.test',
					detection: {
						isWordPress: true,
						context: {
							isLoggedIn: true,
							hasAdminBar: true,
							postId: 42,
							postType: 'post',
							postStatus: 'publish',
							adminBarViewHref: 'https://myblog.test/hello-world/',
							generatorVersion: '6.4.2',
							userAvatarUrl: 'https://secure.gravatar.com/avatar/00000000000000000000000000000000?d=mp&s=64',
							userDisplayName: 'Jane Doe',
							userEditProfileHref: 'https://myblog.test/wp-admin/profile.php',
							adminBarLogoutHref: 'https://myblog.test/wp-login.php?action=logout&_wpnonce=abc',
						},
					},
				}}
			/>
		),
	},
	{
		id: 'logged-out',
		label: 'Logged out',
		render: () => (
			<DetectedView
				host={null}
				result={{
					url: 'https://wordpress.example/',
					origin: 'https://wordpress.example',
					detection: {
						isWordPress: true,
						context: { isLoggedIn: false, generatorVersion: '6.3.1' },
					},
				}}
			/>
		),
	},
	{
		id: 'admin-bar-disabled',
		label: 'Admin bar disabled in profile',
		render: () => (
			<DetectedView
				host="wpengine"
				result={{
					url: 'https://myblog.test/about/',
					origin: 'https://myblog.test',
					detection: {
						isWordPress: true,
						context: {
							isLoggedIn: true,
							hasAdminBar: false,
							postId: 1,
							postType: 'page',
							generatorVersion: '6.4.2',
						},
					},
				}}
			/>
		),
	},
	{
		id: 'not-wp',
		label: 'Not WordPress',
		render: () => <NotWordPressView hostname="news.example.com" />,
	},
	{
		id: 'unsupported',
		label: 'Chrome internal page',
		render: () => <NotSupportedView />,
	},
	{
		id: 'loading',
		label: 'Loading',
		render: () => <LoadingView />,
	},
	{
		id: 'my-sites',
		label: 'My Sites launcher',
		render: () => <MySites />,
	},
];

const board = document.getElementById('board');
for (const fx of fixtures) {
	const cell = document.createElement('div');
	cell.className = 'preview-cell';
	cell.innerHTML = `
		<div class="preview-label">${fx.label}</div>
		<div class="preview-frame"></div>
	`;
	board.appendChild(cell);
	createRoot(cell.querySelector('.preview-frame')).render(fx.render());
}
