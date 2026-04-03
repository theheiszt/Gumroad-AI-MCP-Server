import type { SalesSummary, WebhookEvent } from "../types.js";

type WebhookDelivery = {
  kind: "sale" | "membership" | "summary";
  url: string;
  payload: Record<string, unknown>;
};

export async function dispatchRuleOutputs(deliveries: WebhookDelivery[]) {
  for (const delivery of deliveries) {
    if (!delivery.url) continue;
    const response = await fetch(delivery.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(delivery.payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const details = body ? ` - ${body.slice(0, 500)}` : "";
      throw new Error(
        `[automation] ${delivery.kind} webhook failed with status ${response.status} ${response.statusText}${details}`,
      );
    }
  }
}

export function buildWebhookDeliveries(args: {
  event: WebhookEvent;
  saleWebhookUrl?: string;
  membershipWebhookUrl?: string;
}) {
  const deliveries: WebhookDelivery[] = [];
  if (args.event.eventType.includes("sale") && args.saleWebhookUrl) {
    deliveries.push({
      kind: "sale",
      url: args.saleWebhookUrl,
      payload: {
        type: args.event.eventType,
        receivedAt: args.event.receivedAt,
        productId: args.event.productId,
        productName: args.event.productName,
        saleId: args.event.saleId,
        orderNumber: args.event.orderNumber,
        purchaserEmail: args.event.purchaserEmail,
      },
    });
  }

  if (
    (args.event.eventType.includes("subscription") || args.event.eventType.includes("cancellation")) &&
    args.membershipWebhookUrl
  ) {
    deliveries.push({
      kind: "membership",
      url: args.membershipWebhookUrl,
      payload: {
        type: args.event.eventType,
        receivedAt: args.event.receivedAt,
        productId: args.event.productId,
        productName: args.event.productName,
        purchaserEmail: args.event.purchaserEmail,
        saleId: args.event.saleId,
      },
    });
  }

  return deliveries;
}

export function buildSummaryDelivery(summary: SalesSummary, summaryWebhookUrl?: string) {
  if (!summaryWebhookUrl) return [];
  return [
    {
      kind: "summary" as const,
      url: summaryWebhookUrl,
      payload: summary,
    },
  ];
}
