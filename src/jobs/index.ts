import { buildSummaryDelivery, buildWebhookDeliveries, dispatchRuleOutputs } from "../automation/rules.js";
import type { AppContext } from "../services/app-context.js";
import type { JobRun, SyncSalesArgs, WebhookEvent } from "../types.js";
import { daysAgoIso, isoNow, randomId } from "../utils/format.js";

async function recordRun(ctx: AppContext, run: Omit<JobRun, "id">) {
  ctx.store.recordJobRun({ id: randomId("job"), ...run });
}

export async function syncProductsJob(ctx: AppContext) {
  const startedAt = isoNow();
  try {
    const products = await ctx.client.listProducts();
    ctx.store.upsertProducts(products);
    await recordRun(ctx, {
      name: "sync-products",
      startedAt,
      finishedAt: isoNow(),
      status: "success",
      message: `Synced ${products.length} product(s).`,
      details: { count: products.length },
    });
    return { count: products.length };
  } catch (error) {
    await recordRun(ctx, {
      name: "sync-products",
      startedAt,
      finishedAt: isoNow(),
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function syncSalesJob(ctx: AppContext, args: SyncSalesArgs = {}) {
  const startedAt = isoNow();
  const after = args.after ?? daysAgoIso(ctx.config.syncLookbackDays);
  try {
    const sales = await ctx.client.listSales({ ...args, after });
    ctx.store.upsertSales(sales);
    await recordRun(ctx, {
      name: "sync-sales",
      startedAt,
      finishedAt: isoNow(),
      status: "success",
      message: `Synced ${sales.length} sale(s).`,
      details: { count: sales.length, after },
    });
    return { count: sales.length, after };
  } catch (error) {
    await recordRun(ctx, {
      name: "sync-sales",
      startedAt,
      finishedAt: isoNow(),
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      details: { after },
    });
    throw error;
  }
}

export async function dailySummaryJob(ctx: AppContext, windowDays = 1) {
  const startedAt = isoNow();
  try {
    const summary = ctx.store.createSummary(windowDays);
    await dispatchRuleOutputs(buildSummaryDelivery(summary, ctx.config.outboundSummaryWebhookUrl));
    await recordRun(ctx, {
      name: "daily-summary",
      startedAt,
      finishedAt: isoNow(),
      status: "success",
      message: `Generated ${windowDays}d summary for ${summary.saleCount} sale(s).`,
      details: { windowDays, saleCount: summary.saleCount, revenueCents: summary.totalRevenueCents },
    });
    return summary;
  } catch (error) {
    await recordRun(ctx, {
      name: "daily-summary",
      startedAt,
      finishedAt: isoNow(),
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      details: { windowDays },
    });
    throw error;
  }
}

export async function processWebhookEvent(ctx: AppContext, event: WebhookEvent) {
  const record = ctx.store.recordWebhookEvent(event);
  if (!record.inserted) {
    return { duplicate: true, event: record.existing };
  }

  await dispatchRuleOutputs(
    buildWebhookDeliveries({
      event,
      saleWebhookUrl: ctx.config.outboundSaleWebhookUrl,
      membershipWebhookUrl: ctx.config.outboundMembershipWebhookUrl,
    }),
  );

  await recordRun(ctx, {
    name: "webhook-event",
    startedAt: event.receivedAt,
    finishedAt: isoNow(),
    status: "success",
    message: `Processed webhook event ${event.eventType}.`,
    details: {
      dedupeKey: event.dedupeKey,
      eventType: event.eventType,
      productId: event.productId,
      saleId: event.saleId,
    },
  });

  return { duplicate: false, event };
}
