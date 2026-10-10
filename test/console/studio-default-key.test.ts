import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AccessDecision } from "../../src/security/access-control";
import {
  DEFAULT_API_KEY_LABEL,
  generateApiKeySecret,
} from "../../src/console/domains/api-keys/contracts";
import { createStudioOperations } from "../../src/console/domains/studio/routes";
import type { StudioSessionStore } from "../../src/console/domains/studio/contracts";
import type {
  ApiKeyRecord,
  ApiKeyStore,
} from "../../src/persistence/api-key-store";
import {
  decryptCredentialToString,
  encryptCredential,
  hashSecret,
  setCredentialEncryptionKeyForTesting,
} from "../../src/security/crypto";

const TENANT_ID = "tenant-1";
const ACCESS: AccessDecision = {
  id: "admin-1",
  tenantId: TENANT_ID,
  scopes: ["dashboard:write"],
  admissionIdentity: "admin-1",
};

function memoryKeyStore(initial: readonly ApiKeyRecord[] = []): {
  readonly records: ApiKeyRecord[];
  readonly store: ApiKeyStore;
} {
  const records = [...initial];
  const store: ApiKeyStore = {
    list: async (tenantId) =>
      records.filter((record) => record.tenantId === tenantId),
    get: async (tenantId, keyId) =>
      records.find(
        (record) => record.tenantId === tenantId && record.id === keyId,
      ),
    listChildren: async (tenantId, parentKeyId) =>
      records.filter(
        (record) =>
          record.tenantId === tenantId && record.parentKeyId === parentKeyId,
      ),
    create: async (record) => {
      records.push(record);
    },
    reorder: async () => undefined,
    update: async () => undefined,
    revoke: async () => false,
  };
  return { records, store };
}

function operationsFor(keyStore: ApiKeyStore) {
  return createStudioOperations({
    sessionStore: {} as StudioSessionStore,
    keyStore,
    accessResolver: () => ACCESS,
  });
}

describe("Studio default gateway key", () => {
  beforeEach(() => setCredentialEncryptionKeyForTesting(Buffer.alloc(32, 37)));
  afterEach(() => setCredentialEncryptionKeyForTesting(undefined));

  test("creates and reuses an encrypted default key when setup did not seed one", async () => {
    const { records, store } = memoryKeyStore();
    const operations = operationsFor(store);

    const [first, concurrent] = await Promise.all([
      operations.ensureStudioKey(ACCESS),
      operations.ensureStudioKey(ACCESS),
    ]);
    const record = records[0];

    expect(first).toEqual(concurrent);
    expect(records).toHaveLength(1);
    expect(record).toMatchObject({
      tenantId: TENANT_ID,
      label: DEFAULT_API_KEY_LABEL,
      keyMode: "personal",
      enabled: true,
      keyPrefix: first.prefix,
    });
    expect(record?.keyHash).toBe(hashSecret(first.key));
    expect(record?.keyEncrypted).toBeDefined();
    expect(
      decryptCredentialToString(record?.keyEncrypted ?? Buffer.alloc(0)),
    ).toBe(first.key);
    expect(await operations.ensureStudioKey(ACCESS)).toEqual(first);
    expect(records).toHaveLength(1);
  });

  test("reuses an existing default key without minting another", async () => {
    const generated = generateApiKeySecret();
    const existing: ApiKeyRecord = {
      id: "existing-key",
      tenantId: TENANT_ID,
      keyHash: generated.hash,
      keyMode: "personal",
      label: DEFAULT_API_KEY_LABEL,
      enabled: true,
      scopes: ["routing:invoke"],
      keyPrefix: generated.prefix,
      keyEncrypted: encryptCredential(generated.secret),
      createdAt: new Date(),
      tokensConsumed: 0,
    };
    const { records, store } = memoryKeyStore([existing]);

    const result = await operationsFor(store).ensureStudioKey(ACCESS);

    expect(result).toEqual({
      key: generated.secret,
      keyId: existing.id,
      prefix: generated.prefix,
    });
    expect(records).toHaveLength(1);
  });

  test("does not replace a default key whose secret cannot be recovered", async () => {
    const existing: ApiKeyRecord = {
      id: "unrecoverable-key",
      tenantId: TENANT_ID,
      keyHash: "stored-hash",
      keyMode: "personal",
      label: DEFAULT_API_KEY_LABEL,
      enabled: true,
      scopes: ["routing:invoke"],
      createdAt: new Date(),
      tokensConsumed: 0,
    };
    const { records, store } = memoryKeyStore([existing]);

    await expect(
      operationsFor(store).ensureStudioKey(ACCESS),
    ).rejects.toMatchObject({
      code: "default_key_unrecoverable",
    });
    expect(records).toHaveLength(1);
  });
});
