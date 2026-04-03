import type { LicenseCheck, OfferCode, Product, ProductVariant, VariantCategory, Sale, WebhookEvent } from "../types.js";
import { isoNow, randomId } from "../utils/format.js";

export function normalizeProduct(input: Record<string, any>): Product {
  return {
    id: String(input.id),
    name: String(input.name ?? "Untitled product"),
    permalink: String(input.short_url ?? input.product_permalink ?? input.custom_permalink ?? ""),
    priceCents: Number(input.price ?? input.price_cents ?? 0),
    currency: String(input.currency ?? "USD").toUpperCase(),
    status: input.published === false ? "draft" : "published",
    createdAt: String(input.created_at ?? isoNow()),
    description: typeof input.description === "string"
      ? input.description
      : typeof input.custom_summary === "string"
        ? input.custom_summary
        : undefined,
    salesCount: input.sales_count != null ? Number(input.sales_count) : undefined,
    tags: Array.isArray(input.tags) ? input.tags.map((value: unknown) => String(value)) : undefined,
    raw: input,
  };
}

export function normalizeVariantCategory(productId: string, input: Record<string, any>): VariantCategory {
  const options = Array.isArray(input.options)
    ? input.options.map((value: unknown) => String(value))
    : Array.isArray(input.variants)
      ? input.variants.map((value: unknown) => String(value))
      : [];

  return {
    id: String(input.id ?? input.variant_category_id ?? randomId("varcat")),
    productId,
    name: String(input.name ?? input.title ?? "Variant category"),
    options,
    raw: input,
  };
}

export function normalizeVariant(productId: string, input: Record<string, any>): ProductVariant {
  return {
    id: String(input.id ?? input.variant_id ?? randomId("variant")),
    productId,
    categoryId: typeof input.variant_category_id === "string" ? input.variant_category_id : undefined,
    categoryName: typeof input.variant_category_name === "string" ? input.variant_category_name : undefined,
    name: String(input.name ?? input.title ?? input.option ?? "Variant"),
    priceDifferenceCents: input.price_difference_cents != null ? Number(input.price_difference_cents) : undefined,
    quantityLeft: input.quantity_left != null ? Number(input.quantity_left) : undefined,
    raw: input,
  };
}

export function normalizeOfferCode(productId: string, input: Record<string, any>): OfferCode {
  return {
    id: String(input.id ?? input.offer_code_id ?? randomId("offer")),
    productId,
    name: String(input.name ?? input.offer_name ?? input.code ?? "Offer code"),
    code: String(input.code ?? input.offer_code ?? input.name ?? ""),
    amountOffCents: input.amount_off_cents != null ? Number(input.amount_off_cents) : undefined,
    percentOff: input.percent_off != null ? Number(input.percent_off) : undefined,
    maxPurchaseCount: input.max_purchase_count != null ? Number(input.max_purchase_count) : undefined,
    expiresAt: typeof input.expires_at === "string" ? input.expires_at : undefined,
    disabled: input.disabled != null ? Boolean(input.disabled) : undefined,
    raw: input,
  };
}

export function normalizeSale(input: Record<string, any>): Sale {
  return {
    id: String(input.id ?? input.sale_id ?? input.purchase_id ?? input.order_id ?? randomId("sale")),
    productId: String(input.product_id ?? ""),
    productName: String(input.product_name ?? input.name ?? "Untitled product"),
    purchaserEmail: String(input.purchase_email ?? input.email ?? input.user_email ?? "unknown@example.com"),
    priceCents: Number(input.price ?? input.price_cents ?? 0),
    currency: String(input.currency ?? "USD").toUpperCase(),
    orderNumber: String(input.order_id ?? input.order_number ?? input.purchase_id ?? input.id ?? "unknown-order"),
    occurredAt: String(input.created_at ?? input.sale_timestamp ?? input.timestamp ?? isoNow()),
    recurring: Boolean(input.recurring_charge ?? input.is_recurring_billing ?? input.subscription_id ?? input.recurrence),
    raw: input,
  };
}

export function normalizeLicenseCheck(productId: string, licenseKey: string, input: Record<string, any>): LicenseCheck {
  const purchase = typeof input.purchase === "object" && input.purchase ? input.purchase : {};
  return {
    productId: String((purchase as Record<string, any>).product_id ?? productId),
    productName: String((purchase as Record<string, any>).product_name ?? "Unknown product"),
    licenseKey: String((purchase as Record<string, any>).license_key ?? licenseKey),
    valid: Boolean(input.success),
    uses: Number(input.uses ?? 0),
    purchaserEmail: typeof (purchase as Record<string, any>).email === "string" ? (purchase as Record<string, any>).email : undefined,
    checkedAt: isoNow(),
    raw: input,
  };
}

export function normalizeWebhookEvent(payload: Record<string, unknown>): WebhookEvent {
  const eventType = deriveEventType(payload);
  const productId = readString(payload, "product_id");
  const productName = readString(payload, "product_name");
  const saleId = readString(payload, "sale_id") ?? readString(payload, "purchase_id");
  const orderNumber = readString(payload, "order_id") ?? readString(payload, "order_number");
  const purchaserEmail = readString(payload, "email") ?? readString(payload, "purchase_email") ?? readString(payload, "user_email");
  const dedupeKey = [
    eventType,
    saleId ?? orderNumber ?? "no-sale-id",
    productId ?? "no-product-id",
    purchaserEmail ?? "no-email",
    readString(payload, "created_at") ?? readString(payload, "timestamp") ?? "no-time",
  ].join("::");

  return {
    id: randomId("evt"),
    dedupeKey,
    receivedAt: isoNow(),
    eventType,
    productId,
    productName,
    saleId,
    orderNumber,
    purchaserEmail,
    raw: payload,
  };
}

export function deriveSaleFromWebhook(payload: Record<string, unknown>): Sale | null {
  const productId = readString(payload, "product_id");
  const productName = readString(payload, "product_name");
  const email = readString(payload, "email") ?? readString(payload, "purchase_email") ?? readString(payload, "user_email");
  if (!productId || !productName || !email) return null;

  return normalizeSale(payload as Record<string, any>);
}

function deriveEventType(payload: Record<string, unknown>) {
  const explicit = readString(payload, "resource_name") ?? readString(payload, "event_type") ?? readString(payload, "type");
  if (explicit) return explicit;
  if ("subscription_id" in payload && "cancelled" in payload) return "cancellation";
  if ("subscription_id" in payload && "old_plan" in payload && "new_plan" in payload) return "subscription_updated";
  if ("subscription_id" in payload) return "subscription_event";
  if ("sale_id" in payload || "purchase_id" in payload || "order_id" in payload) return "sale";
  return "unknown";
}

function readString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  return typeof value === "string" && value ? value : undefined;
}
