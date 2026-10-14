import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect, createServer as createRawServer, type Socket } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseJevTransport, parseProjectConfig, type JevTransport } from "../src/config.js";
import { doctorProject } from "../src/doctor.js";
import { initProject } from "../src/init.js";
import { routeTask } from "../src/route.js";
import { ClassifierRequestError, choiceRequest, requestTaskChoice, type RequestSpec } from "../src/systemone.js";
import { decisionReply, fakeEnv, fixtureConfig } from "./fixtures.js";

// Isolated synthetic fixture certificate authority and leaves. The CA is
// trusted only by fixture child processes through NODE_EXTRA_CA_CERTS; the
// product itself never gains a CA or verification option.
const FIXTURE_CA = `
-----BEGIN CERTIFICATE-----
MIIDHzCCAgegAwIBAgIUI3tweswFiXS3htjx7LZJA4oKa+8wDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTVHVybmhlbG0gRml4dHVyZSBDQTAgFw0yNjEwMTQxMjEy
NThaGA8yMTI2MDkyMDEyMTI1OFowHjEcMBoGA1UEAwwTVHVybmhlbG0gRml4dHVy
ZSBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAL2iOZIE5jAVHBbn
qH/1FTuuxzpe9lAs8rr8t1qOYJRzLdImdtT92V1NE90fOQa+xRIDDp26OeT3aUtm
0gjq3ArZQw3OWLbb7Ybzwj7BCAld8FqyUok9DUpLhvXcM2hummsksaHU9SanUEbT
wb680MaUY4x9YakBZ7BAyLgO1T/AApGWTJOUfageJhSKQX7P+pHHDoNX6Vl6lhci
4w60b2zI3irqLrny4ovaJAUCNuuhDdzIOt0CMu2p9u9+JMwaKQBcSx/QPu8OJYrf
ApDuwDA3BFGRM+bdRKGgKwB3lsNXc9fsiEeq3jPBUOu+btaYrr+f5QM2YMj8Mn+c
9rfsjcMCAwEAAaNTMFEwHQYDVR0OBBYEFJANyyVLYHVkFRpwD0iVjPjj7ZjOMB8G
A1UdIwQYMBaAFJANyyVLYHVkFRpwD0iVjPjj7ZjOMA8GA1UdEwEB/wQFMAMBAf8w
DQYJKoZIhvcNAQELBQADggEBAEzJMgF50nN9mnFsEwmue8Mq751SvBVf+b9YDdyy
0K0ZannEMyb7k4Z6EOwlpwCvfHHW2rftbMqGEz51n28p6HWnJWB6rzL3syFInjMf
eF2iHCMFgVSurm9RCAbfPUedlTEHv+El3cqzaIixKCe31hHlTmBnbI80J2EPEVlj
QTsqlGb2yr4GoXlBefUhCVqJ8IoSK7Rm/YCHGXRS0u0s40ymMj5au6I91R+IuzvV
nWug9fAL1qro5PjB/LzRHDNt163VTW7Rd7rsMKdJvwXLKDTQlarkH2X6lE9v85K/
I1CYrliM8Rb4vV9fs9yovzdERB/nHsAMb1zY5KjfLstrVV8=
-----END CERTIFICATE-----
`;
const JEV_KEY = `
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCbRm/koJ9+adBK
ndXrg2mwhYuOkZdGJ2ZL2PdZS7ZX+1jTB3pKgjMN56RH+88hVn927u02J5pyJ95g
jRi4w9sGYxhotwxqyKIgDvO3THPS0QZnYoKZQ0B7X2SdDYsDas4IErypyN/CTzPb
IbXATYGSNIeHOQwxOnBtDrwrAJ7zZKeueAcyqyRgrgjpgphSHLEwhybmHrds4Nsj
8XCr0ZOlnmTyxO8kr5oWxJsxK52Q7m06kqlamlVu8lC2g6gSKdObmoBhmZLRtt5m
d/qmhMBKnD75+UAKL97PqFBPHMse7g3g0oTRvgH/fNmXPFWQLdnt5IthEQClO+wa
ieCPRBmFAgMBAAECggEAFCZsI1p/0CcZp3E7n0xGtShjb60vmSRIR2wAz1b+swS0
ZnBYO56RUwrePBQusUgZEv1XDbnOdmV7m4J79JBAFmBaPM6SXzIpreja0kzq0+8Z
umVjhtGeJtR+iU4GXftogM4zqwHdHclq9JM3k5zLRYapFtB9p07K47AvlZIHTpTr
zK1zQ6jNol4aPYhpl2mu2hpj7rZQDPySYLde4sItxEJ1+qXxjKoAzlcbctl/aBQF
OFXwXM9aMTB7XblKGc7UOTkyyOLC1beR2POoyWV0lFPwDeqjisw8zjBRdDzvwAf7
T59n3n0ULI9N5Dr7Qd4yDfd33lZGUZ8e/z54PCS+gQKBgQDQX7d4p1Dbb5PGaH5D
CMvW9f5cQAsslL55uuVxl82CBbseTR/lOsGx4qd2g+RwdDlKB58kx2uFwOnLuAX6
2TGpkP0Dualtto2ihXbviCXs6m0q+Zz/VyBLkrNRFvxbuZ7PKoR2e/ifyqF4vQqz
eeRGn5EmksWcl3VkRj6Bo9RMBQKBgQC+w9RP7muELr/dHs0E5l28M7WO18Pypyvv
H7a5p34x1ZSwyWv94LOrnYWjGgTVdMzB9m+vcjGDQpVIyzWgybgGpC1JLloX3MW/
rLvZeSHVqZG27TAWqmIlaPIWghCtfqXAgPWwD/vceMuP0th3pFO8nU1XSAhxINLY
hMLyavePgQKBgQCnZl4VFgXFZEwJt2TIIcbwuMtR/Tl85TpovRcbPOMis8vxufAH
zj5R1E7IzYi2NwjXSmw1tefRmnu45+wV7GsTWKGLXpqYw3HhwOsd3/jn7iUpw0K3
d51AWWipmpe+cM7+i5/DODEy3iz+vJBeQ2x6uDJ6FKug86ShnDUXHTCuqQKBgEqg
hWA3nyv4teok8INoM2c6u14EHo3AxDkpqOv8ECwip6Z5RZvt2ZvbZbompZlztd5z
L8Hs5F27IHd3t6UNBMbkVyr3zRrkrR+MzXgIISpaybxMEbHsObT01y/i9e9JSkKC
sJqNxjO7tbav/yreyDtTNjxc26CV/KXjWfhHzE0BAoGAQP1uAEZmwFYu9dYy2dla
sKtjJPXi98KOF8GAHu0Md7gUTudNcVVP4uPknI+9fPepQmNtOycSq0Qft4K/80vP
pmHLTkZ2kfe+NKMSwGCxCeER5xRyaDxZH2bOfLiLV+PYkNDjtnqVACwmr3ew5i9J
JNtOYHqkQ4y3MaQi6eb/iG8=
-----END PRIVATE KEY-----
`;
const JEV_CERT = `
-----BEGIN CERTIFICATE-----
MIIDOzCCAiOgAwIBAgIUVwXPvJ0bZ5oN7Dlt5GRCCd2jj9cwDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTVHVybmhlbG0gRml4dHVyZSBDQTAgFw0yNjEwMTQxMjEy
NThaGA8yMTI2MDkyMDEyMTI1OFowGjEYMBYGA1UEAwwPYXBpLnR5cGVzYWZlLmFp
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAm0Zv5KCffmnQSp3V64Np
sIWLjpGXRidmS9j3WUu2V/tY0wd6SoIzDeekR/vPIVZ/du7tNieacifeYI0YuMPb
BmMYaLcMasiiIA7zt0xz0tEGZ2KCmUNAe19knQ2LA2rOCBK8qcjfwk8z2yG1wE2B
kjSHhzkMMTpwbQ68KwCe82SnrngHMqskYK4I6YKYUhyxMIcm5h63bODbI/Fwq9GT
pZ5k8sTvJK+aFsSbMSudkO5tOpKpWppVbvJQtoOoEinTm5qAYZmS0bbeZnf6poTA
Spw++flACi/ez6hQTxzLHu4N4NKE0b4B/3zZlzxVkC3Z7eSLYREApTvsGongj0QZ
hQIDAQABo3MwcTAaBgNVHREEEzARgg9hcGkudHlwZXNhZmUuYWkwEwYDVR0lBAww
CgYIKwYBBQUHAwEwHQYDVR0OBBYEFALx7SK0A86WlaiawMEty9aI8GxXMB8GA1Ud
IwQYMBaAFJANyyVLYHVkFRpwD0iVjPjj7ZjOMA0GCSqGSIb3DQEBCwUAA4IBAQBT
LQAkWzpPPg07C5gihqk6Toq8Ygr++65QelEVufCQhK81vj5/a4VDCIiIfSpKi3P3
4DjJ9ZvTdil6abiyNmUxDMacBgfDzgrqNUskpiURP+jaYz+RFaQl0C44G4eh40Fp
5D2D7NQhqYMVJqrslmOOBAsN7g3y6koy1ADo/A2omyya5mwGxeLkc9Ry+sjm2Wa4
3rs+FTg2jGk82L9prBbPz1VegkVDH+q1hMBDzDxnVH6IM1ZkZu9lsu/fVhLWAq1X
fOU20i6kBjY2BMUAVdXHPzXJyOxt/DZtwoHFAxytbYgVR4c3rMqZD3NJbFEDl5uB
2A34I64xqxPPd6rm9tni
-----END CERTIFICATE-----
`;
const WRONG_KEY = `
-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDo8a5kP4/ewlMw
5i5OMd4rLp5ayGcQ0JIBwVzeRhKfDxiaelss5KNe4o/M8nRaQ6pq/oZ1wITHSh5W
NDpiaM0JIj9IHBvz05UkvJ17sAQJ+pSDqfnOiNGrKA6+l8azbDOodYaw7qDh3Yby
ZIGFsRurp1R4g3BYoYCyLYZl09Q9tuVaO5R8xyrLidgXHe1XyYWe+jwvgAIknASz
czFTiLN9/eosrKQKeJcf6y08Zw5iv/BDTsYtLwwme+0P2bhzSs9s8krqYr+l14o6
TZdb5PeNF1Dv66LmxobWobA+e+3nCliYFy8v80/aYAhWmW4DcnDU5fB/ibBQ0i2n
/60yvo8JAgMBAAECggEAUsbDIkOGA/II7uj0znuhB7ZGtlrdaRe8spv8PM4owtXx
978AFElhFpAq6njDyOmfruqobEKPzGO1uQtRLfQw3AyL8Ttv4Wqv5oCR88h9/u/J
A6qMpwxueURATRERHmQWTUgKJ2h8yhZW5F67uf7QJuTMuxB2BUDKw0YzKo8mLhFY
8jeSPA483ySS//XqPyi9mnvhTT9tb5tAGY6nuZNX6G10f9wt5H5dYEcy6UgeSS8o
VhSSwQvX0u90nst7lNI1XOtiRCRXVdaUHbdHt1zsagp5aCVt/IfBrp587GVqgafK
CsarXB8g4rOXjkEz1pfVqRiSkWq5V85RDiU2gx3DgwKBgQD8pVblADKyLnJF3IEP
AShZC7tDBuGDaL5c5HcYPImPpig1ZV20VmYmtSeSi9775JddauF5hLk3MqYTxNyk
h8zFW2CuCev48jpJyjwzii0RPk25gQB/zEIY+i4w8hkgeEoNeTPLr8TM7m/wGdmk
IFdgbYeHW/tvZ40WzhaR3ZWJawKBgQDsCWHA9qFr0dLtOZMtIdaHcU/qR2J+5ftT
3x0PwpbvsmxTrvJnXcy2/j6rVR9mgtNQryPSUhXTB/4bwEn42O8JBHaFBc9aua7f
jqOsjMKzx+j8oR4m71dlVRCm2zmTc54avHmgu0RLBsEjHbmxNgroYXPF3d19kVmG
o+8oDCOiWwKBgDw7DqQ5j9x6xjNxhjMVi5DvAw3PriOt7PQoY1wb0o+0hRF1wQkl
L+U6etytC9Pxg0R6Hpbh1WYbZQyBejifR2olhr73DpKi7NJ6rC99WZEq0UzQPFY7
U+awfiKdFPBwvPbJVlfQ55ITpgwPnZtLOol6kzzp6N9+SFyPdUIBGY1RAoGAU2UB
L78zyzdoMb6c3F5PQK1tUdYE29b/1GNJDk9vKqM8mNh/9rtyX9k2ZSx/GqXwaVpn
6qBr65KwWje3Kv/ifKoiAd/KokBmo7/u3kEhbYmdLNz0HUeE9l12s61TC2DXJJUg
2AQyHdv2EyUmfZEdi3sa/3bjEcFwAx0am2imkm8CgYB9wcrUsZjaR9W66R9gLejt
FqSMbcfAqOKJ4AdZ0BWbWAcGpDRAm8Cg8hLqJI6VyBIeh63Ne7QaTGLOE13GwO8I
mX8Vz3dxqBLHZfyTC1uST7lXlsWlGw9liXqrV4xG48PcejaNEjJnsxhA30mqYI+M
dCDKpYvJczcP74iFfbRzyQ==
-----END PRIVATE KEY-----
`;
const WRONG_CERT = `
-----BEGIN CERTIFICATE-----
MIIDOzCCAiOgAwIBAgIUVwXPvJ0bZ5oN7Dlt5GRCCd2jj9gwDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTVHVybmhlbG0gRml4dHVyZSBDQTAgFw0yNjEwMTQxMjEy
NThaGA8yMTI2MDkyMDEyMTI1OFowGjEYMBYGA1UEAwwPZml4dHVyZS5pbnZhbGlk
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6PGuZD+P3sJTMOYuTjHe
Ky6eWshnENCSAcFc3kYSnw8YmnpbLOSjXuKPzPJ0WkOqav6GdcCEx0oeVjQ6YmjN
CSI/SBwb89OVJLyde7AECfqUg6n5zojRqygOvpfGs2wzqHWGsO6g4d2G8mSBhbEb
q6dUeINwWKGAsi2GZdPUPbblWjuUfMcqy4nYFx3tV8mFnvo8L4ACJJwEs3MxU4iz
ff3qLKykCniXH+stPGcOYr/wQ07GLS8MJnvtD9m4c0rPbPJK6mK/pdeKOk2XW+T3
jRdQ7+ui5saG1qGwPnvt5wpYmBcvL/NP2mAIVpluA3Jw1OXwf4mwUNItp/+tMr6P
CQIDAQABo3MwcTAaBgNVHREEEzARgg9maXh0dXJlLmludmFsaWQwEwYDVR0lBAww
CgYIKwYBBQUHAwEwHQYDVR0OBBYEFI+6yXnt/4dU7Nu7WoFY1rliC7nOMB8GA1Ud
IwQYMBaAFJANyyVLYHVkFRpwD0iVjPjj7ZjOMA0GCSqGSIb3DQEBCwUAA4IBAQBX
GubLpsBxCGCjUGs8daQsblvn1hN3AdtohZOPF27aRUIym1nOTWcNZW8AOwj9ohzd
OlQVStYlcsqSFYFuHVN+8hqOW21YkzBN1GhUr3Sk/E/WbasQ7UVkkdv82pNMOTVd
xPNyrkvcS3MNxNLN0PNbfr7Xt1OQ23NWEylYyLX3FK/F4TaLPYNlSqe5T3W5TO/Z
XIUa7BquUFIsVcPmYMSsOQDOXkU1NKQZVxwQmSWdOouxNfMxGmDZfhKTvKXhYuHo
8Gvn/SohNcT29I31lkU3TyWEErJXZZOZqZHwAOHRhSY9PblizJNGv2W2rdfjr7RT
PzQapn3y4Knbc/WV6dvx
-----END CERTIFICATE-----
`;

const jsonReply = JSON.stringify(decisionReply("fast"));
const OFFICIAL_JEV_URL = "https://api.typesafe.ai/v1/systemone";
const DIRECT: JevTransport = Object.freeze({ mode: "direct" });

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const eventually = async (predicate: () => boolean, what: string, ms = 1500): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail(what);
};

const distUrl = (module: string): string =>
  pathToFileURL(fileURLToPath(new URL("../src/" + module, import.meta.url))).href;

// ---------------------------------------------------------------------------
// Owned loopback fixtures
// ---------------------------------------------------------------------------

type LoopbackServer = {
  once(event: "error", listener: (error: Error) => void): unknown;
  listen(port: number, host: string, callback: () => void): unknown;
  address(): { port: number } | string | null;
};

const listenLoopback = async (t: TestContext, server: LoopbackServer): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
};

const startHttp = async (t: TestContext): Promise<{ port: number; requests: IncomingMessage[] }> => {
  const requests: IncomingMessage[] = [];
  const server = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push(request);
    response.on("error", () => { /* a rejected peer must not crash the fixture */ });
    if (request.url === "/control") {
      response.end("direct-ok");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(jsonReply);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { port: await listenLoopback(t, server), requests };
};

// A forward-proxy sentinel for the environment activation control: it answers
// every request itself so the control can prove the default agent traversed it.
const startSentinel = async (t: TestContext): Promise<{ url: string; port: number; requests: number; connects: number }> => {
  let requests = 0;
  let connects = 0;
  const server = createHttpServer((_request: IncomingMessage, response: ServerResponse) => {
    requests += 1;
    response.on("error", () => {});
    response.end("proxied-ok");
  });
  server.on("connect", (_request: IncomingMessage, socket: Socket) => { connects += 1; socket.destroy(); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const port = await listenLoopback(t, server);
  return { url: `http://127.0.0.1:${port}`, port, get requests() { return requests; }, get connects() { return connects; } };
};

type OriginScript = "reply" | "stall" | "status451" | "oversize";

const startOrigin = async (
  t: TestContext,
  script: OriginScript = "reply",
  cert: string = JEV_CERT.trim(),
  key: string = JEV_KEY.trim()
): Promise<{ port: number; requests: IncomingMessage[]; bodies: string[]; closed: number }> => {
  const requests: IncomingMessage[] = [];
  const bodies: string[] = [];
  const sockets = new Set<Socket>();
  let closed = 0;
  const server = createHttpsServer({ key, cert }, (request: IncomingMessage, response: ServerResponse) => {
    requests.push(request);
    response.on("error", () => {});
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk; });
    request.on("end", () => {
      bodies.push(body);
      if (script === "stall") return; // never respond; the deadline must settle the client
      if (script === "status451") {
        response.statusCode = 451;
        response.end("ORIGIN-BLOCKED-SENTINEL");
        return;
      }
      if (script === "oversize") {
        response.setHeader("content-type", "application/json");
        response.end("x".repeat(8193));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(jsonReply);
    });
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); closed += 1; });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { port: await listenLoopback(t, server), requests, bodies, get closed() { return closed; } };
};

// Accepts tunnelled connections but never completes the TLS handshake. The
// peer still drains so a settlement-time close is observed, not deferred.
const startRawOrigin = async (t: TestContext): Promise<{ port: number; closed: number }> => {
  let closed = 0;
  const sockets = new Set<Socket>();
  const server = createRawServer((socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); closed += 1; });
    socket.on("error", () => {});
    socket.resume();
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { port: await listenLoopback(t, server), get closed() { return closed; } };
};

type ProxyScript = "tunnel" | "reject407" | "stall" | "disconnect" | "tunnelDestroy";

type ProxyFixture = {
  url: string;
  port: number;
  connects: { target: string | undefined; authorization: string | undefined; proxyAuthorization: string | undefined; headBytes: number }[];
  connections: number;
  clientCloses: number;
};

const startProxy = async (t: TestContext, script: ProxyScript, originPort?: number): Promise<ProxyFixture> => {
  const connects: ProxyFixture["connects"] = [];
  const upstreams = new Set<Socket>();
  // A CONNECT tunnel socket is detached from the HTTP server's connection
  // tracking, so closeAllConnections() cannot reap it; the fixture owns every
  // tunnelled client socket itself.
  const tunnels = new Set<Socket>();
  let connections = 0;
  let clientCloses = 0;
  const server = createHttpServer();
  server.on("connection", (socket: Socket) => {
    connections += 1;
    socket.on("close", () => { clientCloses += 1; });
  });
  server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => {
    connects.push({
      target: request.url,
      authorization: request.headers.authorization,
      proxyAuthorization: request.headers["proxy-authorization"],
      headBytes: head.length
    });
    tunnels.add(client);
    client.on("close", () => tunnels.delete(client));
    if (script === "stall") {
      // Accept the CONNECT and never answer it; the peer still drains on the
      // client's FIN so no half-open socket outlives the settlement.
      client.on("end", () => client.destroy());
      client.resume();
      return;
    }
    if (script === "disconnect") {
      client.destroy();
      return;
    }
    if (script === "reject407") {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n");
      return;
    }
    assert.ok(originPort !== undefined, "the tunnelling proxy needs an owned origin port");
    const upstream = netConnect(originPort, "127.0.0.1");
    upstreams.add(upstream);
    // Fixture peers drain on both error and close, so a severed client never
    // leaves a half-open tunnel behind.
    const fail = (): void => { upstream.destroy(); client.destroy(); };
    upstream.on("error", fail);
    client.on("error", fail);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => upstreams.delete(upstream));
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      if (script === "tunnelDestroy") {
        // Let the client start TLS, then sever the tunnel mid-handshake.
        setTimeout(() => client.destroy(), 20).unref();
        return;
      }
      client.pipe(upstream);
      upstream.pipe(client);
      // Drain on the peer's FIN so a settled client never leaves this side of
      // the tunnel half-open.
      client.on("end", () => client.end());
    });
  });
  t.after(async () => {
    for (const socket of tunnels) socket.destroy();
    for (const socket of upstreams) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const port = await listenLoopback(t, server);
  return {
    url: `http://127.0.0.1:${port}`, port, connects,
    get connections() { return connections; },
    get clientCloses() { return clientCloses; }
  };
};

const deadPort = async (t: TestContext): Promise<number> => {
  const server = createRawServer();
  const port = await listenLoopback(t, server);
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
};

// ---------------------------------------------------------------------------
// Guarded child processes
// ---------------------------------------------------------------------------

// The preload guard keeps every child on owned loopback ports: any dial the
// product attempts outside the fixture set is refused and reported, so a
// direct-fallback bug can never reach the real hosted origin.
const GUARD_CJS = `const net = require("node:net");
const tls = require("node:tls");
const owned = new Set(String(process.env.TEST_OWNED_PORTS ?? "").split(",").map(Number).filter(Number.isInteger));
const guarded = (original, label) => function (first, second) {
  const options = typeof first === "number"
    ? { host: typeof second === "string" ? second : undefined, port: first }
    : first;
  const host = String((options && (options.hostname ?? options.host)) ?? "").replace(/^\\[|\\]$/g, "");
  const ridesOwnedSocket = Boolean(options && options.socket);
  const port = Number(options && options.port);
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (ridesOwnedSocket || (loopback && owned.has(port))) {
    return original.apply(this, arguments);
  }
  console.log("GUARD_DENIED " + label + " " + host + ":" + port);
  throw new Error("TEST_GUARD refused " + label);
};
net.connect = guarded(net.connect, "net.connect");
net.createConnection = guarded(net.createConnection, "net.createConnection");
tls.connect = guarded(tls.connect, "tls.connect");
`;

type ChildOutcome = { code: number; stdout: string; stderr: string };

const runNode = async (
  t: TestContext,
  prefix: string,
  ownedPorts: readonly number[],
  nodeArgs: readonly string[],
  env: NodeJS.ProcessEnv = {},
  files: readonly [string, string][] = []
): Promise<ChildOutcome> => {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-" + prefix + "-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const guard = join(directory, "guard.cjs");
  await writeFile(guard, GUARD_CJS);
  for (const [name, body] of files) await writeFile(join(directory, name), body);
  return new Promise(resolve => {
    execFile(process.execPath, [...nodeArgs], {
      encoding: "utf8",
      timeout: 30000,
      killSignal: "SIGKILL",
      cwd: directory,
      env: {
        PATH: process.env.PATH ?? "",
        NODE_OPTIONS: "--require " + guard,
        TEST_OWNED_PORTS: ownedPorts.join(","),
        ...env
      }
    }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : error ? 1 : 0;
      resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
};

const assertNoDeniedDial = (run: ChildOutcome): void => {
  assert.equal(run.stdout.includes("GUARD_DENIED"), false, "no non-owned dial may be attempted: " + run.stdout + run.stderr);
  assert.equal(run.stderr.includes("GUARD_DENIED"), false, "no non-owned dial may be attempted: " + run.stderr);
};

const childJson = (run: ChildOutcome, marker: string): Record<string, unknown> => {
  const line = run.stdout.split("\n").find(candidate => candidate.startsWith(marker));
  assert.ok(line !== undefined, `expected a ${marker} line in ${JSON.stringify(run.stdout + run.stderr)}`);
  return JSON.parse(line.slice(marker.length)) as Record<string, unknown>;
};

const jevChildBody = (signalSource: string, tail = ""): string => `
const mod = await import(${JSON.stringify(distUrl("systemone.js"))});
try {
  const reply = await mod.choiceRequest({
    backend: "jev",
    url: new URL(${JSON.stringify(OFFICIAL_JEV_URL)}),
    body: JSON.stringify({ state: "Prove the routing invariants" }),
    headers: { "content-type": "application/json", authorization: "Bearer TEST_JEV_SENTINEL" },
    signal: ${signalSource},
    transport: { mode: "http-connect", proxyUrl: process.env.TEST_PROXY_URL }
  });
  console.log("REPLY " + JSON.stringify(reply));
} catch (error) {
  console.log("TRANSPORT_ERROR " + JSON.stringify({
    typed: error instanceof mod.ClassifierRequestError,
    message: error && error.message,
    failure: error && error.failure
  }));
  process.exitCode = 1;
}
${tail}
`;

const jevSpec = (proxyUrl: string, signal: AbortSignal): RequestSpec => ({
  backend: "jev",
  url: new URL(OFFICIAL_JEV_URL),
  body: JSON.stringify({ state: "Prove the routing invariants" }),
  headers: { "content-type": "application/json", authorization: "Bearer TEST_JEV_SENTINEL" },
  signal,
  transport: { mode: "http-connect", proxyUrl }
});

const transportFailure = async (spec: RequestSpec): Promise<ClassifierRequestError> => {
  const error = await choiceRequest(spec)
    .then(() => assert.fail("expected the transport to reject"), (failure: unknown) => failure);
  assert.ok(error instanceof ClassifierRequestError, "every transport failure is a typed error");
  assert.ok(Object.isFrozen(error.failure), "the failure projection is frozen");
  return error;
};

const caFile = async (t: TestContext): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "turnhelm-proxy-ca-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "fixture-ca.pem");
  await writeFile(path, FIXTURE_CA.trim() + "\n");
  return path;
};

// ---------------------------------------------------------------------------
// Boundary matrix
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const netModule = require("node:net") as Record<string, unknown>;
const tlsModule = require("node:tls") as Record<string, unknown>;

test("invalid backend target and policy never dial", async (t) => {
  const plain = await startHttp(t);
  const secureOrigin = await startOrigin(t);
  // Any dial the boundary might wrongly attempt is refused and recorded, so
  // this matrix proves zero Agent/request/socket creation, not just zero
  // fixture hits. The CJS dial entry points are interposed in this process and
  // restored afterwards; tests within a file run sequentially.
  const realConnect = netModule.connect;
  const realCreate = netModule.createConnection;
  const realTlsConnect = tlsModule.connect;
  let dialAttempts = 0;
  const refuseDial = (..._args: unknown[]): never => {
    dialAttempts += 1;
    throw new Error("TEST_GUARD dial refused");
  };
  netModule.connect = refuseDial;
  netModule.createConnection = refuseDial;
  tlsModule.connect = refuseDial;

  const official = new URL(OFFICIAL_JEV_URL);
  const plainUrl = (path = "/v1/systemone"): URL => new URL(`http://127.0.0.1:${plain.port}${path}`);
  const secureUrl = (path = "/v1/systemone"): URL => new URL(`https://127.0.0.1:${secureOrigin.port}${path}`);
  try {
    const cases: readonly [string, Omit<RequestSpec, "body" | "headers" | "signal">][] = [
      ["jev over http", { backend: "jev", url: plainUrl(), transport: DIRECT }],
      ["jev over http at the official host", { backend: "jev", url: new URL("http://api.typesafe.ai/v1/systemone"), transport: DIRECT }],
      ["jev non-official target", { backend: "jev", url: secureUrl(), transport: DIRECT }],
      ["jev target query", { backend: "jev", url: new URL(OFFICIAL_JEV_URL + "?x=1"), transport: DIRECT }],
      ["jev target fragment", { backend: "jev", url: new URL(OFFICIAL_JEV_URL + "#f"), transport: DIRECT }],
      ["jev target userinfo", { backend: "jev", url: new URL("https://key@api.typesafe.ai/v1/systemone"), transport: DIRECT }],
      ["jev target path", { backend: "jev", url: new URL("https://api.typesafe.ai/v1/other"), transport: DIRECT }],
      ["laya over https", { backend: "laya", url: secureUrl(), transport: DIRECT }],
      ["laya proxied policy", { backend: "laya", url: plainUrl(), transport: { mode: "http-connect", proxyUrl: `http://127.0.0.1:${plain.port}` } }],
      ["laya target query", { backend: "laya", url: plainUrl("/v1/systemone?x=1"), transport: DIRECT }],
      ["laya target fragment", { backend: "laya", url: plainUrl("/v1/systemone#f"), transport: DIRECT }],
      ["laya target userinfo", { backend: "laya", url: new URL(`http://key@127.0.0.1:${plain.port}/v1/systemone`), transport: DIRECT }],
      ["laya target path", { backend: "laya", url: plainUrl("/v1/other"), transport: DIRECT }],
      ["malformed transport mode", { backend: "jev", url: official, transport: { mode: "socks5" } as unknown as JevTransport }],
      ["malformed transport shape", { backend: "jev", url: official, transport: null as unknown as JevTransport }],
      ["direct transport with extra field", { backend: "jev", url: official, transport: { mode: "direct", extra: 1 } as unknown as JevTransport }],
      ["proxy transport without proxyUrl", { backend: "jev", url: official, transport: { mode: "http-connect" } as unknown as JevTransport }],
      ["malformed proxy host", { backend: "jev", url: official, transport: { mode: "http-connect", proxyUrl: "http://10.9.8.7:7890" } as unknown as JevTransport }],
      ["malformed proxy scheme", { backend: "jev", url: official, transport: { mode: "http-connect", proxyUrl: "socks5://127.0.0.1:7890" } as unknown as JevTransport }],
      ["malformed proxy port", { backend: "jev", url: official, transport: { mode: "http-connect", proxyUrl: "http://127.0.0.1:07890" } as unknown as JevTransport }],
      ["proxy port out of range", { backend: "jev", url: official, transport: { mode: "http-connect", proxyUrl: "http://127.0.0.1:65536" } as unknown as JevTransport }],
      ["proxy without a port", { backend: "jev", url: official, transport: { mode: "http-connect", proxyUrl: "http://127.0.0.1" } as unknown as JevTransport }],
      ["proxy with userinfo", { backend: "jev", url: official, transport: { mode: "http-connect", proxyUrl: "http://u@127.0.0.1:7890" } as unknown as JevTransport }],
      ["proxy with a path", { backend: "jev", url: official, transport: { mode: "http-connect", proxyUrl: "http://127.0.0.1:7890/proxy" } as unknown as JevTransport }]
    ];
    for (const [name, spec] of cases) {
      const error = await choiceRequest({ ...spec, body: "{}", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(500) })
        .then(() => assert.fail(name + " must be refused before dialing"), (failure: unknown) => failure);
      assert.ok(error instanceof ClassifierRequestError, name + " refuses with a typed failure");
      assert.deepEqual(error.failure, { kind: "request", httpStatus: null, code: null }, name);
      assert.ok(
        error.message === "classifier request target is not valid for this backend"
          || error.message === "classifier transport policy is not valid for this backend",
        name + " keeps a fixed refusal message: " + error.message
      );
    }
    assert.equal(plain.requests.length, 0, "no plain fixture request may be dialed");
    assert.equal(secureOrigin.requests.length, 0, "no TLS fixture request may be dialed");
    assert.equal(dialAttempts, 0, "no Agent/request/socket construction may happen for a refused spec");
  } finally {
    netModule.connect = realConnect;
    netModule.createConnection = realCreate;
    tlsModule.connect = realTlsConnect;
  }
});

// ---------------------------------------------------------------------------
// Eligibility and frozen policy
// ---------------------------------------------------------------------------

const jevConfig = (transport: JevTransport): ReturnType<typeof parseProjectConfig> => {
  const raw = JSON.parse(JSON.stringify(fixtureConfig())) as Record<string, unknown>;
  const backends = raw.backends as Record<string, Record<string, unknown>>;
  backends.jev = { enabled: true, transport: JSON.parse(JSON.stringify(transport)) };
  return parseProjectConfig(raw);
};

test("protocol eligibility precedes injected requests", async (t) => {
  const conditions: readonly [string, NodeJS.ProcessEnv][] = [
    ["opt-in absent", { ...fakeEnv, TURNHELM_ALLOW_HOSTED_JEV: undefined }],
    ["opt-in refused", { ...fakeEnv, TURNHELM_ALLOW_HOSTED_JEV: "0" }],
    ["key absent", { LAYA_API_KEY: "k", TURNHELM_ALLOW_HOSTED_JEV: "1" }],
    ["key blank", { ...fakeEnv, TYPESAFE_API_KEY: "   " }]
  ];
  for (const transport of [{ mode: "direct" } as const, { mode: "http-connect", proxyUrl: "http://127.0.0.1:7890" } as const]) {
    const config = jevConfig(transport);
    for (const [name, env] of conditions) {
      let calls = 0;
      await assert.rejects(
        () => requestTaskChoice(config, "Prove the invariants", "jev", env, AbortSignal.timeout(500),
          async () => { calls += 1; return decisionReply(); }),
        Error,
        name
      );
      assert.equal(calls, 0, name + ": neither a seam nor the default transport may be called");
    }
  }
  // A disabled backend is refused even with full credentials.
  let calls = 0;
  await assert.rejects(
    () => requestTaskChoice(fixtureConfig(), "Prove the invariants", "jev", fakeEnv, AbortSignal.timeout(500),
      async () => { calls += 1; return decisionReply(); }),
    Error
  );
  assert.equal(calls, 0, "a disabled backend must not reach any request");
  // Routing never attempts an ineligible hosted backend.
  const attempted: string[] = [];
  const routing = await routeTask("Prove the invariants", jevConfig({ mode: "http-connect", proxyUrl: "http://127.0.0.1:7890" }), {
    env: { LAYA_API_KEY: "k", TURNHELM_ALLOW_HOSTED_JEV: "0", TYPESAFE_API_KEY: "k" },
    request: async spec => { attempted.push(spec.backend); return decisionReply(); }
  });
  assert.ok(routing.status === "selected");
  assert.deepEqual(attempted, ["laya"]);
  // The doctor probe skips an ineligible hosted backend with zero seam calls.
  const root = await mkdtemp(join(tmpdir(), "turnhelm-proxy-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await initProject(root, { dryRun: false })).code, 0);
  const configPath = join(root, ".turnhelm", "config.json");
  const raw = JSON.parse(JSON.stringify(fixtureConfig())) as Record<string, unknown>;
  const backends = raw.backends as Record<string, Record<string, unknown>>;
  backends.laya = { enabled: false, url: (backends.laya as { url: string }).url };
  backends.jev = { enabled: true, transport: { mode: "http-connect", proxyUrl: "http://127.0.0.1:7890" } };
  await writeFile(configPath, JSON.stringify(raw));
  const emptyPath = await mkdtemp(join(tmpdir(), "turnhelm-proxy-emptybin-"));
  t.after(() => rm(emptyPath, { recursive: true, force: true }));
  let probeCalls = 0;
  const result = await doctorProject(root, {
    probe: true,
    env: { ...fakeEnv, TURNHELM_ALLOW_HOSTED_JEV: undefined, PATH: emptyPath, CODEX_HOME: emptyPath },
    request: async () => { probeCalls += 1; return decisionReply(); }
  });
  const byId = new Map(result.checks.map(check => [check.id, check]));
  assert.equal(byId.get("backend.jev")?.status, "skipped", "an ineligible hosted backend is never probed");
  assert.equal(probeCalls, 0);
});

test("default route and probe honor frozen transport", async (t) => {
  // Seams observe the frozen policy for both modes, unchanged by routing.
  for (const transport of [{ mode: "direct" } as const, { mode: "http-connect", proxyUrl: "http://127.0.0.1:7890" } as const]) {
    const rawConfig = JSON.parse(JSON.stringify(fixtureConfig())) as Record<string, unknown>;
    const rawBackends = rawConfig.backends as Record<string, Record<string, unknown>>;
    rawBackends.laya.enabled = false;
    rawBackends.jev = { enabled: true, transport };
    const config = parseProjectConfig(rawConfig);
    let seen: RequestSpec | undefined;
    const routing = await routeTask("Prove the invariants", config, {
      env: fakeEnv,
      request: async spec => { seen = spec; return decisionReply("deep"); }
    });
    assert.ok(routing.status === "selected");
    assert.ok(seen !== undefined);
    assert.equal(seen.backend, "jev");
    assert.equal(seen.url.href, OFFICIAL_JEV_URL);
    assert.deepEqual(seen.transport, parseJevTransport(transport));
    assert.ok(Object.isFrozen(seen.transport), "the frozen policy travels to the boundary");
  }
  // The default chain, with no seam at all, routes a proxied Jev policy over
  // the owned loopback proxy and returns a typed choice.
  const origin = await startOrigin(t);
  const proxy = await startProxy(t, "tunnel", origin.port);
  const ca = await caFile(t);
  const baseRaw = JSON.parse(JSON.stringify(fixtureConfig())) as Record<string, unknown>;
  const baseBackends = baseRaw.backends as Record<string, Record<string, unknown>>;
  baseBackends.laya.enabled = false;
  const routeBody = `
const { routeTask } = await import(${JSON.stringify(distUrl("route.js"))});
const { parseProjectConfig } = await import(${JSON.stringify(distUrl("config.js"))});
const raw = ${JSON.stringify(baseRaw)};
raw.backends.jev = { enabled: true, transport: { mode: "http-connect", proxyUrl: process.env.TEST_PROXY_URL } };
const config = parseProjectConfig(raw);
const routing = await routeTask("Prove the routing invariants", config, {
  env: { TURNHELM_ALLOW_HOSTED_JEV: "1", TYPESAFE_API_KEY: "TEST_JEV_SENTINEL" }
});
console.log("ROUTE " + JSON.stringify({
  status: routing.status,
  backend: routing.decision ? routing.decision.backend : undefined,
  profileId: routing.decision ? routing.decision.profileId : undefined
}));
`;
  const routed = await runNode(t, "proxy-route", [proxy.port, origin.port], ["child.mjs"],
    { TEST_PROXY_URL: proxy.url, NODE_EXTRA_CA_CERTS: ca }, [["child.mjs", routeBody]]);
  assert.equal(childJson(routed, "ROUTE ").profileId, "fast", JSON.stringify(routed.stdout + routed.stderr));
  assertNoDeniedDial(routed);
  assert.equal(proxy.connects.length, 1, "the default chain issues exactly one CONNECT");
  // The doctor probe dials through the shared default without any seam.
  const laya = await startHttp(t);
  const doctorRoot = await mkdtemp(join(tmpdir(), "turnhelm-proxy-doctor-"));
  t.after(() => rm(doctorRoot, { recursive: true, force: true }));
  await mkdir(join(doctorRoot, ".turnhelm"), { recursive: true });
  const doctorRaw = JSON.parse(JSON.stringify(fixtureConfig())) as Record<string, unknown>;
  const doctorBackends = doctorRaw.backends as Record<string, Record<string, unknown>>;
  doctorBackends.laya.url = `http://127.0.0.1:${laya.port}`;
  await writeFile(join(doctorRoot, ".turnhelm", "config.json"), JSON.stringify(doctorRaw));
  const emptyPath = await mkdtemp(join(tmpdir(), "turnhelm-proxy-emptybin-"));
  t.after(() => rm(emptyPath, { recursive: true, force: true }));
  const probed = await doctorProject(doctorRoot, {
    probe: true,
    env: { ...fakeEnv, PATH: emptyPath, CODEX_HOME: emptyPath }
  });
  const byId = new Map(probed.checks.map(check => [check.id, check]));
  assert.equal(byId.get("backend.laya")?.status, "pass", "an eligible probe works through the default request");
  assert.equal(laya.requests.length, 1, "the default probe dials exactly once");
  // The production CLI doctor --probe honors the frozen proxy policy with no
  // injected adapter anywhere on the default path.
  const cliRoot = await mkdtemp(join(tmpdir(), "turnhelm-proxy-cli-"));
  t.after(() => rm(cliRoot, { recursive: true, force: true }));
  await mkdir(join(cliRoot, ".turnhelm"), { recursive: true });
  const cliRaw = JSON.parse(JSON.stringify(baseRaw));
  const cliBackends = cliRaw.backends as Record<string, Record<string, unknown>>;
  cliBackends.jev = { enabled: true, transport: { mode: "http-connect", proxyUrl: proxy.url } };
  await writeFile(join(cliRoot, ".turnhelm", "config.json"), JSON.stringify(cliRaw));
  const cli = await runNode(t, "proxy-cli", [proxy.port, origin.port],
    [fileURLToPath(new URL("../src/cli.js", import.meta.url)), "doctor", "--probe", "--json", "--project", cliRoot],
    {
      PATH: emptyPath,
      TURNHELM_ALLOW_HOSTED_JEV: "1",
      TYPESAFE_API_KEY: "TEST_JEV_SENTINEL",
      NODE_EXTRA_CA_CERTS: ca,
      CODEX_HOME: emptyPath
    });
  assertNoDeniedDial(cli);
  const report = JSON.parse(cli.stdout) as { checks: { id: string; status: string }[] };
  const cliById = new Map(report.checks.map(check => [check.id, check.status]));
  assert.equal(cliById.get("backend.jev"), "pass", "the CLI default probe honors the frozen proxy policy: " + cli.stdout);
  assert.equal(proxy.connects.length, 2, "route and CLI probe each issued exactly one CONNECT");
  assert.equal(proxy.connects[1].target, "api.typesafe.ai:443");
  assert.equal(proxy.connects[1].authorization, undefined, "Origin authorization never appears in CONNECT");
  assert.equal(proxy.connects[1].headBytes, 0, "CONNECT carries no body");
  assert.equal(origin.requests.length, 2);
  assert.equal(origin.requests[1].headers.authorization, "Bearer TEST_JEV_SENTINEL");
  assert.equal(origin.requests[1].url, "/v1/systemone");
});

// ---------------------------------------------------------------------------
// Positive proxy traversal
// ---------------------------------------------------------------------------

test("a proxied Jev request sends one clean CONNECT and resolves a typed choice", async (t) => {
  const origin = await startOrigin(t);
  const proxy = await startProxy(t, "tunnel", origin.port);
  const run = await runNode(t, "proxy-positive", [proxy.port, origin.port], ["child.mjs"],
    { TEST_PROXY_URL: proxy.url, NODE_EXTRA_CA_CERTS: await caFile(t) },
    [["child.mjs", jevChildBody("AbortSignal.timeout(10000)")]]
  );
  assert.equal(run.code, 0);
  assert.deepEqual(childJson(run, "REPLY "), decisionReply("fast"));
  assertNoDeniedDial(run);
  assert.equal(proxy.connects.length, 1, "exactly one CONNECT for the whole request");
  assert.equal(proxy.connects[0].target, "api.typesafe.ai:443", "the CONNECT target is the fixed Jev origin");
  assert.equal(proxy.connects[0].authorization, undefined, "Origin authorization never appears in CONNECT");
  assert.equal(proxy.connects[0].proxyAuthorization, undefined, "no proxy credentials are attached");
  assert.equal(proxy.connects[0].headBytes, 0, "CONNECT carries no body");
  assert.equal(origin.requests.length, 1, "the tunnelled origin sees exactly one request");
  assert.equal(origin.requests[0].method, "POST");
  assert.equal(origin.requests[0].url, "/v1/systemone");
  assert.equal(origin.requests[0].headers.authorization, "Bearer TEST_JEV_SENTINEL");
});

test("bounded response handling is preserved through the proxy", async (t) => {
  const ca = await caFile(t);
  const oversize = await startOrigin(t, "oversize");
  const oversizeProxy = await startProxy(t, "tunnel", oversize.port);
  const tooLarge = await runNode(t, "proxy-oversize", [oversizeProxy.port, oversize.port], ["child.mjs"],
    { TEST_PROXY_URL: oversizeProxy.url, NODE_EXTRA_CA_CERTS: ca },
    [["child.mjs", jevChildBody("AbortSignal.timeout(10000)")]]);
  const failure = childJson(tooLarge, "TRANSPORT_ERROR ");
  assert.equal(failure.message, "classifier response too large");
  assert.deepEqual(failure.failure, { kind: "response", httpStatus: 200, code: null });
  const blocked = await startOrigin(t, "status451");
  const blockedProxy = await startProxy(t, "tunnel", blocked.port);
  const refused = await runNode(t, "proxy-451", [blockedProxy.port, blocked.port], ["child.mjs"],
    { TEST_PROXY_URL: blockedProxy.url, NODE_EXTRA_CA_CERTS: ca },
    [["child.mjs", jevChildBody("AbortSignal.timeout(10000)")]]);
  const blockedFailure = childJson(refused, "TRANSPORT_ERROR ");
  assert.equal(blockedFailure.message, "classifier HTTP 451");
  assert.deepEqual(blockedFailure.failure, { kind: "http", httpStatus: 451, code: null });
  assert.equal((refused.stdout + refused.stderr).includes("ORIGIN-BLOCKED-SENTINEL"), false,
    "the origin body must not leak through the proxy path");
});

// ---------------------------------------------------------------------------
// Negative proxy behavior
// ---------------------------------------------------------------------------

test("proxy failures fail closed without fallback", async (t) => {
  const origin = await startOrigin(t);
  // 407: the CONNECT refusal stays a request failure, never an origin status.
  const rejecting = await startProxy(t, "reject407");
  const refused = await transportFailure(jevSpec(rejecting.url, AbortSignal.timeout(5000)));
  assert.equal(refused.message, "classifier request failed");
  assert.deepEqual(refused.failure, { kind: "request", httpStatus: null, code: null });
  assert.equal(rejecting.connects.length, 1);
  assert.equal(origin.requests.length, 0, "a refused CONNECT never reaches the origin");
  // A dead proxy port fails closed with the whitelisted code.
  const dead = await deadPort(t);
  const deadFailure = await transportFailure(jevSpec(`http://127.0.0.1:${dead}`, AbortSignal.timeout(5000)));
  assert.equal(deadFailure.message, "classifier request failed");
  assert.deepEqual(deadFailure.failure, { kind: "request", httpStatus: null, code: "ECONNREFUSED" });
  // A disconnect during CONNECT fails closed.
  const disconnecting = await startProxy(t, "disconnect");
  const severed = await transportFailure(jevSpec(disconnecting.url, AbortSignal.timeout(5000)));
  assert.equal(severed.message, "classifier request failed");
  assert.deepEqual(severed.failure, { kind: "request", httpStatus: null, code: severed.failure.code });
  assert.ok(severed.failure.code === null || severed.failure.code === "ECONNRESET", "fixed projection only");
  // A tunnel severed mid-handshake fails closed too.
  const severing = await startProxy(t, "tunnelDestroy", origin.port);
  const midHandshake = await transportFailure(jevSpec(severing.url, AbortSignal.timeout(5000)));
  assert.equal(midHandshake.message, "classifier request failed");
  assert.equal(midHandshake.failure.kind, "request");
  assert.equal(midHandshake.failure.httpStatus, null);
  assert.equal(origin.requests.length, 0, "TLS never completes, so no origin request exists");
  // A pre-aborted signal settles before anything is dialed.
  const stalling = await startProxy(t, "stall");
  const cancelled = await transportFailure(jevSpec(stalling.url, AbortSignal.abort()));
  assert.equal(cancelled.message, "classifier request was cancelled");
  assert.deepEqual(cancelled.failure, { kind: "aborted", httpStatus: null, code: null });
  assert.equal(stalling.connects.length, 0, "a pre-aborted request must not dial at all");
  assert.equal(stalling.connections, 0, "a pre-aborted request must not even connect");
});

test("CONNECT and TLS stalls settle once on the deadline and close the peer", async (t) => {
  // A CONNECT stall: the pending CONNECT socket is owned, so settlement
  // destroys it and the proxy peer observes the close.
  const stalling = await startProxy(t, "stall");
  const began = performance.now();
  const stalled = await transportFailure(jevSpec(stalling.url, AbortSignal.timeout(150)));
  assert.equal(stalled.message, "classifier request was cancelled");
  assert.deepEqual(stalled.failure, { kind: "aborted", httpStatus: null, code: null });
  assert.ok(performance.now() - began < 1500, "the deadline must not wait out the stall");
  assert.equal(stalling.connects.length, 1);
  await eventually(() => stalling.clientCloses >= 1,
    "the owned pending CONNECT socket must be destroyed on settlement");
  // A TLS stall behind an established tunnel settles the same way.
  const rawOrigin = await startRawOrigin(t);
  const tunneling = await startProxy(t, "tunnel", rawOrigin.port);
  const tlsStalled = await transportFailure(jevSpec(tunneling.url, AbortSignal.timeout(200)));
  assert.equal(tlsStalled.message, "classifier request was cancelled");
  await eventually(() => tunneling.clientCloses >= 1,
    "the stalled tunnel socket must be destroyed on settlement");
  await eventually(() => rawOrigin.closed >= 1,
    "the origin peer must observe the tunnel close");
});

test("a stalled origin response settles once and a late reply cannot re-settle", async (t) => {
  const ca = await caFile(t);
  // The deadline outranks a pending response through the tunnel.
  const stalled = await startOrigin(t, "stall");
  const stalledProxy = await startProxy(t, "tunnel", stalled.port);
  const abortWins = await runNode(t, "proxy-stalled", [stalledProxy.port, stalled.port], ["child.mjs"],
    { TEST_PROXY_URL: stalledProxy.url, NODE_EXTRA_CA_CERTS: ca },
    [["child.mjs", jevChildBody("AbortSignal.timeout(250)")]]);
  assert.equal(abortWins.code, 1);
  const failure = childJson(abortWins, "TRANSPORT_ERROR ");
  assert.equal(failure.message, "classifier request was cancelled");
  assert.deepEqual(failure.failure, { kind: "aborted", httpStatus: null, code: null });
  assertNoDeniedDial(abortWins);
  assert.equal(stalled.requests.length, 1, "the stalled origin observed exactly one request");
  // A reply that wins the race stands; the deadline firing afterwards can
  // neither re-settle nor crash the finished request.
  const quick = await startOrigin(t, "reply");
  const quickProxy = await startProxy(t, "tunnel", quick.port);
  const replyWins = await runNode(t, "proxy-race", [quickProxy.port, quick.port], ["child.mjs"],
    { TEST_PROXY_URL: quickProxy.url, NODE_EXTRA_CA_CERTS: ca },
    [["child.mjs", jevChildBody("AbortSignal.timeout(400)", `
await new Promise(resolve => setTimeout(resolve, 500)); // let the deadline fire post-settlement
`)]]);
  assert.equal(replyWins.code, 0, "a settled reply must survive its own late deadline: " + replyWins.stdout + replyWins.stderr);
  assert.deepEqual(childJson(replyWins, "REPLY "), decisionReply("fast"));
  assertNoDeniedDial(replyWins);
});

// ---------------------------------------------------------------------------
// Hostile createConnection interleavings (ownership sensitivity)
// ---------------------------------------------------------------------------

const patchedChild = (scenario: string, signalSource: string): string => `
import https from "node:https";
const { Agent } = https;
const original = Agent.prototype.createConnection;
${
  scenario === "callback-before-return"
    ? `Agent.prototype.createConnection = function (options, callback) {
  const socket = original.call(this, options, (_error, established) => {
    if (established) established.destroy(); // fixture hygiene: drop the real tunnel socket
  });
  callback(null, socket); // delivered before createConnection returns
  return socket;          // and delivered again as the return value
};`
    : scenario === "duplicate"
      ? `Agent.prototype.createConnection = function (options, callback) {
  return original.call(this, options, (error, established) => {
    callback(error, established);
    if (!error && established) callback(null, established); // duplicate delivery
  });
};`
      : scenario === "post-settlement"
        ? `let held = null;
let deliver = null;
Agent.prototype.createConnection = function (options, callback) {
  deliver = callback;
  return original.call(this, options, (error, established) => { held = { error, established }; });
};
globalThis.releaseHeld = () => { if (held && deliver) deliver(held.error, held.established); return held && held.established; };`
        : `let triggered = false;
Agent.prototype.createConnection = function (options, callback) {
  const socket = original.call(this, options, callback);
  if (!triggered) {
    triggered = true;
    setTimeout(() => { this.createConnection(options, callback); }, 30); // unexpected second construction
  }
  return socket;
};`
}
${jevChildBody(signalSource, scenario === "post-settlement"
  ? `
if (globalThis.releaseHeld) {
  const held = globalThis.releaseHeld();
  await new Promise(resolve => setTimeout(resolve, 150));
  console.log("HELD_DESTROYED " + (held ? held.destroyed : "none"));
}
` : "")}
`;

test("ownership survives hostile createConnection interleavings", async (t) => {
  const origin = await startOrigin(t);
  const proxy = await startProxy(t, "tunnel", origin.port);
  const ca = await caFile(t);
  const ports = [proxy.port, origin.port];
  const env = { TEST_PROXY_URL: proxy.url, NODE_EXTRA_CA_CERTS: ca };
  // A callback that beats the return, plus a duplicate of the returned socket.
  // The exact failure shape depends on how the hostile delivery scrambles the
  // exchange; the pinned contract is one typed failure, one construction, no
  // fallback dial, and a clean exit.
  const before = await runNode(t, "patch-before", ports, ["child.mjs"], env,
    [["child.mjs", patchedChild("callback-before-return", "AbortSignal.timeout(10000)")]]);
  const beforeFailure = childJson(before, "TRANSPORT_ERROR ");
  assert.equal(beforeFailure.typed, true);
  assert.equal(before.code, 1);
  assertNoDeniedDial(before);
  assert.equal(proxy.connections, 1, "only the single original TCP connection exists");
  // A duplicate established-socket delivery is deduplicated and the request completes.
  const connectsBeforeDuplicate = proxy.connects.length;
  const duplicate = await runNode(t, "patch-duplicate", ports, ["child.mjs"], env,
    [["child.mjs", patchedChild("duplicate", "AbortSignal.timeout(10000)")]]);
  assert.equal(duplicate.code, 0, duplicate.stdout + duplicate.stderr);
  assert.deepEqual(childJson(duplicate, "REPLY "), decisionReply("fast"));
  assertNoDeniedDial(duplicate);
  assert.equal(proxy.connects.length, connectsBeforeDuplicate + 1);
  // A socket delivered after settlement is destroyed immediately.
  const late = await runNode(t, "patch-late", ports, ["child.mjs"], env,
    [["child.mjs", patchedChild("post-settlement", "AbortSignal.timeout(300)")]]);
  assert.equal(late.code, 1);
  const lateFailure = childJson(late, "TRANSPORT_ERROR ");
  assert.equal(lateFailure.message, "classifier request was cancelled");
  const heldLine = late.stdout.split("\n").find(line => line.startsWith("HELD_DESTROYED "));
  assert.ok(heldLine !== undefined, late.stdout + late.stderr);
  assert.equal(heldLine, "HELD_DESTROYED true", "a post-settlement socket must be destroyed immediately");
  assertNoDeniedDial(late);
  // An unexpected second construction is refused without dialing again.
  const connectsBeforeSecond = proxy.connects.length;
  const connectionsBeforeSecond = proxy.connections;
  const second = await runNode(t, "patch-second", ports, ["child.mjs"], env,
    [["child.mjs", patchedChild("second-construction", "AbortSignal.timeout(10000)")]]);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.deepEqual(childJson(second, "REPLY "), decisionReply("fast"));
  assertNoDeniedDial(second);
  assert.equal(proxy.connects.length, connectsBeforeSecond + 1, "only the first construction may dial");
  assert.equal(proxy.connections, connectionsBeforeSecond + 1, "no second TCP connection may be built");
});

test("synchronous construction failures settle as one typed failure", async (t) => {
  const origin = await startOrigin(t);
  const proxy = await startProxy(t, "tunnel", origin.port);
  const ports = [proxy.port, origin.port];
  const env = { TEST_PROXY_URL: proxy.url, NODE_EXTRA_CA_CERTS: await caFile(t) };
  const createThrow = `
import https from "node:https";
https.Agent.prototype.createConnection = function () { throw new Error("TEST_SYNC_CREATE_CANARY"); };
` + jevChildBody("AbortSignal.timeout(10000)");
  const createFailure = await runNode(t, "sync-create", ports, ["child.mjs"], env, [["child.mjs", createThrow]]);
  const createReport = childJson(createFailure, "TRANSPORT_ERROR ");
  assert.equal(createReport.typed, true);
  assert.equal(createReport.message, "classifier request failed");
  assert.equal((createFailure.stdout + createFailure.stderr).includes("TEST_SYNC_CREATE_CANARY"), false,
    "the native throw text must not leak");
  assertNoDeniedDial(createFailure);
  assert.equal(proxy.connects.length, 0, "a throwing construction dials nothing");
  const requestThrow = `
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
const realRequest = https.request;
https.request = function () { throw new Error("TEST_SYNC_REQUEST_CANARY"); };
syncBuiltinESMExports();
` + jevChildBody("AbortSignal.timeout(10000)");
  const requestFailure = await runNode(t, "sync-request", ports, ["child.mjs"], env, [["child.mjs", requestThrow]]);
  const requestReport = childJson(requestFailure, "TRANSPORT_ERROR ");
  assert.equal(requestReport.typed, true);
  assert.equal(requestReport.message, "classifier request failed");
  assert.equal((requestFailure.stdout + requestFailure.stderr).includes("TEST_SYNC_REQUEST_CANARY"), false,
    "the native throw text must not leak");
  assertNoDeniedDial(requestFailure);
});

// ---------------------------------------------------------------------------
// TLS verification through the proxy
// ---------------------------------------------------------------------------

test("proxied TLS verifies the origin certificate and hostname", async (t) => {
  // An untrusted chain rejects even though no test CA is present in the child.
  const untrusted = await startOrigin(t);
  const untrustedProxy = await startProxy(t, "tunnel", untrusted.port);
  const noCa = await runNode(t, "tls-untrusted", [untrustedProxy.port, untrusted.port], ["child.mjs"],
    { TEST_PROXY_URL: untrustedProxy.url },
    [["child.mjs", jevChildBody("AbortSignal.timeout(10000)")]]);
  const noCaFailure = childJson(noCa, "TRANSPORT_ERROR ");
  const noCaProjection = noCaFailure.failure as { kind: string; httpStatus: number | null; code: string | null };
  assert.equal(noCaFailure.typed, true);
  assert.equal(noCaFailure.message, "classifier request failed");
  assert.equal(noCaProjection.kind, "request");
  assert.equal(noCaProjection.httpStatus, null);
  assert.ok(noCaProjection.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || noCaProjection.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "the whitelisted verification code is retained: " + JSON.stringify(noCaProjection));
  assertNoDeniedDial(noCa);
  assert.equal(untrusted.requests.length, 0, "verification fails before any origin request");
  // A TLS-disabling environment cannot bypass the explicit verification.
  const disabled = await runNode(t, "tls-disabled", [untrustedProxy.port, untrusted.port], ["child.mjs"],
    { TEST_PROXY_URL: untrustedProxy.url, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    [["child.mjs", jevChildBody("AbortSignal.timeout(10000)")]]);
  const disabledFailure = childJson(disabled, "TRANSPORT_ERROR ");
  assert.equal(disabledFailure.message, "classifier request failed");
  assert.equal((disabled.stdout + disabled.stderr).includes("REPLY"), false,
    "TLS verification must stay on despite the disable flag");
  // A trusted chain with the wrong hostname still rejects: the fixed target
  // name is verified, not just the chain.
  const wrong = await startOrigin(t, "reply", WRONG_CERT.trim(), WRONG_KEY.trim());
  const wrongProxy = await startProxy(t, "tunnel", wrong.port);
  const mismatch = await runNode(t, "tls-wronghost", [wrongProxy.port, wrong.port], ["child.mjs"],
    { TEST_PROXY_URL: wrongProxy.url, NODE_EXTRA_CA_CERTS: await caFile(t) },
    [["child.mjs", jevChildBody("AbortSignal.timeout(10000)")]]);
  const mismatchFailure = childJson(mismatch, "TRANSPORT_ERROR ");
  assert.equal(mismatchFailure.message, "classifier request failed");
  assert.deepEqual(mismatchFailure.failure, { kind: "request", httpStatus: null, code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  assert.equal(wrong.requests.length, 0, "hostname verification fails before any origin request");
});

// ---------------------------------------------------------------------------
// Environment proxy isolation
// ---------------------------------------------------------------------------

test("the explicit policy ignores an activated environment proxy in either case or NO_PROXY form", async (t) => {
  const origin = await startOrigin(t);
  const configured = await startProxy(t, "tunnel", origin.port);
  const sentinel = await startSentinel(t);
  const laya = await startHttp(t);
  const ca = await caFile(t);
  const body = (controlPath: string): string => `
const http = await import("node:http");
const mod = await import(${JSON.stringify(distUrl("systemone.js"))});
const control = await new Promise((resolve, reject) => {
  const request = http.get("http://127.0.0.1:${laya.port}${controlPath}", { signal: AbortSignal.timeout(10000) }, response => {
    let text = "";
    response.setEncoding("utf8");
    response.on("data", chunk => { text += chunk; });
    response.on("end", () => resolve(text));
  });
  request.on("error", reject);
});
console.log("CONTROL " + control);
const ask = (spec) => mod.choiceRequest(spec).then(
  reply => console.log("REPLY " + JSON.stringify(reply)),
  error => { console.log("TRANSPORT_ERROR " + (error && error.message)); process.exitCode = 1; }
);
await ask({
  backend: "jev",
  url: new URL(${JSON.stringify(OFFICIAL_JEV_URL)}),
  body: JSON.stringify({ state: "Prove the routing invariants" }),
  headers: { "content-type": "application/json", authorization: "Bearer TEST_JEV_SENTINEL" },
  signal: AbortSignal.timeout(10000),
  transport: { mode: "http-connect", proxyUrl: process.env.TEST_PROXY_URL }
});
await ask({
  backend: "laya",
  url: new URL("http://127.0.0.1:${laya.port}/v1/systemone"),
  body: JSON.stringify({ state: "Prove the routing invariants" }),
  headers: { "content-type": "application/json", authorization: "Bearer TEST_LAYA_SENTINEL" },
  signal: AbortSignal.timeout(10000),
  transport: { mode: "direct" }
});
`;
  const ports = [configured.port, sentinel.port, origin.port, laya.port];
  // Activated environment proxy with both key spellings: the default-agent
  // control is proxied, the explicit policy is not.
  const proxied = await runNode(t, "proxy-env-empty", ports, ["child.mjs"], {
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: sentinel.url,
    https_proxy: sentinel.url,
    HTTPS_PROXY: sentinel.url,
    http_proxy: sentinel.url,
    NO_PROXY: "",
    no_proxy: "",
    TEST_PROXY_URL: configured.url,
    NODE_EXTRA_CA_CERTS: ca
  }, [["child.mjs", body("/control")]]);
  assert.match(proxied.stdout, /CONTROL proxied-ok/, "the default-agent control must traverse the sentinel");
  assert.equal((proxied.stdout.match(/REPLY /g) ?? []).length, 2, proxied.stdout + proxied.stderr);
  assertNoDeniedDial(proxied);
  assert.equal(sentinel.requests, 1, "only the control uses the sentinel");
  assert.equal(sentinel.connects, 0, "the explicit policy never CONNECTs through the sentinel");
  assert.equal(configured.connects.length, 1, "the explicit policy uses its configured proxy");
  assert.equal(laya.requests.length, 1, "direct Laya stays direct under an activated environment proxy");
  // NO_PROXY=* disables the environment proxy for the control, but the
  // explicit policy still traverses its configured proxy.
  const sentinelBeforeBypass = sentinel.requests;
  const bypassed = await runNode(t, "proxy-env-wildcard", ports, ["child.mjs"], {
    NODE_USE_ENV_PROXY: "1",
    HTTP_PROXY: sentinel.url,
    https_proxy: sentinel.url,
    HTTPS_PROXY: sentinel.url,
    http_proxy: sentinel.url,
    NO_PROXY: "*",
    no_proxy: "*",
    TEST_PROXY_URL: configured.url,
    NODE_EXTRA_CA_CERTS: ca
  }, [["child.mjs", body("/control")]]);
  assert.match(bypassed.stdout, /CONTROL direct-ok/, "NO_PROXY=* must disable the default agent proxy");
  assert.equal((bypassed.stdout.match(/REPLY /g) ?? []).length, 2, bypassed.stdout + bypassed.stderr);
  assertNoDeniedDial(bypassed);
  assert.equal(sentinel.requests, sentinelBeforeBypass, "NO_PROXY=* keeps the sentinel untouched");
  assert.equal(configured.connects.length, 2, "the explicit policy ignores NO_PROXY=*");
  assert.equal(laya.requests.length, 3, "the control and the direct Laya request both reach the fixture");
});
