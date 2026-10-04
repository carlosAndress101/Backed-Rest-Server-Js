# Developer Documentation Specification

## Purpose

Define the hand-authored developer-facing documentation deliverables that close TECH_DEBT DOC-01: a root `README.md`, a committed `.env.example`, an error-code catalogue, and a runnable `.http`/curl example collection. These artifacts let a new consumer or agent set up, authenticate, and call the API without reading source first, while pointing to (not duplicating) `ARCHITECTURE.md` and `API_PROGRESS.md`.

## Requirements

### Requirement: Root README covers setup, environment, scripts, and an architecture summary

The system MUST provide a root `README.md` that documents:
- Setup: Node 24, pnpm, and MongoDB prerequisites, and the commands to install and run the project locally.
- Environment: every variable defined in `envSchema` (`src/config/env.ts`), including `DOCS_ENABLED`.
- Scripts: every script defined in `package.json`.
- Architecture: a short summary that links to `ARCHITECTURE.md` and `API_PROGRESS.md` rather than reproducing their content.
- The error-code catalogue file's location, linked rather than reproduced (placement per the approved decision: a root `ERROR_CODES.md`).

#### Scenario: Every env schema key is documented in the README

- GIVEN the keys defined in `envSchema` in `src/config/env.ts`
- WHEN a doc-drift test compares them against the environment variables named in `README.md`
- THEN every `envSchema` key appears in the README
- AND the test fails if a key is added to `envSchema` without a corresponding README mention

#### Scenario: Every package.json script is documented in the README

- GIVEN the script names defined in `package.json`
- WHEN a doc-drift test compares them against the scripts named in `README.md`
- THEN every script name appears in the README
- AND the test fails if a script is added to `package.json` without a corresponding README mention

#### Scenario: Architecture summary links instead of duplicating

- GIVEN the README's architecture section
- WHEN its content is inspected
- THEN it contains a link/reference to `ARCHITECTURE.md` and to `API_PROGRESS.md`
- AND it does not reproduce their detailed ADR log or full route ledger content verbatim

#### Scenario: README has no root README gap

- GIVEN the repository previously had no root `README.md` (TECH_DEBT DOC-01)
- WHEN the repository is inspected after this change
- THEN a root `README.md` file exists and is non-empty

### Requirement: `.env.example` lists every configuration key with placeholder values

The system MUST provide a committed root `.env.example` file listing every key defined in `envSchema`, each with a placeholder value (no real secrets, tokens, or credentials), including `DOCS_ENABLED`.

#### Scenario: Every env schema key appears in `.env.example`

- GIVEN the keys defined in `envSchema`
- WHEN a doc-drift test compares them against the keys present in `.env.example`
- THEN every key appears
- AND no key's example value is a real secret (verified by the absence of production-like credential patterns)

#### Scenario: `.env.example` is sufficient to boot the application

- GIVEN a copy of `.env.example` renamed to `.env` with placeholder values substituted for valid-shaped local values
- WHEN the application attempts to boot in a local/dev configuration
- THEN `loadConfig()` does not reject due to a missing or malformed key present in the schema

### Requirement: `.http` collection covers every live API operation

The system MUST provide a committed `.http` (or equivalent REST client format) collection containing exactly one request per live API operation (21 operations), runnable against a locally running `pnpm dev` instance using variables for the base URL and an authentication token.

The README MUST include a curl quick start demonstrating the sign-in (or sign-up) → authenticated call flow end to end.

#### Scenario: Collection has one request per live operation

- GIVEN the 21 live API operations documented in the OpenAPI catalog
- WHEN the `.http` collection file is inspected
- THEN it contains exactly one request entry per operation, matching method and path
- AND no operation is missing and no extraneous (non-existent) operation is present

#### Scenario: Collection requests are parameterized, not hardcoded

- GIVEN any authenticated request in the `.http` collection
- WHEN its headers are inspected
- THEN the authorization value references a variable (for example `{{token}}`) rather than a hardcoded credential

#### Scenario: README curl quick start demonstrates the auth flow

- GIVEN the README's curl quick-start section
- WHEN its steps are followed against a locally running instance
- THEN a sign-in (or sign-up) request returns a token
- AND a subsequent authenticated request using that token succeeds

### Requirement: Error-code catalogue documents all ErrorCodes and the envelope contract

The system MUST provide a root `ERROR_CODES.md` file (linked from the README, per the approved placement decision) documenting all 9 `ErrorCode` values from `src/core/errors/app-error.ts`: each entry MUST state its HTTP status, its meaning, its typical triggers (including the `toAppError` mappings: request-too-large → 413, Mongoose duplicate key → 409, cast/validation errors → 400, unrecognized errors → 500 fallback), and the `details` field semantics for the 422 validation-failure case (an array of `{ path, message }` issue objects).

The catalogue MUST also document the shared error envelope shape (`{ error: { code, message, details? } }`, ADR-021).

#### Scenario: Every ErrorCode is present in the catalogue

- GIVEN the 9 `ErrorCode` values
- WHEN a test or script checks `ERROR_CODES.md` for a documented entry per code
- THEN all 9 are present, each with its HTTP status stated

#### Scenario: Catalogue documents the envelope shape

- GIVEN `ERROR_CODES.md`
- WHEN its introductory section is inspected
- THEN it describes the `{ error: { code, message, details? } }` envelope shape matching the live `error-handler.ts` output

#### Scenario: Catalogue documents the `details` semantics for validation failures

- GIVEN the `VALIDATION_FAILED` (422) entry in the catalogue
- WHEN its description is inspected
- THEN it states that `details` is an array of `{ path, message }` validation issue objects and is only populated for this error code

### Requirement: Documentation ledger closure

The system MUST update, as part of this change: `TECH_DEBT.md` to close item DOC-01, `API_PROGRESS.md` row 23 (or its successor row after any demo-page removal) to reflect the completed documentation milestone, `ROADMAP.md`'s M8 entry with its outcome, `CHANGELOG.md`'s `[Unreleased]` section with entries describing the new documentation and `/docs` capability, and `ARCHITECTURE.md` with new ADR entries (ADR-045 onward) recording the accepted decisions D1 through D6.

#### Scenario: TECH_DEBT DOC-01 is closed

- GIVEN `TECH_DEBT.md`'s DOC-01 entry is open before this change
- WHEN the change is applied
- THEN the entry is marked closed/resolved with a reference to this change

#### Scenario: CHANGELOG records the new capability

- GIVEN `CHANGELOG.md`'s `[Unreleased]` section
- WHEN the change is applied
- THEN it contains an `Added` entry describing the OpenAPI document, `/docs` serving, and the developer documentation deliverables

#### Scenario: New ADR entries record the owner decisions

- GIVEN `ARCHITECTURE.md`'s ADR log
- WHEN the change is applied
- THEN new ADR entries starting at ADR-045 document the accepted decisions for OpenAPI generation (native `z.toJSONSchema`), docs UI (dependency-free CDN-pinned static page), the `DOCS_ENABLED` flag shape, the search-route documentation approach, and the error-catalogue placement
