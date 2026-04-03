import { resolve } from "node:path";

function numberFromEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: numberFromEnv(process.env.PORT, 8788),
  adminToken: process.env.ADMIN_TOKEN ?? "change-me",
  mcpBearerToken: process.env.MCP_BEARER_TOKEN ?? "",
  gumroadAccessToken: process.env.GUMROAD_ACCESS_TOKEN ?? "",
  gumroadWebhookSecret: process.env.GUMROAD_WEBHOOK_SECRET ?? "",
  dataFile: resolve(process.cwd(), process.env.DATA_FILE ?? "./data/personal-db.json"),
  syncLookbackDays: numberFromEnv(process.env.SYNC_LOOKBACK_DAYS, 30),
  enableIntervalJobs: String(process.env.ENABLE_INTERVAL_JOBS ?? "false").toLowerCase() === "true",
  syncProductsIntervalMs: numberFromEnv(process.env.SYNC_PRODUCTS_INTERVAL_MS, 6 * 60 * 60 * 1000),
  syncSalesIntervalMs: numberFromEnv(process.env.SYNC_SALES_INTERVAL_MS, 15 * 60 * 1000),
  dailySummaryIntervalMs: numberFromEnv(process.env.DAILY_SUMMARY_INTERVAL_MS, 24 * 60 * 60 * 1000),
  outboundSaleWebhookUrl: process.env.OUTBOUND_SALE_WEBHOOK_URL ?? "",
  outboundMembershipWebhookUrl: process.env.OUTBOUND_MEMBERSHIP_WEBHOOK_URL ?? "",
  outboundSummaryWebhookUrl: process.env.OUTBOUND_SUMMARY_WEBHOOK_URL ?? "",
  logLevel: process.env.LOG_LEVEL ?? "info",
};

export function assertConfiguredAccessToken() {
  if (!config.gumroadAccessToken) {
    throw new Error("Missing GUMROAD_ACCESS_TOKEN in environment.");
  }
}
