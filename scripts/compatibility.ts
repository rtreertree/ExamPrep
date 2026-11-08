import "dotenv/config";
import { randomUUID } from "node:crypto";
import { connectDatabase } from "../server/db";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
neonConfig.webSocketConstructor = ws;
const db = connectDatabase(process.env.DATABASE_URL!);
const email = `compat-${randomUUID()}@example.test`;
const password = randomUUID() + "aB9!";
for (const base of process.argv.slice(2)) {
  let cookie = "";
  const request = async (path: string, body?: unknown) => {
    const r = await fetch(base + "/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: new URL(base).origin,
        Cookie: cookie,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const cookies = r.headers.getSetCookie();
    if (cookies.length) cookie = cookies.map((c) => c.split(";")[0]).join("; ");
    const value = (await r.json()) as Record<string, any>;
    if (!r.ok)
      throw new Error(
        `${base} ${path}: ${r.status} ${value.error || value.message}`,
      );
    return value;
  };
  const accountEmail = base.includes("8788")
    ? email.replace("compat-", "compat-worker-")
    : email;
  const start = performance.now();
  try {
    await request("/auth/sign-up/email", {
      email: accountEmail,
      password,
      name: "Compatibility test",
    });
    await request("/auth/sign-out", {});
    await request("/auth/sign-in/email", { email: accountEmail, password });
    const session = await request("/auth/get-session");
    if (session.user.email !== accountEmail)
      throw new Error("Session mismatch");
    const set = await request("/sets", {
      schemaVersion: 1,
      kind: "flashcards",
      title: "Compatibility",
      cards: [{ id: "c1", front: "Test", back: "Persisted" }],
    });
    const stored = await request(`/sets/${set.id}`);
    if (stored.content.cards[0].back !== "Persisted")
      throw new Error("Database round-trip failed");
    console.info(
      `${base}: registration, sign-out, sign-in, session, Prisma write/read passed (${Math.round(performance.now() - start)} ms total).`,
    );
  } finally {
    await db.user.deleteMany({ where: { email: accountEmail } });
  }
}
await db.$disconnect();
