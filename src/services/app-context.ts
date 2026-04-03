import { config } from "../config.js";
import { FileStore } from "../db/file-store.js";
import { GumroadClient } from "../gumroad/client.js";

export function createAppContext() {
  return {
    config,
    store: new FileStore(config.dataFile),
    client: new GumroadClient(config.gumroadAccessToken),
  };
}

export type AppContext = ReturnType<typeof createAppContext>;
