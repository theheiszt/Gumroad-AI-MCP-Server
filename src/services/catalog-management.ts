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
    "product_enable",
    "product_disable",
    "variant_category_create",
    "variant_category_edit",
    "variant_category_delete",
    "variant_create",
    "variant_edit",
    "variant_delete",
    "custom_field_create",
    "custom_field_edit",
    "custom_field_delete",
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
    case "product_enable":
    case "product_disable": {
      const productId = requiredString(input.product_id, "product_id");
      const published = actionType === "product_enable";
      const payload = { published: String(published) };
      return {
        input: { product_id: productId },
        apiRequest: { method: "PATCH" as const, path: `/v2/products/${productId}`, payload },
        preview: `${published ? "Enable" : "Disable"} product ${productId}.`,
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
    case "custom_field_create": {
      const productId = requiredString(input.product_id, "product_id");
      const name = requiredString(input.name, "name");
      const payload: Record<string, string> = { name };
      maybeSet(payload, "type", optionalString(input.type));
      maybeSet(payload, "required", booleanString(input.required));
      maybeSet(payload, "collect_per_quantity", booleanString(input.collect_per_quantity));
      return {
        input: { product_id: productId, ...payload },
        apiRequest: { method: "POST" as const, path: `/v2/products/${productId}/custom_fields`, payload },
        preview: `Create custom field "${name}" for product ${productId}.`,
      };
    }
    case "custom_field_edit": {
      const productId = requiredString(input.product_id, "product_id");
      const customFieldId = requiredString(input.custom_field_id, "custom_field_id");
      const payload: Record<string, string> = {};
      maybeSet(payload, "name", optionalString(input.name));
      maybeSet(payload, "required", booleanString(input.required));
      maybeSet(payload, "collect_per_quantity", booleanString(input.collect_per_quantity));
      if (Object.keys(payload).length === 0) throw new Error("custom_field_edit requires at least one editable field.");
      return {
        input: { product_id: productId, custom_field_id: customFieldId, ...payload },
        apiRequest: { method: "PATCH" as const, path: `/v2/products/${productId}/custom_fields/${customFieldId}`, payload },
        preview: `Edit custom field ${customFieldId} for product ${productId}.`,
      };
    }
    case "custom_field_delete": {
      const productId = requiredString(input.product_id, "product_id");
      const customFieldId = requiredString(input.custom_field_id, "custom_field_id");
      return {
        input: { product_id: productId, custom_field_id: customFieldId },
        apiRequest: { method: "DELETE" as const, path: `/v2/products/${productId}/custom_fields/${customFieldId}` },
        preview: `Delete custom field ${customFieldId} for product ${productId}.`,
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
    case "offer_code_disable": {
      const productId = requiredString(input.product_id, "product_id");
      const offerCodeId = requiredString(input.offer_code_id, "offer_code_id");
      return {
        input: { product_id: productId, offer_code_id: offerCodeId },
        apiRequest: { method: "PATCH" as const, path: `/v2/products/${productId}/offer_codes/${offerCodeId}`, payload: { disabled: "true" } },
        preview: `Disable offer code ${offerCodeId} for product ${productId}.`,
      };
    }
    case "offer_code_delete": {
      const productId = requiredString(input.product_id, "product_id");
      const offerCodeId = requiredString(input.offer_code_id, "offer_code_id");
      return {
        input: { product_id: productId, offer_code_id: offerCodeId },
        apiRequest: { method: "DELETE" as const, path: `/v2/products/${productId}/offer_codes/${offerCodeId}` },
        preview: `Delete offer code ${offerCodeId} for product ${productId}.`,
      };
    }
    default:
      throw new Error(`Unsupported action_type: ${actionType}`);
  }
}

async function executeAction(ctx: AppContext, actionType: WriteActionType, input: Record<string, unknown>) {
  switch (actionType) {
    case "product_create":
      throw new Error("Base product creation is UI-first. Create the product in Gumroad UI, then manage it via API actions.");
    case "product_enable":
    case "product_disable": {
      const productId = requiredString(input.product_id, "product_id");
      const published = actionType === "product_enable";
      const response = await ctx.client.setProductPublished(productId, published);
      return { ...response, product_id: productId, published };
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
    case "custom_field_create": {
      const productId = requiredString(input.product_id, "product_id");
      const payload = requirePayload(buildActionPlan(actionType, input as CatalogActionInput).apiRequest.payload, actionType);
      return ctx.client.createCustomField(productId, payload);
    }
    case "custom_field_edit": {
      const productId = requiredString(input.product_id, "product_id");
      const customFieldId = requiredString(input.custom_field_id, "custom_field_id");
      const payload = requirePayload(buildActionPlan(actionType, input as CatalogActionInput).apiRequest.payload, actionType);
      return ctx.client.editCustomField(productId, customFieldId, payload);
    }
    case "custom_field_delete": {
      const productId = requiredString(input.product_id, "product_id");
      const customFieldId = requiredString(input.custom_field_id, "custom_field_id");
      return ctx.client.deleteCustomField(productId, customFieldId);
    }
    case "offer_code_create": {
      const productId = requiredString(input.product_id, "product_id");
      const payload = requirePayload(buildActionPlan(actionType, input as CatalogActionInput).apiRequest.payload, actionType);
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
    case "offer_code_disable": {
      const productId = requiredString(input.product_id, "product_id");
      const offerCodeId = requiredString(input.offer_code_id, "offer_code_id");
      const response = await ctx.client.disableOfferCode(productId, offerCodeId);
      const offerCodes = await ctx.client.listOfferCodes(productId);
      ctx.store.upsertProductOfferCodes(productId, offerCodes);
      return { ...response, product_id: productId, offer_code_id: offerCodeId };
    }
    case "offer_code_delete": {
      const productId = requiredString(input.product_id, "product_id");
      const offerCodeId = requiredString(input.offer_code_id, "offer_code_id");
      const response = await ctx.client.deleteOfferCode(productId, offerCodeId);
      const offerCodes = await ctx.client.listOfferCodes(productId);
      ctx.store.upsertProductOfferCodes(productId, offerCodes);
      return { ...response, product_id: productId, offer_code_id: offerCodeId };
    }
    default:
      throw new Error(`Unsupported action_type: ${actionType}`);
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

function maybeSet(target: Record<string, string>, key: string, value?: string) {
  if (value !== undefined) target[key] = value;
}

function requirePayload(payload: Record<string, string> | undefined, actionType: WriteActionType) {
  if (!payload) throw new Error(`Action ${actionType} requires a request payload.`);
  return payload;
}
