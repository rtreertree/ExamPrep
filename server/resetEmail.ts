import type { Config } from "./auth";

export const passwordRecoveryEnabled = (config: Config) =>
  Boolean(config.RESEND_API_KEY?.trim() && config.RESET_EMAIL_FROM?.trim());

export async function sendResetEmail(
  config: Config,
  email: string,
  token: string,
) {
  // The fragment keeps the reset token out of web server request URLs.
  const link = new URL("/reset-password", config.BETTER_AUTH_URL);
  link.hash = new URLSearchParams({ token }).toString();
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.RESET_EMAIL_FROM,
        to: [email],
        subject: "Reset your Exam Prep password",
        text: `Use this link within 30 minutes to choose a new password:\n\n${link}\n\nIf you didn't request a reset, you can ignore this email.`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok)
      console.error("Password reset email delivery rejected.", response.status);
  } catch {
    console.error("Password reset email delivery unavailable.");
  }
}
