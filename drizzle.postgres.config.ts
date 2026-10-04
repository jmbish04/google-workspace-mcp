import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/backend/db/postgres-schema.ts",
  out: "./drizzle-postgres",
});
