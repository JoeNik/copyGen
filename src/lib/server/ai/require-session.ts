import { auth } from "@/lib/auth";
import { AIError, AIErrorCodes } from "./errors";

/**
 * Assert that a valid, authenticated user session exists for Route Handler use.
 * Throws AIError(AUTH_REQUIRED) when there is no session.
 */
export async function requireSession(): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new AIError({
      code: AIErrorCodes.AUTH_REQUIRED,
      message: "请先使用 GitHub 登录",
    });
  }
}