import { useEffect, useRef } from 'react';
import { useDetection } from './hooks/useDetection';
import { LoadingView } from './components/LoadingView';
import { ErrorView } from './components/ErrorView';
import { NotSupportedView } from './components/NotSupportedView';
import { NotWordPressView } from './components/NotWordPressView';
import { DetectedView } from './components/DetectedView';
import { MySites } from './components/MySites';

export function App() {
	const state = useDetection();
	const scrollRef = useRef(null);
	const contentRef = useRef(null);
	// Gate the baseline lock on detection having resolved, so it never freezes
	// to the brief loading view and trap the real content inside it.
	useSafariPopupLock(scrollRef, contentRef, state.status !== 'loading');

	let view;
	if (state.status === 'loading') view = <LoadingView />;
	else if (state.status === 'error') view = <ErrorView />;
	else if (state.status === 'unsupported') view = <NotSupportedView />;
	else if (state.status === 'not-wordpress') view = <NotWordPressView hostname={state.hostname} />;
	else view = <DetectedView result={state.result} host={state.host} />;

	// "My Sites" is a global launcher — independent of the current tab, so it
	// renders under every view (including non-WP / internal pages). It hides
	// itself when the list is empty. The scroll wrappers host the Safari popup
	// fix below; on Chrome they are inert content-height divs.
	return (
		<div className="wpd-scroll" ref={scrollRef}>
			<div className="wpd-scroll__content" ref={contentRef}>
				{view}
				<MySites />
			</div>
		</div>
	);
}

/**
 * Safari-only popup sizing fix.
 *
 * Safari grows the extension popup to fit content but will not shrink it back,
 * and it leaves its own scroll offset stuck. So expanding an accordion (which
 * grows the popup), then collapsing it, leaves the window stuck tall, scrolled
 * down into an empty band with the header pushed off the top and no way up.
 *
 * The fix stops relying on the popup window resizing at all. Once the initial
 * content has settled — detection resolved and My Sites loaded, with every panel
 * collapsed — we LOCK the popup to that baseline height and make the inner
 * container the scroll surface. From then on, expanding a panel scrolls WITHIN
 * the popup instead of growing the window, and collapsing returns the scroll to
 * the top. Because the window never grows past the baseline, it never needs to
 * shrink, so the stuck band and stuck scroll can't happen.
 *
 * Chrome auto-sizes popups correctly (grow AND shrink), so this is a no-op
 * there: the wrappers stay content-height and nothing is pinned.
 */
function useSafariPopupLock(scrollRef, contentRef, ready) {
	useEffect(() => {
		// navigator.vendor is 'Apple Computer, Inc.' only on Safari; Chrome and
		// other Chromium browsers report 'Google Inc.'. Scoped so we never touch
		// Chrome's already-correct content-fit behavior.
		if (navigator.vendor !== 'Apple Computer, Inc.') return undefined;

		// Styling hook for Safari-only rules (the empty states reserve extra
		// baseline height there — see .wpd-empty).
		document.documentElement.classList.add('is-safari');

		const scroller = scrollRef.current;
		const content = contentRef.current;
		const html = document.documentElement;
		const body = document.body;
		if (!scroller || !content || typeof ResizeObserver === 'undefined') return undefined;

		let locked = 0; // 0 until the baseline height is frozen
		let settleTimer = null;

		const freeze = () => {
			const h = content.offsetHeight;
			if (h <= 0) return;
			locked = h;
			// Pin the window to the baseline; taller content now scrolls inside
			// the scroller rather than growing the popup.
			scroller.style.height = `${h}px`;
			scroller.style.overflowY = 'auto';
			body.style.height = `${h}px`;
			html.style.height = `${h}px`;
		};

		const armFreeze = () => {
			clearTimeout(settleTimer);
			settleTimer = setTimeout(freeze, 300);
		};

		const onResize = () => {
			if (!locked) {
				// Still settling (detected view painting, My Sites arriving): let
				// the popup grow with the base content and re-arm the freeze for
				// once it stops changing. Only after detection has resolved.
				if (ready) armFreeze();
				return;
			}
			// Locked: when a panel collapses and the content fits the baseline
			// again, return the scroll to the top so the header is reachable.
			if (scroller.scrollTop > 0 && content.offsetHeight <= locked) {
				scroller.scrollTop = 0;
			}
		};

		const obs = new ResizeObserver(onResize);
		obs.observe(content);
		// Effect re-runs when `ready` flips (loading -> resolved); arm the freeze
		// only once the real content is in place.
		if (ready) armFreeze();

		return () => {
			clearTimeout(settleTimer);
			obs.disconnect();
			scroller.style.height = '';
			scroller.style.overflowY = '';
			body.style.height = '';
			html.style.height = '';
		};
	}, [scrollRef, contentRef, ready]);
}
