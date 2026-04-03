export type ProductStatus = "published" | "draft";

export type Variant = {
  id: string;
  productId: string;
  categoryId?: string;
  name: string;
  priceDifferenceCents?: number;
  description?: string;
  quantityLeft?: number;
  raw?: Record<string, unknown>;
};

export type VariantCategory = {
  id: string;
  productId: string;
  title: string;
  options: Variant[];
  raw?: Record<string, unknown>;
};

export type OfferCode = {
  id: string;
  productId: string;
  name: string;
  code: string;
  amountOffCents?: number;
  percentOff?: number;
  maxUses?: number;
  uses?: number;
  valid?: boolean;
  expiresAt?: string;
  raw?: Record<string, unknown>;
};

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
  variants?: VariantCategory[];
  offerCodes?: OfferCode[];
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

export type WriteConfirmationStatus = "pending" | "executing" | "completed" | "expired" | "failed";

export type WriteActionType =
  | "product_create"
  | "variant_category_create"
  | "variant_category_edit"
  | "variant_category_delete"
  | "variant_create"
  | "variant_edit"
  | "variant_delete"
  | "offer_code_create"
  | "offer_code_delete"
  | "offer_code_disable";

export type WriteActionLog = {
  id: string;
  actionType: WriteActionType;
export type ConfirmationStatus = "pending" | "executing" | "completed" | "expired" | "failed";

export type WriteActionLog = {
  id: string;
  actionType: string;
  status: "attempted" | "completed" | "failed";
  at: string;
  confirmationId?: string;
  details?: Record<string, unknown>;
};

export type WriteConfirmationRecord = {
  confirmationId: string;
  actionType: WriteActionType;
  payloadHash: string;
  expiresAt: string;
  status: WriteConfirmationStatus;
  createdAt: string;
  updatedAt: string;
  requiresPhrase: boolean;
  input: Record<string, unknown>;
  apiPayload: Record<string, string>;
  preview: string;
  productId?: string;
  result?: {
    executedAt: string;
    response: Record<string, unknown>;
export type ProductCreateDraft = {
  name: string;
  description?: string;
  priceCents: number;
  currency: string;
  published?: boolean;
  customSummary?: string;
  customReceipt?: string;
  tags?: string[];
};

export type ProductCreateConfirmation = {
  confirmationId: string;
  actionType: "product_create";
  payloadHash: string;
  expiresAt: string;
  status: ConfirmationStatus;
  createdAt: string;
  updatedAt: string;
  requiresPhrase: boolean;
  input: ProductCreateDraft;
  apiPayload: Record<string, string>;
  preview: string;
  result?: {
    executedAt: string;
    response: Record<string, unknown>;
    productId?: string;
  };
  error?: string;
};

export type StoreState = {
  products: Record<string, Product>;
  sales: Record<string, Sale>;
  webhookEvents: Record<string, WebhookEvent>;
  licenseChecks: LicenseCheck[];
  jobRuns: JobRun[];
  writeConfirmations: Record<string, WriteConfirmationRecord>;
  productCreateConfirmations: Record<string, ProductCreateConfirmation>;
  writeActions: WriteActionLog[];
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
