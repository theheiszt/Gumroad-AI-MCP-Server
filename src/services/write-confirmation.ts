import { createHash } from "node:crypto";
import { config } from "../config.js";
import { UnsupportedGumroadOperationError } from "../gumroad/client.js";
import type { AppContext } from "./app-context.js";
import type { WriteConfirmation } from "../types.js";
import { isoNow, randomId } from "../utils/format.js";

type PreviewResult = {
  actionType: string;
  productId?: string;
  requestPayload: Record<string, string>;
  preview: string;
};

const SUPPORTED_CURRENCIES = new Set(["usd", "eur", "gbp", "cad", "aud"]);

export function previewWriteOperation(ctx: AppContext, args: { action_type?: unknown; input?: unknown }) {
  const actionType = typeof args.action_type === "string" ? args.action_type.trim() : "";
  const input = isRecord(args.input) ? args.input : {};
  const prepared = prepareAction(actionType, input);

  const payloadHash = hashPayload(prepared.requestPayload);
  const createdAt = isoNow();
  const confirmationId = randomId("confirm_write");
  const expiresAt = new Date(Date.now() + config.productCreateConfirmationTtlMs).toISOString();

  const confirmation: WriteConfirmation = {
    confirmationId,
    actionType: prepared.actionType,
    payloadHash,
    expiresAt,
    status: "pending",
    createdAt,
    updatedAt: createdAt,
    requiresPhrase: Boolean(config.productCreateConfirmationPhrase),
    productId: prepared.productId,
    requestPayload: prepared.requestPayload,
    preview: prepared.preview,
  };

  ctx.store.recordWriteConfirmation(confirmation);

  return {
    ok: true,
    action_type: `preview_${prepared.actionType}`,
    confirmation_id: confirmation.confirmationId,
    payload_hash: confirmation.payloadHash,
    expires_at: confirmation.expiresAt,
    status: confirmation.status,
    preview: confirmation.preview,
    request_payload: confirmation.requestPayload,
    requires_confirmation_phrase: confirmation.requiresPhrase,
  };
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
    ctx.store.updateWriteConfirmation(confirmationId, (current) => ({ ...current, status: "expired", updatedAt: isoNow() }));
    throw new Error("Confirmation expired. Create a new preview.");
  }
  if (confirmation.status === "executing" || confirmation.status === "completed") {
    throw new Error("This confirmation has already been used and cannot be executed again.");
  }

  if (confirmation.requiresPhrase) {
    const phrase = typeof args.confirmation_phrase === "string" ? args.confirmation_phrase : "";
    if (phrase !== config.productCreateConfirmationPhrase) throw new Error("Invalid confirmation_phrase.");
  }

  ctx.store.updateWriteConfirmation(confirmationId, (current) => ({ ...current, status: "executing", updatedAt: isoNow(), error: undefined }));

  ctx.store.recordWriteAction({
    id: randomId("write"),
    actionType: confirmation.actionType,
    status: "attempted",
    at: isoNow(),
    confirmationId,
    details: { productId: confirmation.productId, payloadHash: confirmation.payloadHash },
  });

  try {
    const result = await executeAction(ctx, confirmation.actionType, confirmation.requestPayload);
    if (confirmation.productId) {
      await refreshProductCatalog(ctx, confirmation.productId);
    }

    ctx.store.updateWriteConfirmation(confirmationId, (current) => ({
      ...current,
      status: "completed",
      updatedAt: isoNow(),
      result: { executedAt: isoNow(), response: result },
      error: undefined,
    }));

    ctx.store.recordWriteAction({
      id: randomId("write"),
      actionType: confirmation.actionType,
      status: "completed",
      at: isoNow(),
      confirmationId,
      details: { productId: confirmation.productId, payloadHash: confirmation.payloadHash },
    });

    return {
      ok: true,
      action_type: `confirm_${confirmation.actionType}`,
      confirmation_id: confirmationId,
      status: "completed",
      summary: `Completed ${confirmation.actionType}.`,
      full_response: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.store.updateWriteConfirmation(confirmationId, (current) => ({ ...current, status: "failed", updatedAt: isoNow(), error: message }));
    ctx.store.recordWriteAction({
      id: randomId("write"),
      actionType: confirmation.actionType,
      status: "failed",
      at: isoNow(),
      confirmationId,
      details: { productId: confirmation.productId, payloadHash: confirmation.payloadHash, error: message },
    });
    throw error;
  }
}

export async function refreshProductCatalog(ctx: AppContext, productId: string) {
  const [variantCategories, variants, offerCodes] = await Promise.all([
    ctx.client.listProductVariantCategories(productId),
    ctx.client.listProductVariants(productId),
    ctx.client.listOfferCodes(productId),
  ]);

  ctx.store.attachProductCatalog(productId, { variantCategories, variants, offerCodes });
  return { variantCategories, variants, offerCodes };
}

function prepareAction(actionType: string, input: Record<string, unknown>): PreviewResult {
  switch (actionType) {
    case "product_create":
      return {
        actionType,
        requestPayload: {
          name: requiredString(input.name, "name"),
          price: requiredPositiveInt(input.price_cents, "price_cents"),
          currency: currencyString(input.currency),
          ...(optionalString(input.description) ? { description: optionalString(input.description) as string } : {}),
          ...(optionalBoolean(input.published) !== undefined ? { published: String(optionalBoolean(input.published)) } : {}),
          ...(optionalString(input.custom_summary) ? { custom_summary: optionalString(input.custom_summary) as string } : {}),
          ...(optionalString(input.custom_receipt) ? { custom_receipt: optionalString(input.custom_receipt) as string } : {}),
          ...(tagsString(input.tags) ? { tags: tagsString(input.tags) as string } : {}),
        },
        preview: `Create product \"${requiredString(input.name, "name")}\".`,
      };
    case "variant_category_create": {
      const productId = requiredString(input.product_id, "product_id");
      return {
        actionType,
        productId,
        requestPayload: {
          product_id: productId,
          name: requiredString(input.name, "name"),
        },
        preview: `Create variant category \"${requiredString(input.name, "name")}\" for product ${productId}.`,
      };
    }
    case "variant_category_edit": {
      const productId = requiredString(input.product_id, "product_id");
      return {
        actionType,
        productId,
        requestPayload: {
          product_id: productId,
          variant_category_id: requiredString(input.variant_category_id, "variant_category_id"),
          name: requiredString(input.name, "name"),
        },
        preview: `Edit variant category ${requiredString(input.variant_category_id, "variant_category_id")} for product ${productId}.`,
      };
    }
    case "variant_category_delete": {
      const productId = requiredString(input.product_id, "product_id");
      return {
        actionType,
        productId,
        requestPayload: {
          product_id: productId,
          variant_category_id: requiredString(input.variant_category_id, "variant_category_id"),
        },
        preview: `Delete variant category ${requiredString(input.variant_category_id, "variant_category_id")} for product ${productId}.`,
      };
    }
    case "variant_create": {
      const productId = requiredString(input.product_id, "product_id");
      return {
        actionType,
        productId,
        requestPayload: {
          product_id: productId,
          variant_category_id: requiredString(input.variant_category_id, "variant_category_id"),
          name: requiredString(input.name, "name"),
          ...(optionalPositiveInt(input.price_difference_cents, "price_difference_cents")
            ? { price_difference_cents: optionalPositiveInt(input.price_difference_cents, "price_difference_cents") as string }
            : {}),
        },
        preview: `Create variant \"${requiredString(input.name, "name")}\" for product ${productId}.`,
      };
    }
    case "variant_edit": {
      const productId = requiredString(input.product_id, "product_id");
      return {
        actionType,
        productId,
        requestPayload: {
          product_id: productId,
          variant_id: requiredString(input.variant_id, "variant_id"),
          ...(optionalString(input.name) ? { name: optionalString(input.name) as string } : {}),
          ...(optionalPositiveInt(input.price_difference_cents, "price_difference_cents")
            ? { price_difference_cents: optionalPositiveInt(input.price_difference_cents, "price_difference_cents") as string }
            : {}),
        },
        preview: `Edit variant ${requiredString(input.variant_id, "variant_id")} for product ${productId}.`,
      };
    }
    case "variant_delete": {
      const productId = requiredString(input.product_id, "product_id");
      return {
        actionType,
        productId,
        requestPayload: {
          product_id: productId,
          variant_id: requiredString(input.variant_id, "variant_id"),
        },
        preview: `Delete variant ${requiredString(input.variant_id, "variant_id")} for product ${productId}.`,
      };
    }
    case "offer_code_create": {
      const productId = requiredString(input.product_id, "product_id");
      return {
        actionType,
        productId,
        requestPayload: {
          product_id: productId,
          name: requiredString(input.name, "name"),
          code: requiredString(input.code, "code"),
          ...(optionalPositiveInt(input.amount_off_cents, "amount_off_cents")
            ? { amount_off_cents: optionalPositiveInt(input.amount_off_cents, "amount_off_cents") as string }
            : {}),
          ...(optionalPercent(input.percent_off) ? { percent_off: optionalPercent(input.percent_off) as string } : {}),
        },
        preview: `Create offer code ${requiredString(input.code, "code")} for product ${productId}.`,
      };
    }
    case "offer_code_delete": {
      const productId = requiredString(input.product_id, "product_id");
      return {
        actionType,
        productId,
        requestPayload: {
          product_id: productId,
          offer_code_id: requiredString(input.offer_code_id, "offer_code_id"),
        },
        preview: `Delete offer code ${requiredString(input.offer_code_id, "offer_code_id")} for product ${productId}.`,
      };
    }
    case "offer_code_disable":
      throw new UnsupportedGumroadOperationError(
        "offer_code_disable is unsupported in the current API wrapper. Use offer_code_delete or list_offer_codes.",
      );
    default:
      throw new Error(`Unsupported action_type: ${actionType}`);
  }
}

async function executeAction(ctx: AppContext, actionType: string, payload: Record<string, string>) {
  switch (actionType) {
    case "product_create":
      return ctx.client.createProduct(payload);
    case "variant_category_create":
      return ctx.client.createVariantCategory(payload);
    case "variant_category_edit":
      return ctx.client.editVariantCategory(payload);
    case "variant_category_delete":
      return ctx.client.deleteVariantCategory(payload);
    case "variant_create":
      return ctx.client.createVariant(payload);
    case "variant_edit":
      return ctx.client.editVariant(payload);
    case "variant_delete":
      return ctx.client.deleteVariant(payload);
    case "offer_code_create":
      return ctx.client.createOfferCode(payload);
    case "offer_code_delete":
      return ctx.client.deleteOfferCode(payload);
    case "offer_code_disable":
      return ctx.client.disableOfferCode();
    default:
      throw new Error(`Unsupported action_type: ${actionType}`);
  }
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required.`);
  return value.trim();
}

function optionalString(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

function requiredPositiveInt(value: unknown, field: string) {
  const asNumber = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(asNumber) || asNumber <= 0) throw new Error(`${field} must be a positive integer.`);
  return String(asNumber);
}

function optionalPositiveInt(value: unknown, field: string) {
  if (value == null || value === "") return undefined;
  return requiredPositiveInt(value, field);
}

function optionalPercent(value: unknown) {
  if (value == null || value === "") return undefined;
  const asNumber = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(asNumber) || asNumber <= 0 || asNumber > 100) {
    throw new Error("percent_off must be > 0 and <= 100.");
  }
  return String(asNumber);
}

function currencyString(value: unknown) {
  const currency = typeof value === "string" && value ? value.toLowerCase() : "usd";
  if (!SUPPORTED_CURRENCIES.has(currency)) throw new Error(`currency must be one of: ${Array.from(SUPPORTED_CURRENCIES).join(", ")}.`);
  return currency;
}

function tagsString(value: unknown) {
  if (Array.isArray(value)) {
    const tags = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    return tags.length ? tags.join(",") : undefined;
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function hashPayload(payload: Record<string, string>) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
