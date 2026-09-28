/** API process: Hono on 0.0.0.0:8000 (the container publishes it on 127.0.0.1 only). */
import { serve } from "@hono/node-server";
import { getSettings } from "../config.js";
import { configureLogging, getLogger } from "../logging.js";
import { buildState, createApp } from "./app.js";

const log = getLogger("coach.api.main");
export const HOST = "0.0.0.0";
export const PORT = 8000;

async function main(): Promise<void> {
  const settings = getSettings();
  configureLogging(settings.logLevel);
  const { state, close } = await buildState(settings);
  const server = serve({ fetch: createApp(state).fetch, hostname: HOST, port: PORT }, (info) =>
    log.info("api_started", { host: HOST, port: info.port }),
  );
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("api_stopping", { signal });
    server.close(async () => {
      try {
        await close();
      } finally {
        process.exit(0);
      }
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((exc) => {
  log.exception("api_crashed", exc);
  process.exit(1);
});
