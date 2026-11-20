import "dotenv/config";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { connectDatabase } from "../server/db";

const [id, ...extra] = process.argv.slice(2);
if (!id || extra.length || !process.env.DATABASE_URL)
  throw new Error("Set DATABASE_URL and supply one exact existing user ID.");
neonConfig.webSocketConstructor = ws;
const db = connectDatabase(process.env.DATABASE_URL);
try {
  const promoted = await db.user.updateMany({
    where: { id, suspended: false },
    data: { role: "admin" },
  });
  if (!promoted.count) throw new Error("No active account has that ID.");
  console.info("Administrator role granted.");
} finally {
  await db.$disconnect();
}
