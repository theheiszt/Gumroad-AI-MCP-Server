import { createHash } from "node:crypto";
import { config } from "../config.js";
import type { AppContext } from "./app-context.js";
import type { WriteActionType, WriteConfirmation } from "../types.js";
import { isoNow, randomId } from "../utils/format.js";

export function previewWriteOperation(args: {
  ctx: AppContext;
  actionType: WriteActionType;
  input: Record<string, unknown>;
  apiRequest: WriteConfirmation["apiRequest"];
  preview: string;
}) {
  const createdAt = isoNow();
  const confirmationId = randomId("confirm_write");
  const payloadHash = createHash("sha256").update(JSON.stringify({ input: args.input, apiRequest: args.apiRequest })).digest("hex");

  const record: WriteConfirmation = {
    confirmationId,
    actionType: args.actionType,
    payloadHash,
    expiresAt: new Date(Date.now() + config.productCreateConfirmationTtlMs).toISOString(),
    status: "pending",
    createdAt,
    updatedAt: createdAt,
    requiresPhrase: Boolean(config.productCreateConfirmationPhrase),
    input: args.input,
    apiRequest: args.apiRequest,
    preview: args.preview,
  };

  args.ctx.store.recordWriteConfirmation(record);
  return record;
}

export async function confirmWriteOperation(args: {
  ctx: AppContext;
  confirmationId: string;
  confirmationPhrase?: string;
  execute: (record: WriteConfirmation) => Promise<Record<string, unknown>>;
}) {
  const record = args.ctx.store.getWriteConfirmation(args.confirmationId);
  if (!record) throw new Error("confirmation_id not found.");

  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    args.ctx.store.updateWriteConfirmation(args.confirmationId, (current) => ({
      ...current,
      status: "expired",
      updatedAt: isoNow(),
      error: "Confirmation expired.",
    }));
    throw new Error("Confirmation expired. Create a new preview.");
  }

  if (record.status === "executing" || record.status === "completed") {
    throw new Error("This confirmation has already been used and cannot be executed again.");
  }

  if (record.requiresPhrase && args.confirmationPhrase !== config.productCreateConfirmationPhrase) {
    throw new Error("Invalid confirmation_phrase.");
  }

  args.ctx.store.updateWriteConfirmation(args.confirmationId, (current) => ({
    ...current,
    status: "executing",
    updatedAt: isoNow(),
  }));

  args.ctx.store.recordWriteAction({
    id: randomId("write"),
    actionType: record.actionType,
    status: "attempted",
    at: isoNow(),
    confirmationId: record.confirmationId,
    details: { payloadHash: record.payloadHash },
  });

  try {
    const response = await args.execute(record);
    args.ctx.store.updateWriteConfirmation(args.confirmationId, (current) => ({
      ...current,
      status: "completed",
      updatedAt: isoNow(),
      error: undefined,
      result: {
        executedAt: isoNow(),
        response,
      },
    }));

    args.ctx.store.recordWriteAction({
      id: randomId("write"),
      actionType: record.actionType,
      status: "completed",
      at: isoNow(),
      confirmationId: record.confirmationId,
      details: { payloadHash: record.payloadHash },
    });

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    args.ctx.store.updateWriteConfirmation(args.confirmationId, (current) => ({
      ...current,
      status: "failed",
      updatedAt: isoNow(),
      error: message,
    }));
    args.ctx.store.recordWriteAction({
      id: randomId("write"),
      actionType: record.actionType,
      status: "failed",
      at: isoNow(),
      confirmationId: record.confirmationId,
      details: { payloadHash: record.payloadHash, error: message },
    });
    throw error;
  }
}
