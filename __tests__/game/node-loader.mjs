import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = new URL("../../", import.meta.url);
const MATTER_SHIM = new URL("./matter-js-shim.mjs", import.meta.url).href;

function existingModuleUrl(url) {
  const path = fileURLToPath(url);
  for (const candidate of [path, `${path}.ts`, `${path}/index.ts`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true };
  }
  if (specifier === "matter-js" && context.parentURL !== MATTER_SHIM) {
    return { url: MATTER_SHIM, shortCircuit: true };
  }
  if (specifier.startsWith("next/") && !specifier.endsWith(".js")) {
    try {
      return await nextResolve(`${specifier}.js`, context);
    } catch {
      // Let Node surface the original package resolution failure below.
    }
  }
  if (specifier.startsWith("@/")) {
    const resolved = existingModuleUrl(new URL(specifier.slice(2), REPO_ROOT));
    if (resolved) return resolved;
  }
  if (specifier.startsWith(".") && context.parentURL) {
    const resolved = existingModuleUrl(new URL(specifier, context.parentURL));
    if (resolved) return resolved;
  }
  return nextResolve(specifier, context);
}
