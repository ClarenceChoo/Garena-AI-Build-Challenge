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

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
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
    if (process.env.UNSEEN_AUTH_PROVIDER !== "cloudflare_access") return null;
    const cloudflareEmail = requestHeaders.get(CLOUDFLARE_ACCESS_EMAIL_HEADER)?.trim();
    const cloudflareAccessJwt = requestHeaders.get(CLOUDFLARE_ACCESS_JWT_HEADER)?.trim();
    if (!cloudflareEmail || !cloudflareAccessJwt) return null;
    return {
      userId: `cloudflare-access:${cloudflareEmail.toLocaleLowerCase()}`,
      displayName: cloudflareEmail,
      email: cloudflareEmail,
      fullName: null,
      provider: "cloudflare_access",
    };
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

export async function unseenApiAuthorizationError(payload?: unknown): Promise<Response | null> {
  if (await hasValidServiceToken(payload)) return null;

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

async function hasValidServiceToken(payload?: unknown): Promise<boolean> {
  const expectedToken = process.env.UNSEEN_API_ACCESS_TOKEN?.trim();
  if (!expectedToken) return false;

  const payloadToken =
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>).serviceToken === "string"
      ? (payload as Record<string, string>).serviceToken
      : null;
  if (payloadToken === expectedToken) return true;

  const requestHeaders = await headers();
  return requestHeaders.get(SERVICE_TOKEN_HEADER) === expectedToken;
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
