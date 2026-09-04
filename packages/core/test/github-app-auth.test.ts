import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GitHubAppAuth, GitHubAppError, signAppJwt } from "../src/github/app-auth.ts";

function makeCredentials() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    appId: "12345",
    privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
  };
}

function decodeJwtPayload(jwt: string): { iat: number; exp: number; iss: string } {
  const [, payload] = jwt.split(".");
  const padded = (payload ?? "").replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

describe("signAppJwt", () => {
  it("carries the App id as iss, backdated iat, and a ~10 minute exp", () => {
    const credentials = makeCredentials();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const jwt = signAppJwt(credentials, now);
    const payload = decodeJwtPayload(jwt);

    expect(payload.iss).toBe("12345");
    expect(payload.iat).toBe(Math.floor(now.getTime() / 1000) - 60);
    expect(payload.exp - payload.iat).toBe(10 * 60);
  });

  it("produces a three-segment JWT with a non-empty signature", () => {
    const jwt = signAppJwt(makeCredentials());
    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);
    expect(segments[2]!.length).toBeGreaterThan(0);
  });
});

describe("GitHubAppAuth.app", () => {
  it("returns the App's id/name/slug from GET /app", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://api.github.com/app");
      return new Response(JSON.stringify({ id: 999, name: "Foreman Review", slug: "foreman-review" }));
    }) as unknown as typeof fetch;
    const auth = new GitHubAppAuth(makeCredentials(), { fetchImpl });
    expect(await auth.app()).toEqual({ id: 999, name: "Foreman Review", slug: "foreman-review" });
  });

  it("throws GitHubAppError carrying the status on a non-ok response", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const auth = new GitHubAppAuth(makeCredentials(), { fetchImpl });
    await expect(auth.app()).rejects.toThrow(GitHubAppError);
    try {
      await auth.app();
      throw new Error("expected app() to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubAppError);
      expect((error as GitHubAppError).status).toBe(401);
    }
  });
});

describe("GitHubAppAuth.installationExists", () => {
  it("returns true when the installation lookup succeeds", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ id: 1 }))) as unknown as typeof fetch;
    const auth = new GitHubAppAuth(makeCredentials(), { fetchImpl });
    expect(await auth.installationExists("acme", "plotroom")).toBe(true);
  });

  it("returns false on a 404, distinct from other failures", async () => {
    const fetchImpl = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const auth = new GitHubAppAuth(makeCredentials(), { fetchImpl });
    expect(await auth.installationExists("acme", "plotroom")).toBe(false);
  });

  it("rethrows a non-404 failure rather than reporting it as not-installed", async () => {
    const fetchImpl = (async () => new Response("server error", { status: 500 })) as unknown as typeof fetch;
    const auth = new GitHubAppAuth(makeCredentials(), { fetchImpl });
    await expect(auth.installationExists("acme", "plotroom")).rejects.toThrow(GitHubAppError);
  });
});

describe("GitHubAppAuth.installationToken", () => {
  it("resolves the installation id, then mints an access token, and caches it per repo", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/repos/acme/plotroom/installation")) {
        return new Response(JSON.stringify({ id: 42 }));
      }
      if (path.endsWith("/app/installations/42/access_tokens")) {
        return new Response(
          JSON.stringify({ token: "ghs_installation_token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
        );
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;
    const auth = new GitHubAppAuth(makeCredentials(), { fetchImpl });

    const first = await auth.installationToken("acme", "plotroom");
    expect(first).toBe("ghs_installation_token");
    expect(calls).toEqual([
      "GET https://api.github.com/repos/acme/plotroom/installation",
      "POST https://api.github.com/app/installations/42/access_tokens",
    ]);

    // Cached: a second call for the same repo mints nothing new.
    const second = await auth.installationToken("acme", "plotroom");
    expect(second).toBe("ghs_installation_token");
    expect(calls).toHaveLength(2);
  });

  it("mints a fresh token once the cached one is within the refresh margin of expiring", async () => {
    let mintCount = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/installation")) return new Response(JSON.stringify({ id: 42 }));
      mintCount += 1;
      // Already inside the 60s refresh margin — every call must mint again.
      return new Response(JSON.stringify({ token: `token-${mintCount}`, expires_at: new Date(Date.now() + 1_000).toISOString() }));
    }) as unknown as typeof fetch;
    const auth = new GitHubAppAuth(makeCredentials(), { fetchImpl });

    const first = await auth.installationToken("acme", "plotroom");
    const second = await auth.installationToken("acme", "plotroom");
    expect(first).toBe("token-1");
    expect(second).toBe("token-2");
  });
});

describe("GitHubAppAuth timeout", () => {
  it("rejects with GitHubAppError when the request never resolves", async () => {
    const fetchImpl = ((_url: string | URL | Request, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "TimeoutError";
          reject(err);
        });
      })) as unknown as typeof fetch;
    const auth = new GitHubAppAuth(makeCredentials(), { fetchImpl, timeoutMs: 20 });

    await expect(auth.app()).rejects.toThrow(/timed out/);
    await expect(auth.app()).rejects.toBeInstanceOf(GitHubAppError);
  });
});
