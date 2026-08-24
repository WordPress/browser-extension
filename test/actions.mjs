/**
 * Tests for the popup's destructive clear-data action
 * (src/popup/lib/actions.js).
 *
 * The file is an ES module with no imports that reads `chrome` and `window`
 * as free globals, so it can be evaluated with the same new Function()
 * pattern smoke.js uses for the lib IIFEs — the `export ` prefixes are
 * stripped and stub globals are passed as parameters.
 *
 * The executeScript stub emulates the injected document: it materializes
 * `location` / `localStorage` / `sessionStorage` reflecting the tab's
 * origin *at execution time* and invokes the injected function against
 * them, so the in-document origin re-check is exercised for real.
 *
 *   cd test && npm install && npm test
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { JSDOM } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const actionsSrc = readFileSync(
	join(__dirname, '..', 'src', 'popup', 'lib', 'actions.js'),
	'utf8',
).replace(/^export /gm, '');

let failures = 0;

// Installs page-document globals on globalThis for the duration of `fn`.
// Node has none of these by default, so add/remove is safe.
function withDocumentGlobals(globals, fn) {
	for (const [key, value] of Object.entries(globals)) globalThis[key] = value;
	try {
		return fn();
	} finally {
		for (const key of Object.keys(globals)) delete globalThis[key];
	}
}

function assert(cond, msg) {
	if (!cond) {
		failures++;
		console.error('  FAIL:', msg);
	} else {
		console.log('  ok  :', msg);
	}
}

/**
 * Builds a chrome stub for one clear-data run.
 *
 * `originAfterCookieWork` simulates the page navigating while the popup's
 * cookie round-trips are in flight: the tab starts on `origin` and reports
 * the new origin from the moment cookies.getAll resolves.
 */
function makeHarness({
	origin = 'https://site-a.example',
	originAfterCookieWork = null,
	tabId = 7,
	closeTabBeforeExecute = false,
	closeTabBeforeReload = false,
} = {}) {
	const calls = {
		queries: 0,
		localCleared: 0,
		sessionCleared: 0,
		reloadedTabIds: [],
		removedCookies: [],
	};
	let currentOrigin = origin;

	const chrome = {
		tabs: {
			query: async () => {
				calls.queries++;
				return [{ id: tabId, url: `${currentOrigin}/` }];
			},
			reload: async (id) => {
				if (closeTabBeforeReload) throw new Error('No tab with id');
				calls.reloadedTabIds.push(id);
			},
		},
		cookies: {
			getAll: async () => {
				if (originAfterCookieWork) currentOrigin = originAfterCookieWork;
				return [
					{ name: 'sess', hostOnly: true, domain: 'site-a.example', path: '/', secure: true },
					{ name: 'wordpress_logged_in_abc', hostOnly: true, domain: 'site-a.example', path: '/', secure: true },
					{ name: 'parent', hostOnly: false, domain: '.example', path: '/', secure: true },
				];
			},
			remove: async ({ name }) => {
				calls.removedCookies.push(name);
			},
		},
		scripting: {
			executeScript: async ({ target, func, args }) => {
				if (closeTabBeforeExecute) throw new Error('No tab with id: ' + target.tabId);
				// The injected function resolves location/storage as free
				// identifiers from the global object, so emulate the target
				// document by installing them on globalThis for the call.
				const result = withDocumentGlobals(
					{
						location: { origin: currentOrigin },
						localStorage: { clear: () => calls.localCleared++ },
						sessionStorage: { clear: () => calls.sessionCleared++ },
					},
					() => func(...(args || [])),
				);
				return [{ result }];
			},
		},
	};

	const windowStub = { close: () => {}, WPRest: null };
	const loader = new Function('chrome', 'window', 'navigator', `${actionsSrc}\nreturn { runAction };`);
	const { runAction } = loader(chrome, windowStub, { vendor: 'Test' });

	return { runAction, calls, origin };
}

console.log('\n[24] clear-data — stable tab and origin');
{
	const { runAction, calls, origin } = makeHarness();
	await runAction('clear-data', { origin, url: `${origin}/` });
	assert(calls.localCleared === 1, 'localStorage cleared');
	assert(calls.sessionCleared === 1, 'sessionStorage cleared');
	assert(calls.reloadedTabIds.length === 1 && calls.reloadedTabIds[0] === 7,
		'captured tab reloaded');
	assert(calls.queries === 1, 'tab identity resolved once, before async work');
	assert(calls.removedCookies.length === 1 && calls.removedCookies[0] === 'sess',
		'host-only non-WP cookie removed; WP auth + parent-domain cookies kept');
}

console.log('\n[25] clear-data — tab navigated to another origin mid-flight');
{
	const { runAction, calls, origin } = makeHarness({
		originAfterCookieWork: 'https://victim-b.example',
	});
	await runAction('clear-data', { origin, url: `${origin}/` });
	assert(calls.localCleared === 0, 'localStorage NOT cleared on the new origin');
	assert(calls.sessionCleared === 0, 'sessionStorage NOT cleared on the new origin');
	assert(calls.reloadedTabIds.length === 0, 'navigated tab not reloaded');
}

console.log('\n[26] clear-data — tab closed before script injection');
{
	const { runAction, calls, origin } = makeHarness({ closeTabBeforeExecute: true });
	let rejected = false;
	try {
		await runAction('clear-data', { origin, url: `${origin}/` });
	} catch (_) {
		rejected = true;
	}
	assert(!rejected, 'resolves without an unhandled rejection');
	assert(calls.reloadedTabIds.length === 0, 'no reload attempted');
}

console.log('\n[27] clear-data — tab closed between clear and reload');
{
	const { runAction, calls, origin } = makeHarness({ closeTabBeforeReload: true });
	let rejected = false;
	try {
		await runAction('clear-data', { origin, url: `${origin}/` });
	} catch (_) {
		rejected = true;
	}
	assert(!rejected, 'reload failure is swallowed');
	assert(calls.localCleared === 1, 'storage was still cleared for the confirmed origin');
}

console.log('\n[28] clear-data — origin check lives inside the injected function');
{
	// The injected function itself must refuse the wrong origin even if
	// every popup-side check passed: invoke it directly with a mismatched
	// document origin and assert it declines to clear.
	const { calls, origin } = makeHarness();
	let injectedFunc = null;
	let injectedArgs = null;
	const chrome = {
		tabs: {
			query: async () => [{ id: 1, url: `${origin}/` }],
			reload: async () => {},
		},
		cookies: { getAll: async () => [], remove: async () => {} },
		scripting: {
			executeScript: async ({ func, args }) => {
				injectedFunc = func;
				injectedArgs = args;
				return [{ result: false }];
			},
		},
	};
	const loader = new Function('chrome', 'window', 'navigator', `${actionsSrc}\nreturn { runAction };`);
	const { runAction: run } = loader(chrome, { close: () => {}, WPRest: null }, { vendor: 'Test' });
	await run('clear-data', { origin, url: `${origin}/` });
	assert(typeof injectedFunc === 'function', 'a function is injected');
	assert(Array.isArray(injectedArgs) && injectedArgs[0] === origin,
		'expected origin is passed into the document');
	const cleared = withDocumentGlobals(
		{
			location: { origin: 'https://other.example' },
			localStorage: { clear: () => calls.localCleared++ },
			sessionStorage: { clear: () => calls.sessionCleared++ },
		},
		() => injectedFunc(origin),
	);
	assert(cleared === false, 'injected function refuses a mismatched document origin');
	assert(calls.localCleared === 0, 'and clears nothing');
}

console.log('\n[29] mobile-preview — delegates to the background instead of opening a window itself');
{
	const sent = [];
	let windowsCreated = 0;
	let closed = 0;
	const chrome = {
		runtime: { sendMessage: async (msg) => { sent.push(msg); } },
		// Present so a regression that calls it directly would be observable.
		windows: { create: async () => { windowsCreated++; return { id: 1 }; } },
	};
	const loader = new Function('chrome', 'window', 'navigator', `${actionsSrc}\nreturn { runAction };`);
	// navigator.vendor is Safari's here, so the popup should flag enforceSize.
	const { runAction } = loader(chrome, { close: () => { closed++; }, WPRest: null }, { vendor: 'Apple Computer, Inc.' });
	const url = 'https://make.wordpress.org/core/2026/05/22/post/';
	await runAction('mobile-preview', { url });
	assert(windowsCreated === 0, 'popup does not call chrome.windows.create directly');
	assert(sent.length === 1 && sent[0].type === 'OPEN_MOBILE_PREVIEW',
		'sends OPEN_MOBILE_PREVIEW to the background');
	assert(sent[0].url === url, 'forwards the target URL');
	assert(sent[0].enforceSize === true,
		'flags Safari (navigator.vendor) so the background re-asserts the window size');
	assert(closed === 1, 'popup closes after dispatching');
}

console.log('\n[43] synthesized targets from a subdirectory admin base (#88)');
{
	// Real WPRest so the visit-site same-origin guard is exercised, not stubbed.
	const restSrc = readFileSync(join(__dirname, '..', 'lib', 'rest.js'), 'utf8');
	const libCtx = {};
	new Function('globalThis', 'document', 'window', restSrc)(libCtx, undefined, undefined);

	const run = async (action, args) => {
		const targets = [];
		const chrome = {
			tabs: {
				update: async ({ url }) => { targets.push(url); },
				create: async ({ url }) => { targets.push(url); },
			},
			runtime: { sendMessage: async () => {} },
		};
		const loader = new Function('chrome', 'window', 'navigator', `${actionsSrc}\nreturn { runAction };`);
		const { runAction } = loader(chrome, { close: () => {}, WPRest: libCtx.WPRest }, { vendor: '' });
		await runAction(action, args);
		return targets[0] || null;
	};

	const base = {
		origin: 'https://www.example.com',
		baseUrl: 'https://www.example.com/en-us/research',
		url: 'https://www.example.com/en-us/research/wp-admin/index.php',
	};
	assert(await run('visit-site', base) === 'https://www.example.com/en-us/research/',
		'Visit Site target carries the full install base');
	assert(await run('admin', base) === 'https://www.example.com/en-us/research/wp-admin/',
		'WordPress Admin target carries the full install base');
	assert(await run('profile', base) === 'https://www.example.com/en-us/research/wp-admin/profile.php',
		'Profile target carries the full install base');
	assert(await run('login', base) === 'https://www.example.com/en-us/research/wp-login.php',
		'Log In target carries the full install base');
	assert(await run('visit-site', { ...base, visitUrl: 'https://www.example.com/' }) === 'https://www.example.com/',
		'validated Visit Site href (home_url) preferred over the synthesized base');
	assert(await run('visit-site', { ...base, visitUrl: 'https://evil.example/' }) === 'https://www.example.com/en-us/research/',
		'cross-origin Visit Site href rejected, base used');
	assert(await run('visit-site', { ...base, visitUrl: 'javascript:alert(1)' }) === 'https://www.example.com/en-us/research/',
		'non-http Visit Site href rejected, base used');
}

console.log('\n[44] cache-only fallback recovers the admin base from the tab pathname (#88)');
{
	// Models the orphaned-content-script scenario at the helper seam (an
	// already-open subdirectory wp-admin tab, messaging dead, cached
	// detection present, probe confirming the admin document): covers
	// adminBaseFromProbe's derivation contract with the REAL lib/detect.js
	// and the recovered base flowing into real target synthesis. The React
	// hook wiring itself (probe field → merge call in useDetection) is not
	// driven here — the repo has no React harness; that remains build- and
	// review-verified. True pipeline coverage is a possible follow-up.
	const detectSrc = readFileSync(join(__dirname, '..', 'lib', 'detect.js'), 'utf8');
	const libCtx = {};
	new Function('globalThis', detectSrc)(libCtx);
	const adminBaseSrc = readFileSync(
		join(__dirname, '..', 'src', 'popup', 'lib', 'adminBase.js'),
		'utf8',
	).replace(/^export /gm, '');
	const { adminBaseFromProbe } = new Function('window', `${adminBaseSrc}\nreturn { adminBaseFromProbe };`)(
		{ WPDetect: libCtx.WPDetect },
	);

	const O = 'https://www.example.com';
	// Returns deriveBase's `{ baseUrl, evidence }` pair, not a bare string, so
	// the provenance travels with the value (#103).
	const probeBase = (...a) => adminBaseFromProbe(...a)?.baseUrl ?? null;
	assert(probeBase(O, '/en-us/research/wp-admin/edit.php', true) === `${O}/en-us/research`,
		'an open subdirectory wp-admin tab recovers its full install base');
	assert(adminBaseFromProbe(O, '/guides/wp-admin/security/', false) === null,
		'a public URL containing /wp-admin/ derives nothing without body.wp-admin');
	assert(probeBase(O, '/en-us/research///wp-admin/', true) === `${O}/en-us/research`,
		'trailing slash runs are trimmed');
	assert(probeBase(O, '/a%2Fb/wp-admin/', true) === O,
		'encoded slashes fail closed to the bare origin');
	assert(probeBase(O, '/wp-admin/index.php', true) === O,
		'a root install derives the bare origin');
	assert(adminBaseFromProbe(O, '/en-us/research/wp-admin/edit.php', undefined) === null,
		'an unconfirmed probe derives nothing');

	// The evidence rides along, so a root install reached only through this
	// fallback can still enter My Sites; a fail-closed derivation claims none.
	assert(adminBaseFromProbe(O, '/wp-admin/index.php', true).evidence === 'admin-path',
		'a recovered root base carries admin-path evidence (#103)');
	assert(adminBaseFromProbe(O, '/en-us/research/wp-admin/edit.php', true).evidence === 'admin-path',
		'a recovered subdirectory base carries admin-path evidence too');
	assert(adminBaseFromProbe(O, '/a%2Fb/wp-admin/', true).evidence === null,
		'an encoded-slash fail-close claims no evidence, so it mints no My Sites row');

	// The recovered base must flow into synthesized targets exactly like a
	// live-detected one — the user story from the report: reopening the
	// popup on that tab, Admin/Profile/Login retain /en-us/research.
	const derived = probeBase(O, '/en-us/research/wp-admin/edit.php', true);
	const restSrc = readFileSync(join(__dirname, '..', 'lib', 'rest.js'), 'utf8');
	const restCtx = {};
	new Function('globalThis', 'document', 'window', restSrc)(restCtx, undefined, undefined);
	const run = async (action, args) => {
		const targets = [];
		const chrome = {
			tabs: {
				update: async ({ url }) => { targets.push(url); },
				create: async ({ url }) => { targets.push(url); },
			},
			runtime: { sendMessage: async () => {} },
		};
		const loader = new Function('chrome', 'window', 'navigator', `${actionsSrc}\nreturn { runAction };`);
		const { runAction } = loader(chrome, { close: () => {}, WPRest: restCtx.WPRest }, { vendor: '' });
		await runAction(action, args);
		return targets[0] || null;
	};
	const args = { origin: O, baseUrl: derived, url: `${O}/en-us/research/wp-admin/edit.php` };
	assert(await run('admin', args) === `${O}/en-us/research/wp-admin/`,
		'Admin target from the recovered base retains /en-us/research');
	assert(await run('profile', args) === `${O}/en-us/research/wp-admin/profile.php`,
		'Profile target from the recovered base retains /en-us/research');
	assert(await run('login', args) === `${O}/en-us/research/wp-login.php`,
		'Log In target from the recovered base retains /en-us/research');
}

console.log('\n[45] probe reconciliation and navigation guard (#103 review hardening)');
{
	// Helper-seam coverage like [44]: reconcileProbeBase and probeMatchesTab
	// with the REAL lib/detect.js, and the extracted page probe against a real
	// DOM. The hook wiring (probe → guard → merge in useDetection) is not
	// driven here — the repo has no React harness; build- and review-verified.
	const detectSrc = readFileSync(join(__dirname, '..', 'lib', 'detect.js'), 'utf8');
	const libCtx = {};
	new Function('globalThis', detectSrc)(libCtx);
	const adminBaseSrc = readFileSync(
		join(__dirname, '..', 'src', 'popup', 'lib', 'adminBase.js'),
		'utf8',
	).replace(/^export /gm, '');
	const { reconcileProbeBase, probeMatchesTab } = new Function(
		'window',
		`${adminBaseSrc}\nreturn { reconcileProbeBase, probeMatchesTab };`,
	)({ WPDetect: libCtx.WPDetect });

	const O = 'https://www.example.com';

	// #88 cache-synthesized context: no base at all — adopt the derivation.
	let patch = reconcileProbeBase(null, undefined, O, '/wp-admin/index.php', true);
	assert(patch && patch.baseUrl === O && patch.evidence === 'admin-path',
		'a base-less context adopts the derived base and its evidence');

	// The 1.0.2 compat gap: an orphaned old content script reports the
	// bare-origin FALLBACK value with no evidence field at all. On an admin
	// tab the derivation agrees, so the evidence upgrades in place.
	patch = reconcileProbeBase(O, undefined, O, '/wp-admin/index.php', true);
	assert(patch && patch.baseUrl === O && patch.evidence === 'admin-path',
		'an old-shape bare-origin context gains admin-path evidence when the derivation agrees');
	patch = reconcileProbeBase(`${O}/siteA`, undefined, O, '/siteA/wp-admin/edit.php', true);
	assert(patch && patch.baseUrl === `${O}/siteA` && patch.evidence === 'admin-path',
		'an old-shape subdirectory base upgrades when the admin tab derives the same base');
	patch = reconcileProbeBase(`${O}/siteA/`, undefined, O, '/siteA/wp-admin/edit.php', true);
	assert(patch && patch.evidence === 'admin-path',
		'agreement is decided on canonical form — a trailing slash does not block the upgrade');

	// Never replace a base the derivation disagrees with, and never touch an
	// evidenced one.
	assert(reconcileProbeBase(`${O}/siteA`, undefined, O, '/wp-admin/index.php', true) === null,
		'a disagreeing derivation leaves the stored base untouched and unevidenced');
	assert(reconcileProbeBase(O, 'rest', O, '/wp-admin/index.php', true) === null,
		'an already-evidenced context is never rewritten');
	assert(reconcileProbeBase(`${O}/siteA`, undefined, O, '/siteA/hello-world/', true) === null,
		'a non-admin pathname derives nothing to reconcile');
	assert(reconcileProbeBase(null, undefined, O, '/wp-admin/index.php', false) === null,
		'an unconfirmed probe still contributes nothing');

	// Navigation guard: the probe's document must be the tab the popup
	// captured — same origin and pathname; query and hash may differ (wp-admin
	// list tables navigate by query string within one document path).
	assert(probeMatchesTab(`${O}/wp-admin/edit.php`, `${O}/wp-admin/edit.php`) === true,
		'identical document and tab URLs match');
	assert(probeMatchesTab(`${O}/wp-admin/edit.php?paged=2#top`, `${O}/wp-admin/edit.php?post_type=page`) === true,
		'query and hash differences still match');
	assert(probeMatchesTab(`${O}/siteB/wp-admin/`, `${O}/siteA/wp-admin/`) === false,
		'a different pathname is a navigated tab');
	assert(probeMatchesTab(`https://other.example/wp-admin/`, `${O}/wp-admin/`) === false,
		'a different origin is a navigated tab');
	assert(probeMatchesTab(null, `${O}/wp-admin/`) === false
		&& probeMatchesTab('not a url', `${O}/wp-admin/`) === false,
		'a missing or unparsable probe URL never matches');

	// The extracted page probe itself: reports its own document URL, and only
	// calls a document an admin screen when body.wp-admin AND #wpwrap are both
	// present (both printed by wp-admin/admin-header.php on every core admin
	// screen; a body class alone is spoofable by any theme).
	const probeSrc = readFileSync(
		join(__dirname, '..', 'src', 'popup', 'lib', 'pageProbe.js'),
		'utf8',
	).replace(/^export /gm, '');
	const loadProbe = (dom) => new Function(
		'document', 'location', `${probeSrc}\nreturn probePageState;`,
	)(dom.window.document, dom.window.location);

	const adminDom = new JSDOM(
		'<html><body class="wp-admin wp-core-ui"><div id="wpwrap">'
		+ '<div id="wpadminbar"></div></div></body></html>',
		{ url: `${O}/wp-admin/index.php` },
	);
	const adminState = await loadProbe(adminDom)();
	assert(adminState.href === `${O}/wp-admin/index.php`,
		'the probe reports its own document URL');
	assert(adminState.bodyAdmin === true, 'body.wp-admin plus #wpwrap is an admin document');
	assert(adminState.hasAdminBar === true, 'the admin bar is seen inside #wpwrap');

	const spoofDom = new JSDOM(
		'<html><body class="wp-admin logged-in"><p>front end</p></body></html>',
		{ url: `${O}/press/wp-admin/tour/` },
	);
	const spoofState = await loadProbe(spoofDom)();
	assert(spoofState.href === `${O}/press/wp-admin/tour/`,
		'the no-admin-bar branch reports the document URL too');
	assert(spoofState.bodyAdmin === false,
		'body.wp-admin without #wpwrap is not an admin document');
}

console.log(`\n${failures === 0 ? 'Popup action tests passed.' : failures + ' failure(s).'}`);
process.exit(failures === 0 ? 0 : 1);
