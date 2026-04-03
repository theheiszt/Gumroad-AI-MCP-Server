import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { assertConfiguredAccessToken } from "./config.js";
import { syncProductsJob, syncSalesJob, dailySummaryJob } from "./jobs/index.js";
import type { AppContext } from "./services/app-context.js";
import { confirmCatalogAction, previewCatalogAction } from "./services/catalog-management.js";
import { formatMoney } from "./utils/format.js";

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

function toolError(message: string, error?: unknown) {
  const details = error instanceof Error ? error.message : error ? String(error) : undefined;
  return {
    content: textContent(details ? `${message} ${details}` : message),
    isError: true,
    _meta: details ? { details } : undefined,
  };
}

function filterProducts(ctx: AppContext, query?: string, limit = 25) {
  const q = query?.trim().toLowerCase();
  const products = ctx.store.listProducts().filter((product) => {
    if (!q) return true;
    const haystack = [product.name, product.description ?? "", ...(product.tags ?? [])].join(" ").toLowerCase();
    return haystack.includes(q);
  });
  return products.slice(0, limit);
}

function filterSales(
  ctx: AppContext,
  args?: { limit?: number; after?: string; before?: string; productId?: string },
) {
  const limit = args?.limit ?? 50;
  const afterTime = args?.after ? new Date(args.after).getTime() : undefined;
  const beforeTime = args?.before ? new Date(args.before).getTime() : undefined;
  const productId = args?.productId;

  return Object.values(ctx.store.snapshot().sales)
    .filter((sale) => {
      const time = new Date(sale.occurredAt).getTime();
      if (afterTime && time < afterTime) return false;
      if (beforeTime && time > beforeTime) return false;
      if (productId && sale.productId !== productId) return false;
      return true;
    })
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, limit);
}

export function createMcpServer(ctx: AppContext) {
  const server = new McpServer({
    name: "gumroad-personal-automation-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "get_health",
    {
      title: "Get service health",
      description: "Return health and metadata for the Gumroad personal automation service.",
      inputSchema: {},
    },
    async () => {
      const state = ctx.store.snapshot();
      return {
        content: textContent("Gumroad personal automation MCP shim is healthy."),
        structuredContent: {
          ok: true,
          service: "gumroad-personal-automation",
          mcp: true,
          updatedAt: state.meta.updatedAt,
        },
      };
    },
  );

  server.registerTool(
    "get_state",
    {
      title: "Get automation state",
      description: "Return counts and sync timestamps from the local automation store.",
      inputSchema: {},
    },
    async () => {
      const state = ctx.store.snapshot();
      return {
        content: textContent("Loaded automation state."),
        structuredContent: {
          meta: state.meta,
          counts: {
            products: Object.keys(state.products).length,
            sales: Object.keys(state.sales).length,
            webhookEvents: Object.keys(state.webhookEvents).length,
            licenseChecks: state.licenseChecks.length,
            jobRuns: state.jobRuns.length,
          },
        },
      };
    },
  );

  server.registerTool(
    "get_profile",
    {
      title: "Get Gumroad profile",
      description: "Fetch the Gumroad profile for the configured personal account.",
      inputSchema: {},
    },
    async () => {
      try {
        assertConfiguredAccessToken();
        const profile = await ctx.client.getProfile();
        return {
          content: textContent("Loaded Gumroad profile."),
          structuredContent: { profile },
        };
      } catch (error) {
        return toolError("Unable to load the Gumroad profile.", error);
      }
    },
  );

  server.registerTool(
    "list_products",
    {
      title: "List cached products",
      description: "List products from the local automation store, optionally filtered by query.",
      inputSchema: {
        query: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) => {
      const products = filterProducts(ctx, args.query, args.limit ?? 50);
      return {
        content: textContent(`Loaded ${products.length} product(s) from the local store.`),
        structuredContent: {
          count: products.length,
          products,
        },
      };
    },
  );

  server.registerTool(
    "list_sales",
    {
      title: "List cached sales",
      description: "List sales from the local automation store with optional filters.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).optional(),
        after: z.string().optional(),
        before: z.string().optional(),
        productId: z.string().optional(),
      },
    },
    async (args) => {
      const sales = filterSales(ctx, args);
      const totalRevenueCents = sales.reduce((sum, sale) => sum + sale.priceCents, 0);
      return {
        content: textContent(`Loaded ${sales.length} sale(s) from the local store.`),
        structuredContent: {
          count: sales.length,
          totalRevenueCents,
          totalRevenueFormatted: formatMoney(totalRevenueCents, sales[0]?.currency ?? "USD"),
          sales,
        },
      };
    },
  );

  server.registerTool(
    "get_summary",
    {
      title: "Get sales summary",
      description: "Return a sales summary for the requested number of days from local cached data.",
      inputSchema: {
        days: z.number().int().min(1).max(365).optional(),
      },
    },
    async (args) => {
      const summary = ctx.store.createSummary(args.days ?? 7);
      return {
        content: textContent(`Generated a ${summary.windowDays}-day sales summary.`),
        structuredContent: summary,
      };
    },
  );

  server.registerTool(
    "list_events",
    {
      title: "List webhook events",
      description: "Return recent Gumroad webhook events recorded by the automation service.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) => {
      const events = ctx.store.listWebhookEvents(args.limit ?? 50);
      return {
        content: textContent(`Loaded ${events.length} webhook event(s).`),
        structuredContent: { count: events.length, events },
      };
    },
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List job runs",
      description: "Return recent background job runs from the automation service.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async (args) => {
      const jobs = ctx.store.listJobRuns(args.limit ?? 50);
      return {
        content: textContent(`Loaded ${jobs.length} job run(s).`),
        structuredContent: { count: jobs.length, jobs },
      };
    },
  );

  server.registerTool(
    "run_sync_products",
    {
      title: "Run product sync",
      description: "Trigger a live Gumroad product sync and update the local automation store.",
      inputSchema: {},
    },
    async () => {
      try {
        assertConfiguredAccessToken();
        const result = await syncProductsJob(ctx);
        return {
          content: textContent(`Synced ${result.count} product(s).`),
          structuredContent: { ok: true, job: "sync-products", result },
        };
      } catch (error) {
        return toolError("Unable to sync products.", error);
      }
    },
  );

  server.registerTool(
    "run_sync_sales",
    {
      title: "Run sales sync",
      description: "Trigger a live Gumroad sales sync and update the local automation store.",
      inputSchema: {
        after: z.string().optional(),
        before: z.string().optional(),
        productId: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async (args) => {
      try {
        assertConfiguredAccessToken();
        const result = await syncSalesJob(ctx, args);
        return {
          content: textContent(`Synced ${result.count} sale(s).`),
          structuredContent: { ok: true, job: "sync-sales", result },
        };
      } catch (error) {
        return toolError("Unable to sync sales.", error);
      }
    },
  );

  server.registerTool(
    "run_daily_summary",
    {
      title: "Run daily summary job",
      description: "Generate a summary job and return the resulting summary payload.",
      inputSchema: {
        days: z.number().int().min(1).max(365).optional(),
      },
    },
    async (args) => {
      try {
        const result = await dailySummaryJob(ctx, args.days ?? 1);
        return {
          content: textContent(`Ran summary job for ${result.windowDays} day(s).`),
          structuredContent: { ok: true, job: "daily-summary", result },
        };
      } catch (error) {
        return toolError("Unable to run the summary job.", error);
      }
    },
  );

  server.registerTool(
    "preview_product_create",
    {
      title: "Preview product creation",
      description:
        "Create a confirmation-gated preview for product creation. Supports digital_product, ebook, bundle, membership, and course.",
      inputSchema: {
        product_type: z.enum(["digital_product", "ebook", "bundle", "membership", "course"]).default("digital_product"),
        name: z.string().min(1),
        price_cents: z.number().int().min(1),
        currency: z.string().optional(),
        description: z.string().optional(),
        published: z.union([z.boolean(), z.string()]).optional(),
        custom_summary: z.string().optional(),
        custom_receipt: z.string().optional(),
        tags: z.union([z.string(), z.array(z.string())]).optional(),
      },
    },
    async (args) => {
      try {
        assertConfiguredAccessToken();
        const result = previewCatalogAction(ctx, { ...args, action_type: "product_create" });
        return {
          content: textContent(`Prepared product creation preview for ${args.name}. Confirm with confirmation_id to execute.`),
          structuredContent: result,
        };
      } catch (error) {
        return toolError("Unable to preview product creation.", error);
      }
    },
  );

  server.registerTool(
    "confirm_product_create",
    {
      title: "Confirm product creation",
      description: "Execute a previously previewed product creation request using confirmation_id.",
      inputSchema: {
        confirmation_id: z.string().min(1),
        confirmation_phrase: z.string().optional(),
      },
    },
    async (args) => {
      try {
        assertConfiguredAccessToken();
        const result = await confirmCatalogAction(ctx, args);
        return {
          content: textContent(`Product creation confirmed for ${args.confirmation_id}.`),
          structuredContent: result,
        };
      } catch (error) {
        return toolError("Unable to confirm product creation.", error);
      }
    },
  );

  server.registerTool(
    "verify_license",
    {
      title: "Verify license",
      description: "Verify a Gumroad license key and store the result in local history.",
      inputSchema: {
        productId: z.string().min(1),
        licenseKey: z.string().min(1),
      },
    },
    async (args) => {
      try {
        assertConfiguredAccessToken();
        const result = await ctx.client.verifyLicense(args.productId, args.licenseKey);
        ctx.store.recordLicenseCheck(result);
        return {
          content: textContent(result.valid ? `License is valid for ${result.productName}.` : `License is not valid for ${result.productName}.`),
          structuredContent: result,
        };
      } catch (error) {
        return toolError("Unable to verify the Gumroad license.", error);
      }
    },
  );

  return server;
}

export async function handleMcpRequest(req: any, res: any, ctx: AppContext) {
  const server = createMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}
