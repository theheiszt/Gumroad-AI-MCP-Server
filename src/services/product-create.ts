import { createHash } from "node:crypto";
import { config } from "../config.js";
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
    description,
    priceCents: priceCentsNumber,
    currency: currency.toUpperCase(),
    published,
    customSummary,
    customReceipt,
    tags,
  };
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
