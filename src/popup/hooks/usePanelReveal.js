import { useEffect, useRef } from 'react';

/**
 * When a collapsible section opens below the fold, scroll so as much of its
 * panel as possible becomes visible — without ever pushing the section's own
 * header out of view. `scrollIntoView({ block: 'nearest' })` on the section
 * (header + panel together) is exactly that contract: fully visible → no
 * scroll; partially cut off → the minimal scroll that reveals it; taller
 * than the viewport → the header pins to the top showing maximum content.
 *
 * Browser-agnostic by construction: whenever the popup can still grow to fit
 * (Chrome below its height clamp), nothing is scrollable and the call is a
 * natural no-op. Once a scroll host exists — Safari's locked popover
 * (.wpd-scroll, see useSafariPopupLock) or Chrome's clamped body — the same
 * rule reveals the panel there.
 *
 * Usage:
 *   const triggerRef = usePanelReveal(open);
 *   <Collapsible.Trigger ref={triggerRef} ... />
 */
export function usePanelReveal(open) {
	const ref = useRef(null);
	const wasOpen = useRef(open);
	const armed = useRef(false);

	// Arm only after the popup has settled and (on Safari) locked its baseline
	// height. This skips hydration / persisted opens (e.g. Developer Tools
	// restoring its open state from storage) that would otherwise scroll on
	// mount and fight the baseline measurement.
	useEffect(() => {
		const t = setTimeout(() => { armed.current = true; }, 400);
		return () => clearTimeout(t);
	}, []);

	useEffect(() => {
		const justOpened = open && !wasOpen.current;
		wasOpen.current = open;
		if (!justOpened || !armed.current) return undefined;
		const trigger = ref.current;
		if (!trigger) return undefined;
		// Defer past the expand's layout and past Chrome's popup re-size: when
		// the window can still grow it has by the time this fires, nothing is
		// scrollable, and the reveal no-ops instead of fighting the growth.
		const t = setTimeout(() => {
			const section = trigger.parentElement || trigger;
			if (typeof section.scrollIntoView !== 'function') return;
			const reduce = typeof window.matchMedia === 'function'
				&& window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			section.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
		}, 200);
		return () => clearTimeout(t);
	}, [open]);

	return ref;
}
