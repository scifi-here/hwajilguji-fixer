# Review rules

Review the code, not the description. Each finding names the file, the line, the consumer that breaks, and the severity. A finding that no command or test can check is not a finding.

## Blocking defects

### Model bytes without proof

Every file in `web/static/models/` must match its SHA-256 in `models.json` and must have a row in `NOTICE.md`. `session.ts` rejects a mismatch with `ModelIntegrityError`. `web/tests/models.test.ts` checks the files on disk. `hwajilguji-tools export` is the only source of those bytes and hashes. A change that edits a hash by hand, or adds a model file that the export tool did not write, is blocking.

### Whole-image tensors

Every model call goes through `runTiled` in `web/src/lib/pipeline/tiles.ts`. A route that calls `session.run` on a full image ignores the pixel caps in `limits.ts` and runs out of memory on the WebAssembly backend. `web/tests/tiles.test.ts` proves that tiled output equals whole-image output. A route that bypasses `runTiled` has no such proof. `session.ts` is the only module that imports `onnxruntime-web`.

### Cross-origin isolation

The app is served from a static host that sends no COOP or COEP headers. Code that reads `SharedArrayBuffer`, sets `numThreads` above 1, or needs a response header breaks on that host. The e2e test runs against a plain `vite preview` server and catches it.

### Edited gate truth

Gate fixtures and their labels come only from `hwajilguji-tools fixtures`. It labels each file by how the file was degraded. A diff in `web/tests/fixtures/gate/` that the tool did not produce is blocking. A change that edits a label to make `gate.test.ts` pass is blocking. Fix `thresholds.ts` or the algorithm instead.

### Lossy output

The only export format is PNG. Code that encodes JPEG, WebP, or AVIF output adds the damage this tool removes.

## Slop and structure

`lefthook.yml` declares the gates: Biome, `svelte-check`, vitest, ruff, pyright in strict mode, and pytest. A change that passes only because a gate was weakened, skipped, or filtered is blocking.

Flag dead code, unreferenced exports, commented-out code, placeholder or TODO residue, debug logging, and copies of one behavior. Flag every compatibility shim, alias, and deprecated route. A replaced path is deleted in the same change, with all of its callers migrated.

Flag comments that explain code. The fix is a better name or a smaller function.

Flag a test that cannot fail under a real defect: a snapshot, a saved expected output, a mock that echoes its input, or a tautology. A new test must name the fault it detects. The author shows that the test fails when that fault is introduced.

Flag any Python run outside uv.
