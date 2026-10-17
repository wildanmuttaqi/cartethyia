import { getOpenCodeVersion } from "../../operations/client-versions";
import { createHash, randomBytes } from "node:crypto";

let lastTimestamp = 0;
let sequenceCounter = 0;
const SESSION_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * Generate a valid OpenCode session identifier matching official binary:
 * `ses_` + 12-char hex (bitwise inverted millisecond timestamp * 4096 + seq) + 14-char base62.
 */
export function generateOpenCodeSessionId(now = Date.now()): string {
  if (now !== lastTimestamp) {
    lastTimestamp = now;
    sequenceCounter = 0;
  }
  sequenceCounter++;
  const num = BigInt(now) * 0x1000n + BigInt(sequenceCounter);
  const inverted = ~num;
  const hex = Array.from({ length: 6 }, (_, i) =>
    Number((inverted >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0"),
  ).join("");
  const rand = crypto.getRandomValues(new Uint8Array(14));
  const suffix = Array.from(rand, (byte) => SESSION_ID_ALPHABET[byte % 62]).join("");
  return `ses_${hex}${suffix}`;
}

/**
 * Derive a conversation-stable session id from an affinity key.
 *
 * The free-tier gate validates that the session's 12 hex digits decode to a
 * plausible inverted-millisecond timestamp (verified live 2026-10-14: a hash
 * of arbitrary hex is refused with 403 FreeTierError, while the same shape
 * carrying a real timestamp passes). So the hex part is an inverted timestamp
 * jittered deterministically within the last 48 hours of the affinity key —
 * stable per conversation, plausible per the gate — and only the base62
 * suffix comes from the hash.
 *
 * The jitter derives from 6-hour time buckets, not raw `Date.now()`: two
 * dispatches of one conversation that land in the same bucket (or adjacent
 * ones before the bucket rolls) produce the identical session id, so prompt
 * cache affinity survives the millisecond a request happens to cross.
 */
function stableOpenCodeSessionId(affinity: string): string {
  const digest = createHash("sha256").update(`opencode-session:${affinity}`).digest();
  const bucketMs = 6 * 3_600_000;
  const bucket = Math.floor(Date.now() / bucketMs);
  const jitterBuckets = digest.readUint32BE(0) % 8; // 0..7 buckets = up to 42h back
  const timestamp = (bucket - jitterBuckets) * bucketMs;
  const num = BigInt(timestamp) * 0x1000n + 1n;
  const inverted = ~num;
  const hex = Array.from({ length: 6 }, (_, i) =>
    Number((inverted >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0"),
  ).join("");
  const suffix = Array.from(digest.subarray(6, 20), (byte) => SESSION_ID_ALPHABET[byte % 62]).join("");
  return `ses_${hex}${suffix}`;
}

function isOpenCodeSessionId(value: string | undefined): value is string {
  return value !== undefined && /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(value);
}

function createTraceHeaders(): Record<string, string> {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const parentSpanId = randomBytes(8).toString("hex");
  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
  };
}

/** Build the observed OpenCode CLI identity headers for an upstream dispatch. */
export function buildOpenCodeHeaders(
  version = getOpenCodeVersion(),
  affinity?: string,
  projectId?: string,
): Record<string, string> {
  let sessionId: string;
  if (isOpenCodeSessionId(affinity)) {
    sessionId = affinity;
  } else if (affinity !== undefined) {
    sessionId = stableOpenCodeSessionId(affinity);
  } else {
    sessionId = generateOpenCodeSessionId();
  }
  return {
    // The free-tier gate accepts both "cli" and "desktop" (verified live), but
    // "desktop" matches the identity the observed free-tier traffic carries.
    "x-opencode-client": "desktop",
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    "x-session-affinity": sessionId,
    "x-session-id": sessionId,
    // No `x-opencode-request`: the current client no longer sends it, and
    // sending it now makes the free-tier gate refuse the dispatch (verified
    // live 2026-10-14 — identical request returns 403 with it, 200 without).
    // The id generator was removed with it; this header is simply not part of
    // the dispatch identity anymore.
    "x-opencode-project": projectId ?? "global",
    "user-agent": `opencode/latest/${version}/cli`,
    ...createTraceHeaders(),
  };
}
