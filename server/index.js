import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, migrate } from "./db.js";
import { seedDatabase } from "./seed.js";
import { createApp } from "./app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const dbPath = process.env.IAM_DB || join(__dirname, "..", "data", "iam.db");

const db = openDatabase(dbPath);
migrate(db);
seedDatabase(db);

const app = createApp(db);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Helix IAM API listening on http://0.0.0.0:${PORT}`);
});
