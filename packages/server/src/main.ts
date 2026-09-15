import { loadConfig } from "./config.js";
import { buildApp } from "./app.js";

const config = loadConfig();
const { app } = await buildApp(config);
app.log.info({ dataDir: config.dataDir, hostUrl: config.hostUrl, validate: config.validate, editorDir: config.editorDir }, "blockshop config");
await app.listen({ port: config.port, host: config.host });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { app.log.info(`${sig}: shutting down`); void app.close().then(() => process.exit(0)); });
}
