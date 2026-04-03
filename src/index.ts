import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { assertConfiguredAccessToken, config } from "./config.js";
import { normalizeWebhookEvent } from "./gumroad/normalize.js";
import { dailySummaryJob, processPendingWebhookEvents, processWebhookEvent, syncProductsJob, syncSalesJob } from "./jobs/index.js";
import { handleMcpRequest } from "./mcp.js";
import { createAppContext } from "./services/app-context.js";
import { buildCheckoutUrl, parseCheckoutLinkRequest } from "./services/checkout-links.js";
import { confirmCatalogAction, previewCatalogAction, readProductOfferCodes, readProductVariants } from "./services/catalog-management.js";
import { confirmProductCreate, previewProductCreate, refreshOfferCodes, refreshVariants } from "./services/product-create.js";
import { formatMoney } from "./utils/format.js";
import {
  parseBody,
  readRawBody,
  sendJson,
  sendText,
  unauthorized,
  verifyAdminToken,
  verifyMcpToken,
  verifyWebhookRequest,
} from "./utils/http.js";

const ctx = createAppContext();

function numberOrFallback(value: string | null | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function confirmationErrorStatus(message: string) {
  if (message.includes("already been used")) return 409;
  if (message.includes("not found")) return 404;
  if (message.includes("Unsupported operation") || message.includes("Unsupported action")) return 501;
  return 400;
}

function publicConfirmation(result: {
  confirmationId: string;
  expiresAt: string;
  payloadHash: string;
  status: string;
  requiresPhrase: boolean;
  preview: string;
  apiPayload: Record<string, string>;
}) {
  return {
    confirmation_id: result.confirmationId,
    expires_at: result.expiresAt,
    payload_hash: result.payloadHash,
    status: result.status,
    requires_confirmation_phrase: result.requiresPhrase,
    preview: result.preview,
    request_payload: result.apiPayload,
  };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  if (!req.url) return sendJson(res, 400, { error: "Missing URL" });
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "authorization, content-type, x-admin-token",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/") {
    return sendJson(res, 200, {
      ok: true,
      service: "gumroad-personal-automation",
      mcp: true,
      port: config.port,
      endpoints: ["/healthz", "/webhooks/gumroad/ping", "/admin/*", "/mcp"],
    });
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, {
      ok: true,
      service: "gumroad-personal-automation",
      mcp: true,
      updatedAt: ctx.store.snapshot().meta.updatedAt,
    });
  }

  if (url.pathname === "/mcp" && req.method && new Set(["GET", "POST", "DELETE"]).has(req.method)) {
    if (!verifyMcpToken(req, config.mcpBearerToken)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="gumroad-personal-automation-mcp"');
      return sendJson(res, 401, { error: "Unauthorized" });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    return handleMcpRequest(req, res, ctx);
  }

  if (req.method === "POST" && url.pathname === "/webhooks/gumroad/ping") {
    const rawBody = await readRawBody(req);
    const body = parseBody(req.headers["content-type"], rawBody);
    const verification = verifyWebhookRequest({
      rawBody,
      headers: req.headers,
      body,
      secret: config.gumroadWebhookSecret,
      mode: config.gumroadWebhookVerificationMode,
    });

    if (!verification.ok) {
      console.error("[webhooks] verification failed", {
        mode: verification.mode,
        contentType: req.headers["content-type"],
      });
      return sendJson(res, 401, {
        ok: false,
        error: "Webhook verification failed",
        mode: verification.mode,
      });
    }

    if (!body || typeof body !== "object" || Array.isArray(body) || ("raw" in body && Object.keys(body).length === 1)) {
      const malformedEvent = normalizeWebhookEvent({
        event_type: "malformed",
        parse_error: "Payload could not be parsed into a structured object.",
        raw: String(rawBody.toString("utf8")).slice(0, 5000),
      });
      ctx.store.recordWebhookEvent({
        ...malformedEvent,
        status: "failed",
        processingAttempts: 1,
        lastProcessedAt: malformedEvent.receivedAt,
        lastError: "Malformed webhook payload",
      });
      console.error("[webhooks] malformed payload", { contentType: req.headers["content-type"] });
      return sendJson(res, 400, { ok: false, error: "Malformed webhook payload." });
    }

    const event = normalizeWebhookEvent(body);
    const result = await processWebhookEvent(ctx, event);

    return sendJson(res, 200, {
      ok: true,
      duplicate: result.duplicate,
      eventType: event.eventType,
      dedupeKey: event.dedupeKey,
      verificationMode: verification.mode,
    });
  }

  if (url.pathname.startsWith("/admin/")) {
    if (!verifyAdminToken(req, config.adminToken)) {
      return unauthorized(res);
    }

    if (req.method === "GET" && url.pathname === "/admin/state") {
      const state = ctx.store.snapshot();
      return sendJson(res, 200, {
        meta: state.meta,
        counts: {
          products: Object.keys(state.products).length,
          sales: Object.keys(state.sales).length,
          webhookEvents: Object.keys(state.webhookEvents).length,
          gumroadPingSales: Object.keys(state.gumroadPingSales).length,
          licenseChecks: state.licenseChecks.length,
          jobRuns: state.jobRuns.length,
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/admin/profile") {
      const profile = await ctx.client.getProfile();
      return sendJson(res, 200, { profile });
    }

    if (req.method === "GET" && url.pathname === "/admin/products") {
      const products = ctx.store.listProducts();
      return sendJson(res, 200, { count: products.length, products });
    }

    if (req.method === "GET" && /^\/admin\/products\/[^/]+\/variants$/.test(url.pathname)) {
      const productId = url.pathname.split("/")[3];
      const product = ctx.store.getProduct(productId);
      return sendJson(res, 200, { productId, variants: product?.variants ?? [] });
    }

    if (req.method === "GET" && /^\/admin\/products\/[^/]+\/offer-codes$/.test(url.pathname)) {
      const productId = url.pathname.split("/")[3];
      const product = ctx.store.getProduct(productId);
      return sendJson(res, 200, { productId, offerCodes: product?.offerCodes ?? [] });
    }

    if (req.method === "POST" && url.pathname === "/admin/checkout-links/generate") {
      const body = parseBody(req.headers["content-type"], await readRawBody(req));
      try {
        const input = parseCheckoutLinkRequest(body);
        const product = input.product ?? ctx.store.getProduct(input.productId ?? "");
        if (!product) {
          return sendJson(res, 404, { ok: false, error: "Product not found. Provide product or valid productId." });
        }

        const checkout = buildCheckoutUrl(product, input.options ?? {});
        return sendJson(res, 200, {
          ok: true,
          checkout,
          output: {
            text: checkout.copyPaste,
          },
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "POST" && /^\/admin\/products\/[^/]+\/variants\/refresh$/.test(url.pathname)) {
      assertConfiguredAccessToken();
      const productId = url.pathname.split("/")[3];
      const variants = await refreshVariants(ctx, productId);
      return sendJson(res, 200, { ok: true, productId, count: variants.length, variants });
    }

    if (req.method === "POST" && /^\/admin\/products\/[^/]+\/offer-codes\/refresh$/.test(url.pathname)) {
      assertConfiguredAccessToken();
      const productId = url.pathname.split("/")[3];
      const offerCodes = await refreshOfferCodes(ctx, productId);
      return sendJson(res, 200, { ok: true, productId, count: offerCodes.length, offerCodes });
    }

    if (req.method === "GET" && url.pathname === "/admin/sales") {
      const limit = numberOrFallback(url.searchParams.get("limit"), 50);
      const after = url.searchParams.get("after") ?? undefined;
      const sales = ctx.store.listSales(limit, after);
      return sendJson(res, 200, {
        count: sales.length,
        totalRevenueCents: sales.reduce((sum, sale) => sum + sale.priceCents, 0),
        totalRevenueFormatted: formatMoney(sales.reduce((sum, sale) => sum + sale.priceCents, 0), sales[0]?.currency ?? "USD"),
        sales,
      });
    }

    if (req.method === "GET" && url.pathname === "/admin/summary") {
      const days = numberOrFallback(url.searchParams.get("days"), 7);
      return sendJson(res, 200, ctx.store.createSummary(days));
    }

    if (req.method === "GET" && url.pathname === "/admin/events") {
      const limit = numberOrFallback(url.searchParams.get("limit"), 50);
      return sendJson(res, 200, { events: ctx.store.listWebhookEvents(limit) });
    }

    if (req.method === "GET" && url.pathname === "/admin/events/gumroad-sales") {
      const limit = numberOrFallback(url.searchParams.get("limit"), 50);
      return sendJson(res, 200, { sales: ctx.store.listGumroadPingSales(limit) });
    }

    if (req.method === "GET" && url.pathname === "/admin/jobs") {
      const limit = numberOrFallback(url.searchParams.get("limit"), 20);
      return sendJson(res, 200, { jobs: ctx.store.listJobRuns(limit) });
    }

    if (req.method === "GET" && url.pathname === "/admin/licenses") {
      const limit = numberOrFallback(url.searchParams.get("limit"), 20);
      return sendJson(res, 200, { checks: ctx.store.listRecentLicenseChecks(limit) });
    }

    if (req.method === "GET" && url.pathname === "/admin/write-actions") {
      const limit = numberOrFallback(url.searchParams.get("limit"), 50);
      return sendJson(res, 200, { actions: ctx.store.listWriteActions(limit) });
    }

    if (req.method === "POST" && url.pathname === "/admin/jobs/sync-products") {
      assertConfiguredAccessToken();
      const result = await syncProductsJob(ctx);
      return sendJson(res, 200, { ok: true, job: "sync-products", result });
    }

    if (req.method === "POST" && url.pathname === "/admin/jobs/sync-sales") {
      assertConfiguredAccessToken();
      const rawBody = await readRawBody(req);
      const body = parseBody(req.headers["content-type"], rawBody);
      const result = await syncSalesJob(ctx, {
        after: typeof body.after === "string" ? body.after : undefined,
        before: typeof body.before === "string" ? body.before : undefined,
        productId: typeof body.productId === "string" ? body.productId : undefined,
        limit:
          typeof body.limit === "string"
            ? numberOrFallback(body.limit, 100)
            : typeof body.limit === "number" && Number.isFinite(body.limit)
              ? body.limit
              : undefined,
      });
      return sendJson(res, 200, { ok: true, job: "sync-sales", result });
    }

    if (req.method === "POST" && url.pathname === "/admin/jobs/daily-summary") {
      const rawBody = await readRawBody(req);
      const body = parseBody(req.headers["content-type"], rawBody);
      const result = await dailySummaryJob(
        ctx,
        typeof body.days === "string"
          ? numberOrFallback(body.days, 1)
          : typeof body.days === "number" && Number.isFinite(body.days)
            ? body.days
            : 1,
      );
      return sendJson(res, 200, { ok: true, job: "daily-summary", result });
    }

    if (req.method === "POST" && url.pathname === "/admin/jobs/process-webhooks") {
      const rawBody = await readRawBody(req);
      const body = parseBody(req.headers["content-type"], rawBody);
      const batchSize =
        typeof body.batchSize === "string"
          ? numberOrFallback(body.batchSize, 25)
          : typeof body.batchSize === "number" && Number.isFinite(body.batchSize)
            ? body.batchSize
            : 25;
      const result = await processPendingWebhookEvents(ctx, batchSize);
      return sendJson(res, 200, { ok: true, job: "process-webhooks", result });
    }

    if (req.method === "POST" && url.pathname === "/admin/licenses/verify") {
      assertConfiguredAccessToken();
      const rawBody = await readRawBody(req);
      const body = parseBody(req.headers["content-type"], rawBody);
      const productId = typeof body.productId === "string" ? body.productId : undefined;
      const licenseKey = typeof body.licenseKey === "string" ? body.licenseKey : undefined;
      if (!productId || !licenseKey) {
        return sendJson(res, 400, { error: "productId and licenseKey are required." });
      }
      const result = await ctx.client.verifyLicense(productId, licenseKey);
      ctx.store.recordLicenseCheck(result);
      return sendJson(res, 200, { ok: true, result });
    }

    if (req.method === "GET" && url.pathname === "/admin/products/variants") {
      assertConfiguredAccessToken();
      const productId = url.searchParams.get("productId");
      if (!productId) return sendJson(res, 400, { error: "productId is required." });
      const result = await readProductVariants(ctx, productId);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === "GET" && url.pathname === "/admin/products/offer-codes") {
      assertConfiguredAccessToken();
      const productId = url.searchParams.get("productId");
      if (!productId) return sendJson(res, 400, { error: "productId is required." });
      const result = await readProductOfferCodes(ctx, productId);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === "POST" && url.pathname === "/admin/writes/preview") {
      const rawBody = await readRawBody(req);
      const body = parseBody(req.headers["content-type"], rawBody);
      try {
        const result = previewCatalogAction(ctx, body);
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/products/preview_product_create") {
      const rawBody = await readRawBody(req);
      const body = parseBody(req.headers["content-type"], rawBody);
      try {
        const result = previewProductCreate(ctx, body);
        return sendJson(res, 200, {
          ok: true,
          action_type: "preview_product_create",
          confirmation_id: result.confirmation.confirmationId,
          expires_at: result.confirmation.expiresAt,
          payload_hash: result.confirmation.payloadHash,
          status: result.confirmation.status,
          requires_confirmation_phrase: result.confirmation.requiresPhrase,
          preview: result.preview,
          request_payload: result.confirmation.apiPayload,
        });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/writes/confirm") {
      const rawBody = await readRawBody(req);
      const body = parseBody(req.headers["content-type"], rawBody);
      try {
        const result = await confirmCatalogAction(ctx, body);
        return sendJson(res, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes("already been used") ? 409 : message.includes("not found") ? 404 : 400;
        return sendJson(res, status, { ok: false, action_type: "confirm_catalog_action", error: message });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/products/confirm_product_create") {
      assertConfiguredAccessToken();
      const rawBody = await readRawBody(req);
      const body = parseBody(req.headers["content-type"], rawBody);
      try {
        const result = await confirmProductCreate(ctx, body);
        return sendJson(res, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = confirmationErrorStatus(message);
        return sendJson(res, status, { ok: false, action_type: "confirm_product_create", error: message });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/variants/categories/preview_create") {
      const body = parseBody(req.headers["content-type"], await readRawBody(req));
      try {
        const result = previewCatalogAction(ctx, { ...body, action_type: "variant_category_create" });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/variants/categories/preview_edit") {
      const body = parseBody(req.headers["content-type"], await readRawBody(req));
      try {
        const result = previewCatalogAction(ctx, { ...body, action_type: "variant_category_edit" });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/variants/categories/preview_delete") {
      const body = parseBody(req.headers["content-type"], await readRawBody(req));
      try {
        const result = previewCatalogAction(ctx, { ...body, action_type: "variant_category_delete" });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/variants/preview_create") {
      const body = parseBody(req.headers["content-type"], await readRawBody(req));
      try {
        const result = previewCatalogAction(ctx, { ...body, action_type: "variant_create" });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/variants/preview_edit") {
      const body = parseBody(req.headers["content-type"], await readRawBody(req));
      try {
        const result = previewCatalogAction(ctx, { ...body, action_type: "variant_edit" });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/variants/preview_delete") {
      const body = parseBody(req.headers["content-type"], await readRawBody(req));
      try {
        const result = previewCatalogAction(ctx, { ...body, action_type: "variant_delete" });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/offer-codes/preview_create") {
      const body = parseBody(req.headers["content-type"], await readRawBody(req));
      try {
        const result = previewCatalogAction(ctx, { ...body, action_type: "offer_code_create" });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/offer-codes/preview_delete") {
      const body = parseBody(req.headers["content-type"], await readRawBody(req));
      try {
        const result = previewCatalogAction(ctx, { ...body, action_type: "offer_code_delete" });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (req.method === "POST" && url.pathname === "/admin/offer-codes/preview_disable") {
      const body = parseBody(req.headers["content-type"], await readRawBody(req));
      try {
        const result = previewCatalogAction(ctx, { ...body, action_type: "offer_code_disable" });
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return sendJson(res, 404, { error: "Admin route not found." });
  }

  return sendJson(res, 404, { error: "Not found" });
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

server.listen(config.port, () => {
  console.log(`gumroad-personal-automation listening on http://localhost:${config.port}`);
  console.log(`mcp endpoint available at http://localhost:${config.port}/mcp`);
  if (config.enableIntervalJobs) {
    console.log("interval jobs enabled");
    setInterval(() => void syncProductsJob(ctx).catch(console.error), config.syncProductsIntervalMs);
    setInterval(() => void syncSalesJob(ctx).catch(console.error), config.syncSalesIntervalMs);
    setInterval(() => void dailySummaryJob(ctx, 1).catch(console.error), config.dailySummaryIntervalMs);
    setInterval(() => void processPendingWebhookEvents(ctx).catch(console.error), config.processWebhookEventsIntervalMs);
  }
});
