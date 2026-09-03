/**
 * GitHub App authentication (SPEC §7.4).
 *
 * `foreman-review` submits real PR reviews under the App's own bot identity
 * rather than whoever `gh` is otherwise authenticated as. That distinct
 * identity is load-bearing, not cosmetic: `foreman-implement` opens the PR
 * through the operator's own `gh` auth, and GitHub refuses an `APPROVE`
 * review from the PR's own author — reusing that identity for review would
 * only ever succeed for `REQUEST_CHANGES`/`COMMENT` verdicts.
 *
 * Hand-rolled against the REST API with `fetch`, matching `linear/client.ts`
 * — no SDK dependency for what is a two-call JWT-to-installation-token
 * exchange plus reads used to verify and check installation.
 */

import { createSign } from "node:crypto";

export interface GitHubAppCredentials {
  /** The App's numeric id, as a string — the JWT's `iss` claim. */
  appId: string;
  /** PEM-encoded private key (PKCS#1 or PKCS#8; Node's `crypto` accepts either). */
  privateKey: string;
}

export interface AppIdentity {
  id: number;
  name: string;
  /** URL-safe App identifier, e.g. `https://github.com/apps/<slug>/installations/new`. */
  slug: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Refresh this many ms before actual expiry, so a call never races an installation token expiring mid-request. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export class GitHubAppError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GitHubAppError";
    this.status = status;
  }
}

function base64url(input: Buffer | string): string {
  return (Buffer.isBuffer(input) ? input : Buffer.from(input))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * RS256 App JWT (GitHub App auth, App-level). Backdates `iat` by 60s to
 * tolerate clock skew and expires at 10 minutes — GitHub's own maximum —
 * since this is minted fresh per call, never persisted.
 */
export function signAppJwt(credentials: GitHubAppCredentials, now: Date = new Date()): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = Math.floor(now.getTime() / 1000) - 60;
  const exp = iat + 10 * 60;
  const payload = base64url(JSON.stringify({ iat, exp, iss: credentials.appId }));
  const signature = base64url(createSign("RSA-SHA256").update(`${header}.${payload}`).sign(credentials.privateKey));
  return `${header}.${payload}.${signature}`;
}

export interface GitHubAppAuthOptions {
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

/**
 * Mints and caches per-repo installation access tokens. Every call signs a
 * fresh App JWT (App-level auth) to resolve the installation, then mints an
 * installation token (repo-scoped, 1h TTL) — the actual credential used to
 * submit a review.
 */
export class GitHubAppAuth {
  readonly #credentials: GitHubAppCredentials;
  readonly #fetchImpl: typeof fetch;
  readonly #apiBase: string;
  readonly #tokenCache = new Map<string, CachedToken>();

  constructor(credentials: GitHubAppCredentials, options?: GitHubAppAuthOptions) {
    this.#credentials = credentials;
    this.#fetchImpl = options?.fetchImpl ?? fetch;
    this.#apiBase = options?.apiBase ?? "https://api.github.com";
  }

  async #request(path: string, init?: { method?: string }): Promise<unknown> {
    const jwt = signAppJwt(this.#credentials);
    const response = await this.#fetchImpl(`${this.#apiBase}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new GitHubAppError(`GitHub App API ${path} failed: ${response.status} ${body}`, response.status);
    }
    return response.json();
  }

  /** The App's own identity — `foreman setup`'s confirmation step, and the install-link slug for `foreman init`. */
  async app(): Promise<AppIdentity> {
    const data = (await this.#request("/app")) as { id: number; name: string; slug: string };
    return { id: data.id, name: data.name, slug: data.slug };
  }

  /** True when this App is installed on `owner/repo` — `foreman init`'s non-blocking check; installation itself only ever happens through GitHub's own UI. */
  async installationExists(owner: string, repo: string): Promise<boolean> {
    try {
      await this.#request(`/repos/${owner}/${repo}/installation`);
      return true;
    } catch (error) {
      if (error instanceof GitHubAppError && error.status === 404) return false;
      throw error;
    }
  }

  /** Installation access token for `owner/repo`, minted fresh and cached until 60s before expiry. */
  async installationToken(owner: string, repo: string): Promise<string> {
    const key = `${owner}/${repo}`;
    const cached = this.#tokenCache.get(key);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return cached.token;

    const installation = (await this.#request(`/repos/${owner}/${repo}/installation`)) as { id: number };
    const grant = (await this.#request(`/app/installations/${installation.id}/access_tokens`, { method: "POST" })) as {
      token: string;
      expires_at: string;
    };
    const expiresAt = new Date(grant.expires_at).getTime();
    this.#tokenCache.set(key, { token: grant.token, expiresAt });
    return grant.token;
  }
}
