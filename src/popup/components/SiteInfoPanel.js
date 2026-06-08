import { useMemo, useRef, useState } from 'react';
import { Collapsible, Icon } from '@wordpress/ui';
import { chevronDown, info as infoIcon } from '@wordpress/icons';
import { requestSiteInfo } from '../lib/actions';
import { mergePlugins, mergeTheme, stripTags } from '../../../lib/site-info.js';

/**
 * Surfaces whatever metadata we can gather about the site: active theme,
 * installed plugins, site name/description, REST namespaces.
 *
 * Site info is fetched lazily on first expand. DOM-detected slugs and REST
 * data are merged only after that fetch settles so counts and pills do not
 * jump while loading (see #5).
 */
export function SiteInfoPanel({ ctx, origin, onOpen }) {
	const [open, setOpen] = useState(false);
	const [data, setData] = useState(null);
	const [loading, setLoading] = useState(false);
	const [attempted, setAttempted] = useState(false);
	const fetchStartedRef = useRef(false);
	const snapshotRef = useRef({ pluginSlugs: [], themeSlug: null });

	const handleOpenChange = (next) => {
		setOpen(next);
		if (!next || fetchStartedRef.current) {
			return;
		}
		// Guard synchronously — setLoading(true) is async, and Collapsible can
		// emit onOpenChange(true) more than once per expand, which previously
		// kicked off overlapping GET_SITE_INFO requests that completed out of
		// order and made the plugin list/count flicker.
		fetchStartedRef.current = true;
		snapshotRef.current = {
			pluginSlugs: Array.isArray(ctx.pluginSlugs) ? [...ctx.pluginSlugs] : [],
			themeSlug: ctx.themeSlug || null,
		};
		setLoading(true);
		requestSiteInfo()
			.then((res) => {
				setData(res);
			})
			.finally(() => {
				setLoading(false);
				setAttempted(true);
			});
	};

	const activeTheme = data?.activeTheme || null;
	const plugins = data?.plugins || null;
	const siteInfo = data?.siteInfo || null;
	const { pluginSlugs: snapshotSlugs, themeSlug: snapshotTheme } = snapshotRef.current;

	const pluginRows = useMemo(() => {
		if (loading) {
			return [];
		}
		return mergePlugins(snapshotSlugs, plugins, siteInfo?.namespaces);
	}, [loading, snapshotSlugs, plugins, siteInfo]);

	const themeInfo = useMemo(() => {
		if (loading) {
			return null;
		}
		return mergeTheme(snapshotTheme, activeTheme);
	}, [loading, snapshotTheme, activeTheme]);

	const hasAnything = !!themeInfo || pluginRows.length > 0;
	const showPluginsSection =
		loading || pluginRows.length > 0 || (attempted && snapshotSlugs.length > 0);

	if (!hasAnything && !ctx.restApiRoot && !loading && !attempted) {
		return null;
	}

	return (
		<Collapsible.Root open={open} onOpenChange={handleOpenChange} className="wpd-siteinfo">
			<Collapsible.Trigger className="wpd-siteinfo__trigger">
				<span className="wpd-siteinfo__label-group">
					<Icon icon={infoIcon} size={16} />
					<span className="wpd-siteinfo__label">{chrome.i18n.getMessage('site_info_label') /* "Site Information" */}</span>
				</span>
				<span
					className={`wpd-siteinfo__chevron ${open ? 'is-open' : ''}`}
					aria-hidden="true"
				>
					<Icon icon={chevronDown} size={14} />
				</span>
			</Collapsible.Trigger>
			<Collapsible.Panel className="wpd-siteinfo__panel">
				<div className="wpd-siteinfo__body">
					{loading && (
						<p className="wpd-siteinfo__hint wpd-siteinfo__hint--loading" aria-live="polite">
							{chrome.i18n.getMessage('site_info_loading') /* "Loading site information…" */}
						</p>
					)}

					{!loading && themeInfo && (
						<InfoGroup label={chrome.i18n.getMessage('active_theme_label') /* "Active theme" */}>
							<ThemeRow theme={themeInfo} origin={origin} onOpen={onOpen} />
						</InfoGroup>
					)}

					{!loading && showPluginsSection && (
						<InfoGroup label={pluginsPluginLabel(plugins, pluginRows.length)}>
							{pluginRows.length > 0 && (
								<div className="wpd-siteinfo__pills">
									{pluginRows.map((p) => (
										<PluginPill key={p.slug} plugin={p} onOpen={onOpen} />
									))}
								</div>
							)}
							{attempted && !plugins && pluginRows.length > 0 && (
								<p className="wpd-siteinfo__hint">
									{chrome.i18n.getMessage('login_for_plugin_list') /* "Log in for a comprehensive list of plugins with additional information." */}
								</p>
							)}
						</InfoGroup>
					)}

					{!loading && attempted && !hasAnything && (
						<p className="wpd-siteinfo__hint">{chrome.i18n.getMessage('nothing_detected') /* "Nothing extra we could detect." */}</p>
					)}
				</div>
			</Collapsible.Panel>
		</Collapsible.Root>
	);
}

function pluginsPluginLabel(plugins, count) {
	if (plugins) {
		return chrome.i18n.getMessage('plugins_with_count', [String(count)]); // "Plugins (N)"
	}
	if (count > 0) {
		return chrome.i18n.getMessage('detected_plugins_with_count', [String(count)]); // "Detected plugins (N)"
	}
	return chrome.i18n.getMessage('plugins_label'); // "Plugins"
}

function InfoGroup({ label, children }) {
	return (
		<div className="wpd-siteinfo__group">
			<div className="wpd-siteinfo__group-label">{label}</div>
			<div className="wpd-siteinfo__group-items">{children}</div>
		</div>
	);
}

function ThemeRow({ theme, origin, onOpen }) {
	// hasRestDetail correlates with admin login — the REST themes endpoint
	// requires edit_theme_options, which only admins have. So this is also
	// our signal for "is the row actionable."
	const hasRestDetail = !!(theme.version || theme.author);
	const tooltip = theme.version ? `${theme.name} ${theme.version}` : theme.name;
	const body = (
		<div className="wpd-siteinfo__row-main">
			<div className="wpd-siteinfo__row-title">
				{theme.name}
				{theme.version && (
					<span className="wpd-siteinfo__row-version">{theme.version}</span>
				)}
			</div>
			<div className="wpd-siteinfo__row-sub">
				{hasRestDetail ? (
					<>
						{theme.slug && <code>{theme.slug}</code>}
						{theme.author && <span>by {stripTags(theme.author)}</span>}
					</>
				) : (
					<span>{chrome.i18n.getMessage('login_for_info') /* "Log in for additional information." */}</span>
				)}
			</div>
		</div>
	);
	if (!hasRestDetail) {
		// No useful destination when logged out — the row is informational.
		return <div className="wpd-siteinfo__row" title={tooltip}>{body}</div>;
	}
	// Admin: open the themes management page (browse, switch, configure).
	return (
		<button
			type="button"
			className="wpd-siteinfo__row wpd-siteinfo__row--button"
			onClick={() => onOpen(`${origin}/wp-admin/themes.php`, true)}
			title={tooltip}
		>
			{body}
		</button>
	);
}

function PluginPill({ plugin, onOpen }) {
	const label = plugin.name || plugin.slug;
	// Prefer the plugin's own homepage URL when REST gave us one. Otherwise
	// fall back to the wp.org plugin directory — works for hosted plugins
	// and 404s gracefully for premium/custom ones.
	const href = plugin.pluginUri || `https://wordpress.org/plugins/${plugin.slug}/`;
	const tooltip = plugin.version ? `${label} ${plugin.version}` : label;
	return (
		<button
			type="button"
			className="wpd-siteinfo__pill"
			onClick={() => onOpen(href, true)}
			title={tooltip}
		>
			{label}
		</button>
	);
}
