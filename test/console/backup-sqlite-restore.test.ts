import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { applySqliteMigrations, buildSqliteHandle, createSqliteDatabase } from "../../src/persistence/db-sqlite";
import { BackupService } from "../../src/console/backup/service";
import { FirstBootSetupService, recoverMissingDefaultGatewayApiKeys } from "../../src/console/auth/setup-service";
import { apiKeys, providerAccounts } from "../../src/persistence/schema";
import {
  decryptCredentialToString,
  encryptCredential,
  setCredentialEncryptionKeyForTesting,
  snapshotCredentialEncryptionKeyForTesting,
} from "../../src/security/crypto";
import { seedBundledProviders } from "../../src/providers/operations/provider-catalog-service";

test("first-boot restore and startup recover a missing default gateway key", async () => {
  const previousMode = process.env.CARTETHYIA_DB_MODE;
  const previousApiKey = process.env.CARTETHYIA_API_KEY;
  const previousEncryptionKey = snapshotCredentialEncryptionKeyForTesting();
  const sqlite = createSqliteDatabase(":memory:");
  process.env.CARTETHYIA_DB_MODE = "lite";
  delete process.env.CARTETHYIA_API_KEY;
  setCredentialEncryptionKeyForTesting(randomBytes(32));
  try {
    await applySqliteMigrations(sqlite);
    const { db } = buildSqliteHandle(sqlite);
    const setup = new FirstBootSetupService(db, {
      hashPassword: async () => "test-password-hash",
      verifyPassword: async () => true,
    });
    const result = await setup.restoreBackup(
      { app: "cartethyia", version: 1, exportedAt: new Date().toISOString(), sections: { config: {} } },
      { password: "test-password" },
    );

    expect(result.createdAdmin).toBe(true);
    let keys = await db.select().from(apiKeys);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.isDefault).toBe(true);
    if (keys[0]?.keyEncrypted == null || keys[0].keyPrefix == null) {
      throw new Error("default key secret or prefix was not stored");
    }
    expect(decryptCredentialToString(keys[0].keyEncrypted)).toStartWith(keys[0].keyPrefix);

    // Simulate an older running installation that has an admin but lost the key.
    await db.delete(apiKeys);
    expect(await setup.requiresSetup()).toBe(false);
    await recoverMissingDefaultGatewayApiKeys(db);
    await recoverMissingDefaultGatewayApiKeys(db);
    keys = await db.select().from(apiKeys);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.isDefault).toBe(true);

    await db.update(apiKeys).set({ enabled: false, revokedAt: new Date() });
    await recoverMissingDefaultGatewayApiKeys(db);
    const preserved = await db.select().from(apiKeys);
    expect(preserved).toHaveLength(1);
    expect(preserved[0]?.id).toBe(keys[0]?.id);
    expect(preserved[0]?.enabled).toBe(false);
    expect(preserved[0]?.revokedAt).not.toBeNull();
  } finally {
    sqlite.close();
    setCredentialEncryptionKeyForTesting(previousEncryptionKey);
    if (previousMode === undefined) delete process.env.CARTETHYIA_DB_MODE;
    else process.env.CARTETHYIA_DB_MODE = previousMode;
    if (previousApiKey === undefined) delete process.env.CARTETHYIA_API_KEY;
    else process.env.CARTETHYIA_API_KEY = previousApiKey;
  }
});

test("first-boot restore preserves a default gateway key already in the backup", async () => {
  const previousMode = process.env.CARTETHYIA_DB_MODE;
  const previousApiKey = process.env.CARTETHYIA_API_KEY;
  const previousEncryptionKey = snapshotCredentialEncryptionKeyForTesting();
  const sqlite = createSqliteDatabase(":memory:");
  process.env.CARTETHYIA_DB_MODE = "lite";
  delete process.env.CARTETHYIA_API_KEY;
  setCredentialEncryptionKeyForTesting(randomBytes(32));
  try {
    await applySqliteMigrations(sqlite);
    const { db } = buildSqliteHandle(sqlite);
    const setup = new FirstBootSetupService(db, {
      hashPassword: async () => "test-password-hash",
      verifyPassword: async () => true,
    });
    const id = randomUUID();
    await setup.restoreBackup(
      {
        app: "cartethyia",
        version: 1,
        exportedAt: new Date().toISOString(),
        sections: {
          config: {
            api_keys: [{
              id,
              key_hash: "restored-default-hash",
              key_mode: "personal",
              label: "Imported gateway",
              scopes: ["tenant:invoke"],
              key_prefix: "carte_",
              api_key: "carte_restored-secret",
              is_default: true,
            }],
          },
        },
      },
      { password: "test-password" },
    );

    const keys = await db.select().from(apiKeys);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.id).toBe(id);
    expect(keys[0]?.label).toBe("Imported gateway");
    if (keys[0]?.keyEncrypted == null) throw new Error("restored key secret was not sealed");
    expect(decryptCredentialToString(keys[0].keyEncrypted)).toBe("carte_restored-secret");
  } finally {
    sqlite.close();
    setCredentialEncryptionKeyForTesting(previousEncryptionKey);
    if (previousMode === undefined) delete process.env.CARTETHYIA_DB_MODE;
    else process.env.CARTETHYIA_DB_MODE = previousMode;
    if (previousApiKey === undefined) delete process.env.CARTETHYIA_API_KEY;
    else process.env.CARTETHYIA_API_KEY = previousApiKey;
  }
});

test("restores legacy sealed credentials with the active encryption key", async () => {
  const previousKey = snapshotCredentialEncryptionKeyForTesting();
  const key = randomBytes(32);
  setCredentialEncryptionKeyForTesting(key);
  const tenantId = randomUUID();
  const accountId = randomUUID();
  const ciphertext = encryptCredential("legacy-provider-token").toString("base64");
  const sqlite = createSqliteDatabase(":memory:");
  try {
    await applySqliteMigrations(sqlite);
    const { db } = buildSqliteHandle(sqlite);
    await seedBundledProviders(db);

    const service = new BackupService({ db, verifyPassword: async () => true });
    const result = await service.restore("password", {
      app: "cartethyia",
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: {
        config: {
          tenants: [{ id: tenantId, name: "restored", status: "active" }],
          provider_accounts: [
            {
              id: accountId,
              provider_id: "openai",
              tenant_id: tenantId,
              label: "legacy account",
              credential_ciphertext: { __bytes: ciphertext },
              credential_kind: "api_key",
              status: "active",
            },
          ],
        },
      },
    }, tenantId);

    const [account] = await db.select().from(providerAccounts);
    expect(result.restored["provider_accounts"]).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(account).toBeDefined();
    if (account === undefined || account.credentialCiphertext === null) {
      throw new Error("restored account credential was not sealed");
    }
    expect(decryptCredentialToString(account.credentialCiphertext)).toBe("legacy-provider-token");
  } finally {
    sqlite.close();
    setCredentialEncryptionKeyForTesting(previousKey);
  }
});

test("skips routing settings for providers absent from the backup target", async () => {
  const sqlite = createSqliteDatabase(":memory:");
  try {
    await applySqliteMigrations(sqlite);
    const { db } = buildSqliteHandle(sqlite);
    const service = new BackupService({ db, verifyPassword: async () => true });
    const result = await service.restore("password", {
      app: "cartethyia",
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: {
        config: {
          provider_routing_settings: [
            { provider_id: "retired-provider", strategy: "fallback", rotate_count: 1 },
          ],
        },
      },
    }, randomUUID());

    expect(result.restored["provider_routing_settings"]).toBe(0);
    expect(result.warnings).toContainEqual({
      table: "provider_routing_settings",
      column: "provider_id",
      reason: "referenced a provider not available in this installation; those rows were skipped",
    });
  } finally {
    sqlite.close();
  }
});
