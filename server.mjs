// The production server (npm start runs it after building): the built Astro
// site, plus the live co-editing rooms (src/rooms/server.ts) on the same port.
//
//   PORT  (default 4321)
//   HOST  (default localhost; 0.0.0.0 to let other computers in)
//
// and the settings in astro.config.mjs (DATABASE_URL, S3_*, DATA_DIR), all of
// which a .env file next to package.json can set.

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createRooms, dataDir } from "./src/rooms/server.ts";

if (existsSync(".env")) process.loadEnvFile(".env");
process.env.ASTRO_NODE_AUTOSTART = "disabled";
const { handler } = await import("./dist/server/entry.mjs");

const port = Number(process.env.PORT ?? 4321);
const host = process.env.HOST ?? "localhost";

const rooms = createRooms({ dir: join(dataDir(), "rooms"), self: () => `http://${loopback(host)}:${port}` });

const server = createServer((req, res) => {
  if (!rooms.request(req, res)) handler(req, res);
});
server.on("upgrade", (req, socket, head) => {
  if (!rooms.upgrade(req, socket, head)) socket.destroy();
});

server.listen(port, host, () => {
  const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  console.log(`newsletteditor is running at http://${shown}:${port}/`);
});

// How this process reaches itself: the host it listens on, unless that's
// every address.
function loopback(host) {
  return host === "0.0.0.0" || host === "::" ? "localhost" : host.includes(":") ? `[${host}]` : host;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    rooms.close();
    server.close();
    process.exit(0);
  });
}
