# Contributing

## Set up and check

```sh
pnpm install --frozen-lockfile
pnpm exec lefthook run pre-commit --all-files
```

The command runs every gate: Biome, `svelte-check`, vitest, ruff, pyright in strict mode, and pytest. A commit that fails a gate is not accepted. Do not weaken a gate to pass it.

Run all Python through uv: `uv run --frozen --project tools <command>`. Do not call `python`, `python3`, or `pip`. Change dependencies only with `uv add` or `uv remove`, and commit `tools/uv.lock` with the change.

## Invariants and the test that enforces each

- Model files match `models.json` and `NOTICE.md`: `web/tests/models.test.ts`, and the integrity check in `session.ts`.
- Every model call goes through `runTiled`: `web/tests/tiles.test.ts`. A new route reuses `runTiled`.
- The app works without cross-origin isolation: `numThreads` is 1, `SharedArrayBuffer` is unused, and `pnpm --dir web e2e` runs on a plain preview server.
- Gate fixtures and labels come only from `hwajilguji-tools fixtures`: `web/tests/gate.test.ts` reads them. When the test fails, change `web/src/lib/pipeline/thresholds.ts` or the algorithm. Never edit a fixture or a label.
- Output is PNG only. Add no lossy export path.

## Shape of a change

- One concern per commit. The subject is a capitalized imperative of at most 72 characters. The body says what changed and why.
- Replace, do not accrete. Migrate every caller and delete the old path in the same change. Add no shim, alias, or deprecated route.
- Write no comments and no commented-out code. Use names, types, and control flow to carry the meaning.
- Write tests first. Each test attacks one named fault and uses an oracle that does not run the code under test: a known degradation, a literal, a second library, or a mathematical invariant. Do not add snapshots or saved expected outputs. Show that the test fails when you introduce the fault.
- Add no plan, spec, or ADR file with a change. The spec in `docs/spec.md` changes only when a requirement changes.
- Use semantic names for files, functions, and sections. Use no opaque codes or sequence prefixes.
- Ship no stub, placeholder, or deferred part. A change is complete or it is not merged.
