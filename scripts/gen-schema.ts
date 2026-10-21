import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { configSchema } from "../src/config/schema.js";

const out = resolve(process.cwd(), "schema/config.schema.json");
const jsonSchema = zodToJsonSchema(configSchema, {
  name: "BufferMcpConfig",
  $refStrategy: "root",
});

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(jsonSchema, null, 2)}\n`, "utf8");
process.stdout.write(`wrote ${out}\n`);
