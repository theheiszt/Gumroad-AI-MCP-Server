import { assertConfiguredAccessToken } from "../config.js";
import { createAppContext } from "../services/app-context.js";
import { dailySummaryJob, processPendingWebhookEvents, syncProductsJob, syncSalesJob } from "./index.js";

async function main() {
  const command = process.argv[2];
  if (!command) {
    throw new Error("Missing job name. Use sync-products, sync-sales, daily-summary, or process-webhooks.");
  }

  assertConfiguredAccessToken();
  const ctx = createAppContext();

  if (command === "sync-products") {
    const result = await syncProductsJob(ctx);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "sync-sales") {
    const result = await syncSalesJob(ctx);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "daily-summary") {
    const result = await dailySummaryJob(ctx, Number(process.argv[3] ?? 1));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "process-webhooks") {
    const result = await processPendingWebhookEvents(ctx, Number(process.argv[3] ?? 25));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown job: ${command}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
