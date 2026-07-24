# WordPress Browser Extension — Safari

The extension ships a companion Xcode project under `safari/` that wraps the
same extension files in a macOS host app — Safari's own packaging model.
The runtime (background, content scripts, popup) is identical to the
Chrome build.

> The container app and extension targets use `org.wordpress.browserextension`
> / `org.wordpress.browserextension.Extension` as their bundle identifiers,
> under the WordPress Foundation Apple Developer account (Team ID
> `6MBPTHPZ22`). The committed project deliberately leaves `DEVELOPMENT_TEAM`
> unset so that contributors outside that team can build and run locally with
> personal or ad-hoc signing; the team is selected at archive/submission time.
> Development installs signed under the previous `com.fabiankaegy.wp-detective`
> identifiers appear to Safari as a separate leftover extension and can be
> removed by deleting the old built app.

## Build & install (developer)

Requirements: macOS with Xcode installed (not just Command Line Tools).

```
git clone https://github.com/WordPress/browser-extension.git
cd browser-extension
npm install
npm run build:safari
open 'safari/WordPress Browser Extension/WordPress Browser Extension.xcodeproj'
```

In Xcode:

1. Select the `WordPress Browser Extension` scheme (the default).
2. Press **Run** (⌘R). Xcode builds the container app, installs it, and
   launches it once.
3. Quit the launched app.
4. Open Safari → Settings → Extensions → enable **WordPress Browser Extension**.

If Safari refuses to enable an unsigned extension, turn on:
**Safari → Develop → Allow Unsigned Extensions**. This setting resets each
time Safari quits — unsigned dev builds need to be re-enabled per session.

## Keeping the Safari build in sync

The Xcode project references files it has its own copies of under
`safari/WordPress Browser Extension/WordPress Browser Extension Extension/Resources/`.
`npm run build:safari` rebuilds the popup bundle and rsyncs every shipping
runtime file into that folder, so re-run it whenever `manifest.json`,
`background.js`, `content.js`, `lib/*`, `popup/popup.html`, `options/*`,
or any icon changes.

If new top-level files or folders are added to the runtime (e.g. the
`options/` folder in v0.9, or `_locales/` for i18n), they also have to be
registered in the Xcode project file
(`WordPress Browser Extension.xcodeproj/project.pbxproj`) as a folder
reference. Open the project in Xcode, drag the folder into the Resources
group, and choose "Create folder references" so future files inside it sync
automatically. **A missed registration is silent**: `sync-safari.sh` still
copies the folder into `Resources/`, but Xcode won't bundle it, so the built
extension ships without it — e.g. an unregistered `_locales/` left the
manifest's `__MSG_*` name unresolved and Safari dropped the extension with no
error. Files added inside an already-registered folder (e.g. another
`lib/*.js`) need no project change.

## Toolbar icon

The toolbar icon ships as a single full-color set (`icons/icon-*.png`, rendered
from `icons/src/*.svg` by `scripts/render-icons.js`) used by both Chrome and
Safari. Safari template-renders a toolbar icon — paints its alpha shape with the
system color and discards the icon's own colors — *only* when it reads the icon
as monochrome (a black/grayscale shape on transparency). An icon carrying
genuine color is rendered as-is. This is the opt-out extensions like 1Password
rely on, and it keeps all three states distinct in Safari:

- **WordPress, logged in** — blue disc, white W, green corner dot.
- **WordPress, logged out** — blue disc, white W.
- **Not WordPress / default** — muted slate disc, white W (no slash).

Because the monochrome check is unreliable for near-grayscale darks, the muted
"not WordPress" state is a clearly-saturated slate (`#2c3e50`), not a near-gray —
a too-desaturated fill can still be flattened to a tinted blob. **Don't
reintroduce a monochrome/silhouette icon set for Safari**; it re-collapses the
logged-in and logged-out states to a single tinted W (see #15).

## Known issues

### Popup leaves a gap at the bottom after collapsing an accordion

When an accordion (Site Information, Developer Tools, +New) expands the
popup tall enough to scroll, then collapses, Safari leaves the popup
window at the previous (taller) size — the now-shorter content sits at
the top with empty space below, and there's nothing scrollable to
re-anchor on. Closing and reopening the popup restores the correct size.

Cause: Safari Web Extension popup windows appear to size against the
WebContent process's first-paint measurement and don't re-measure when
the body shrinks. `App.js` pins `html` and `body` heights to the React
root's measured height to nudge a re-measure, which mitigates but does
not fully resolve it. Chrome auto-sizes correctly and the same code is
a no-op there.

Workarounds tried that didn't resolve it: ResizeObserver on body /
html, scrollTop reset, explicit min/max height, transform-trick reflow.

If the bug becomes a release blocker, the fallback is to pin the popup
to a fixed height (e.g. 600px) so it never grows or shrinks.

## Distribution

For personal use, a Debug build signed with an ad-hoc identity (as
produced by a plain ⌘R in Xcode) is enough.

Shipping to other Macs requires joining the Apple Developer Program (\$99/yr),
setting `DEVELOPMENT_TEAM` in the project settings, and either:

- notarizing a Release build of `WordPress Browser Extension.app` for direct distribution, or
- submitting to the Mac App Store (App Store Connect → new Mac app →
  attach the Safari extension target).

## Re-generating the Xcode project

The project under `safari/` was produced by:

```
xcrun safari-web-extension-converter ./path-to-runtime-files \
  --project-location ./safari \
  --app-name "WordPress Browser Extension" \
  --bundle-identifier org.wordpress.browserextension \
  --swift --macos-only --copy-resources --no-open
```

Re-run it only when changing major project structure (e.g. adding iOS,
renaming the app). One fix-up is needed after regeneration: the converter
auto-capitalizes the app's product name into the app bundle ID
(`org.wordpress.WordPress-Browser-Extension`), which then doesn't share
a prefix with the extension's bundle ID and fails the embedded-binary
check. Run:

```
sed -i '' \
  's|PRODUCT_BUNDLE_IDENTIFIER = "org.wordpress.WordPress-Browser-Extension";|PRODUCT_BUNDLE_IDENTIFIER = "org.wordpress.browserextension";|g' \
  'safari/WordPress Browser Extension/WordPress Browser Extension.xcodeproj/project.pbxproj'
```
