export const DEPLOYMENT_IDENTITY_PROJECT_HEADER =
  "X-Boss-Paegi-Supabase-Project-Ref";
export const DEPLOYMENT_IDENTITY_COMMIT_HEADER =
  "X-Boss-Paegi-Build-Commit";
export const DEPLOYMENT_IDENTITY_VERCEL_PROJECT_HEADER =
  "X-Boss-Paegi-Vercel-Project-Id";
export const DEPLOYMENT_IDENTITY_VERCEL_DEPLOYMENT_HEADER =
  "X-Boss-Paegi-Vercel-Deployment-Id";
export const DEPLOYMENT_IDENTITY_VERCEL_URL_HEADER =
  "X-Boss-Paegi-Vercel-Deployment-Url";
export const DEPLOYMENT_IDENTITY_VERCEL_ENVIRONMENT_HEADER =
  "X-Boss-Paegi-Vercel-Environment";

export type DeploymentIdentityEnvironment = Readonly<
  Partial<
    Record<
      | "NEXT_PUBLIC_SUPABASE_URL"
      | "VERCEL_GIT_COMMIT_SHA"
      | "VERCEL_PROJECT_ID"
      | "VERCEL_DEPLOYMENT_ID"
      | "VERCEL_URL"
      | "VERCEL_TARGET_ENV",
      string | undefined
    >
  >
>;

/**
 * Public, non-secret deployment identity used by production rollout probes.
 * Return every field or none so a partially configured deployment can never
 * look authoritative.
 */
export function deploymentIdentityHeaders(
  env: DeploymentIdentityEnvironment = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
    VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID,
    VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID,
    VERCEL_URL: process.env.VERCEL_URL,
    VERCEL_TARGET_ENV: process.env.VERCEL_TARGET_ENV,
  },
): Readonly<Record<string, string>> {
  const commit = env.VERCEL_GIT_COMMIT_SHA?.toLowerCase() ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) return {};
  const vercelProjectId = env.VERCEL_PROJECT_ID ?? "";
  const vercelDeploymentId = env.VERCEL_DEPLOYMENT_ID ?? "";
  const vercelUrl = env.VERCEL_URL?.toLowerCase() ?? "";
  const vercelEnvironment = env.VERCEL_TARGET_ENV ?? "";
  if (
    !/^prj_[A-Za-z0-9]{16,64}$/.test(vercelProjectId) ||
    !/^dpl_[A-Za-z0-9]{16,64}$/.test(vercelDeploymentId) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/.test(
      vercelUrl,
    ) ||
    vercelEnvironment !== "production"
  ) {
    return {};
  }

  let projectRef = "";
  try {
    const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname);
    if (
      url.protocol !== "https:" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      match === null
    ) {
      return {};
    }
    projectRef = match[1];
  } catch {
    return {};
  }

  return {
    [DEPLOYMENT_IDENTITY_PROJECT_HEADER]: projectRef,
    [DEPLOYMENT_IDENTITY_COMMIT_HEADER]: commit,
    [DEPLOYMENT_IDENTITY_VERCEL_PROJECT_HEADER]: vercelProjectId,
    [DEPLOYMENT_IDENTITY_VERCEL_DEPLOYMENT_HEADER]:
      vercelDeploymentId,
    [DEPLOYMENT_IDENTITY_VERCEL_URL_HEADER]: vercelUrl,
    [DEPLOYMENT_IDENTITY_VERCEL_ENVIRONMENT_HEADER]:
      vercelEnvironment,
  };
}
