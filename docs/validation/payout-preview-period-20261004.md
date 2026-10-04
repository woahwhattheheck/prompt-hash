# Payout preview period lifecycle — October 4, 2026

Source commit: `49acf7f16340436851d5c8094ddf81e5ccaf8b52`.
Source tree: `b043906f7e40e61a624f284be2ec87255b88eb76`.

Editing either period date now clears the old preview and its save/export actions. Both date controls are disabled during the existing load, preview and save operation. Starting a new preview clears the previous result, so a failed refresh cannot leave that stale result actionable. Saved statement rows and the existing wallet isolation and exact XLM formatting are retained.

The production change is +11/-2 in `src/components/profile/PayoutStatementsCard.tsx`. Three cases were added to its existing component test file; no dependency or application configuration changed.

## Executed result

[Owned-fork run 37207406377](https://github.com/woahwhattheheck/prompt-hash/actions/runs/37207406377) installed the unchanged project manifest and Yarn Classic lockfile with `yarn install --frozen-lockfile`.

- With the original component blob `c1b3fc425773ca7cb60be042907499fa503e1e8a` and the candidate tests, the three selected period-lifecycle cases failed as expected. The ten unrelated cases were excluded from this baseline selection.
- With candidate component blob `b850f20e639714220c16cf5c943aea01d46ae09f` and test blob `fb37fb259dad638eb72a2e37f33504b3383ebc95`, all **13 maintained component cases passed**, with zero failures or skips.
- Node 22.23.3; Yarn 1.22.22; React/React DOM 19.2.8; Vitest 4.1.10; jsdom 29.1.1; TypeScript 6.0.3. The manifest and lockfile were unchanged after execution.

Command on the candidate:

```sh
yarn vitest run src/components/profile/PayoutStatementsCard.test.tsx
```

[Artifact 11305376956](https://github.com/woahwhattheheck/prompt-hash/actions/runs/37207406377/artifacts/11305376956) contains the raw before/after JSON, logs, versions and source pins. ZIP SHA-256: `3afe87ffe472d91860eeaa4b9cf85c591a13dd38197a0baead401b74629b8616`. Its advertised retention ends October 11, 2026.

The preceding run 37207230866 selected Yarn 4 for a Yarn v1 lockfile and stopped at installation; it ran no tests. Only the isolated validation workflow was corrected. That workflow is not included in this PR.

This is real component execution in jsdom with mocked HTTP responses, not a live payout, backend integration run, browser end-to-end acceptance, full semantic typecheck or full application build. No sponsor acceptance or payment result is asserted.
