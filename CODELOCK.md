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
- Terminal-only `response.completed` and `response.done` recover message text from `response.output`, without replaying earlier deltas or done frames (dedup by item/output/content identity).
- Malformed terminal entries are skipped; terminal status, usage, and non-text handling remain intact.
- Existing streamed text is not duplicated by either final frame.

Run:

```sh
bun test test/protocol/codex-response.test.ts
```

The test imports `CanonicalEvent` from `src/protocol/canonical-model.ts`.

## Codex Tool Calls Must Survive Responses-to-Chat Conversion

Reference checked: `../referensi/9router/open-sse/translator/response/openai-responses.js`, `openaiResponsesToOpenAIResponse`. The reference emits tool identity at `response.output_item.added` and recovers arguments at `response.output_item.done` when argument deltas were absent. Cartethyia previously stored these final arguments without emitting them, producing a `tool_calls` finish reason with no tool payload. VS Code can reject this as an empty response.

Keep the Codex decoder's per-call recovery and deduplication: named identities on added, final input from argument-done/item-done/terminal output, buffering unnamed deltas until a name arrives, and no replay of already emitted arguments. Cover function/custom/computer calls and parallel calls. The tests in `test/protocol/codex-response.test.ts` verify actual `ChatStreamEncoder` chunks and `jsonCompletion`, not just internal flags. Preserve these tests when updating upstream. This does not guarantee a live upstream always sends usable output.

## Model Lab Requires a Default Gateway Key

**Symptom:** Model Lab reports `The default gateway API key is missing. Complete first-boot setup before sending.` after restoring a backup on a fresh installation.

**Cause:** Normal first-boot setup seeded a default gateway API key, but first-boot backup restore could finish with an administrator and no default key when the backup omitted `api_keys`.

**Required behavior:** In `src/console/auth/setup-service.ts`, both normal setup and first-boot restore must ensure the restoring tenant has one default gateway API key. Reuse the default key already present in the backup; only create one when none exists. A newly created key must use `CARTETHYIA_API_KEY` when configured, or generate a secret otherwise, then hash it for authentication and encrypt it for retrieval. Do not create duplicates or overwrite a restored key. Keep the operation inside the restore failure-cleanup path so a failed setup does not leave a partial first-boot tenant behind.

**Regression coverage:** `test/console/backup-sqlite-restore.test.ts` must verify that:

- A first-boot restore without `api_keys` creates exactly one encrypted default key.
- A first-boot restore containing a default key preserves it without adding another.
- Existing installations with console users but no default key are repaired on startup. `recoverMissingDefaultGatewayApiKeys` is called by `src/boot/dependencies.ts` after migrations, under the same transaction lock as first-boot setup. Do not remove this call: setup/restore fixes alone do not repair an already-initialized database.
- Running recovery repeatedly creates no duplicate. Existing default keys (including disabled/revoked keys) are not replaced or re-enabled. Configuration and administrator accounts remain intact.

Run:

```sh
bun test test/console/backup-sqlite-restore.test.ts
```

## Deployment

These are source changes. If Cartethyia runs from a Docker image, rebuild and deploy the updated image before expecting the fixes to take effect; updating source or this document alone does not update a running container.

For an offline SCP workflow: build the new image locally, export it with Docker save, transfer the archive, load it on the VPS with Docker load, then force-recreate service `app` using the loaded tag. SCP alone or restarting the old container does not select the newly loaded image. Do not delete the data volume. Check startup logs for the `default-gateway-key-recovery` phase, then reload Model Lab and test a Codex request. Prefer a unique image tag per build to avoid confusing old and new archives.