import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { Database } from "./db";
import { databasePasswords } from "./passwords";
export type Config = {
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  PASSWORD_PEPPER: string;
  RUNTIME?: "worker" | "node";
};
export function createAuth(db: Database, config: Config) {
  return betterAuth({
    appName: "Exam Prep",
    baseURL: config.BETTER_AUTH_URL,
    secret: config.BETTER_AUTH_SECRET,
    database: prismaAdapter(db, { provider: "postgresql" }),
    trustedOrigins: [new URL(config.BETTER_AUTH_URL).origin],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      password: databasePasswords(
        db,
        config.PASSWORD_PEPPER,
        config.RUNTIME ?? "node",
      ),
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: config.BETTER_AUTH_URL.startsWith("https:"),
      ipAddress: {
        ipAddressHeaders: [
          config.RUNTIME === "worker"
            ? "cf-connecting-ip"
            : "x-examprep-client-ip",
        ],
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 5 },
        "/change-password": { window: 60, max: 5 },
      },
    },
  });
}
