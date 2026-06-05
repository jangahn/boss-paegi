import "server-only";

export const SERVER_ENV = {
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  FAL_KEY: process.env.FAL_KEY!,
};
