export type ProductStatus = "published" | "draft";

export type Product = {
  id: string;
  name: string;
  permalink: string;
  priceCents: number;
  currency: string;
  status: ProductStatus;
  createdAt: string;
  description?: string;
  salesCount?: number;
  tags?: string[];
  raw?: Record<string, unknown>;
};

export type Sale = {
  id: string;
  productId: string;
  productName: string;
  purchaserEmail: string;
  priceCents: number;
  currency: string;
  orderNumber: string;
  occurredAt: string;
  recurring: boolean;
  raw?: Record<string, unknown>;
};

export type LicenseCheck = {
  productId: string;
  productName: string;
  licenseKey: string;
  valid: boolean;
  uses: number;
  purchaserEmail?: string;
  checkedAt: string;
  raw?: Record<string, unknown>;
};

export type WebhookEvent = {
  id: string;
  dedupeKey: string;
  receivedAt: string;
  eventType: string;
  productId?: string;
  productName?: string;
  saleId?: string;
  orderNumber?: string;
  purchaserEmail?: string;
  raw: Record<string, unknown>;
};

export type JobStatus = "success" | "error";

export type JobRun = {
  id: string;
  name: string;
  startedAt: string;
  finishedAt: string;
  status: JobStatus;
  message: string;
  details?: Record<string, unknown>;
};

export type StoreState = {
  products: Record<string, Product>;
  sales: Record<string, Sale>;
  webhookEvents: Record<string, WebhookEvent>;
  licenseChecks: LicenseCheck[];
  jobRuns: JobRun[];
  meta: {
    createdAt: string;
    updatedAt: string;
    lastProductSyncAt?: string;
    lastSalesSyncAt?: string;
    lastSummaryAt?: string;
  };
};

export type SalesSummary = {
  generatedAt: string;
  windowDays: number;
  saleCount: number;
  totalRevenueCents: number;
  totalRevenueFormatted: string;
  topProducts: Array<{
    productId: string;
    productName: string;
    salesCount: number;
    revenueCents: number;
    revenueFormatted: string;
  }>;
  recurringCount: number;
  recentSales: Sale[];
};

export type SyncSalesArgs = {
  after?: string;
  before?: string;
  limit?: number;
  productId?: string;
};
