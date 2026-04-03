import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { assertConfiguredAccessToken, config } from "./config.js";
import { normalizeWebhookEvent, deriveSaleFromWebhook } from "./gumroad/normalize.js";
import { dailySummaryJob, processWebhookEvent, syncProductsJob, syncSalesJob } from "./jobs/index.js";
import { handleMcpRequest } from "./mcp.js";
import { createAppContext } from "./services/app-context.js";
import { confirmCatalogAction, previewCatalogAction, readProductOfferCodes, readProductVariants } from "./services/catalog-management.js";
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
    });

    if (!verification.ok) {
      return sendJson(res, 401, {
        ok: false,
        error: "Webhook verification failed",
        mode: verification.mode,
      });
    }

    const event = normalizeWebhookEvent(body);
    const result = await processWebhookEvent(ctx, event);
    const sale = deriveSaleFromWebhook(body);
    if (sale) {
      ctx.store.upsertSales([sale]);
    }

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
  }
});
