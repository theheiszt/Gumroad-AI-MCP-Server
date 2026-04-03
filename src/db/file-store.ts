import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JobRun, LicenseCheck, Product, Sale, SalesSummary, StoreState, WebhookEvent } from "../types.js";
import { formatMoney, isoNow } from "../utils/format.js";

function createEmptyState(): StoreState {
  const now = isoNow();
  return {
    products: {},
    sales: {},
    webhookEvents: {},
    licenseChecks: [],
    jobRuns: [],
    meta: {
      createdAt: now,
      updatedAt: now,
    },
  };
}

export class FileStore {
  private state: StoreState;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.state = this.read();
  }

  private read(): StoreState {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      return { ...createEmptyState(), ...(JSON.parse(raw) as StoreState) };
    } catch {
      return createEmptyState();
    }
  }

  private persist() {
    this.state.meta.updatedAt = isoNow();
    const tempFile = `${this.filePath}.tmp`;
    writeFileSync(tempFile, JSON.stringify(this.state, null, 2));
    renameSync(tempFile, this.filePath);
  }

  snapshot(): StoreState {
    return JSON.parse(JSON.stringify(this.state)) as StoreState;
  }

  upsertProducts(products: Product[]) {
    for (const product of products) {
      this.state.products[product.id] = product;
    }
    this.state.meta.lastProductSyncAt = isoNow();
    this.persist();
  }

  upsertSales(sales: Sale[]) {
    for (const sale of sales) {
      this.state.sales[sale.id] = sale;
    }

    const counts = new Map<string, number>();
    for (const sale of Object.values(this.state.sales)) {
      counts.set(sale.productId, (counts.get(sale.productId) ?? 0) + 1);
    }

    for (const product of Object.values(this.state.products)) {
      product.salesCount = counts.get(product.id) ?? 0;
    }

    this.state.meta.lastSalesSyncAt = isoNow();
    this.persist();
  }

  recordWebhookEvent(event: WebhookEvent) {
    const existing = this.findWebhookByDedupeKey(event.dedupeKey);
    if (existing) return { inserted: false, existing };
    this.state.webhookEvents[event.id] = event;
    this.persist();
    return { inserted: true, event };
  }

  private findWebhookByDedupeKey(dedupeKey: string) {
    return Object.values(this.state.webhookEvents).find((item) => item.dedupeKey === dedupeKey) ?? null;
  }

  recordLicenseCheck(result: LicenseCheck) {
    this.state.licenseChecks.unshift(result);
    this.state.licenseChecks = this.state.licenseChecks.slice(0, 500);
    this.persist();
  }

  recordJobRun(run: JobRun) {
    this.state.jobRuns.unshift(run);
    this.state.jobRuns = this.state.jobRuns.slice(0, 200);
    this.persist();
  }

  listProducts() {
    return Object.values(this.state.products).sort((a, b) => a.name.localeCompare(b.name));
  }

  listSales(limit = 50, after?: string) {
    const afterTime = after ? new Date(after).getTime() : undefined;
    return Object.values(this.state.sales)
      .filter((sale) => (afterTime ? new Date(sale.occurredAt).getTime() >= afterTime : true))
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
      .slice(0, limit);
  }

  listWebhookEvents(limit = 50) {
    return Object.values(this.state.webhookEvents)
      .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
      .slice(0, limit);
  }

  listJobRuns(limit = 20) {
    return this.state.jobRuns.slice(0, limit);
  }

  listRecentLicenseChecks(limit = 20) {
    return this.state.licenseChecks.slice(0, limit);
  }

  createSummary(windowDays: number): SalesSummary {
    const afterTime = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const sales = Object.values(this.state.sales)
      .filter((sale) => new Date(sale.occurredAt).getTime() >= afterTime)
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

    const totalRevenueCents = sales.reduce((sum, sale) => sum + sale.priceCents, 0);
    const byProduct = new Map<string, { productId: string; productName: string; salesCount: number; revenueCents: number }>();
    for (const sale of sales) {
      const bucket = byProduct.get(sale.productId) ?? {
        productId: sale.productId,
        productName: sale.productName,
        salesCount: 0,
        revenueCents: 0,
      };
      bucket.salesCount += 1;
      bucket.revenueCents += sale.priceCents;
      byProduct.set(sale.productId, bucket);
    }

    const topProducts = Array.from(byProduct.values())
      .sort((a, b) => b.revenueCents - a.revenueCents)
      .slice(0, 5)
      .map((row) => ({
        ...row,
        revenueFormatted: formatMoney(row.revenueCents, sales[0]?.currency ?? "USD"),
      }));

    return {
      generatedAt: isoNow(),
      windowDays,
      saleCount: sales.length,
      totalRevenueCents,
      totalRevenueFormatted: formatMoney(totalRevenueCents, sales[0]?.currency ?? "USD"),
      topProducts,
      recurringCount: sales.filter((sale) => sale.recurring).length,
      recentSales: sales.slice(0, 10),
    };
  }
}
