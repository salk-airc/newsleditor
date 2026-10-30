// @ts-check
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash, { local, s3 } from "emdash/astro";
import { postgres, sqlite } from "emdash/db";
import { createRooms, dataDir } from "./src/rooms/server.ts";

// Where things live, from the environment (see README, "Hosting"):
//
// - DATABASE_URL: a postgres:// connection string. Default: a SQLite file,
//   data/newsletter.db.
// - S3_BUCKET (with S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
//   S3_REGION, S3_PUBLIC_URL): images in an S3-compatible bucket. Default:
//   the data/media folder, served by this site.
// - DATA_DIR: the data folder. Default: ./data.
// - SITE_URL: the address people reach the site at, when it isn't localhost.
// - OIDC_ISSUER (with OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_LABEL,
//   OIDC_FIRST_ADMIN): sign-in with an OpenID Connect provider as well as
//   passkeys. See src/auth/oidc.ts.
//
// A .env file next to package.json sets any of them.

if (existsSync(".env")) process.loadEnvFile(".env");
const data = dataDir();

// Paths handed to EmDash, with forward slashes. It writes some into generated
// code unescaped (`import … from "${entrypoint}"`), where a Windows path's
// backslashes vanish ("C:\Program Files\newsleditor" → "C:Program Files" and a
// newline); forward slashes work everywhere, Windows included.
const slashes = (/** @type {string} */ path) => path.replaceAll("\\", "/");
const here = (/** @type {string} */ rel) => slashes(fileURLToPath(new URL(rel, import.meta.url)));
const pluginsDir = here("./src/plugins/");

const database = process.env.DATABASE_URL
  ? postgres({ connectionString: process.env.DATABASE_URL })
  : sqlite({ url: `file:${slashes(join(data, "newsletter.db"))}` });

const storage = process.env.S3_BUCKET
  ? s3()
  : local({ directory: join(data, "media"), baseUrl: "/_emdash/api/media/file" });

// Sign-in with an OpenID Connect provider, alongside passkeys, when OIDC_ISSUER
// is set (src/auth/oidc.ts; the client's id and secret are read when it runs).
const auth = (/** @type {string} */ path) => here(`./src/auth/${path}`);
const oidcLabel = process.env.OIDC_LABEL || "your organisation";
const authProviders = process.env.OIDC_ISSUER
  ? [
      {
        id: "oidc",
        label: oidcLabel,
        adminEntry: auth("oidc-admin.tsx"),
        routes: [
          { pattern: "/_emdash/api/auth/oidc/login", entrypoint: auth("oidc-login.ts") },
          { pattern: "/_emdash/api/auth/oidc/callback", entrypoint: auth("oidc-callback.ts") },
        ],
        publicRoutes: ["/_emdash/api/auth/oidc/"],
      },
    ]
  : [];

// EmDash builds its plugin list once when the dev server starts and keeps it,
// so a hot-reloaded plugin file never replaces the running copy. Restart the
// dev server instead whenever a file under src/plugins changes.
/** @returns {import("vite").Plugin} */
function restartOnPluginChange() {
  return {
    name: "newsleditor:restart-on-plugin-change",
    apply: "serve",
    handleHotUpdate({ file, server }) {
      if (file.startsWith(pluginsDir)) {
        server.config.logger.info(`plugin changed, restarting: ${file.slice(pluginsDir.length)}`);
        server.restart();
        return [];
      }
    },
  };
}

// The live co-editing rooms on the dev server, as server.mjs does for
// npm start: WebSocket upgrades and seed POSTs to /newsletter/edit/<slug>/sync.
/** @returns {import("vite").Plugin} */
function editionRooms() {
  return {
    name: "newsleditor:edition-rooms",
    apply: "serve",
    configureServer(server) {
      const rooms = createRooms({
        dir: join(data, "rooms"),
        self: () => {
          const address = server.httpServer?.address();
          const port = typeof address === "object" && address ? address.port : 4321;
          return `http://localhost:${port}`;
        },
      });
      server.httpServer?.on("upgrade", (req, socket, head) => rooms.upgrade(req, socket, head));
      server.middlewares.use((req, res, next) => {
        if (!rooms.request(req, res)) next();
      });
      server.httpServer?.on("close", () => rooms.close());
    },
  };
}

export default defineConfig({
  site: process.env.SITE_URL,
  output: "server",
  // Standalone's handler (pages and static files), but server.mjs starts the
  // HTTP server itself (ASTRO_NODE_AUTOSTART=disabled), so it can take the
  // co-editing WebSockets too.
  adapter: node({ mode: "standalone" }),

  integrations: [
    // React is required by EmDash's admin UI at /_emdash/admin.
    react(),
    emdash({
      database,
      storage,
      authProviders,
      // An edition's body is markdown rendered to one block of HTML, edited in
      // the studio at /newsletter/edit rather than on the page.
      toolbar: false,
      plugins: [
        {
          id: "newsletter",
          version: "0.1.0",
          // Absolute path: EmDash imports this from a generated virtual
          // module, where a relative specifier would not resolve.
          entrypoint: here("./src/plugins/newsletter/index.ts"),
        },
      ],
    }),
  ],

  build: { inlineStylesheets: "always" },
  devToolbar: { enabled: false },
  server: { port: 4321, host: process.env.HOST ?? "localhost" },

  vite: {
    plugins: [restartOnPluginChange(), editionRooms()],
    define: { "import.meta.env.NEWSLEDITOR_OIDC_LABEL": JSON.stringify(oidcLabel) },
    environments: {
      ssr: { optimizeDeps: { include: ["marked"] } },
    },
  },
});
