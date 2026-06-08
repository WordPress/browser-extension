import { EmptyState } from '@wordpress/ui';
import { error } from '@wordpress/icons';

export function ErrorView() {
	return (
		<EmptyState.Root className="wpd-empty">
			<EmptyState.Visual>
				<EmptyState.Icon icon={error} />
			</EmptyState.Visual>
			<EmptyState.Title>{chrome.i18n.getMessage('error_view_title') /* "Something went wrong" */}</EmptyState.Title>
			<EmptyState.Description>{chrome.i18n.getMessage('error_view_description') /* "Check the service-worker logs." */}</EmptyState.Description>
		</EmptyState.Root>
	);
}
