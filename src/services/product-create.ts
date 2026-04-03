import { createHash } from "node:crypto";
import { config } from "../config.js";
import { normalizeOfferCodes, normalizeVariantCategories } from "../gumroad/normalize.js";
import type { AppContext } from "./app-context.js";
import type { WriteActionType, WriteConfirmationRecord } from "../types.js";
import { isoNow, randomId } from "../utils/format.js";

type PreviewArgs = {
  actionType: WriteActionType;
  input: Record<string, unknown>;
  productId?: string;
  apiPayload: Record<string, string>;
  preview: string;
};

type ConfirmArgs = {
  confirmation_id?: unknown;
  confirmation_phrase?: unknown;
};

const SUPPORTED_CURRENCIES = new Set(["usd", "eur", "gbp", "cad", "aud"]);

export function previewWrite(ctx: AppContext, args: PreviewArgs) {
  const createdAt = isoNow();
  const confirmationId = randomId("confirm_write");
  const confirmation: WriteConfirmationRecord = {
    confirmationId,
    actionType: args.actionType,
    payloadHash: hashPayload(args.apiPayload),
    expiresAt: new Date(Date.now() + config.productCreateConfirmationTtlMs).toISOString(),
import type { AppContext } from "./app-context.js";
import type { ProductCreateConfirmation, ProductCreateDraft } from "../types.js";
import { isoNow, randomId } from "../utils/format.js";

const SUPPORTED_CURRENCIES = new Set(["usd", "eur", "gbp", "cad", "aud"]);

type ProductCreateInput = {
  name?: unknown;
  description?: unknown;
  price_cents?: unknown;
  currency?: unknown;
  published?: unknown;
  custom_summary?: unknown;
  custom_receipt?: unknown;
  tags?: unknown;
};

export function previewProductCreate(ctx: AppContext, input: ProductCreateInput) {
  const normalized = validateAndNormalizeInput(input);
  const apiPayload = buildApiPayload(normalized);
  const payloadHash = hashPayload(apiPayload);
  const createdAt = isoNow();
  const expiresAt = new Date(Date.now() + config.productCreateConfirmationTtlMs).toISOString();
  const confirmationId = randomId("confirm_prod_create");

  const confirmation: ProductCreateConfirmation = {
    confirmationId,
    actionType: "product_create",
    payloadHash,
    expiresAt,
    status: "pending",
    createdAt,
    updatedAt: createdAt,
    requiresPhrase: Boolean(config.productCreateConfirmationPhrase),
    input: args.input,
    apiPayload: args.apiPayload,
    preview: args.preview,
    productId: args.productId,
  };
  ctx.store.recordWriteConfirmation(confirmation);
  return confirmation;
}

export async function confirmWrite(ctx: AppContext, args: ConfirmArgs) {
  const confirmationId = typeof args.confirmation_id === "string" ? args.confirmation_id.trim() : "";
  if (!confirmationId) throw new Error("confirmation_id is required.");

  const confirmation = ctx.store.getWriteConfirmation(confirmationId);
  if (!confirmation) throw new Error("confirmation_id not found.");

  if (new Date(confirmation.expiresAt).getTime() <= Date.now()) {
    ctx.store.updateWriteConfirmation(confirmationId, (current) => ({
    input: normalized,
    apiPayload,
    preview: createPreview(normalized, apiPayload),
  };

  ctx.store.recordProductCreateConfirmation(confirmation);

  return {
    confirmation,
    preview: confirmation.preview,
  };
}

export async function confirmProductCreate(
  ctx: AppContext,
  args: { confirmation_id?: unknown; confirmation_phrase?: unknown },
) {
  const confirmationId = typeof args.confirmation_id === "string" ? args.confirmation_id.trim() : "";
  if (!confirmationId) {
    throw new Error("confirmation_id is required.");
  }

  const confirmation = ctx.store.getProductCreateConfirmation(confirmationId);
  if (!confirmation) {
    throw new Error("confirmation_id not found.");
  }

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

  ctx.store.updateWriteConfirmation(confirmationId, (current) => ({
  ctx.store.updateProductCreateConfirmation(confirmationId, (current) => ({
    ...current,
    status: "executing",
    updatedAt: isoNow(),
    error: undefined,
  }));

  ctx.store.recordWriteAction({
    id: randomId("write"),
    actionType: confirmation.actionType,
    actionType: "product_create",
    status: "attempted",
    at: isoNow(),
    confirmationId,
    details: {
      productId: confirmation.productId,
      payloadHash: confirmation.payloadHash,
      payloadHash: confirmation.payloadHash,
      name: confirmation.input.name,
      priceCents: confirmation.input.priceCents,
      currency: confirmation.input.currency,
    },
  });

  try {
    const response = await executeConfirmedAction(ctx, confirmation);
    const executedAt = isoNow();
    ctx.store.updateWriteConfirmation(confirmationId, (current) => ({
      ...current,
      status: "completed",
      updatedAt: executedAt,
      result: { executedAt, response },
    const result = await ctx.client.createProduct(confirmation.apiPayload);

    ctx.store.updateProductCreateConfirmation(confirmationId, (current) => ({
      ...current,
      status: "completed",
      updatedAt: isoNow(),
      result: {
        executedAt: isoNow(),
        response: result,
        productId: typeof result?.product?.id === "string" ? result.product.id : undefined,
      },
      error: undefined,
    }));

    ctx.store.recordWriteAction({
      id: randomId("write"),
      actionType: confirmation.actionType,
      status: "completed",
      at: executedAt,
      confirmationId,
      details: {
        productId: confirmation.productId,
        payloadHash: confirmation.payloadHash,
      actionType: "product_create",
      status: "completed",
      at: isoNow(),
      confirmationId,
      details: {
        payloadHash: confirmation.payloadHash,
        productId: typeof result?.product?.id === "string" ? result.product.id : undefined,
      },
    });

    return {
      ok: true,
      action_type: confirmation.actionType,
      confirmation_id: confirmationId,
      status: "completed",
      summary: `${confirmation.actionType} completed successfully.`,
      full_response: response,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.store.updateWriteConfirmation(confirmationId, (current) => ({
      confirmation_id: confirmationId,
      action_type: confirmation.actionType,
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
      actionType: confirmation.actionType,
      status: "failed",
      at: isoNow(),
      confirmationId,
      details: { error: message, productId: confirmation.productId },
      actionType: "product_create",
      status: "failed",
      at: isoNow(),
      confirmationId,
      details: {
        payloadHash: confirmation.payloadHash,
        error: message,
      },
    });
    throw error;
  }
}

async function executeConfirmedAction(ctx: AppContext, confirmation: WriteConfirmationRecord) {
  const p = confirmation.apiPayload;
  switch (confirmation.actionType) {
    case "product_create":
      return ctx.client.createProduct(p);
    case "variant_category_create": {
      requireField(p, "product_id");
      const response = await ctx.client.createVariantCategory(p.product_id, p);
      await syncVariantsFromResponse(ctx, p.product_id, response);
      return response;
    }
    case "variant_category_edit": {
      requireField(p, "product_id");
      requireField(p, "variant_category_id");
      const response = await ctx.client.editVariantCategory(p.product_id, p.variant_category_id, p);
      await syncVariantsFromResponse(ctx, p.product_id, response);
      return response;
    }
    case "variant_category_delete": {
      requireField(p, "product_id");
      requireField(p, "variant_category_id");
      const response = await ctx.client.deleteVariantCategory(p.product_id, p.variant_category_id);
      await syncVariantsLive(ctx, p.product_id);
      return response;
    }
    case "variant_create": {
      requireField(p, "product_id");
      requireField(p, "variant_category_id");
      const response = await ctx.client.createVariant(p.product_id, p.variant_category_id, p);
      await syncVariantsFromResponse(ctx, p.product_id, response);
      return response;
    }
    case "variant_edit": {
      requireField(p, "product_id");
      requireField(p, "variant_category_id");
      requireField(p, "variant_id");
      const response = await ctx.client.editVariant(p.product_id, p.variant_category_id, p.variant_id, p);
      await syncVariantsFromResponse(ctx, p.product_id, response);
      return response;
    }
    case "variant_delete": {
      requireField(p, "product_id");
      requireField(p, "variant_category_id");
      requireField(p, "variant_id");
      const response = await ctx.client.deleteVariant(p.product_id, p.variant_category_id, p.variant_id);
      await syncVariantsLive(ctx, p.product_id);
      return response;
    }
    case "offer_code_create": {
      requireField(p, "product_id");
      const response = await ctx.client.createOfferCode(p.product_id, p);
      await syncOfferCodes(ctx, p.product_id);
      return response;
    }
    case "offer_code_delete": {
      requireField(p, "product_id");
      requireField(p, "offer_code_id");
      const response = await ctx.client.deleteOfferCode(p.product_id, p.offer_code_id);
      await syncOfferCodes(ctx, p.product_id);
      return response;
    }
    case "offer_code_disable":
      throw new Error("Unsupported operation: disabling offer codes is not supported by configured endpoint set.");
    default:
      throw new Error(`Unsupported action type: ${confirmation.actionType}`);
  }
}

export function previewProductCreate(input: Record<string, unknown>, ctx: AppContext) {
  const normalized = normalizeProductCreateInput(input);
  return previewWrite(ctx, {
    actionType: "product_create",
    productId: undefined,
    input: normalized,
    apiPayload: buildProductPayload(normalized),
    preview: [
      `Create product: ${normalized.name}`,
      `Price: ${normalized.price_cents} ${normalized.currency}`,
      `Published: ${String(normalized.published ?? "unspecified")}`,
      `Tags: ${normalized.tags?.join(", ") ?? "(none)"}`,
    ].join("\n"),
  });
}

export function previewVariantCategoryCreate(input: Record<string, unknown>, ctx: AppContext) {
  const productId = requiredString(input.product_id, "product_id");
  const title = requiredString(input.title, "title");
  const payload = { product_id: productId, title };
  return previewWrite(ctx, {
    actionType: "variant_category_create",
    productId,
    input: { product_id: productId, title },
    apiPayload: payload,
    preview: `Create variant category \"${title}\" for product ${productId}.`,
  });
}

export function previewVariantCategoryEdit(input: Record<string, unknown>, ctx: AppContext) {
  const productId = requiredString(input.product_id, "product_id");
  const categoryId = requiredString(input.variant_category_id, "variant_category_id");
  const title = requiredString(input.title, "title");
  const payload = { product_id: productId, variant_category_id: categoryId, title };
  return previewWrite(ctx, {
    actionType: "variant_category_edit",
    productId,
    input: payload,
    apiPayload: payload,
    preview: `Edit variant category ${categoryId} title to \"${title}\" for product ${productId}.`,
  });
}

export function previewVariantCategoryDelete(input: Record<string, unknown>, ctx: AppContext) {
  const productId = requiredString(input.product_id, "product_id");
  const categoryId = requiredString(input.variant_category_id, "variant_category_id");
  const payload = { product_id: productId, variant_category_id: categoryId };
  return previewWrite(ctx, {
    actionType: "variant_category_delete",
    productId,
    input: payload,
    apiPayload: payload,
    preview: `Delete variant category ${categoryId} from product ${productId}.`,
  });
}

export function previewVariantCreate(input: Record<string, unknown>, ctx: AppContext) {
  const productId = requiredString(input.product_id, "product_id");
  const categoryId = requiredString(input.variant_category_id, "variant_category_id");
  const name = requiredString(input.name, "name");
  const payload: Record<string, string> = { product_id: productId, variant_category_id: categoryId, name };
  if (input.price_difference_cents != null) payload.price_difference_cents = integerString(input.price_difference_cents, "price_difference_cents");
  if (input.quantity_left != null) payload.quantity_left = integerString(input.quantity_left, "quantity_left");

  return previewWrite(ctx, {
    actionType: "variant_create",
    productId,
    input: { ...payload },
    apiPayload: payload,
    preview: `Create variant \"${name}\" in category ${categoryId} for product ${productId}.`,
  });
}

export function previewVariantEdit(input: Record<string, unknown>, ctx: AppContext) {
  const productId = requiredString(input.product_id, "product_id");
  const categoryId = requiredString(input.variant_category_id, "variant_category_id");
  const variantId = requiredString(input.variant_id, "variant_id");
  const payload: Record<string, string> = { product_id: productId, variant_category_id: categoryId, variant_id: variantId };
  if (input.name != null) payload.name = requiredString(input.name, "name");
  if (input.price_difference_cents != null) payload.price_difference_cents = integerString(input.price_difference_cents, "price_difference_cents");
  if (input.quantity_left != null) payload.quantity_left = integerString(input.quantity_left, "quantity_left");
  if (Object.keys(payload).length <= 3) throw new Error("At least one editable field (name, price_difference_cents, quantity_left) is required.");

  return previewWrite(ctx, {
    actionType: "variant_edit",
    productId,
    input: payload,
    apiPayload: payload,
    preview: `Edit variant ${variantId} for product ${productId}.`,
  });
}

export function previewVariantDelete(input: Record<string, unknown>, ctx: AppContext) {
  const productId = requiredString(input.product_id, "product_id");
  const categoryId = requiredString(input.variant_category_id, "variant_category_id");
  const variantId = requiredString(input.variant_id, "variant_id");
  const payload = { product_id: productId, variant_category_id: categoryId, variant_id: variantId };
  return previewWrite(ctx, {
    actionType: "variant_delete",
    productId,
    input: payload,
    apiPayload: payload,
    preview: `Delete variant ${variantId} in category ${categoryId} for product ${productId}.`,
  });
}

export function previewOfferCodeCreate(input: Record<string, unknown>, ctx: AppContext) {
  const productId = requiredString(input.product_id, "product_id");
  const name = requiredString(input.name, "name");
  const code = requiredString(input.code, "code");
  const payload: Record<string, string> = { product_id: productId, name, code };
  if (input.amount_off_cents != null) payload.amount_off_cents = integerString(input.amount_off_cents, "amount_off_cents");
  if (input.percent_off != null) payload.percent_off = integerString(input.percent_off, "percent_off");
  if (input.max_uses != null) payload.max_uses = integerString(input.max_uses, "max_uses");

  return previewWrite(ctx, {
    actionType: "offer_code_create",
    productId,
    input: payload,
    apiPayload: payload,
    preview: `Create offer code ${code} for product ${productId}.`,
  });
}

export function previewOfferCodeDelete(input: Record<string, unknown>, ctx: AppContext) {
  const productId = requiredString(input.product_id, "product_id");
  const offerCodeId = requiredString(input.offer_code_id, "offer_code_id");
  const payload = { product_id: productId, offer_code_id: offerCodeId };
  return previewWrite(ctx, {
    actionType: "offer_code_delete",
    productId,
    input: payload,
    apiPayload: payload,
    preview: `Delete offer code ${offerCodeId} from product ${productId}.`,
  });
}

export function previewOfferCodeDisable(input: Record<string, unknown>, ctx: AppContext) {
  const productId = requiredString(input.product_id, "product_id");
  const offerCodeId = requiredString(input.offer_code_id, "offer_code_id");
  const payload = { product_id: productId, offer_code_id: offerCodeId };
  return previewWrite(ctx, {
    actionType: "offer_code_disable",
    productId,
    input: payload,
    apiPayload: payload,
    preview: `Disable offer code ${offerCodeId} from product ${productId}.`,
  });
}

export async function refreshOfferCodes(ctx: AppContext, productId: string) {
  const response = await ctx.client.listOfferCodes(productId);
  const offers = normalizeOfferCodes(response.offer_codes, productId);
  ctx.store.setProductOfferCodes(productId, offers);
  return offers;
}

export async function refreshVariants(ctx: AppContext, productId: string) {
  const product = await ctx.client.getProduct(productId);
  const variants = normalizeVariantCategories(product?.raw?.variants ?? product?.raw?.variant_categories, productId);
  ctx.store.setProductVariants(productId, variants);
  return variants;
}

function normalizeProductCreateInput(input: Record<string, unknown>) {
  const name = requiredString(input.name, "name");
  const priceCents = integerString(input.price_cents, "price_cents");
  if (Number(priceCents) <= 0) throw new Error("price_cents must be a positive integer.");
  const currency = optionalString(input.currency)?.toLowerCase() ?? "usd";
function validateAndNormalizeInput(input: ProductCreateInput): ProductCreateDraft {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("name is required.");

  const priceCentsNumber = typeof input.price_cents === "number" ? input.price_cents : Number(input.price_cents);
  if (!Number.isInteger(priceCentsNumber) || priceCentsNumber <= 0) {
    throw new Error("price_cents must be a positive integer.");
  }

  const currency = typeof input.currency === "string" ? input.currency.trim().toLowerCase() : "usd";
  if (!SUPPORTED_CURRENCIES.has(currency)) {
    throw new Error(`currency must be one of: ${Array.from(SUPPORTED_CURRENCIES).join(", ")}.`);
  }

  const published = parseOptionalBoolean(input.published);
  const description = typeof input.description === "string" ? input.description.trim() : undefined;
  const customSummary = typeof input.custom_summary === "string" ? input.custom_summary.trim() : undefined;
  const customReceipt = typeof input.custom_receipt === "string" ? input.custom_receipt.trim() : undefined;

  const published =
    typeof input.published === "boolean"
      ? input.published
      : typeof input.published === "string"
        ? input.published.toLowerCase() === "true"
        : undefined;

  const tags = normalizeTags(input.tags);

  return {
    name,
    description: optionalString(input.description),
    price_cents: Number(priceCents),
    currency: currency.toUpperCase(),
    published,
    custom_summary: optionalString(input.custom_summary),
    custom_receipt: optionalString(input.custom_receipt),
    description,
    priceCents: priceCentsNumber,
    currency: currency.toUpperCase(),
    published,
    customSummary,
    customReceipt,
    tags,
  };
}

function buildProductPayload(input: ReturnType<typeof normalizeProductCreateInput>) {
  const payload: Record<string, string> = {
    name: input.name,
    price: String(input.price_cents),
    currency: input.currency.toLowerCase(),
  };
  if (input.description) payload.description = input.description;
  if (typeof input.published === "boolean") payload.published = String(input.published);
  if (input.custom_summary) payload.custom_summary = input.custom_summary;
  if (input.custom_receipt) payload.custom_receipt = input.custom_receipt;
  if (input.tags?.length) payload.tags = input.tags.join(",");
  return payload;
}

async function syncVariantsFromResponse(ctx: AppContext, productId: string, response: Record<string, unknown>) {
  const source = (response.product as Record<string, unknown> | undefined) ?? response;
  const categories = normalizeVariantCategories((source as any).variants ?? (source as any).variant_categories, productId);
  if (categories.length) {
    ctx.store.setProductVariants(productId, categories);
    return;
  }
  await syncVariantsLive(ctx, productId);
}

async function syncVariantsLive(ctx: AppContext, productId: string) {
  const product = await ctx.client.getProduct(productId);
  const categories = normalizeVariantCategories(product?.raw?.variants ?? product?.raw?.variant_categories, productId);
  ctx.store.setProductVariants(productId, categories);
}

async function syncOfferCodes(ctx: AppContext, productId: string) {
  const response = await ctx.client.listOfferCodes(productId);
  const offers = normalizeOfferCodes(response.offer_codes, productId);
  ctx.store.setProductOfferCodes(productId, offers);
}

function normalizeTags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tags = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return tags.length ? tags : undefined;
  }
function normalizeTags(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const tags = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    return tags.length ? tags : undefined;
  }

  if (typeof value === "string") {
    const tags = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
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

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function optionalString(value: unknown) {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error("Expected string value.");
  const trimmed = value.trim();
  return trimmed || undefined;
}

function integerString(value: unknown, field: string) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) throw new Error(`${field} must be an integer.`);
  return String(n);
}

function requireField(payload: Record<string, string>, key: string) {
  if (!payload[key]) throw new Error(`Missing required payload field ${key}.`);

  return undefined;
}

function buildApiPayload(input: ProductCreateDraft) {
  const payload: Record<string, string> = {
    name: input.name,
    price: String(input.priceCents),
    currency: input.currency.toLowerCase(),
  };

  if (input.description) payload.description = input.description;
  if (typeof input.published === "boolean") payload.published = String(input.published);
  if (input.customSummary) payload.custom_summary = input.customSummary;
  if (input.customReceipt) payload.custom_receipt = input.customReceipt;
  if (input.tags?.length) payload.tags = input.tags.join(",");

  return payload;
}

function createPreview(input: ProductCreateDraft, payload: Record<string, string>) {
  const lines = [
    `Product: ${input.name}`,
    `Price: ${input.priceCents} ${input.currency}`,
    `Publish immediately: ${input.published === undefined ? "not specified" : String(input.published)}`,
    `Description: ${input.description ?? "(none)"}`,
    `Tags: ${input.tags?.join(", ") ?? "(none)"}`,
    `API payload: ${JSON.stringify(payload)}`,
  ];
  return lines.join("\n");
}

function hashPayload(payload: Record<string, string>) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
