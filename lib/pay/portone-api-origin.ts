export const PORTONE_API_ORIGIN = "https://api.portone.io";

type PortoneApiEnvironment = {
  NODE_ENV?: string;
  PORTONE_API_BASE_URL?: string;
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * PortOne credentials may only leave the process for the exact production API
 * origin. Tests can point at a loopback HTTP stub, but no other override is
 * accepted even outside production.
 */
export function resolvePortoneApiBaseUrl(
  environment: PortoneApiEnvironment,
): string {
  const configured =
    environment.PORTONE_API_BASE_URL ?? PORTONE_API_ORIGIN;

  if (configured === PORTONE_API_ORIGIN) return PORTONE_API_ORIGIN;

  if (environment.NODE_ENV === "production") {
    throw new Error("invalid_production_portone_api_origin");
  }

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("invalid_portone_api_origin");
  }

  const loopbackStub =
    parsed.protocol === "http:" &&
    LOOPBACK_HOSTS.has(parsed.hostname) &&
    parsed.username === "" &&
    parsed.password === "" &&
    (parsed.pathname === "" || parsed.pathname === "/") &&
    parsed.search === "" &&
    parsed.hash === "";

  if (!loopbackStub) {
    throw new Error("invalid_portone_api_origin");
  }

  return parsed.origin;
}
