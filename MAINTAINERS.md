# Maintainers

The current maintainer set, with affiliation disclosed.

| GitHub | Name | Affiliation | Role |
|---|---|---|---|
| [@jakemgold](https://github.com/jakemgold) | Jake Goldman | [Fueled](https://fueled.com/) (formerly [10up](https://10up.com/)) | Project originator; maintainer |
| [@fabiankaegy](https://github.com/fabiankaegy) | Fabian Kägy | [Fueled](https://fueled.com/) (formerly [10up](https://10up.com/)) | Maintainer — React popup architecture, Safari companion, Site Information panel, Block Inspector |

## Notable contributors

Contributors whose sustained work has shaped the extension, beyond the maintainer set:

| GitHub | Name | Contributions |
|---|---|---|
| [@itzmekhokan](https://github.com/itzmekhokan) | Khokan Sardar | The project's most active community contributor — Mobile Preview window reuse ([#67](https://github.com/WordPress/browser-extension/pull/67)), the meticulously verified QA pass on the 1.0 release candidate ([#76](https://github.com/WordPress/browser-extension/pull/76)), and a steady stream of reported-and-fixed issues across the popup, detection, and storage |

The full picture lives in the [contributor graph](https://github.com/WordPress/browser-extension/graphs/contributors).

## Affiliation disclosure

Both maintainers work at **[Fueled](https://fueled.com/)** (formerly **[10up](https://10up.com/)**) — a digital agency with a substantial WordPress practice. The extension was incubated independently and is hosted under the WordPress GitHub organization — community-branded, not Fueled-product-branded — so anyone in the WordPress community can contribute on equal footing.

Decisions are made on the merits in public threads (Issues, Discussions, PR review). No private channel takes precedence over public discussion.

## How to reach us

- **Public, project-scoped**: GitHub Issues and Discussions on this repo.
- **Security disclosure**: see [`SECURITY.md`](SECURITY.md).

## Project governance for non-maintainer decisions

For decisions that affect the project's posture but not its day-to-day code:

- **API and permissions surface promises**. The set of `permissions`, `host_permissions`, content-script injection rules, and stored data are discussed publicly and locked at v1.0. New permission requests after 1.0 require a deprecation/migration plan.
- **Browser-store submissions**. Chrome Web Store and Safari / Mac App Store listings under a WordPress publisher account are the v1.0 goal; Firefox Add-ons (AMO) and Edge Add-ons follow post-1.0. The publisher-account question requires WordPress Foundation alignment.
- **Trademark / branding / display-name changes**. Anything touching the "WordPress" word mark, the public extension display name, or Safari/Mac bundle identifiers requires WordPress Foundation alignment.
- **Renames or repository moves**. Documented in an Issue and announced before any move.

## Origin

This project began as [jakemgold/wp-detective](https://github.com/jakemgold/wp-detective) and moved here at v0.8 to become the official WordPress browser extension. The original repository is preserved as the project's archived origin.
