import { loadConfig } from "./config.js";
import { createHttpServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

const config = loadConfig();
const server = createHttpServer(config);

server.listen(config.port, () => {
  console.log(
    `[${SERVER_NAME}] v${SERVER_VERSION} listening on :${config.port}/mcp (hub ${config.hubUrl}, instance ${config.serviceId})`,
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
