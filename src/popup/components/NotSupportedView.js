import { EmptyState } from '@wordpress/ui';
import { globe } from '@wordpress/icons';

export function NotSupportedView() {
	return (
		<EmptyState.Root className="wpd-empty">
			<EmptyState.Visual>
				<EmptyState.Icon icon={globe} />
			</EmptyState.Visual>
			<EmptyState.Title>{chrome.i18n.getMessage('not_supported_title') /* "Nothing to inspect here" */}</EmptyState.Title>
			<EmptyState.Description>{chrome.i18n.getMessage('not_supported_description') /* "Open a website to get started." */}</EmptyState.Description>
		</EmptyState.Root>
	);
}
