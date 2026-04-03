import { assertConfiguredAccessToken } from "../config.js";
import { normalizeOfferCode, normalizeVariant, normalizeVariantCategory } from "../gumroad/normalize.js";
import type { WriteActionType } from "../types.js";
import type { AppContext } from "./app-context.js";
import { confirmWriteOperation, previewWriteOperation } from "./write-confirmation.js";

type CatalogActionInput = Record<string, unknown> & { action_type?: unknown };

export function previewCatalogAction(ctx: AppContext, input: CatalogActionInput) {
  const actionType = requireActionType(input.action_type);
  const plan = buildActionPlan(actionType, input);
  const record = previewWriteOperation({
    ctx,
    actionType,
    input: plan.input,
    apiRequest: plan.apiRequest,
    preview: plan.preview,
  });

  return {
    ok: true,
    action_type: actionType,
    confirmation_id: record.confirmationId,
    payload_hash: record.payloadHash,
    expires_at: record.expiresAt,
    status: record.status,
    requires_confirmation_phrase: record.requiresPhrase,
    preview: record.preview,
    api_request: record.apiRequest,
  };
}

export async function confirmCatalogAction(
  ctx: AppContext,
  input: { confirmation_id?: unknown; confirmation_phrase?: unknown },
) {
  assertConfiguredAccessToken();
  const confirmationId = typeof input.confirmation_id === "string" ? input.confirmation_id.trim() : "";
  if (!confirmationId) throw new Error("confirmation_id is required.");

  const response = await confirmWriteOperation({
    ctx,
    confirmationId,
    confirmationPhrase: typeof input.confirmation_phrase === "string" ? input.confirmation_phrase : undefined,
    execute: async (record) => executeAction(ctx, record.actionType, record.input),
  });

  return {
    ok: true,
    confirmation_id: confirmationId,
    status: "completed",
    full_response: response,
  };
}

export async function readProductVariants(ctx: AppContext, productId: string) {
  assertConfiguredAccessToken();
  const [categories, variants] = await Promise.all([ctx.client.listVariantCategories(productId), ctx.client.listVariants(productId)]);
  ctx.store.upsertProductVariantCategories(productId, categories);
  ctx.store.upsertProductVariants(productId, variants);
  return { productId, categories, variants };
}

export async function readProductOfferCodes(ctx: AppContext, productId: string) {
  assertConfiguredAccessToken();
  const offerCodes = await ctx.client.listOfferCodes(productId);
  ctx.store.upsertProductOfferCodes(productId, offerCodes);
  return { productId, offerCodes };
}

function requireActionType(value: unknown): WriteActionType {
  if (typeof value !== "string") {
    throw new Error("action_type is required.");
  }
  const valid: WriteActionType[] = [
    "product_create",
    "variant_category_create",
    "variant_category_edit",
    "variant_category_delete",
    "variant_create",
    "variant_edit",
    "variant_delete",
    "offer_code_create",
    "offer_code_list",
    "offer_code_disable",
    "offer_code_delete",
  ];
  if (!valid.includes(value as WriteActionType)) {
    throw new Error(`Unsupported action_type: ${value}`);
  }
  return value as WriteActionType;
}

function buildActionPlan(actionType: WriteActionType, input: CatalogActionInput) {
  switch (actionType) {
    case "product_create": {
      const name = requiredString(input.name, "name");
      const priceCents = requiredInteger(input.price_cents, "price_cents");
      const currency = optionalString(input.currency)?.toLowerCase() ?? "usd";
      const payload: Record<string, string> = { name, price: String(priceCents), currency };
      maybeSet(payload, "description", optionalString(input.description));
      maybeSet(payload, "published", booleanString(input.published));
      maybeSet(payload, "custom_summary", optionalString(input.custom_summary));
      maybeSet(payload, "custom_receipt", optionalString(input.custom_receipt));
      maybeSet(payload, "tags", csv(input.tags));
      return {
        input,
        apiRequest: { method: "POST" as const, path: "/v2/products", payload },
        preview: `Create product \"${name}\" with payload ${JSON.stringify(payload)}`,
      };
    }
    case "variant_category_create": {
      const productId = requiredString(input.product_id, "product_id");
      const name = requiredString(input.name, "name");
      const payload = { name };
      return {
        input: { product_id: productId, name },
        apiRequest: { method: "POST" as const, path: `/v2/products/${productId}/variant_categories`, payload },
        preview: `Create variant category \"${name}\" for product ${productId}.`,
      };
    }
    case "variant_category_edit": {
      const productId = requiredString(input.product_id, "product_id");
      const categoryId = requiredString(input.category_id, "category_id");
      const name = requiredString(input.name, "name");
      const payload = { name };
      return {
        input: { product_id: productId, category_id: categoryId, name },
        apiRequest: { method: "PATCH" as const, path: `/v2/products/${productId}/variant_categories/${categoryId}`, payload },
        preview: `Edit variant category ${categoryId} for product ${productId}.`,
      };
    }
    case "variant_category_delete": {
      const productId = requiredString(input.product_id, "product_id");
      const categoryId = requiredString(input.category_id, "category_id");
      return {
        input: { product_id: productId, category_id: categoryId },
        apiRequest: { method: "DELETE" as const, path: `/v2/products/${productId}/variant_categories/${categoryId}` },
        preview: `Delete variant category ${categoryId} for product ${productId}.`,
      };
    }
    case "variant_create": {
      const productId = requiredString(input.product_id, "product_id");
      const categoryId = requiredString(input.category_id, "category_id");
      const name = requiredString(input.name, "name");
      const payload: Record<string, string> = { name, variant_category_id: categoryId };
      maybeSet(payload, "price_difference_cents", optionalIntegerString(input.price_difference_cents));
      maybeSet(payload, "max_purchase_count", optionalIntegerString(input.max_purchase_count));
      return {
        input: { product_id: productId, category_id: categoryId, name },
        apiRequest: { method: "POST" as const, path: `/v2/products/${productId}/variants`, payload },
        preview: `Create variant \"${name}\" under category ${categoryId} for product ${productId}.`,
      };
    }
    case "variant_edit": {
      const productId = requiredString(input.product_id, "product_id");
      const variantId = requiredString(input.variant_id, "variant_id");
      const payload: Record<string, string> = {};
      maybeSet(payload, "name", optionalString(input.name));
      maybeSet(payload, "price_difference_cents", optionalIntegerString(input.price_difference_cents));
      maybeSet(payload, "max_purchase_count", optionalIntegerString(input.max_purchase_count));
      if (Object.keys(payload).length === 0) throw new Error("variant_edit requires at least one editable field.");
      return {
        input: { product_id: productId, variant_id: variantId, ...payload },
        apiRequest: { method: "PATCH" as const, path: `/v2/products/${productId}/variants/${variantId}`, payload },
        preview: `Edit variant ${variantId} for product ${productId}.`,
      };
    }
    case "variant_delete": {
      const productId = requiredString(input.product_id, "product_id");
      const variantId = requiredString(input.variant_id, "variant_id");
      return {
        input: { product_id: productId, variant_id: variantId },
        apiRequest: { method: "DELETE" as const, path: `/v2/products/${productId}/variants/${variantId}` },
        preview: `Delete variant ${variantId} for product ${productId}.`,
      };
    }
    case "offer_code_create": {
      const productId = requiredString(input.product_id, "product_id");
      const code = requiredString(input.code, "code");
      const payload: Record<string, string> = { code };
      maybeSet(payload, "name", optionalString(input.name));
      maybeSet(payload, "amount_cents", optionalIntegerString(input.amount_cents));
      maybeSet(payload, "amount_percentage", optionalIntegerString(input.amount_percentage));
      maybeSet(payload, "max_uses", optionalIntegerString(input.max_uses));
      return {
        input: { product_id: productId, ...payload },
        apiRequest: { method: "POST" as const, path: `/v2/products/${productId}/offer_codes`, payload },
        preview: `Create offer code ${code} for product ${productId}.`,
      };
    }
    case "offer_code_list": {
      const productId = requiredString(input.product_id, "product_id");
      return {
        input: { product_id: productId },
        apiRequest: { method: "GET" as const, path: `/v2/products/${productId}/offer_codes` },
        preview: `List offer codes for product ${productId}.`,
      };
    }
    case "offer_code_disable":
    case "offer_code_delete":
      throw new Error(`Unsupported action_type: ${actionType}. Current Gumroad client does not expose this endpoint.`);
  }
}

async function executeAction(ctx: AppContext, actionType: WriteActionType, input: Record<string, unknown>) {
  switch (actionType) {
    case "product_create": {
      const payload = buildActionPlan(actionType, input as CatalogActionInput).apiRequest.payload ?? {};
      return ctx.client.createProduct(payload);
    }
    case "variant_category_create": {
      const productId = requiredString(input.product_id, "product_id");
      const response = await ctx.client.createVariantCategory(productId, { name: requiredString(input.name, "name") });
      await refreshVariants(ctx, productId);
      return { ...response, normalized_category: normalizeVariantCategory((response.variant_category ?? response.category ?? response) as Record<string, any>, productId) };
    }
    case "variant_category_edit": {
      const productId = requiredString(input.product_id, "product_id");
      const categoryId = requiredString(input.category_id, "category_id");
      const response = await ctx.client.editVariantCategory(productId, categoryId, { name: requiredString(input.name, "name") });
      await refreshVariants(ctx, productId);
      return { ...response, normalized_category: normalizeVariantCategory((response.variant_category ?? response.category ?? response) as Record<string, any>, productId) };
    }
    case "variant_category_delete": {
      const productId = requiredString(input.product_id, "product_id");
      const categoryId = requiredString(input.category_id, "category_id");
      const response = await ctx.client.deleteVariantCategory(productId, categoryId);
      await refreshVariants(ctx, productId);
      return response;
    }
    case "variant_create": {
      const productId = requiredString(input.product_id, "product_id");
      const payload = buildActionPlan(actionType, input as CatalogActionInput).apiRequest.payload ?? {};
      const response = await ctx.client.createVariant(productId, payload);
      await refreshVariants(ctx, productId);
      return { ...response, normalized_variant: normalizeVariant((response.variant ?? response) as Record<string, any>, productId) };
    }
    case "variant_edit": {
      const productId = requiredString(input.product_id, "product_id");
      const variantId = requiredString(input.variant_id, "variant_id");
      const payload = buildActionPlan(actionType, input as CatalogActionInput).apiRequest.payload ?? {};
      const response = await ctx.client.editVariant(productId, variantId, payload);
      await refreshVariants(ctx, productId);
      return { ...response, normalized_variant: normalizeVariant((response.variant ?? response) as Record<string, any>, productId) };
    }
    case "variant_delete": {
      const productId = requiredString(input.product_id, "product_id");
      const variantId = requiredString(input.variant_id, "variant_id");
      const response = await ctx.client.deleteVariant(productId, variantId);
      await refreshVariants(ctx, productId);
      return response;
    }
    case "offer_code_create": {
      const productId = requiredString(input.product_id, "product_id");
      const payload = buildActionPlan(actionType, input as CatalogActionInput).apiRequest.payload ?? {};
      const response = await ctx.client.createOfferCode(productId, payload);
      const offerCodes = await ctx.client.listOfferCodes(productId);
      ctx.store.upsertProductOfferCodes(productId, offerCodes);
      return { ...response, normalized_offer_code: normalizeOfferCode((response.offer_code ?? response) as Record<string, any>, productId) };
    }
    case "offer_code_list": {
      const productId = requiredString(input.product_id, "product_id");
      const offerCodes = await ctx.client.listOfferCodes(productId);
      ctx.store.upsertProductOfferCodes(productId, offerCodes);
      return { product_id: productId, offer_codes: offerCodes };
    }
    case "offer_code_disable":
      return ctx.client.disableOfferCode();
    case "offer_code_delete":
      return ctx.client.deleteOfferCode();
  }
}

async function refreshVariants(ctx: AppContext, productId: string) {
  const [categories, variants] = await Promise.all([ctx.client.listVariantCategories(productId), ctx.client.listVariants(productId)]);
  ctx.store.upsertProductVariantCategories(productId, categories);
  ctx.store.upsertProductVariants(productId, variants);
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function optionalString(value: unknown) {
  if (typeof value !== "string") return undefined;
  const out = value.trim();
  return out || undefined;
}

function requiredInteger(value: unknown, field: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer.`);
  return parsed;
}

function optionalIntegerString(value: unknown) {
  if (value == null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`Expected an integer value, received ${String(value)}.`);
  return String(parsed);
}

function booleanString(value: unknown) {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string" && ["true", "false"].includes(value.toLowerCase())) return value.toLowerCase();
  return undefined;
}

function csv(value: unknown) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => String(v)).join(",");
  return undefined;
}

function maybeSet(target: Record<string, string>, key: string, value?: string) {
  if (value !== undefined) target[key] = value;
}
