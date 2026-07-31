import { isOAuthFlowId } from "@/lib/oauth-flow-lease";
import { FlowPendingClient } from "./FlowPendingClient";

export const dynamic = "force-dynamic";

export default async function OAuthFlowPendingPage({
  searchParams,
}: {
  searchParams: Promise<
    Record<string, string | string[] | undefined>
  >;
}) {
  const params = await searchParams;
  const rawFlow = params.flow;
  const queryInvalid =
    rawFlow !== undefined &&
    (typeof rawFlow !== "string" ||
      !isOAuthFlowId(rawFlow));
  return (
    <FlowPendingClient
      requestedFlowId={
        typeof rawFlow === "string" &&
        isOAuthFlowId(rawFlow)
          ? rawFlow
          : null
      }
      queryInvalid={queryInvalid}
    />
  );
}
