import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const OPS_ROOT = fileURLToPath(new URL("../../app/api/ops/", import.meta.url));

function walk(directory: string): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) routes.push(...walk(absolute));
    else if (entry.isFile() && entry.name === "route.ts") routes.push(absolute);
  }
  return routes;
}

/**
 * The filesystem is the inventory source. Adding an ops route automatically
 * enrolls it in every central cron contract test without editing a name list.
 */
export function discoverOpsRouteNames(): string[] {
  return walk(OPS_ROOT)
    .map((absolute) =>
      relative(OPS_ROOT, absolute)
        .split(sep)
        .join("/")
        .replace(/\/route\.ts$/, ""),
    )
    .sort();
}
