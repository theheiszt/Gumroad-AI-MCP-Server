import { createHash } from "node:crypto";
import { config } from "../config.js";
import type { AppContext } from "./app-context.js";
import { isoNow, randomId } from "../utils/format.js";
import type { WriteConfirmation } from "../types.js";

const SUPPORTED_CURRENCIES = new Set(["usd", "eur", "gbp", "cad", "aud"]);

export type WriteActionType =
  | "product_create"
  | "variant_category_create"
  | "variant_category_edit"
  | "variant_category_delete"
  | "variant_create"
  | "variant_edit"
  | "variant_delete"
  | "offer_code_create"
  | "offer_code_disable"
  | "offer_code_delete";

type WriteInput = Record<string, unknown>;

export function previewWriteOperation(ctx: AppContext, actionType: WriteActionType, input: WriteInput) {
  const spec = buildOperationSpec(actionType, input);
  const payloadHash = hashPayload(spec.apiPayload);
  const now = isoNow();
  const confirmation: WriteConfirmation = {
    confirmationId: randomId("confirm_write"),
    actionType,
    payloadHash,
    expiresAt: new Date(Date.now() + config.productCreateConfirmationTtlMs).toISOString(),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    requiresPhrase: Boolean(config.productCreateConfirmationPhrase),
    input: spec.normalizedInput,
    apiPayload: spec.apiPayload,
    preview: spec.preview,
  };

  ctx.store.recordWriteConfirmation(confirmation);

  return { confirmation, preview: confirmation.preview };
}

export async function confirmWriteOperation(
  ctx: AppContext,
  args: { confirmation_id?: unknown; confirmation_phrase?: unknown },
) {
  const confirmationId = typeof args.confirmation_id === "string" ? args.confirmation_id.trim() : "";
  if (!confirmationId) throw new Error("confirmation_id is required.");

  const confirmation = ctx.store.getWriteConfirmation(confirmationId);
  if (!confirmation) throw new Error("confirmation_id not found.");

  if (new Date(confirmation.expiresAt).getTime() <= Date.now()) {
    ctx.store.updateWriteConfirmation(confirmationId, (current) => ({
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
    ...current,
    status: "executing",
    updatedAt: isoNow(),
    error: undefined,
  }));

  ctx.store.recordWriteAction({
    id: randomId("write"),
    actionType: confirmation.actionType,
    status: "attempted",
    at: isoNow(),
    confirmationId,
    details: { payloadHash: confirmation.payloadHash, input: confirmation.input },
  });

  try {
    const result = await executeOperation(ctx, confirmation.actionType as WriteActionType, confirmation.input, confirmation.apiPayload);

    ctx.store.updateWriteConfirmation(confirmationId, (current) => ({
      ...current,
      status: "completed",
      updatedAt: isoNow(),
      result: {
        executedAt: isoNow(),
        response: result,
        resourceId: inferResourceId(result),
      },
      error: undefined,
    }));

    ctx.store.recordWriteAction({
      id: randomId("write"),
      actionType: confirmation.actionType,
      status: "completed",
      at: isoNow(),
      confirmationId,
      details: { payloadHash: confirmation.payloadHash, resourceId: inferResourceId(result) },
    });

    return {
      ok: true,
      confirmation_id: confirmationId,
      action_type: confirmation.actionType,
      status: "completed",
      summary: `${confirmation.actionType} completed.`,
      full_response: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.store.updateWriteConfirmation(confirmationId, (current) => ({
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
      details: { payloadHash: confirmation.payloadHash, error: message },
    });
    throw error;
  }
}

function buildOperationSpec(actionType: WriteActionType, input: WriteInput) {
  switch (actionType) {
    case "product_create":
      return buildProductCreateSpec(input);
    case "variant_category_create":
      return buildVariantCategoryCreateSpec(input);
    case "variant_category_edit":
      return buildVariantCategoryEditSpec(input);
    case "variant_category_delete":
      return buildVariantCategoryDeleteSpec(input);
    case "variant_create":
      return buildVariantCreateSpec(input);
    case "variant_edit":
      return buildVariantEditSpec(input);
    case "variant_delete":
      return buildVariantDeleteSpec(input);
    case "offer_code_create":
      return buildOfferCodeCreateSpec(input);
    case "offer_code_disable":
      return buildOfferCodeDisableSpec(input);
    case "offer_code_delete":
      return buildOfferCodeDeleteSpec(input);
    default:
      throw new Error(`Unsupported action type: ${actionType}`);
  }
}

async function executeOperation(ctx: AppContext, actionType: WriteActionType, input: WriteInput, payload: Record<string, string>) {
  switch (actionType) {
    case "product_create":
      return ctx.client.createProduct(payload);
    case "variant_category_create": {
      const productId = requiredString(input.product_id, "product_id");
      const result = await ctx.client.createVariantCategory(productId, payload);
      await refreshVariants(ctx, productId);
      return result;
    }
    case "variant_category_edit": {
      const productId = requiredString(input.product_id, "product_id");
      const variantCategoryId = requiredString(input.variant_category_id, "variant_category_id");
      const result = await ctx.client.editVariantCategory(productId, variantCategoryId, payload);
      await refreshVariants(ctx, productId);
      return result;
    }
    case "variant_category_delete": {
      const productId = requiredString(input.product_id, "product_id");
      const variantCategoryId = requiredString(input.variant_category_id, "variant_category_id");
      const result = await ctx.client.deleteVariantCategory(productId, variantCategoryId);
      await refreshVariants(ctx, productId);
      return result;
    }
    case "variant_create": {
      const productId = requiredString(input.product_id, "product_id");
      const variantCategoryId = requiredString(input.variant_category_id, "variant_category_id");
      const result = await ctx.client.createVariant(productId, variantCategoryId, payload);
      await refreshVariants(ctx, productId, variantCategoryId);
      return result;
    }
    case "variant_edit": {
      const productId = requiredString(input.product_id, "product_id");
      const variantCategoryId = requiredString(input.variant_category_id, "variant_category_id");
      const variantId = requiredString(input.variant_id, "variant_id");
      const result = await ctx.client.editVariant(productId, variantCategoryId, variantId, payload);
      await refreshVariants(ctx, productId, variantCategoryId);
      return result;
    }
    case "variant_delete": {
      const productId = requiredString(input.product_id, "product_id");
      const variantCategoryId = requiredString(input.variant_category_id, "variant_category_id");
      const variantId = requiredString(input.variant_id, "variant_id");
      const result = await ctx.client.deleteVariant(productId, variantCategoryId, variantId);
      await refreshVariants(ctx, productId, variantCategoryId);
      return result;
    }
    case "offer_code_create": {
      const productId = requiredString(input.product_id, "product_id");
      const result = await ctx.client.createOfferCode(productId, payload);
      await refreshOfferCodes(ctx, productId);
      return result;
    }
    case "offer_code_disable": {
      const productId = requiredString(input.product_id, "product_id");
      const offerCodeId = requiredString(input.offer_code_id, "offer_code_id");
      return ctx.client.disableOfferCode(productId, offerCodeId);
    }
    case "offer_code_delete": {
      const productId = requiredString(input.product_id, "product_id");
      const offerCodeId = requiredString(input.offer_code_id, "offer_code_id");
      return ctx.client.deleteOfferCode(productId, offerCodeId);
    }
    default:
      throw new Error(`Unsupported action type: ${actionType}`);
  }
}

async function refreshVariants(ctx: AppContext, productId: string, variantCategoryId?: string) {
  const categories = await ctx.client.listVariantCategories(productId);
  ctx.store.attachVariantCategories(productId, categories);

  const variantsByCategory = await Promise.all(
    categories.map(async (category) => ctx.client.listVariants(productId, category.id).catch(() => [])),
  );
  const variants = variantsByCategory.flat();

  if (variantCategoryId && variants.length === 0) {
    const rows = await ctx.client.listVariants(productId, variantCategoryId).catch(() => []);
    ctx.store.attachVariants(productId, rows);
    return;
  }

  ctx.store.attachVariants(productId, variants);
}

async function refreshOfferCodes(ctx: AppContext, productId: string) {
  const offerCodes = await ctx.client.listOfferCodes(productId);
  ctx.store.attachOfferCodes(productId, offerCodes);
}

function inferResourceId(result: Record<string, any>) {
  for (const key of ["product", "variant_category", "variant", "offer_code"]) {
    const row = result?.[key];
    if (row && typeof row === "object" && typeof row.id === "string") return row.id;
  }
  return undefined;
}

function requiredString(value: unknown, key: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required.`);
  }
  return value.trim();
}

function parseOptionalInt(value: unknown, key: string) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${key} must be an integer.`);
  return parsed;
}

function buildProductCreateSpec(input: WriteInput) {
  const name = requiredString(input.name, "name");
  const priceCents = parseOptionalInt(input.price_cents, "price_cents");
  if (!priceCents || priceCents <= 0) throw new Error("price_cents must be a positive integer.");
  const currencyRaw = typeof input.currency === "string" ? input.currency.trim().toLowerCase() : "usd";
  if (!SUPPORTED_CURRENCIES.has(currencyRaw)) throw new Error(`currency must be one of: ${Array.from(SUPPORTED_CURRENCIES).join(", ")}.`);

  const payload: Record<string, string> = {
    name,
    price: String(priceCents),
    currency: currencyRaw,
  };

  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (description) payload.description = description;
  if (typeof input.published === "boolean" || typeof input.published === "string") payload.published = String(input.published);
  if (typeof input.custom_summary === "string" && input.custom_summary.trim()) payload.custom_summary = input.custom_summary.trim();
  if (typeof input.custom_receipt === "string" && input.custom_receipt.trim()) payload.custom_receipt = input.custom_receipt.trim();
  if (Array.isArray(input.tags) && input.tags.length > 0) payload.tags = input.tags.map((tag) => String(tag).trim()).filter(Boolean).join(",");

  return {
    normalizedInput: { ...input, name, price_cents: priceCents, currency: currencyRaw.toUpperCase() },
    apiPayload: payload,
    preview: `Create product \"${name}\" with payload ${JSON.stringify(payload)}`,
  };
}

function buildVariantCategoryCreateSpec(input: WriteInput) {
  const productId = requiredString(input.product_id, "product_id");
  const title = requiredString(input.title, "title");
  return {
    normalizedInput: { product_id: productId, title },
    apiPayload: { title },
    preview: `Create variant category \"${title}\" for product ${productId}.`,
  };
}

function buildVariantCategoryEditSpec(input: WriteInput) {
  const productId = requiredString(input.product_id, "product_id");
  const variantCategoryId = requiredString(input.variant_category_id, "variant_category_id");
  const title = requiredString(input.title, "title");
  return {
    normalizedInput: { product_id: productId, variant_category_id: variantCategoryId, title },
    apiPayload: { title },
    preview: `Edit variant category ${variantCategoryId} for product ${productId}.`,
  };
}

function buildVariantCategoryDeleteSpec(input: WriteInput) {
  const productId = requiredString(input.product_id, "product_id");
  const variantCategoryId = requiredString(input.variant_category_id, "variant_category_id");
  return {
    normalizedInput: { product_id: productId, variant_category_id: variantCategoryId },
    apiPayload: {},
    preview: `Delete variant category ${variantCategoryId} from product ${productId}.`,
  };
}

function buildVariantCreateSpec(input: WriteInput) {
  const productId = requiredString(input.product_id, "product_id");
  const variantCategoryId = requiredString(input.variant_category_id, "variant_category_id");
  const name = requiredString(input.name, "name");
  const priceDiff = parseOptionalInt(input.price_difference_cents, "price_difference_cents");
  const maxPurchaseCount = parseOptionalInt(input.max_purchase_count, "max_purchase_count");
  const payload: Record<string, string> = { name };
  if (priceDiff !== undefined) payload.price_difference_cents = String(priceDiff);
  if (maxPurchaseCount !== undefined) payload.max_purchase_count = String(maxPurchaseCount);
  return {
    normalizedInput: { product_id: productId, variant_category_id: variantCategoryId, name, price_difference_cents: priceDiff, max_purchase_count: maxPurchaseCount },
    apiPayload: payload,
    preview: `Create variant \"${name}\" in category ${variantCategoryId} for product ${productId}.`,
  };
}

function buildVariantEditSpec(input: WriteInput) {
  const productId = requiredString(input.product_id, "product_id");
  const variantCategoryId = requiredString(input.variant_category_id, "variant_category_id");
  const variantId = requiredString(input.variant_id, "variant_id");
  const payload: Record<string, string> = {};
  if (typeof input.name === "string" && input.name.trim()) payload.name = input.name.trim();
  const priceDiff = parseOptionalInt(input.price_difference_cents, "price_difference_cents");
  const maxPurchaseCount = parseOptionalInt(input.max_purchase_count, "max_purchase_count");
  if (priceDiff !== undefined) payload.price_difference_cents = String(priceDiff);
  if (maxPurchaseCount !== undefined) payload.max_purchase_count = String(maxPurchaseCount);
  if (Object.keys(payload).length === 0) throw new Error("At least one editable field must be provided for variant_edit.");
  return {
    normalizedInput: { product_id: productId, variant_category_id: variantCategoryId, variant_id: variantId, ...payload },
    apiPayload: payload,
    preview: `Edit variant ${variantId} in category ${variantCategoryId} for product ${productId}.`,
  };
}

function buildVariantDeleteSpec(input: WriteInput) {
  const productId = requiredString(input.product_id, "product_id");
  const variantCategoryId = requiredString(input.variant_category_id, "variant_category_id");
  const variantId = requiredString(input.variant_id, "variant_id");
  return {
    normalizedInput: { product_id: productId, variant_category_id: variantCategoryId, variant_id: variantId },
    apiPayload: {},
    preview: `Delete variant ${variantId} in category ${variantCategoryId} for product ${productId}.`,
  };
}

function buildOfferCodeCreateSpec(input: WriteInput) {
  const productId = requiredString(input.product_id, "product_id");
  const name = requiredString(input.name, "name");
  const payload: Record<string, string> = { name };
  const amountCents = parseOptionalInt(input.amount_cents, "amount_cents");
  const percentOff = parseOptionalInt(input.percent_off, "percent_off");
  if (amountCents === undefined && percentOff === undefined) {
    throw new Error("Either amount_cents or percent_off is required for offer_code_create.");
  }
  if (amountCents !== undefined) payload.amount_cents = String(amountCents);
  if (percentOff !== undefined) payload.percent_off = String(percentOff);
  const maxPurchaseCount = parseOptionalInt(input.max_purchase_count, "max_purchase_count");
  if (maxPurchaseCount !== undefined) payload.max_purchase_count = String(maxPurchaseCount);
  if (typeof input.universal === "boolean" || typeof input.universal === "string") payload.universal = String(input.universal);

  return {
    normalizedInput: { product_id: productId, ...payload },
    apiPayload: payload,
    preview: `Create offer code \"${name}\" for product ${productId}.`,
  };
}

function buildOfferCodeDisableSpec(input: WriteInput) {
  const productId = requiredString(input.product_id, "product_id");
  const offerCodeId = requiredString(input.offer_code_id, "offer_code_id");
  return {
    normalizedInput: { product_id: productId, offer_code_id: offerCodeId },
    apiPayload: {},
    preview: `Disable offer code ${offerCodeId} for product ${productId}.`,
  };
}

function buildOfferCodeDeleteSpec(input: WriteInput) {
  const productId = requiredString(input.product_id, "product_id");
  const offerCodeId = requiredString(input.offer_code_id, "offer_code_id");
  return {
    normalizedInput: { product_id: productId, offer_code_id: offerCodeId },
    apiPayload: {},
    preview: `Delete offer code ${offerCodeId} for product ${productId}.`,
  };
}

function hashPayload(payload: Record<string, string>) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
