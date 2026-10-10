import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { directChoiceRequest, type RequestSpec } from "../src/systemone.js";
import { decisionReply } from "./fixtures.js";

const execute = promisify(execFile);

// Test-only self-signed certificate for CN=127.0.0.1; never trusted by the client under test.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCiPx6TQL6Wxo8j
ndzVM8wgvPgNMmiB9cAl3MJlQU+AJHud6AkiN7rCH5svkw0KtoFdn9DDFmuA+asb
2WVb3KPgNNTGo2AU04o9F/rAqhR0RI6/ut7Uioi7/8T79G0a9dsFCRBK85PlAV5D
8PW6pR8LEwoQjOqVN+/E+cu0ZbljMx2gu6pj6qGQ8KP2JRiUordfoEBPAXof+vOp
AW8g1z8UYgWuPSc9zbqf1JHjs3wskKUM+X5U7+O2g15AMqSPYbvW9gHfr1p5AtNh
E2WnSxUw9VNOBywYyioU7UAsBT2YjbU6TICC+g5Lbtar6aDKx+B7wGyRx4lFW3sP
NzKvNObpAgMBAAECggEACN1AdyScKmzY61tSXPlKajEmL0MQB9EB/r+ShQmIsFRY
nE5jWLHT8QuyL5WjP9uBSA4gJSx6J/mGt6E3bbRUEBRAL3Bud9d9OmxvOCwCrT3a
pmSCt04wqBl9AmlUCwX1gaSsCyBG4LCOsnu9fS/3eSQrklm/Q52jAATIHvLI1RUi
qhFeftANH95kgeRo8MuLLgHE1KmzXpd+X9HuOzjI3h4oQvITvMZBvmyWCtRUPgpD
39z1H/ShE5Uv1cDs4grf0vIcZSgbcHo+409T7wG3+lyaGXJJTHawg97C2qjjtXh6
1S1eNlhTdPkIz8kVpzi7KSDiRCypNxr/Uv+Q13HDlQKBgQDQJVIysHjxnsHFb/Nu
r7cFSqocCf4ioQuoSl75k6OlJGECAleV0OPlWxYA9WEl4UILX+5xZZVd9whPZosj
0moztSEYAOIkcRZqzN4lcAdDZU7vJ71At3qcKB84bB/h95M9JnDVJk4e9j/bpXfI
VcZiY+KECCAbGg5sDasc1Ra73QKBgQDHjFenh/uPsd7cgH35erCIrPqoV0Ef4t+F
F79k0P9IfGLRjowF8KJ3U6bWa33nO7zzHwDKptyRFsDf3oPt8JZILF7FR9YKPTYH
rE4K9Ok46vc9KZqISSC5vga0hu/0bWXb+iD1JjZTNEiiLfXEcJ33MeT4YEM6x5n7
ci+ua1scfQKBgDsW7T/go2UMibvwLS52CcIh0SsGlzPjfji3bEDz7dga/MMiQRUR
6TCabCO3hW3IhgROppVgnke/soc/+C4iNO4a9Jso3Qo1ZITLRiFgrV8vqnnwUSTH
MbKVHU/aOi7fJtiMSinopvLZO4Wycs/XsesKqiqLV/n5qrB4LOSRhdOtAoGBAInw
ertFZeEcDLmSXQKzDAs+v/rUbiFTnD2Nf/F6A64gxdKkXijRAg3IlqDMJ3lLsz7A
pLRxijEFcIiQcdRuJgR4H37yPIRRceL1+fDbAcklq4jtFHS3UFb1g/8Q9Bib8viQ
PG4aXx0/HCJ38Nc9HgU9yVDkgjTEu620bj982LulAoGBALF6JoFvmeNafzdHZ9TF
sN8GFhZXUVPwpiw7t1ChWqitObo+je77f5ALsDZF2FGCoxGr0O+YBujYJuD1eNL2
KPHaxv+kPuUjdNX4AAa0ePpNuj2k/CIXIPATWfagKuPwHFQcMAsEHzosKg+TuKX4
zCYvbbJWHAm44tyg2gfMqGDe
-----END PRIVATE KEY-----`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDHDCCAgSgAwIBAgIUHeBNP6Or1as30MT2oG9AF2/xJ24wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTAwNzA0MDkwOFoYDzIxMjYw
OTEzMDQwOTA4WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCiPx6TQL6Wxo8jndzVM8wgvPgNMmiB9cAl3MJlQU+A
JHud6AkiN7rCH5svkw0KtoFdn9DDFmuA+asb2WVb3KPgNNTGo2AU04o9F/rAqhR0
RI6/ut7Uioi7/8T79G0a9dsFCRBK85PlAV5D8PW6pR8LEwoQjOqVN+/E+cu0Zblj
Mx2gu6pj6qGQ8KP2JRiUordfoEBPAXof+vOpAW8g1z8UYgWuPSc9zbqf1JHjs3ws
kKUM+X5U7+O2g15AMqSPYbvW9gHfr1p5AtNhE2WnSxUw9VNOBywYyioU7UAsBT2Y
jbU6TICC+g5Lbtar6aDKx+B7wGyRx4lFW3sPNzKvNObpAgMBAAGjZDBiMB0GA1Ud
DgQWBBQ79UnLWoNfKfW/l2uOpJeJDoUvizAfBgNVHSMEGDAWgBQ79UnLWoNfKfW/
l2uOpJeJDoUvizAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBH8AAAEwDQYJ
KoZIhvcNAQELBQADggEBAAwzrlfkLhFrUNH5rpRQaNLm1t0adhsSMmtfse0pmZHU
sazDcajYHV1GRSacKDCkkN/8kZ3dswJ3/q+23ot9bi1FMAZEEBP33oeCbvvRDq6h
SjA0zpe3byDy37rMYzLvhuw7XNyui9AYT/9Clu8Ymm8v6YG3QgdauZrsni2yZm8G
+fkgRpnVRbH4P/DSY2CQPFhNj7y8rp30hH+9YN+0iGP6agqAXfN55fsYzOtklIEK
uM2KXlHigxsgSIzxP5wqdwt/3BzHUaMNbPs8rzL/lhH/mys9jENHUzkXVaeoj3TK
/JbJf0tYaAP90BnyRSU+cTJsBk57DcFPo2lk2oPRiNA=
-----END CERTIFICATE-----`;

const CHILD_SCRIPT = `const { directChoiceRequest } = await import(process.argv[2]);
try {
  const reply = await directChoiceRequest({
    backend: "laya",
    url: new URL(process.argv[3]),
    body: JSON.stringify({ probe: true }),
    headers: { "content-type": "application/json", authorization: "Bearer TEST" },
    signal: AbortSignal.timeout(10000)
  });
  console.log("REPLY " + JSON.stringify(reply));
} catch (error) {
  console.log("TRANSPORT_ERROR " + String(error && error.message));
  process.exit(1);
}
`;

// Positive control: a plain default-agent http.get with no explicit agent must
// be routed through the environment proxy, proving the proxy setup is live.
const CONTROL_SCRIPT = `const { get } = await import("node:http");
try {
  const body = await new Promise((resolve, reject) => {
    const request = get(process.argv[2], { signal: AbortSignal.timeout(10000) }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve(text));
    });
    request.on("error", reject);
  });
  console.log("CONTROL " + body);
} catch (error) {
  console.log("CONTROL_ERROR " + String(error && error.message));
  process.exit(1);
}
`;

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void> | void;

const startServer = async (t: TestContext, handler: Handler, tls: boolean = false) => {
  const requests: IncomingMessage[] = [];
  const serve = (request: IncomingMessage, response: ServerResponse) => {
    requests.push(request);
    response.on("error", () => { /* A rejected peer must not crash the fixture. */ });
    void handler(request, response);
  };
  const server: Server = tls ? createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }, serve) : createServer(serve);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: new URL(`${tls ? "https" : "http"}://127.0.0.1:${address.port}/v1/systemone`), requests };
};

const spec = (url: URL, signal: AbortSignal = AbortSignal.timeout(5000), body = "{\"probe\":true}"): RequestSpec =>
  ({ backend: "laya", url, body, headers: { "content-type": "application/json" }, signal });

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const jsonReply = JSON.stringify(decisionReply("fast"));
const bareReply = JSON.stringify({ answers: { route: { type: "choice", choice: "fast" } }, pad: "" });
const exact8192 = JSON.stringify({ answers: { route: { type: "choice", choice: "fast" } }, pad: "x".repeat(8192 - bareReply.length) });
const oversize8193 = JSON.stringify({ answers: { route: { type: "choice", choice: "fast" } }, pad: "x".repeat(8193 - bareReply.length) });
assert.equal(exact8192.length, 8192);
assert.equal(oversize8193.length, 8193);

test("posts the body and resolves the decoded JSON reply", async t => {
  let seen: { method?: string; url?: string; contentType?: string; body?: string } | undefined;
  const fixture = await startServer(t, async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen = { method: request.method, url: request.url, contentType: request.headers["content-type"], body };
    response.setHeader("content-type", "application/json");
    response.end(jsonReply);
  });
  const reply = await directChoiceRequest(spec(fixture.url));
  assert.deepEqual(reply, decisionReply("fast"));
  assert.ok(seen);
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/v1/systemone");
  assert.equal(seen.contentType, "application/json");
  assert.deepEqual(JSON.parse(String(seen.body)), { probe: true });
});

test("accepts exactly 8192 actual bytes", async t => {
  const fixture = await startServer(t, (request, response) => { response.end(exact8192); });
  assert.deepEqual(await directChoiceRequest(spec(fixture.url)), JSON.parse(exact8192));
});

test("rejects 8193 actual bytes as too large", async t => {
  const fixture = await startServer(t, (request, response) => { response.end(oversize8193); });
  await assert.rejects(() => directChoiceRequest(spec(fixture.url)), /too large/);
});

test("counts actual bytes beyond a small declared length", async t => {
  const fixture = await startServer(t, (request, response) => {
    response.setHeader("content-length", "10");
    response.end("x".repeat(9000));
  });
  await assert.rejects(() => directChoiceRequest(spec(fixture.url)),
    error => error instanceof Error && /^classifier (request|response) (too large|failed)$/.test(error.message));
});

test("rejects a declared Content-Length over the bound before reading", async t => {
  const fixture = await startServer(t, (request, response) => {
    response.setHeader("content-length", "9000");
    response.end(jsonReply);
  });
  await assert.rejects(() => directChoiceRequest(spec(fixture.url)), { message: "classifier response too large" });
});

test("rejects a truncated body without exposing the socket error", async t => {
  const fixture = await startServer(t, (request, response) => {
    response.setHeader("content-length", "100");
    response.write(jsonReply.slice(0, 20));
    response.destroy();
  });
  await assert.rejects(() => directChoiceRequest(spec(fixture.url)),
    error => error instanceof Error && /^classifier (response was truncated|request failed|response failed)$/.test(error.message));
});

test("reassembles split UTF-8 bodies", async t => {
  const fixture = await startServer(t, async (request, response) => {
    const bytes = Buffer.from(JSON.stringify({ answers: { route: { type: "choice", choice: "fast" } }, note: "界界界界" }), "utf8");
    for (let offset = 0; offset < bytes.length; offset += 2) {
      response.write(bytes.subarray(offset, Math.min(offset + 2, bytes.length)));
      await sleep(1);
    }
    response.end();
  });
  assert.deepEqual(await directChoiceRequest(spec(fixture.url)),
    { answers: { route: { type: "choice", choice: "fast" } }, note: "界界界界" });
});

test("rejects malformed JSON and invalid UTF-8", async t => {
  const malformed = await startServer(t, (request, response) => { response.end("{\"answers\":"); });
  await assert.rejects(() => directChoiceRequest(spec(malformed.url)), { message: "invalid classifier response" });
  const invalidUtf8 = await startServer(t, (request, response) => {
    response.setHeader("content-length", "3");
    response.end(Buffer.from([0x7b, 0xff, 0x7d]));
  });
  await assert.rejects(() => directChoiceRequest(spec(invalidUtf8.url)), { message: "invalid classifier response" });
});

test("rejects bodyless 204 and 205 responses", async t => {
  for (const status of [204, 205]) {
    const fixture = await startServer(t, (request, response) => {
      response.statusCode = status;
      response.end();
    });
    await assert.rejects(() => directChoiceRequest(spec(fixture.url)), { message: "classifier response has no body" });
  }
});

test("rejects non-2xx statuses including 304 without exposing details", async t => {
  for (const status of [304, 400, 500]) {
    const fixture = await startServer(t, (request, response) => {
      response.statusCode = status;
      response.end("service detail that must not leak");
    });
    await assert.rejects(() => directChoiceRequest(spec(fixture.url)), { message: "classifier HTTP " + status });
  }
});

test("rejects a redirect without requesting the Location", async t => {
  const target = await startServer(t, (request, response) => { response.end(jsonReply); });
  const fixture = await startServer(t, (request, response) => {
    response.statusCode = 302;
    response.setHeader("location", target.url.href);
    response.end();
  });
  await assert.rejects(() => directChoiceRequest(spec(fixture.url)), { message: "classifier HTTP 302" });
  assert.equal(target.requests.length, 0);
});

test("rejects an unsupported content encoding", async t => {
  for (const encoding of ["gzip", "br"]) {
    const fixture = await startServer(t, (request, response) => {
      response.setHeader("content-encoding", encoding);
      response.end(jsonReply);
    });
    await assert.rejects(() => directChoiceRequest(spec(fixture.url)), { message: "unsupported classifier response encoding" });
  }
});

test("rejects a socket destroyed before the response without native error text", async t => {
  const fixture = await startServer(t, request => { request.destroy(); });
  await assert.rejects(() => directChoiceRequest(spec(fixture.url)), { message: "classifier request failed" });
});

test("rejects an invalid header construction with a sanitized error", async t => {
  const fixture = await startServer(t, () => assert.fail("the fixture must not receive a request"));
  await assert.rejects(() => directChoiceRequest({
    ...spec(fixture.url), headers: { "content-type": "application/json", authorization: "Bearer bad\nvalue" }
  }), { message: "classifier request failed" });
  assert.equal(fixture.requests.length, 0);
});

test("rejects a self-signed TLS certificate with verification kept on", async t => {
  const fixture = await startServer(t, (request, response) => { response.end(jsonReply); }, true);
  const error = await directChoiceRequest(spec(fixture.url)).then(() => null, (failure: unknown) => failure);
  assert.ok(error instanceof Error);
  assert.equal(error.message, "classifier request failed");
  assert.equal(fixture.requests.length, 0, "the request must die in the TLS handshake, not reach the server");
});

test("expires the total deadline without waiting for the response", async t => {
  const fixture = await startServer(t, async (request, response) => {
    await sleep(1000);
    response.end(jsonReply);
  });
  const began = performance.now();
  await assert.rejects(() => directChoiceRequest(spec(fixture.url, AbortSignal.timeout(60))),
    { message: "classifier request was cancelled" });
  assert.ok(performance.now() - began < 900, "the deadline must not wait out the delayed response");
});

test("honours caller cancellation mid-body", async t => {
  const fixture = await startServer(t, (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{\"answers\":");
    request.on("close", () => response.end());
  });
  const controller = new AbortController();
  const attempt = directChoiceRequest(spec(fixture.url, controller.signal));
  setTimeout(() => controller.abort(), 30).unref();
  await assert.rejects(() => attempt, { message: "classifier request was cancelled" });
});

test("accepts delayed headers and delayed bodies within the deadline", async t => {
  const delayedHeaders = await startServer(t, async (request, response) => {
    await sleep(60);
    response.setHeader("content-type", "application/json");
    response.end(jsonReply);
  });
  assert.deepEqual(await directChoiceRequest(spec(delayedHeaders.url)), decisionReply("fast"));
  const delayedBody = await startServer(t, async (request, response) => {
    const bytes = Buffer.from(jsonReply, "utf8");
    response.setHeader("content-length", String(bytes.length));
    for (const byte of bytes) {
      response.write(Buffer.from([byte]));
      await sleep(1);
    }
    response.end();
  });
  assert.deepEqual(await directChoiceRequest(spec(delayedBody.url)), decisionReply("fast"));
});

// The built-in environment proxy (NODE_USE_ENV_PROXY on the default agent)
// exists on 24.5+ only. On older runtimes the direct assertions below still
// run, but they are not evidence that an activated proxy was bypassed.
const supportsEnvProxy = (() => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 24 || (major === 24 && minor >= 5);
})();

const proxyChild = async (t: TestContext, nodePath: string) => {
  const sentinel = await startServer(t, (request, response) => { response.end("proxied"); });
  const fixture = await startServer(t, (request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(jsonReply);
  });
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-transport-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "proxy-child.mjs");
  await writeFile(script, CHILD_SCRIPT);
  const controlScript = join(directory, "proxy-control.mjs");
  await writeFile(controlScript, CONTROL_SCRIPT);
  const dist = pathToFileURL(fileURLToPath(new URL("../src/systemone.js", import.meta.url))).href;
  const proxy = sentinel.url.origin;
  for (const noProxy of [undefined, ""]) {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_USE_ENV_PROXY: "1" };
    delete env.NO_PROXY;
    delete env.no_proxy;
    delete env.NODE_OPTIONS;
    env.http_proxy = env.https_proxy = env.HTTP_PROXY = env.HTTPS_PROXY = proxy;
    if (noProxy !== undefined) {
      env.NO_PROXY = noProxy;
      env.no_proxy = noProxy;
    }
    if (supportsEnvProxy) {
      const sentinelBefore = sentinel.requests.length;
      const fixtureBefore = fixture.requests.length;
      const control = await execute(nodePath, [controlScript, fixture.url.href], { encoding: "utf8", timeout: 30000, env })
        .catch((failure: { stdout?: string; stderr?: string }) => {
          assert.fail(`control child failed: ${failure.stderr} ${failure.stdout}`);
        });
      assert.match(String(control.stdout), /CONTROL proxied/, "a default-agent request must consume the sentinel's proxied reply");
      assert.equal(sentinel.requests.length, sentinelBefore + 1, "the default-agent control must add exactly one proxy request");
      assert.equal(fixture.requests.length, fixtureBefore, "the default-agent control must not reach the target directly");
    }
    const sentinelAfterControl = sentinel.requests.length;
    const fixtureAfterControl = fixture.requests.length;
    const run = await execute(nodePath, [script, dist, fixture.url.href], { encoding: "utf8", timeout: 30000, env })
      .catch((failure: { stdout?: string; stderr?: string }) => {
        assert.fail(`child failed: ${failure.stderr} ${failure.stdout}`);
      });
    assert.match(String(run.stdout), /REPLY \{"answers":\{"route":\{"type":"choice","choice":"fast"\}\}\}/);
    assert.equal(sentinel.requests.length, sentinelAfterControl, "direct transport must add zero proxy requests");
    assert.equal(fixture.requests.length, fixtureAfterControl + 1, "direct transport must reach the target exactly once");
  }
};

test("explicit verification ignores NODE_TLS_REJECT_UNAUTHORIZED=0", async t => {
  const fixture = await startServer(t, (request, response) => { response.end(jsonReply); }, true);
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "tls-child.mjs");
  await writeFile(script, CHILD_SCRIPT);
  const dist = pathToFileURL(fileURLToPath(new URL("../src/systemone.js", import.meta.url))).href;
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" };
  const outcome = await execute(process.execPath, [script, dist, fixture.url.href], { encoding: "utf8", timeout: 30000, env })
    .then((run: { stdout: string }) => run.stdout,
      (failure: { stdout?: string }) => String(failure.stdout ?? ""));
  assert.match(outcome, /TRANSPORT_ERROR classifier request failed/);
  assert.doesNotMatch(outcome, /REPLY/);
  assert.equal(fixture.requests.length, 0, "the request must die in the TLS handshake");
});

test("direct transport ignores an enabled environment proxy (current runtime)", async t => {
  await proxyChild(t, process.execPath);
});
