import { headers } from "next/headers";
import { redirect } from "next/navigation";

export type ChatGPTUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
  provider: "chatgpt_sites" | "cloudflare_access" | "local_development";
};

const USER_ID_HEADER = "oai-authenticated-user-id";
const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER =
  "oai-authenticated-user-full-name-encoding";
const CLOUDFLARE_ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email";
const CLOUDFLARE_ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";
const SIGN_IN_PATH = "/signin-with-chatgpt";
const SIGN_OUT_PATH = "/signout-with-chatgpt";
const CALLBACK_PATH = "/callback";
const SERVICE_TOKEN_HEADER = "x-unseen-service-token";
const ACCESS_CERTS_PATH = "/cdn-cgi/access/certs";
const ACCESS_KEY_CACHE_MS = 5 * 60_000;

type AccessJwtClaims = {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iss?: string;
  nbf?: number;
  sub?: string;
};

type CachedAccessKeys = {
  expiresAt: number;
  keys: JsonWebKey[];
};

const accessKeyCache = new Map<string, CachedAccessKeys>();

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  if (process.env.UNSEEN_AUTH_PROVIDER === "cloudflare_access") {
    return getCloudflareAccessUser(requestHeaders);
  }

  const userId = requestHeaders.get(USER_ID_HEADER);
  const email = requestHeaders.get(USER_EMAIL_HEADER);
  if (!userId || !email) {
    if (isLocalDevelopmentAuthEnabled()) {
      return {
        userId: "local-development-user",
        displayName: "Local developer",
        email: "local@localhost",
        fullName: "Local developer",
        provider: "local_development",
      };
    }
    return null;
  }

  const encodedFullName = requestHeaders.get(USER_FULL_NAME_HEADER);
  const fullName =
    encodedFullName &&
    requestHeaders.get(USER_FULL_NAME_ENCODING_HEADER) === PERCENT_ENCODED_UTF8
      ? safeDecodeURIComponent(encodedFullName)
      : null;

  return {
    userId,
    displayName: fullName ?? email,
    email,
    fullName,
    provider: "chatgpt_sites",
  };
}

export async function requireChatGPTUser(
  returnTo: string,
): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;

  redirect(chatGPTSignInPath(returnTo));
}

export function isChatGPTUserAllowed(user: ChatGPTUser): boolean {
  if (user.provider === "local_development") return true;

  const allowedEmails = new Set(
    (process.env.UNSEEN_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
  return allowedEmails.has(user.email.trim().toLocaleLowerCase());
}

export async function unseenApiAuthorizationError(): Promise<Response | null> {
  if (await hasValidServiceToken()) return null;

  const user = await getChatGPTUser();
  if (!user) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Sign in with ChatGPT to use UNSEEN." } },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!isChatGPTUserAllowed(user)) {
    return Response.json(
      { error: { code: "FORBIDDEN", message: "This ChatGPT account is not approved for UNSEEN." } },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  return null;
}

async function hasValidServiceToken(): Promise<boolean> {
  const expectedToken = process.env.UNSEEN_API_ACCESS_TOKEN?.trim();
  if (!expectedToken) return false;
  const requestHeaders = await headers();
  const suppliedToken = requestHeaders.get(SERVICE_TOKEN_HEADER) ?? "";
  return constantTimeEqual(suppliedToken, expectedToken);
}

async function getCloudflareAccessUser(requestHeaders: Headers): Promise<ChatGPTUser | null> {
  const headerEmail = requestHeaders.get(CLOUDFLARE_ACCESS_EMAIL_HEADER)?.trim();
  const assertion = requestHeaders.get(CLOUDFLARE_ACCESS_JWT_HEADER)?.trim();
  if (!headerEmail || !assertion) return null;

  const claims = await verifyCloudflareAccessJwt(assertion, headerEmail);
  if (!claims) return null;
  const email = claims.email?.trim() ?? "";
  return {
    userId: `cloudflare-access:${claims.sub || email.toLocaleLowerCase()}`,
    displayName: email,
    email,
    fullName: null,
    provider: "cloudflare_access",
  };
}

async function verifyCloudflareAccessJwt(
  token: string,
  headerEmail: string,
): Promise<AccessJwtClaims | null> {
  try {
    const issuer = normalizedAccessIssuer(process.env.UNSEEN_CLOUDFLARE_ACCESS_ISSUER);
    const expectedAudience = process.env.UNSEEN_CLOUDFLARE_ACCESS_AUD?.trim();
    if (!issuer || !expectedAudience) return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = decodeJwtJson(parts[0]) as { alg?: string; kid?: string };
    const claims = decodeJwtJson(parts[1]) as AccessJwtClaims;
    if (header.alg !== "RS256" || !header.kid) return null;

    const nowSeconds = Math.floor(Date.now() / 1_000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      claims.iss !== issuer ||
      typeof claims.exp !== "number" ||
      claims.exp <= nowSeconds ||
      (typeof claims.nbf === "number" && claims.nbf > nowSeconds) ||
      !audiences.includes(expectedAudience) ||
      typeof claims.email !== "string" ||
      claims.email.trim().toLocaleLowerCase() !== headerEmail.toLocaleLowerCase()
    ) {
      return null;
    }

    const jwk = (await getCloudflareAccessKeys(issuer)).find(
      (candidate) => candidate.kid === header.kid && candidate.kty === "RSA",
    );
    if (!jwk) return null;
    const verificationKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      verificationKey,
      decodeBase64Url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    return valid ? claims : null;
  } catch {
    return null;
  }
}

async function getCloudflareAccessKeys(issuer: string): Promise<JsonWebKey[]> {
  const cached = accessKeyCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;

  const response = await fetch(`${issuer}${ACCESS_CERTS_PATH}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Cloudflare Access keys are unavailable.");
  const payload = (await response.json()) as { keys?: unknown };
  if (!Array.isArray(payload.keys)) throw new Error("Cloudflare Access keys are invalid.");
  const keys = payload.keys.filter(
    (key): key is JsonWebKey => typeof key === "object" && key !== null,
  );
  accessKeyCache.set(issuer, { expiresAt: Date.now() + ACCESS_KEY_CACHE_MS, keys });
  return keys;
}

function normalizedAccessIssuer(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".cloudflareaccess.com") ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function decodeJwtJson(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as unknown;
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function chatGPTSignInPath(returnTo: string): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_IN_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

export function chatGPTSignOutPath(returnTo = "/"): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_OUT_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

export function signOutPathForUser(user: ChatGPTUser, returnTo = "/"): string {
  if (user.provider === "cloudflare_access") return "/cdn-cgi/access/logout";
  if (user.provider === "local_development") return returnTo;
  return chatGPTSignOutPath(returnTo);
}

function isLocalDevelopmentAuthEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.UNSEEN_LOCAL_AUTH_BYPASS === "true";
}

function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";

  let url: URL;
  try {
    url = new URL(value, "https://app.local");
  } catch {
    return "/";
  }
  if (url.origin !== "https://app.local") return "/";
  if (isReservedAuthPath(url.pathname)) return "/";

  return `${url.pathname}${url.search}${url.hash}`;
}

function isReservedAuthPath(pathname: string): boolean {
  return (
    pathname === SIGN_IN_PATH ||
    pathname === SIGN_OUT_PATH ||
    pathname === CALLBACK_PATH
  );
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
