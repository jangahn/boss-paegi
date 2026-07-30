export type SignupBonusConfig = { signupBonusCredits: number };

/**
 * Email/password reviewer-style accounts never receive an OAuth bonus.
 * Unexpected config transport/cache throws use the published code default,
 * never zero, so a transient dependency cannot permanently under-credit a
 * newly inserted member.
 */
export async function resolveSignupBonusStrict(
  provider: string | undefined,
  read: () => Promise<SignupBonusConfig>,
): Promise<number> {
  if (provider === "email") return 0;
  const configured = (await read()).signupBonusCredits;
  if (!Number.isSafeInteger(configured) || configured < 0) {
    throw new Error("invalid_signup_bonus");
  }
  return configured;
}
