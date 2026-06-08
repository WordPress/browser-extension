import { useState } from 'react';
import { Icon } from '@wordpress/ui';
import { copy, external, check } from '@wordpress/icons';
import { copyToClipboard } from '../lib/actions';

/**
 * Card-style action row: a bordered container with a primary button (icon +
 * label + optional trailing hint), and optional Copy-URL / New-Tab icon
 * buttons on the right, separated by a divider. Mirrors the card-button
 * pattern used in the WordPress Studio app.
 */
export function ActionRow({
	icon,
	label,
	hint,
	loading = false,
	disabled = false,
	onClick,
	copyUrl,
	onNewTab,
	destructive = false,
}) {
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		if (!copyUrl) return;
		const ok = await copyToClipboard(copyUrl);
		if (ok) {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		}
	};

	const showHint = !loading && hint;
	const hintContent = loading ? <span className="wpd-card__hint">…</span> : null;

	return (
		<div className={`wpd-card-row ${destructive ? 'is-destructive' : ''}`}>
			<button
				type="button"
				className="wpd-card__main"
				disabled={disabled || loading}
				onClick={onClick}
			>
				{icon && (
					<span className="wpd-card__icon" aria-hidden="true">
						<Icon icon={icon} size={20} />
					</span>
				)}
				<span className="wpd-card__label">{label}</span>
				{showHint && <span className="wpd-card__hint">{hint}</span>}
				{hintContent}
			</button>
			{(copyUrl || onNewTab) && (
				<div className="wpd-card__aux">
					{copyUrl && (
						<button
							type="button"
							className={`wpd-card__aux-btn ${copied ? 'is-copied' : ''}`}
							onClick={handleCopy}
							disabled={disabled}
							aria-label={copied ? chrome.i18n.getMessage('copied_label') /* "Copied" */ : chrome.i18n.getMessage('copy_url_label') /* "Copy URL" */}
							title={copied ? chrome.i18n.getMessage('copied_label') /* "Copied" */ : chrome.i18n.getMessage('copy_url_label') /* "Copy URL" */}
						>
							<Icon icon={copied ? check : copy} size={16} />
						</button>
					)}
					{onNewTab && (
						<button
							type="button"
							className="wpd-card__aux-btn"
							onClick={onNewTab}
							disabled={disabled}
							aria-label={chrome.i18n.getMessage('open_new_tab_label') /* "Open in new tab" */}
							title={chrome.i18n.getMessage('open_new_tab_label') /* "Open in new tab" */}
						>
							<Icon icon={external} size={16} />
						</button>
					)}
				</div>
			)}
		</div>
	);
}
