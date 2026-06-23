import { NextRequest, NextResponse } from "next/server";
import { PUBLIC_ENV } from "@/lib/env";

export const runtime = "nodejs";

/**
 * 결제 후 복귀(returnurl). skip_cstpage=y 라 페이앱이 이 URL 로 POST 이동하므로
 * 페이지(GET)가 직접 못 받는다 → API 라우트로 받아 /credits/done 으로 303 redirect
 * (브라우저는 GET 으로 따라감). order_uuid 는 returnurl 쿼리로 우리가 직접 넣었음.
 */
function redirectToDone(req: NextRequest) {
  const order = req.nextUrl.searchParams.get("order") ?? "";
  // SITE_URL 오형식이어도 결제 후 복귀가 깨지지 않게 요청 origin 으로 폴백.
  let base: string;
  try {
    base = new URL(PUBLIC_ENV.SITE_URL).origin;
  } catch {
    base = req.nextUrl.origin;
  }
  const dest = order
    ? `${base}/credits/done?order=${encodeURIComponent(order)}`
    : `${base}/credits/done`;
  return NextResponse.redirect(dest, 303);
}

export async function POST(req: NextRequest) {
  return redirectToDone(req);
}

export async function GET(req: NextRequest) {
  return redirectToDone(req);
}
