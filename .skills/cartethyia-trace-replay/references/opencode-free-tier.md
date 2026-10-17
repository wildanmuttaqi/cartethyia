# OpenCode free tier (`opencode`)

Two different things refuse a free-tier dispatch, and confusing them costs
hours. **Read this section before changing any header.**

| Symptom | Cause | What to change |
|---|---|---|
| 403 `FreeTierError` from **every** header permutation, and the official client fails too | **Egress IP is blocked** | Nothing in the request. Change the egress IP. |
| 403 `FreeTierError` on one shape, 200 on another | Request shape (tools/stream/wire) | The request, per the sections below |

**The first check is always: does the official client work from this host?**
Run `opencode run -m opencode/big-pickle "reply PONG"` with the real config
directory. If it also returns 403 `FreeTierError`, the block is at the IP
level and no header, tool, session, version, or credential change will help.
Confirmed 2026-10-17: the same byte-identical request returns **403 direct** and
**200 through a proxy** (exit `193.202.12.2`). `Bearer public` was valid the
whole time; only the egress IP differed.

Corollary for deployments: a datacenter IP (Railway and similar) is blocked.
`opencode` cannot be fixed in `provider.ts` — it needs an egress proxy.

## Wire shape (verified 200)

- Base: `https://opencode.ai/inference/v1`; endpoint
  `/chat/completions` for free ids.
- `stream: true` is required.
- The body must carry the OpenCode **agent-tool fingerprint set**:
  `edit, glob, grep, read, shell, skill, subagent, webfetch, websearch, write,
  execute` — `FREE_AGENT_TOOL_NAMES` in
  `src/providers/integrations/opencode/provider.ts`.
- `Authorization: Bearer public` — required, and case-sensitive (`PUBLIC`
  answers 401). Do not remove it.
- Identity headers: `x-opencode-client: cli`, the four session headers set to
  one `ses_` id, `x-opencode-project` as 40 lowercase hex, and
  `user-agent: opencode/latest/<version>/cli`. Do **not** send
  `x-opencode-request` on this lane.
- The legacy lane `https://opencode.ai/zen/v1/chat/completions` also answers
  200 with the pre-2.x shape (`user-agent: opencode/1.18.31 (...)`,
  `x-opencode-request` present, `x-opencode-project: prj_<24hex>`, and only a
  single `read` tool). It is a fallback, not the primary.

Absent the fingerprint, a free-model request is refused:

```json
{"type":"error","error":{"type":"FreeTierError",
 "message":"OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building."}}
```

HTTP **403**, `errorKind: authentication_failed`.

## Reading a non-403 answer

| Status | Meaning |
|---|---|
| **200** | The gate passed. This is the only proof. |
| `410 ModelDeprecated` | Model lookup failed **before** the gate. Says nothing about the gate. |
| `400 ModelProtocolUnsupported` | Gate passed; wrong wire. Free ids are chat-only. |
| `402 Insufficient account funds` | Gate passed; the bearer token is a real account. |
| `401 Missing API key` | No usable bearer at all. |

A `410` is **not** evidence the gate was passed — earlier notes in this repo
recorded it as such and sent an investigation down the wrong path.

## The trap: a clamp that keeps "used" tools drops the fingerprint

`ensureFreeAgentRequest` backfills missing fingerprint names, but
`clampOpenCodeTools` (cap `OPENCODE_MAX_TOOLS = 128`) runs on the payload and
keeps only tools referenced by the conversation. A client that arrives with its
own large catalog and references none of them gets **every fingerprint tool
trimmed away** — the backfill happened upstream of the clamp, so the wire ends
up with zero fingerprint tools and the dispatch 403s.

So the failure is not "the adapter forgot to add the fingerprint" — it added
them and then threw them away. Fixed 2026-10-16 by treating
`FREE_AGENT_TOOL_NAMES` as protected alongside called tools in the clamp.

**Any future trim/dedupe/filter over `payload.tools` must preserve that set.**
Regression test: `test/providers/opencode-tool-limit.test.ts`.

## Replaying it

The real session record is a Request Detail export whose
`payloads.providerRequest` is `{method, url, headers, body}` — replay that
verbatim, then A/B one field at a time.

| Arm | Result |
|---|---|
| 128 Claude Code tools, verbatim headers | 403 |
| + `authorization` | 403 |
| + `accept` | 403 |
| + auth + accept | 403 |
| fingerprint 11 only | **200** |
| 128 foreign tools + fingerprint 11 (139) | **200** |
| same request from a blocked IP | 403 |
| same request through a proxy | **200** |

The 11 fingerprint tools are accepted **alongside** the client's own tools — the
gate is a membership test, not an exact-match test.

Use `bun -e` with `fetch`, not `curl -o <file>`: on Windows the latter
intermittently returns exit 43 / HTTP 000 (schannel renegotiation) and looks
like an unreachable host.

## Wire and model facts

- Free models here are **chat-only**: `responses` returns 400
  `ModelProtocolUnsupported`. `wireFamily` for free ids is `chat`.
- Live ids: `GET https://opencode.ai/zen/v1/models` (open, no credential).
  Limits and status: `https://models.opencode.ai/api.json` — a `status:
  "deprecated"` row is on its way out; do not guess either.
- Known-good real-client capture:
  `documentation/archive/opencode-freetier-exact-request-2.0.26.json`.

## What does NOT matter

Verified by replay, so do not spend time here:

| Suspect | Verdict |
|---|---|
| Client version in the `user-agent` (1.18.0 … 2.0.32) | Not validated. |
| `x-opencode-client: cli` vs `desktop` | Both accepted. |
| Session id value, when the shape is right | Any `ses_` id with a plausible inverted timestamp. |
| Extra tool definitions beyond the 11 | Allowed; the gate is membership, not equality. |
| Tool order | Irrelevant. |
| The egress IP | **Decisive.** Check this first. |
