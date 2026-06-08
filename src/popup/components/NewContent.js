import { useState } from 'react';
import { Collapsible, Icon } from '@wordpress/ui';
import { chevronDown, plus, post, page, media, people } from '@wordpress/icons';
import { ActionRow } from './ActionRow';

/**
 * Maps admin-bar item ids (e.g. "post", "page", "media", "user") to the
 * best-matching @wordpress/icons glyph. Everything else falls back to the
 * generic plus icon so custom post types still get a sensible visual.
 */
const ICON_BY_ID = {
	post,
	page,
	media,
	user: people,
};

const iconFor = (id) => ICON_BY_ID[id] || plus;

export function NewContent({ items = [], onOpen }) {
	const [open, setOpen] = useState(false);
	if (!items.length) return null;

	return (
		<Collapsible.Root open={open} onOpenChange={setOpen} className="wpd-newcontent">
			<Collapsible.Trigger className="wpd-newcontent__trigger">
				<span className="wpd-newcontent__label-group">
					<Icon icon={plus} size={16} />
					<span className="wpd-newcontent__label">{chrome.i18n.getMessage('new_content_label') /* "New" */}</span>
				</span>
				<span className={`wpd-newcontent__chevron ${open ? 'is-open' : ''}`} aria-hidden="true">
					<Icon icon={chevronDown} size={14} />
				</span>
			</Collapsible.Trigger>
			<Collapsible.Panel className="wpd-newcontent__panel">
				<div className="wpd-newcontent__items">
					{items.map((item) => (
						<ActionRow
							key={item.id}
							icon={iconFor(item.id)}
							label={item.label}
							onClick={() => onOpen(item.href)}
							onNewTab={() => onOpen(item.href, true)}
						/>
					))}
				</div>
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}
