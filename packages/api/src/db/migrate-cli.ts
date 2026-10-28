import { loadConfig } from "../config.js";
import { createDb } from "./index.js";
import { migrate } from "./migrations.js";

const cfg = loadConfig();
const db = await createDb(cfg);
const applied = await migrate(db);
console.log(applied.length ? `applied migrations: ${applied.join(", ")}` : "schema up to date");
await db.close();
