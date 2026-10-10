import { expect, test } from "bun:test";
import { createServer } from "node:http";
import {
  deployRelay,
  RELAY_WORKER_SOURCE,
} from "../../src/console/routing/pools/relay-deploy";
import { createValidatedFetch } from "../../src/network/outbound-fetch";

test("Cloudflare relay upload sends a multipart content type matching its body", async () => {
  let uploaded: FormData | undefined;
  let uploadedBytes = 0;
  let declaredBytes = 0;
  let multipartBody = "";
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const contentType = request.headers["content-type"];
      if (!contentType?.startsWith("multipart/form-data; boundary=")) {
        response.writeHead(400);
        response.end(
          JSON.stringify({
            errors: [{ message: "Content-Type must be multipart/form-data" }],
          }),
        );
        return;
      }
      try {
        uploaded = await new Response(body, {
          headers: { "content-type": contentType },
        }).formData();
      } catch {
        response.writeHead(400);
        response.end(
          JSON.stringify({
            errors: [{ message: "Multipart boundary does not match body" }],
          }),
        );
        return;
      }
      uploadedBytes = body.byteLength;
      declaredBytes = Number(request.headers["content-length"]);
      multipartBody = body.toString("utf8");
    }
    if (request.method === "POST") {
      expect(request.headers["content-type"]).toBe("application/json");
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      expect(JSON.parse(body)).toEqual({ enabled: true });
    }
    response.end(
      JSON.stringify({ success: true, result: { subdomain: "test-account" } }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Test server did not bind a port");
    const validatedFetch = createValidatedFetch({
      policy: { allowPrivate: true },
    });
    const result = await deployRelay(
      (url, init) => {
        const target = new URL(url);
        expect(target.hostname).toBe("api.cloudflare.com");
        target.protocol = "http:";
        target.hostname = "127.0.0.1";
        target.port = String(address.port);
        return validatedFetch(target, init);
      },
      {
        target: "cloudflare",
        accountId: "test-account",
        projectName: "test-relay",
        token: "synthetic-token",
      },
    );
    expect(result.relayUrl).toBe("https://test-relay.test-account.workers.dev");
    expect(uploaded).toBeDefined();
    const script = uploaded?.get("index.js");
    const metadata = uploaded?.get("metadata");
    if (!(script instanceof Blob) || !(metadata instanceof Blob))
      throw new Error("Missing worker upload parts");
    expect(multipartBody).toContain(
      "\r\nContent-Type: application/javascript+module\r\n",
    );
    expect(await script.text()).toBe(RELAY_WORKER_SOURCE);
    expect(JSON.parse(await metadata.text())).toEqual({
      main_module: "index.js",
      compatibility_date: "2024-03-20",
    });
    expect(declaredBytes).toBe(uploadedBytes);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
