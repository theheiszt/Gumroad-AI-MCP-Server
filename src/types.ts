export type ProductStatus = "published" | "draft";

export type VariantCategory = {
  id: string;
  productId: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
  raw?: Record<string, unknown>;
};

export type Variant = {
  id: string;
  productId: string;
  categoryId?: string;
  name: string;
  priceDifferenceCents?: number;
  quantityLeft?: number;
  raw?: Record<string, unknown>;
};

export type OfferCode = {
  id: string;
  productId: string;
  code: string;
  name?: string;
  amountOffCents?: number;
  percentOff?: number;
  maxUses?: number;
  uses?: number;
  status: "active" | "disabled";
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
  variantCategories?: VariantCategory[];
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
  status: "pending" | "processed" | "failed";
  processingAttempts: number;
  firstProcessedAt?: string;
  lastProcessedAt?: string;
  lastError?: string;
  productId?: string;
  productName?: string;
  saleId?: string;
  orderNumber?: string;
  purchaserEmail?: string;
  raw: Record<string, unknown>;
};

export type GumroadPingSaleRecord = {
  id: string;
  sourceEventId: string;
  sourceDedupeKey: string;
  saleId?: string;
  saleTimestamp?: string;
  orderNumber?: string;
  sellerId?: string;
  productId?: string;
  productName?: string;
  email?: string;
  price?: number;
  recurrence?: string;
  variants?: string;
  licenseKey?: string;
  quantity?: number;
  refunded?: boolean;
  raw: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
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

export type ConfirmationStatus = "pending" | "executing" | "completed" | "expired" | "failed";

export type WriteActionType =
  | "product_create"
  | "product_enable"
  | "product_disable"
  | "variant_category_create"
  | "variant_category_edit"
  | "variant_category_delete"
  | "variant_create"
  | "variant_edit"
  | "variant_delete"
  | "custom_field_create"
  | "custom_field_edit"
  | "custom_field_delete"
  | "offer_code_create"
  | "offer_code_list"
  | "offer_code_disable"
  | "offer_code_delete";

export type WriteActionLog = {
  id: string;
  actionType: WriteActionType;
  status: "attempted" | "completed" | "failed";
  at: string;
  confirmationId?: string;
  details?: Record<string, unknown>;
};

export type WriteConfirmation = {
  confirmationId: string;
  actionType: WriteActionType;
  payloadHash: string;
  expiresAt: string;
  status: ConfirmationStatus;
  createdAt: string;
  updatedAt: string;
  requiresPhrase: boolean;
  input: Record<string, unknown>;
  apiRequest: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    payload?: Record<string, string>;
  };
  preview: string;
  result?: {
    executedAt: string;
    response: Record<string, unknown>;
  };
  error?: string;
};

export type WriteConfirmationRecord = WriteConfirmation;

export type ProductCreateDraft = {
  productType: "digital_product" | "ebook" | "bundle" | "membership" | "course";
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
  gumroadPingSales: Record<string, GumroadPingSaleRecord>;
  licenseChecks: LicenseCheck[];
  jobRuns: JobRun[];
  writeConfirmations: Record<string, WriteConfirmation>;
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
