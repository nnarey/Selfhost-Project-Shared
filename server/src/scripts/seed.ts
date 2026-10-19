import { getDb, closeDb } from "../db.js";
import { seedDemoData } from "../seed.js";
import { ensureDefaultMappingProfiles } from "../import/mapping.js";

getDb();
ensureDefaultMappingProfiles();
const result = seedDemoData("cli");
console.log(JSON.stringify(result, null, 2));
closeDb();
