import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export async function readRawBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function parseBody(contentType: string | undefined, rawBody: Buffer): Record<string, unknown> {
  const text = rawBody.toString("utf8");
  if (!text) return {};

  if (contentType?.includes("application/json")) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { raw: text };
    }
  }

  if (contentType?.includes("application/x-www-form-urlencoded") || contentType?.includes("multipart/form-data")) {
    const params = new URLSearchParams(text);
    const out: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) {
      if (key in out) {
        const current = out[key];
        out[key] = Array.isArray(current) ? [...current, value] : [current, value];
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  return { raw: text };
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

export function sendText(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

export function unauthorized(res: ServerResponse) {
  sendJson(res, 401, { error: "Unauthorized" });
}

export function bearerTokenFromRequest(req: IncomingMessage) {
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice("Bearer ".length)
    : undefined;
  const header = req.headers["x-admin-token"];
  return bearer ?? (Array.isArray(header) ? header[0] : header);
}

export function verifyAdminToken(req: IncomingMessage, adminToken: string) {
  return bearerTokenFromRequest(req) === adminToken;
}

export function verifyMcpToken(req: IncomingMessage, token: string) {
  if (!token) return true;
  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice("Bearer ".length)
    : undefined;
  return bearer === token;
}

export function verifyWebhookRequest(args: {
  rawBody: Buffer;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
  secret: string;
  mode?: "auto" | "header-hmac" | "body-secret";
}) {
  const verificationMode = args.mode ?? "auto";
  if (!args.secret) {
    return { ok: true, mode: "disabled" } as const;
  }

  const headerSignature = args.headers["x-gumroad-signature"];
  const signature = Array.isArray(headerSignature) ? headerSignature[0] : headerSignature;
  if (signature && verificationMode !== "body-secret") {
    const normalizedSignature = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
    const expected = createHmac("sha256", args.secret).update(args.rawBody).digest("hex");
    const actualBuffer = Buffer.from(normalizedSignature);
    const expectedBuffer = Buffer.from(expected);
    const ok = actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
    return { ok, mode: "x-gumroad-signature" } as const;
  }

  if (verificationMode !== "header-hmac") {
    for (const key of ["secret", "token", "ping_secret", "password"]) {
      const value = args.body[key];
      if (typeof value === "string") {
        return { ok: value === args.secret, mode: `body.${key}` } as const;
      }
    }
  }

  return { ok: false, mode: "missing" } as const;
}
