import { createHash } from "node:crypto";
import { config } from "../config.js";
import { normalizeOfferCodes, normalizeVariantCategories } from "../gumroad/normalize.js";
import type { ProductCreateConfirmation, ProductCreateDraft } from "../types.js";
import { isoNow, randomId } from "../utils/format.js";
import type { AppContext } from "./app-context.js";

const SUPPORTED_CURRENCIES = new Set(["usd", "eur", "gbp", "cad", "aud"]);

type ProductCreateInput = {
  product_type?: unknown;
  name?: unknown;
  description?: unknown;
  price_cents?: unknown;
  currency?: unknown;
  published?: unknown;
  custom_summary?: unknown;
  custom_receipt?: unknown;
  tags?: unknown;
};

const PRODUCT_TYPE_PRESETS: Record<ProductCreateDraft["productType"], { label: string; defaultTags: string[]; summaryHint: string }> = {
  digital_product: {
    label: "Digital Product",
    defaultTags: ["digital-product"],
    summaryHint: "Instant digital delivery.",
  },
  ebook: {
    label: "Ebook",
    defaultTags: ["ebook", "digital-reading"],
    summaryHint: "Downloadable ebook purchase.",
  },
  bundle: {
    label: "Bundle",
    defaultTags: ["bundle", "multi-product"],
    summaryHint: "Bundle access with multiple assets.",
  },
  membership: {
    label: "Membership",
    defaultTags: ["membership", "subscription"],
    summaryHint: "Recurring membership access.",
  },
  course: {
    label: "Course",
    defaultTags: ["course", "learning"],
    summaryHint: "Course access and learning materials.",
  },
};

export function previewProductCreate(ctx: AppContext, input: ProductCreateInput) {
  const normalized = validateAndNormalizeInput(input);
  const apiPayload = buildApiPayload(normalized);
  const createdAt = isoNow();

  const confirmation: ProductCreateConfirmation = {
    confirmationId: randomId("confirm_prod_create"),
    actionType: "product_create",
    payloadHash: hashPayload(apiPayload),
    expiresAt: new Date(Date.now() + config.productCreateConfirmationTtlMs).toISOString(),
    status: "pending",
    createdAt,
    updatedAt: createdAt,
    requiresPhrase: Boolean(config.productCreateConfirmationPhrase),
    input: normalized,
    apiPayload,
    preview: createPreview(normalized, apiPayload),
  };

  ctx.store.recordProductCreateConfirmation(confirmation);
  return { confirmation, preview: confirmation.preview };
}

export async function confirmProductCreate(
  ctx: AppContext,
  args: { confirmation_id?: unknown; confirmation_phrase?: unknown },
) {
  const confirmationId = typeof args.confirmation_id === "string" ? args.confirmation_id.trim() : "";
  if (!confirmationId) throw new Error("confirmation_id is required.");

  const confirmation = ctx.store.getProductCreateConfirmation(confirmationId);
  if (!confirmation) throw new Error("confirmation_id not found.");

  if (new Date(confirmation.expiresAt).getTime() <= Date.now()) {
    ctx.store.updateProductCreateConfirmation(confirmationId, (current) => ({
      ...current,
      status: "expired",
      updatedAt: isoNow(),
      error: "Confirmation expired.",
    }));
    throw new Error("Confirmation expired. Create a new preview.");
  }

  if (confirmation.status === "executing" || confirmation.status === "completed") {
    throw new Error("This confirmation has already been used and cannot be executed again.");
  }

  if (confirmation.requiresPhrase) {
    const phrase = typeof args.confirmation_phrase === "string" ? args.confirmation_phrase : "";
    if (!phrase || phrase !== config.productCreateConfirmationPhrase) {
      throw new Error("Invalid confirmation_phrase.");
    }
  }

  ctx.store.updateProductCreateConfirmation(confirmationId, (current) => ({
    ...current,
    status: "executing",
    updatedAt: isoNow(),
    error: undefined,
  }));

  ctx.store.recordWriteAction({
    id: randomId("write"),
    actionType: "product_create",
    status: "attempted",
    at: isoNow(),
    confirmationId,
    details: {
      payloadHash: confirmation.payloadHash,
      name: confirmation.input.name,
      priceCents: confirmation.input.priceCents,
      currency: confirmation.input.currency,
    },
  });

  try {
    const result = await ctx.client.createProduct(confirmation.apiPayload);
    const executedAt = isoNow();

    ctx.store.updateProductCreateConfirmation(confirmationId, (current) => ({
      ...current,
      status: "completed",
      updatedAt: executedAt,
      result: {
        executedAt,
        response: result,
        productId: typeof result?.product?.id === "string" ? result.product.id : undefined,
      },
      error: undefined,
    }));

    ctx.store.recordWriteAction({
      id: randomId("write"),
      actionType: "product_create",
      status: "completed",
      at: executedAt,
      confirmationId,
      details: {
        payloadHash: confirmation.payloadHash,
        productId: typeof result?.product?.id === "string" ? result.product.id : undefined,
      },
    });

    return {
      ok: true,
      confirmation_id: confirmationId,
      action_type: "product_create",
      status: "completed",
      product_id: typeof result?.product?.id === "string" ? result.product.id : null,
      summary: `Product creation completed for \"${confirmation.input.name}\".`,
      full_response: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.store.updateProductCreateConfirmation(confirmationId, (current) => ({
      ...current,
      status: "failed",
      updatedAt: isoNow(),
      error: message,
    }));
    ctx.store.recordWriteAction({
      id: randomId("write"),
      actionType: "product_create",
      status: "failed",
      at: isoNow(),
      confirmationId,
      details: { payloadHash: confirmation.payloadHash, error: message },
    });
    throw error;
  }
}

export async function refreshOfferCodes(ctx: AppContext, productId: string) {
  const offerCodes = await ctx.client.listOfferCodes(productId);
  ctx.store.setProductOfferCodes(productId, offerCodes);
  return offerCodes;
}

export async function refreshVariants(ctx: AppContext, productId: string) {
  const product = await ctx.client.getProduct(productId);
  const categories = normalizeVariantCategories(product?.raw?.variants ?? product?.raw?.variant_categories, productId);
  ctx.store.setProductVariants(productId, categories);
  return categories;
}

function validateAndNormalizeInput(input: ProductCreateInput): ProductCreateDraft {
  const productType = parseProductType(input.product_type);
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("name is required.");

  const priceCents = typeof input.price_cents === "number" ? input.price_cents : Number(input.price_cents);
  if (!Number.isInteger(priceCents) || priceCents <= 0) throw new Error("price_cents must be a positive integer.");

  const currency = typeof input.currency === "string" ? input.currency.trim().toLowerCase() : "usd";
  if (!SUPPORTED_CURRENCIES.has(currency)) {
    throw new Error(`currency must be one of: ${Array.from(SUPPORTED_CURRENCIES).join(", ")}.`);
  }

  return {
    productType,
    name,
    description: optionalString(input.description),
    priceCents,
    currency: currency.toUpperCase(),
    published: parseOptionalBoolean(input.published),
    customSummary: optionalString(input.custom_summary),
    customReceipt: optionalString(input.custom_receipt),
    tags: normalizeTags(input.tags),
  };
}

function parseProductType(value: unknown): ProductCreateDraft["productType"] {
  if (typeof value !== "string" || !value.trim()) return "digital_product";
  const normalized = value.trim().toLowerCase();
  const allowed: ProductCreateDraft["productType"][] = ["digital_product", "ebook", "bundle", "membership", "course"];
  if (!allowed.includes(normalized as ProductCreateDraft["productType"])) {
    throw new Error(`product_type must be one of: ${allowed.join(", ")}.`);
  }
  return normalized as ProductCreateDraft["productType"];
}

function buildApiPayload(input: ProductCreateDraft) {
  const preset = PRODUCT_TYPE_PRESETS[input.productType];
  const mergedTags = mergeTags(preset.defaultTags, input.tags);

  const payload: Record<string, string> = {
    name: input.name,
    price: String(input.priceCents),
    currency: input.currency.toLowerCase(),
  };

  if (input.description) payload.description = input.description;
  if (typeof input.published === "boolean") payload.published = String(input.published);
  if (input.customSummary ?? preset.summaryHint) payload.custom_summary = input.customSummary ?? preset.summaryHint;
  if (input.customReceipt) payload.custom_receipt = input.customReceipt;
  if (mergedTags.length) payload.tags = mergedTags.join(",");

  return payload;
}

function createPreview(input: ProductCreateDraft, payload: Record<string, string>) {
  const preset = PRODUCT_TYPE_PRESETS[input.productType];
  return [
    `Product type: ${preset.label} (${input.productType})`,
    `Product: ${input.name}`,
    `Price: ${input.priceCents} ${input.currency}`,
    `Publish immediately: ${input.published === undefined ? "not specified" : String(input.published)}`,
    `Description: ${input.description ?? "(none)"}`,
    `Tags: ${payload.tags ?? "(none)"}`,
    `API payload: ${JSON.stringify(payload)}`,
  ].join("\n");
}

function mergeTags(defaultTags: string[], userTags?: string[]) {
  const out = new Set<string>();
  for (const tag of defaultTags) out.add(tag.trim());
  for (const tag of userTags ?? []) out.add(tag.trim());
  return Array.from(out).filter(Boolean);
}

function normalizeTags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tags = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    return tags.length ? tags : undefined;
  }
  if (typeof value === "string") {
    const tags = value.split(",").map((item) => item.trim()).filter(Boolean);
    return tags.length ? tags : undefined;
  }
  return undefined;
}

function parseOptionalBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
    throw new Error("published must be true or false.");
  }
  if (value == null) return undefined;
  throw new Error("published must be a boolean.");
}

function optionalString(value: unknown) {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error("Expected string value.");
  const trimmed = value.trim();
  return trimmed || undefined;
}

function hashPayload(payload: Record<string, string>) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
