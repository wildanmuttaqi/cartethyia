# Cartethyia Local Fixes

This file records local behavior fixes that must survive Cartethyia updates.
Treat it as a porting checklist, not as a replacement for upstream files.

## Before Updating

1. Preserve the current working tree or make a backup before replacing files.
2. Update Cartethyia, then inspect the current implementation and tests listed below.
3. Check whether upstream already contains equivalent behavior. If it does, keep the upstream implementation and verify these cases instead of adding a duplicate patch.
4. If behavior is missing, port the smallest change into the current code. Do not copy an old file over a newer upstream file.
5. Run the listed regression tests, `bun run typecheck`, and `git diff --check` before building or deploying.

## Codex Responses Must Not Go Blank

**Symptom:** A Codex Responses stream can finish without sending any `response.output_text.delta`. If the decoder only forwards deltas, the model's final answer is lost and the client receives a blank response.

**Required behavior:** In `src/protocol/response/codex.ts`, `CodexStreamFrameProcessor` must recover non-empty text from the final `response.output_text.done` frame or from `output_text` blocks in `response.output_item.done`. It must not echo final text when a delta for the same item/content has already been emitted, and it must not emit the same final text twice when both final frame types arrive. Preserve normal streaming deltas and terminal handling.

The implementation may change across upstream versions; preserve the behavior, not the private field names or exact code shape.

**Regression coverage:** `test/protocol/codex-response.test.ts` must cover:

- Final text frames recover an answer when no text delta was sent.
- An `output_item.done` frame alone can recover the answer.
- Existing streamed text is not duplicated by either final frame.

Run:

```sh
bun test test/protocol/codex-response.test.ts
```

The test imports `CanonicalEvent` from `src/protocol/canonical-model.ts`.

## Model Lab Requires a Default Gateway Key

**Symptom:** Model Lab reports `The default gateway API key is missing. Complete first-boot setup before sending.` after restoring a backup on a fresh installation.

**Cause:** Normal first-boot setup seeded a default gateway API key, but first-boot backup restore could finish with an administrator and no default key when the backup omitted `api_keys`.

**Required behavior:** In `src/console/auth/setup-service.ts`, both normal setup and first-boot restore must ensure the restoring tenant has one default gateway API key. Reuse the default key already present in the backup; only create one when none exists. A newly created key must use `CARTETHYIA_API_KEY` when configured, or generate a secret otherwise, then hash it for authentication and encrypt it for retrieval. Do not create duplicates or overwrite a restored key. Keep the operation inside the restore failure-cleanup path so a failed setup does not leave a partial first-boot tenant behind.

**Regression coverage:** `test/console/backup-sqlite-restore.test.ts` must verify that:

- A first-boot restore without `api_keys` creates exactly one encrypted default key.
- A first-boot restore containing a default key preserves it without adding another.

Run:

```sh
bun test test/console/backup-sqlite-restore.test.ts
```

## Deployment

These are source changes. If Cartethyia runs from a Docker image, rebuild and deploy the updated image before expecting the fixes to take effect; updating source or this document alone does not update a running container.