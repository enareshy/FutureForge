import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, migrate } from "./db.js";
import { seedDatabase } from "./seed.js";
import { createApp } from "./app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const dbPath = process.env.IAM_DB || join(__dirname, "..", "data", "iam.db");

if (process.env.NODE_ENV === "production" && !process.env.HELIX_AUTH_SECRET) {
  console.error(
    "[helix] Refusing to start: HELIX_AUTH_SECRET is not set. This key protects " +
      "every encrypted secret in the database and must not use the built-in dev " +
      "fallback in production. Set HELIX_AUTH_SECRET and restart " +
      "(see docs/INTEGRATION_OPERATIONS.md)."
  );
  process.exit(1);
}

const db = openDatabase(dbPath);
migrate(db);
seedDatabase(db);

const app = createApp(db);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Helix IAM API listening on http://0.0.0.0:${PORT}`);
});
