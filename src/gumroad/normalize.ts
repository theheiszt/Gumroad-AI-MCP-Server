import type { LicenseCheck, OfferCode, Product, Sale, Variant, VariantCategory, WebhookEvent } from "../types.js";
import { isoNow, randomId } from "../utils/format.js";

export function normalizeProduct(input: Record<string, any>): Product {
  const productId = String(input.id);
  const variantCategories = normalizeVariantCategories(input.variants ?? input.variant_categories, productId);
  const offerCodes = normalizeOfferCodes(input.offer_codes, productId);

  return {
    id: productId,
    name: String(input.name ?? "Untitled product"),
    permalink: String(input.short_url ?? input.product_permalink ?? input.custom_permalink ?? ""),
    priceCents: Number(input.price ?? input.price_cents ?? 0),
    currency: String(input.currency ?? "USD").toUpperCase(),
    status: input.published === false ? "draft" : "published",
    createdAt: String(input.created_at ?? isoNow()),
    description:
      typeof input.description === "string"
        ? input.description
        : typeof input.custom_summary === "string"
          ? input.custom_summary
          : undefined,
    salesCount: input.sales_count != null ? Number(input.sales_count) : undefined,
    tags: Array.isArray(input.tags) ? input.tags.map((value: unknown) => String(value)) : undefined,
    variants: variantCategories.length ? variantCategories : undefined,
    offerCodes: offerCodes.length ? offerCodes : undefined,
    raw: input,
  };
}

export function normalizeVariantCategory(input: Record<string, any>, productId: string): VariantCategory {
  return {
    id: String(input.id ?? input.variant_category_id ?? randomId("variant_category")),
    productId,
    title: String(input.title ?? input.name ?? "Untitled variant category"),
    options: normalizeVariants(input.options ?? input.variants, productId, String(input.id ?? input.variant_category_id ?? "")),
    raw: input,
  };
}

export function normalizeVariant(input: Record<string, any>, productId: string, categoryId?: string): Variant {
  return {
    id: String(input.id ?? input.variant_id ?? randomId("variant")),
    productId,
    categoryId,
    name: String(input.name ?? input.option ?? "Untitled variant"),
    priceDifferenceCents:
      input.price_difference != null || input.price_difference_cents != null
        ? Number(input.price_difference ?? input.price_difference_cents)
        : undefined,
    description: typeof input.description === "string" ? input.description : undefined,
    quantityLeft: input.quantity_left != null ? Number(input.quantity_left) : undefined,
    raw: input,
  };
}

export function normalizeOfferCode(input: Record<string, any>, productId: string): OfferCode {
  return {
    id: String(input.id ?? input.offer_code_id ?? randomId("offer")),
    productId,
    name: String(input.name ?? input.code ?? "Unnamed offer"),
    code: String(input.code ?? input.name ?? ""),
    amountOffCents:
      input.amount_off != null || input.amount_off_cents != null ? Number(input.amount_off ?? input.amount_off_cents) : undefined,
    percentOff: input.percent_off != null ? Number(input.percent_off) : undefined,
    maxUses: input.max_uses != null ? Number(input.max_uses) : undefined,
    uses: input.uses != null ? Number(input.uses) : undefined,
    valid: input.valid != null ? Boolean(input.valid) : undefined,
    expiresAt: typeof input.expires_at === "string" ? input.expires_at : undefined,
    raw: input,
  };
}

export function normalizeVariantCategories(input: unknown, productId: string): VariantCategory[] {
  if (!Array.isArray(input)) return [];
  return input.map((row) => normalizeVariantCategory((row ?? {}) as Record<string, any>, productId));
}

export function normalizeVariants(input: unknown, productId: string, categoryId?: string): Variant[] {
  if (!Array.isArray(input)) return [];
  return input.map((row) => normalizeVariant((row ?? {}) as Record<string, any>, productId, categoryId));
}

export function normalizeOfferCodes(input: unknown, productId: string): OfferCode[] {
  if (!Array.isArray(input)) return [];
  return input.map((row) => normalizeOfferCode((row ?? {}) as Record<string, any>, productId));
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
