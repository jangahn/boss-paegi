import type { NextRequest } from "next/server";
import {
  handleSignoutRequest,
} from "@/app/api/auth/signout/route";

export const runtime = "nodejs";
export const maxDuration = 30;

export function POST(request: NextRequest) {
  return handleSignoutRequest(request, "oauth");
}
