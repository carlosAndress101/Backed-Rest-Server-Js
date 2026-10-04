# Demo Page Specification

## Purpose

Define the removal of the `public/` Google Sign-In demo page (CQ-07, owner decision D1) and the explicit, testable security-header consequences of that removal on `app.ts`'s Helmet configuration and global response headers. No deployment of this demo page exists (owner-confirmed 2026-09-23), and `/docs` plus the `.http` collection replace it as the developer-facing tool.

## Requirements

### Requirement: `public/` demo page is removed

The system MUST remove the `public/` directory (`index.html`, `js/auth.js`, `css/index.css`, `assets/*.svg`) and MUST remove the `express.static(PUBLIC_DIR)` mount from `src/app.ts`.

#### Scenario: Demo page files no longer exist

- GIVEN the repository state after this change
- WHEN the filesystem is inspected for `public/index.html`, `public/js/auth.js`, `public/css/index.css`, and `public/assets/`
- THEN none of these paths exist

#### Scenario: Static mount is removed from the composition root

- GIVEN `src/app.ts`'s `createApp` function
- WHEN its source is inspected
- THEN no `express.static` call referencing the former `public/` directory remains

#### Scenario: Root GET no longer serves the demo page

- GIVEN the application has started without the demo page
- WHEN a client sends `GET /`
- THEN the response is not the demo page HTML (not a 200 with the former `index.html` content)

### Requirement: Global security headers are simplified consistently with removal

The system MUST remove the `HELMET_OPTIONS` CSP/COOP entries that existed solely to support the Google Sign-In widget on the removed demo page: the `gsi`/`fonts` allowlist entries in `scriptSrc`/`styleSrc`, the `frameSrc` allowance, the `connectSrc` GSI allowance, and the `crossOriginOpenerPolicy: 'same-origin-allow-popups'` setting. The system MUST NOT remove or alter `crossOriginResourcePolicy` (CORP) unless a design-phase finding proves that setting was page-only; absent such proof, CORP MUST remain unchanged.

#### Scenario: CSP no longer allowlists GSI/fonts origins

- GIVEN the application has started after this change
- WHEN a client sends any request and the `Content-Security-Policy` header is inspected
- THEN `scriptSrc` and `styleSrc` do not include the Google Sign-In or Google Fonts origins that were present before this change
- AND `frameSrc` no longer includes the GSI frame allowance
- AND `connectSrc` no longer includes the GSI connect allowance

#### Scenario: Cross-Origin-Opener-Policy reverts to a stricter default

- GIVEN the application has started after this change
- WHEN a client sends any request and the `Cross-Origin-Opener-Policy` response header is inspected
- THEN its value is no longer `same-origin-allow-popups`

#### Scenario: CORP is unchanged absent a page-only proof

- GIVEN no design-phase finding proves `crossOriginResourcePolicy` was scoped only to the demo page
- WHEN the application's response headers are inspected after this change
- THEN `Cross-Origin-Resource-Policy` has the same value it had before this change

### Requirement: Integration tests assert the updated header set

The system MUST update `tests/integration/platform/app.test.ts`'s security-header assertions to match the post-removal `HELMET_OPTIONS`, replacing any assertion that depended on the removed GSI-specific allowances or the removed demo page route.

#### Scenario: Header assertions reflect the simplified CSP

- GIVEN `tests/integration/platform/app.test.ts` after this change
- WHEN its security-header test cases run
- THEN they assert the absence of the removed GSI/fonts CSP entries and the removed COOP value
- AND they do not reference the removed `public/` route or demo page content

#### Scenario: No test depends on the removed demo page

- GIVEN the full test suite after this change
- WHEN it is run
- THEN no test references `public/index.html`, the demo page route, or the removed Google Sign-In client-side flow

### Requirement: CQ-07 and API_PROGRESS ledger are closed for the demo page

The system MUST close TECH_DEBT item CQ-07 referencing this change, and MUST update `API_PROGRESS.md` row 23 (the former demo-page route entry) to reflect its removal (e.g. marked removed, consistent with the existing convention used for other removed rows), and MUST record the removal under `CHANGELOG.md`'s `[Unreleased]` → `Removed` section as a non-API asset change.

#### Scenario: CQ-07 is closed

- GIVEN `TECH_DEBT.md`'s CQ-07 entry is open before this change
- WHEN the change is applied
- THEN the entry is marked closed/resolved, recording the removal decision

#### Scenario: API_PROGRESS row reflects removal

- GIVEN `API_PROGRESS.md`'s row for the former demo-page route
- WHEN the change is applied
- THEN the row is marked removed, consistent with the convention already used for other removed rows in that ledger

#### Scenario: CHANGELOG records the removal

- GIVEN `CHANGELOG.md`'s `[Unreleased]` section
- WHEN the change is applied
- THEN a `Removed` entry describes the demo page removal as a non-API asset change
