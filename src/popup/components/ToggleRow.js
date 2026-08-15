import { useEffect, useState } from 'react';
import { Icon } from '@wordpress/ui';

/**
 * Generic on/off toggle styled as a card-row. @wordpress/ui doesn't ship a
 * Switch yet, so the track/thumb is hand-rolled from design-system tokens.
 *
 * `settled` marks the moment `checked` reflects real (stored) state rather
 * than a pre-read default. The thumb transition stays disabled until one
 * frame after that, so the settle from default to stored value snaps into
 * place instead of playing as a visible slide on popup open; user clicks
 * animate normally.
 */
export function ToggleRow({ icon, label, checked, onChange, disabled = false, settled = true }) {
	const [animatable, setAnimatable] = useState(false);
	useEffect(() => {
		if (!settled || animatable) return undefined;
		const id = requestAnimationFrame(() => setAnimatable(true));
		return () => cancelAnimationFrame(id);
	}, [settled, animatable]);

	return (
		<div className={`wpd-card-row wpd-toggle-row${disabled ? ' is-disabled' : ''}`}>
			<button
				type="button"
				role="switch"
				aria-checked={checked}
				aria-disabled={disabled}
				disabled={disabled}
				className="wpd-card__main"
				onClick={() => !disabled && onChange?.(!checked)}
			>
				{icon && (
					<span className="wpd-card__icon" aria-hidden="true">
						<Icon icon={icon} size={20} />
					</span>
				)}
				<span className="wpd-card__label">{label}</span>
				<span
					className={`wpd-switch ${checked ? 'is-on' : ''}${animatable ? '' : ' no-anim'}`}
					aria-hidden="true"
				>
					<span className="wpd-switch__thumb" />
				</span>
			</button>
		</div>
	);
}
