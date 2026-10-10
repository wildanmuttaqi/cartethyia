import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  createAccountQuotaRoutes,
  resetBackgroundQuotaRefreshesForTests,
} from "../../src/console/quota/account-quota";
import {
  clearQuotaCacheForTests,
  getCachedQuotaEntry,
} from "../../src/console/quota/cache";
import { inFlightAccountQuotaRefreshes } from "../../src/console/quota/refresh";
import {
  applyPgliteMigrations,
  buildPgliteHandle,
  createPgliteClient,
} from "../../src/persistence/db-pglite";
import {
  providerAccounts,
  providers,
  tenants,
} from "../../src/persistence/schema";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import type { QuotaCollectionContext } from "../../src/providers/quota/quota-support";
import { createAccessDecision } from "../../src/security/access-control";

test("tenant quota routes forward stored account auth state to the collector", async () => {
  const client = await createPgliteClient("memory://");
  const { db } = buildPgliteHandle(client);
  const tenantId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const authState = {
    authMethod: "imported",
    region: "eu-west-1",
    profileArn: "arn:aws:codewhisperer:eu-west-1:123456789012:profile/test",
    machineId: "a".repeat(64),
  };
  const contexts: Array<QuotaCollectionContext | undefined> = [];
  const registry = new ProviderRegistry();
  registry.register({
    provider_id: "kiro",
    load: async () => {
      throw new Error("Quota tests must not load an adapter");
    },
    loadQuotaCollector: async () => async (_credential, _fetcher, context) => {
      contexts.push(context);
      return {
        source: "kiro",
        plan: null,
        windows: [],
        error:
          context?.auth_state?.["profileArn"] === authState.profileArn
            ? null
            : "Missing account profile",
      };
    },
  });
  const access = createAccessDecision({
    id: "quota-test",
    tenantId,
    scopes: ["dashboard:read", "dashboard:write"],
  });
  const app = new Elysia().use(
    createAccountQuotaRoutes({
      db,
      redis: undefined,
      providerRegistry: registry,
      accessResolver: () => access,
      resolveCredential: async () => "synthetic-credential",
    }),
  );
  try {
    await applyPgliteMigrations(client);
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "quota-test", status: "active" });
    await db.insert(providers).values({ id: "kiro" });
    await db.insert(providerAccounts).values({
      id: accountId,
      tenantId,
      providerId: "kiro",
      label: "quota-test",
      credentialKind: "oauth",
      authState,
    });
    for (const [path, method, body] of [
      ["/quota/overview", "GET", undefined],
      [`/accounts/${accountId}/quota`, "GET", undefined],
      [`/accounts/${accountId}/quota/refresh`, "POST", undefined],
      ["/quota/refresh", "POST", JSON.stringify({ accountIds: [accountId] })],
    ] as const) {
      clearQuotaCacheForTests();
      contexts.length = 0;
      const response = await app.handle(
        new Request(`http://localhost${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { body, headers: { "content-type": "application/json" } }),
        }),
      );
      expect(response.status).toBe(200);
      await Promise.all(inFlightAccountQuotaRefreshes.values());
      expect(contexts).toEqual([
        { auth_state: authState, credential_kind: "oauth" },
      ]);
      const cached = await getCachedQuotaEntry(tenantId, accountId, undefined);
      expect(cached?.quota.error).toBeNull();
    }
  } finally {
    await Promise.all(inFlightAccountQuotaRefreshes.values());
    resetBackgroundQuotaRefreshesForTests();
    clearQuotaCacheForTests();
    await client.close();
  }
}, 30000);
