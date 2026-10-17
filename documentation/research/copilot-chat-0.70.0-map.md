# Copilot Chat 0.70.0 — peta kemampuan

Sumber: `VSCodeUserSetup-x64-1.142.0.exe`, diekstrak statis ke
`D:\tmp\vscode-142`. Installer tidak dijalankan.

| | |
|---|---|
| VS Code | 1.142.0 stable, commit `6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1`, dibangun 2026-10-15 |
| Extension | `GitHub.copilot-chat` 0.70.0, build 1, `completionsCoreVersion` 1.378.1799 |
| Bundle | `extensions/copilot/dist/extension.js`, 19.748.056 byte |
| `package.json` | 201.852 byte, 133 command, 188 setting |

Angka token per model **tidak ada di bundle**. Katalog datang dari server
(`GET {capi}/models`) dan di-cache per akun. Yang ada di bundle adalah rumus
dan default-nya, bukan daftar model.

## Batas token

Katalog server memberi tiga angka per model. Kalau sebuah angka tidak ada,
bundle mengisinya sendiri:

```text
contextWindow  = contextWindow ?? (maxInputTokens ?? 0) + maxOutputTokens
maxOutputTokens = min(maxOutputTokens, contextWindow)
maxInputTokens  = min(maxInputTokens ?? sisa, contextWindow - maxOutputTokens)
```

Default kalau katalog tidak punya entri sama sekali: context 128.000, input
100.000, output 8.192. Default kalau entri ada tapi field-nya kosong: prompt
8.192, output 4.096.

Request chat mengirim `max_tokens` = `maxOutputTokens` model itu, kecuali
request sudah membawa `prediction`. Responses API mengirim angka yang sama
sebagai `max_output_tokens`. Log debug mencetak `max_tokens ?? 2048`, jadi
2.048 adalah fallback log, bukan batas model.

`luna` tidak disebut di bundle. `gpt-6-luna` tidak ada. Yang ada:
`gpt-5.6-luna`, dipakai sebagai model default execution subagent. Klaim 1M
context untuk luna tidak bisa diverifikasi dari bundle ini — angkanya ada di
respons `/models`, bukan di kode.

## contextTier

Bukan header, dan bukan untuk chat biasa. Hanya sesi Copilot CLI yang
mengirimnya, sebagai opsi sesi (`updateOptions({ contextTier })`), bukan field
body.

```text
function Fet(promptTokens, model) {
  if (!model.defaultContextMax) return undefined;
  if (promptTokens bukan angka) {
    const ceiling = model.maxInputTokens ?? model.maxContextWindowTokens;
    const hasLongPrice = model.longContextInputCost !== undefined
                      || model.longContextOutputCost !== undefined;
    return model.defaultContextMax < ceiling && !hasLongPrice
      ? "long_context" : undefined;
  }
  return promptTokens > model.defaultContextMax ? "long_context" : "default";
}
```

Jadi `long_context` dikirim hanya kalau model punya `defaultContextMax`,
plafon input-nya lebih besar dari itu, dan model itu **tidak** punya harga
konteks panjang sendiri. Model yang punya harga konteks panjang tidak dikirimi
tier — server yang menentukannya dari ukuran prompt.

`long_context` yang lain di bundle adalah nama seksi system prompt ("untuk
input di atas ~10k token, buat outline dulu"), bukan field request.

## Header

Dua jalur, dan versinya berbeda.

Chat (`_fetchWithInstrumentation` dan pembangun request CAPI):

| Header | Nilai |
|---|---|
| `Authorization` | `Bearer <copilot token>` |
| `X-Request-Id` | id request |
| `OpenAI-Intent` | jenis interaksi, atau override |
| `X-GitHub-Api-Version` | `2025-05-01` di satu jalur, `2026-01-09` di jalur lain |
| `X-Interaction-Id` | id interaksi sesi |
| `X-Interaction-Type` | jenis interaksi |
| `X-Agent-Task-Id` | sama dengan request id |
| `X-Initiator` | `user` atau `agent` |
| `Copilot-Vision-Request` | `true`, hanya kalau ada gambar dan model mendukung vision |
| `Copilot-Integration-Id` | `vscode-chat` (prod) atau `vscode-chat-dev` |
| `Request-Hmac` | hanya build dev |
| `Editor-Version` | `vscode/<versi>` |
| `Editor-Plugin-Version` | `copilot-chat/0.70.0` |

GitHub REST (`_mixinHeaders`, hanya untuk tipe request tertentu):

| Header | Nilai |
|---|---|
| `X-GitHub-Api-Version` | `2026-08-01` |
| `VScode-SessionId` | session id |
| `VScode-MachineId` | machine id |
| `Editor-Device-Id` | device id |

Allowlist header yang boleh diteruskan: `api-key`, `authorization`,
`content-type`, `openai-intent`, `x-github-api-version`, `x-initiator`,
`x-interaction-id`, `x-interaction-type`, `x-onbehalf-extension-id`,
`x-request-id`, `x-vscode-user-agent-library-version`.

## Reasoning

Effort tidak dikirim kalau model tidak mendeklarasikan level. Override
`github.copilot.chat.reasoningEffortOverride` menang atas effort yang diminta,
dan effort yang tidak ada di daftar server dibuang dengan warning, bukan
dikirim.

Per wire:

| Wire | Field |
|---|---|
| chat completions | `reasoning_effort` |
| responses | `reasoning.effort` |
| anthropic messages | `output_config.effort` |

Thinking Anthropic: `adaptive` kalau model mendukung, kalau tidak `enabled`
dengan `budget_tokens` = min(max budget, max_tokens − 1, max(min budget,
16.000)). Default effort kalau tidak diminta: `medium` kalau ada, kalau tidak
level tengah.

`github.copilot.chat.claudeDefaultReasoningEffort`: `""`, `low`, `medium`,
`high`, `max`. Tidak ada `xhigh` di setting ini.

## Endpoint

Base: `https://api.githubcopilot.com` (CAPI), `https://copilot-proxy.githubusercontent.com`
(proxy), `https://api.github.com` (dotcom), `https://uploads.github.com`.

| Getter | Path |
|---|---|
| `capiChatURL` | `{capi}/chat/completions` |
| `capiResponsesURL` | `{capi}/responses` |
| `capiMessagesURL` | `{capi}/v1/messages` |
| `capiModelsURL` | `{capi}/models` |
| `capiAutoModelURL` | `{capi}/models/session` |
| `capiModelRouterURL` | `{capi}/models/session/intent` |
| `capiAutoURL` | `{capi}/auto` |
| `capiEmbeddingsURL` | `{capi}/embeddings` |
| `remoteAgentsURL` | `{capi}/agents` |
| `listSkillsURL` | `{capi}/skills` |
| `searchSkillURL` | `{capi}/search` |
| `copilotAgentSessionsURL` | `{capi}/agents/sessions` |
| `copilotAgentJobsURL` | `{capi}/agents/swe` |
| `tokenURL` | `{dotcom}/copilot_internal/v2/token` |
| `contentExclusionURL` | `{dotcom}/copilot_internal/content_exclusion` |
| `embeddingsURL` | `{dotcom}/embeddings` |
| `embeddingsCodeSearchURL` | `{dotcom}/embeddings/code/search` |
| `chatAttachmentUploadURL` | `https://uploads.github.com/copilot/chat/attachments` |
| proxy completions | `{proxy}/v1/engines/gpt-4o-copilot/completions` |
| proxy chat | `{proxy}/chat/completions` |
| MCP | `https://api.githubcopilot.com/mcp/` |

Model lab: `https://api-model-lab.githubcopilot.com`. Telemetry:
`https://copilot-telemetry.githubusercontent.com`.

## Tool — 38

Toolset bawaan: `edit` (6), `execute` (2), `read` (6), `search` (7),
`vscode` (8), `web` (3).

### Baca

| Tool | Ref | Parameter wajib | Syarat |
|---|---|---|---|
| `copilot_readFile` | `readFile` | `filePath`, `startLine`, `endLine` | — |
| `copilot_viewImage` | `viewImage` | `filePath` | `tools.viewImage.enabled` (default hidup) |
| `copilot_listDirectory` | `listDirectory` | `path` | — |
| `copilot_readProjectStructure` | — | — | — |
| `copilot_getErrors` | `problems` | — (`filePaths` opsional) | — |
| `copilot_getNotebookSummary` | `getNotebookSummary` | `filePath` | — |
| `copilot_readNotebookCellOutput` | `readNotebookCellOutput` | `filePath`, `cellId` | — |

### Cari

| Tool | Ref | Parameter wajib | Syarat |
|---|---|---|---|
| `copilot_searchCodebase` | `codebase` | `query` | — |
| `copilot_findFiles` | `fileSearch` | `query` | — |
| `copilot_findTextInFiles` | `textSearch` | `query`, `isRegexp` | — |
| `copilot_searchWorkspaceSymbols` | `symbols` | `symbolName` | — |
| `copilot_findTestFiles` | `findTestFiles` | `filePaths` | — |
| `copilot_getChangedFiles` | `changes` | — | `getChangedFilesTool.enabled` (default mati) |
| `search_subagent` | `searchSubagent` | `query`, `description`, `details` | search + explore agent hidup |
| `explore_subagent` | `exploreSubagent` | sama | search hidup, explore mati |

`search_subagent` dan `explore_subagent` saling meniadakan. Keduanya default
mati (`searchSubagent.enabled` = false).

### Edit

| Tool | Ref | Parameter wajib | Syarat |
|---|---|---|---|
| `copilot_applyPatch` | `applyPatch` | `input`, `explanation` | — |
| `copilot_replaceString` | `replaceString` | `filePath`, `oldString`, `newString` | `disableReplaceTool` tidak di-set |
| `copilot_multiReplaceString` | `multiReplaceString` | `explanation`, `replacements` | sama |
| `copilot_insertEdit` | `insertEdit` | `explanation`, `filePath`, `code` | — |
| `copilot_createFile` | `createFile` | `filePath`, `content` | — |
| `copilot_createDirectory` | `createDirectory` | `dirPath` | — |
| `copilot_editNotebook` | `editNotebook` | `filePath`, `editType`, `cellId` | — |
| `copilot_editFiles` | `editFiles` | — | placeholder, deskripsinya "do not use" |

### Jalankan

| Tool | Ref | Parameter wajib | Syarat |
|---|---|---|---|
| `execution_subagent` | `executionSubagent` | `query`, `description` | default hidup, model `gpt-5.6-luna`, batas 10 tool call |
| `copilot_runNotebookCell` | `runNotebookCell` | `filePath`, `cellId` | — |
| `copilot_runVscodeCommand` | `runCommand` | `commandId`, `name` | — |

### Web dan GitHub

| Tool | Ref | Parameter wajib | Syarat |
|---|---|---|---|
| `copilot_fetchWebPage` | `fetch` | `urls`, `query` | bukan web |
| `copilot_githubRepo` | `githubRepo` | `repo`, `query` | MCP GitHub mati (default) |
| `copilot_githubTextSearch` | `githubTextSearch` | `scope`, `query` | — |

### VS Code, memori, sesi

| Tool | Ref | Parameter wajib | Syarat |
|---|---|---|---|
| `copilot_getVSCodeAPI` | `vscodeAPI` | `query` | — |
| `copilot_createNewWorkspace` | `newWorkspace` | `query` | default hidup |
| `copilot_createNewJupyterNotebook` | `createJupyterNotebook` | `query` | — |
| `copilot_installExtension` | `installExtension` | `id`, `name` | skill install mati (default) |
| `copilot_switchAgent` | `switchAgent` | `agentName` | default mati, hanya Plan |
| `skill` | `skill` | `skill` | default mati |
| `copilot_memory` | `memory` | `command` | — |
| `copilot_resolveMemoryFileUri` | `resolveMemoryFileUri` | `path` | — |
| `copilot_sessionStoreSql` | `sessionStoreSql` | `description` | `sessionSearch.enabled` |

Memori punya tiga tingkat di bawah `/memories/`: user (lintas workspace),
repo, dan session. SQL sesi read-only: hanya `SELECT` dan `WITH`.

## Skill bawaan — 15

| Skill | Sesi | Syarat |
|---|---|---|
| `project-setup-info-local` | local | Context7 mati |
| `project-setup-info-context7` | local | Context7 hidup |
| `install-vscode-extension` | local | skill install + new workspace hidup |
| `get-search-view-results` | local | — |
| `troubleshoot` | local, cli | — |
| `agent-customization` | local, cli | — |
| `migrate-customizations` | cli, claude, codex | — |
| `init` | local | — |
| `create-prompt` | local | — |
| `create-instructions` | local | — |
| `create-skill` | local | — |
| `create-agent` | local | — |
| `create-hook` | local | — |
| `create-canvas` | cli | `chat.canvases.enabled` |
| `chronicle` | local | session search hidup |

Prompt file: `plan.prompt.md`, plus enam prompt chronicle (standup, tips,
cost, improve, reindex, search) yang semuanya menunggu session search.

## Peserta chat — 9

| Id | Lokasi | Perintah |
|---|---|---|
| `github.copilot.default` | panel | explain, review, tests, fix, new, newNotebook, semanticSearch, setupTests |
| `github.copilot.editingSession` | panel | — |
| `github.copilot.editingSessionEditor` | editor | — |
| `github.copilot.editsAgent` | panel | error, compact, explain, review, tests, fix, new, newNotebook, semanticSearch, setupTests |
| `github.copilot.notebook` | notebook | fix, explain |
| `github.copilot.notebookEditorAgent` | notebook | fix, explain |
| `github.copilot.vscode` | panel | search |
| `github.copilot.terminal` | terminal | explain |
| `github.copilot.terminalPanel` | panel | explain |

## Provider model — 11

`copilot`, `copilotcli` (when: false), `anthropic`, `xai`, `gemini`,
`openrouter`, `openai`, `ollama` (deprecated), `customoai` (deprecated, bukan
stable), `customendpoint`, `azure`.

## Setting yang mengubah kontrak request

| Setting | Default | Efek |
|---|---|---|
| `chatCompletionsTokenParameter` | `max_tokens` | `max_tokens` atau `max_completion_tokens` |
| `reasoningEffortOverride` | null | menang atas effort yang diminta, dibuang kalau model tidak mendukung |
| `claudeDefaultReasoningEffort` | `""` | `low`/`medium`/`high`/`max` |
| `anthropic.useMessagesApi` | true | Claude lewat `/v1/messages` |
| `anthropic.contextEditing.mode` | `off` | `clear-thinking`, `clear-tooluse`, `clear-both` |
| `responsesApiContextManagement.enabled` | false | compaction responses |
| `responsesApi.promptCacheKey.enabled` | false | — |
| `responsesApi.promptCacheBreakpoint.enabled` | false | — |
| `useResponsesApiTruncation` | false | — |
| `gpt56Verbosity.enabled` | true | `text.verbosity` di responses |
| `virtualTools.threshold` | 128 | tool di atas ini dijadikan virtual |
| `agent.temperature` | null | — |
| `agent.largeToolResultsToDisk.thresholdBytes` | 8192 | — |
| `executionSubagent.model` | `gpt-5.6-luna` | — |
| `executionSubagent.toolCallLimit` | 10 | — |
| `searchSubagent.toolCallLimit` | 4 | — |
| `instantApply.shortContextLimit` | 8000 | — |
| `modelCapabilityOverrides` | `{}` | menimpa kemampuan model dari katalog |

## Yang tidak ada di bundle

- Daftar model dan angka token per model. Itu respons `GET /models`.
- `gpt-6-luna` dan klaim 1M context-nya.
- `xhigh` sebagai effort. Setting Claude berhenti di `max`.
- Header khusus untuk menaikkan context window di jalur chat. `contextTier`
  hanya ada di sesi CLI, dan hanya untuk model tanpa harga konteks panjang.
