import { useEffect, useRef, useState } from 'react';
import { Button, Icon } from '@wordpress/ui';

/**
 * Card-styled action that reveals an inline "Confirm" pill on first click.
 * The confirm auto-hides after `revealMs` to prevent accidental commits —
 * no modal, no lost click.
 */
export function InlineConfirm({
	icon,
	label,
	confirmLabel = chrome.i18n.getMessage('confirm_label'), // "Confirm"
	onConfirm,
	revealMs = 10000,
	destructive = false,
}) {
	const [open, setOpen] = useState(false);
	const timerRef = useRef(null);

	useEffect(() => () => clearTimeout(timerRef.current), []);

	const reveal = () => {
		setOpen((prev) => {
			const next = !prev;
			clearTimeout(timerRef.current);
			if (next) {
				timerRef.current = setTimeout(() => setOpen(false), revealMs);
			}
			return next;
		});
	};

	const confirm = (e) => {
		e.stopPropagation();
		clearTimeout(timerRef.current);
		setOpen(false);
		onConfirm();
	};

	return (
		<div className={`wpd-card-row ${destructive ? 'is-destructive' : ''}`}>
			<button type="button" className="wpd-card__main" onClick={reveal}>
				{icon && (
					<span className="wpd-card__icon" aria-hidden="true">
						<Icon icon={icon} size={20} />
					</span>
				)}
				<span className="wpd-card__label">{label}</span>
			</button>
			{open && (
				<div className="wpd-confirm-pill">
					<Button variant="outline" tone="neutral" size="small" onClick={confirm}>
						{confirmLabel}
					</Button>
				</div>
			)}
		</div>
	);
}
