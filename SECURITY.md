# Security policy

Browser extensions sit in a sensitive position — they run with broad host permissions across every site you visit and have access to cookies on those sites. Vulnerabilities here matter, and we take them seriously.

## Reporting a vulnerability

If you believe you've found a security issue in this extension:

- **Do not open a public GitHub Issue or Discussion.**
- Use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this repo. This creates an advisory only visible to maintainers.
- If GitHub's private reporting is unavailable for any reason, contact a maintainer directly via the email on their GitHub profile.

Please include:

- A description of the issue and its impact (e.g. "feature X exfiltrates Y to Z")
- Reproduction steps or a minimal proof-of-concept
- Browser, operating system, and extension version
- Whether you've shared the report with anyone else

### Response

We aim to acknowledge reports within five business days. After triage we coordinate with the reporter on a disclosure timeline. The default is: fix in private → release patch and store update → publish advisory and credit the reporter (unless they prefer to remain anonymous).

## Scope

**In scope:**

- The shipping extension runtime: `background.js`, `content.js`, `lib/*`, `popup/*`
- The Safari companion app under `safari/`
- Build scripts that produce the distributed bundles: `scripts/*`, build configuration

**Out of scope:**

- Vulnerabilities in third-party WordPress sites the extension interacts with — report those to the site operator
- Issues only reproducible on heavily modified or unmaintained browser builds
- Self-XSS or social-engineering attacks that require the user to paste content into devtools
- Findings against unreleased branches or PR builds (please test against a tagged release)

## Permissions reasoning

The extension requests `storage`, `activeTab`, `scripting`, `cookies`, and `host_permissions` for `http://*/*` and `https://*/*`. The reasoning for each is documented in [`CONTRIBUTING.md`](CONTRIBUTING.md#conventions). New permission requests are discussed publicly before being added, and the v1.0 milestone freezes the surface.

### Chrome package: `activeTab` removed

The **shipped Chrome package** drops `activeTab`. With the broad `http`/`https` host permissions already present, `activeTab` grants nothing extra — Chrome's restricted "on click" site-access mode works by withholding and re-granting host permissions on invocation, not through `activeTab` — and the Chrome Web Store expects the narrowest permission set that supports shipped functionality. `scripts/package-chrome.sh` stages the manifest through `scripts/stage-chrome-manifest.js`, which filters `activeTab` out. This is the only point where the submitted Chrome manifest diverges from the repository manifest.

The **repository manifest**, which the Safari build mirrors verbatim, keeps `activeTab` for now: an earlier permission-narrowing experiment broke Safari detection in ways we didn't foresee, so Safari-side removal is deferred to the Safari / App Store store-readiness pass, where it will be re-evaluated and tested before submission. Until then Safari intentionally ships the superset. See [issue #61](https://github.com/WordPress/browser-extension/issues/61).
