import { CONTENT_REPORT_REASONS } from "./content-report.ts";

export const MODERATION_REPORT_DETAIL_LIMIT = 100;

const MODERATION_STATES = new Set([
  "pending",
  "hidden",
  "purged",
  "dismissed",
]);
const REPORT_STATUSES = new Set(["pending", "actioned", "dismissed"]);
const REPORT_REASONS = new Set<string>(CONTENT_REPORT_REASONS);

type ModerationReportContract = {
  id: string;
  reason: string;
  detail: string | null;
  contact: string | null;
  status: string;
  created_at: string;
};

export type ModerationQueueContractRow = {
  state: string;
  deleted_at: string | null;
  artifacts_purged_at: string | null;
  report_count: number;
  pending_count: number;
  latest_report_at: string | null;
  reports_truncated: boolean;
  reports: ModerationReportContract[];
};

function reportComesBefore(
  left: ModerationReportContract,
  right: ModerationReportContract,
): boolean {
  const leftTime = Date.parse(left.created_at);
  const rightTime = Date.parse(right.created_at);
  return leftTime > rightTime ||
    (leftTime === rightTime && left.id.localeCompare(right.id) > 0);
}

/**
 * SQL의 상태 계산·exact count·최근-N preview 계약을 애플리케이션 경계에서
 * 독립 재검증한다. 손상/드리프트 응답을 빈 큐나 정상 운영 상태로 표시하지 않는다.
 */
export function assertModerationQueueContract(
  row: ModerationQueueContractRow,
): void {
  if (
    !MODERATION_STATES.has(row.state) ||
    !Number.isSafeInteger(row.report_count) ||
    row.report_count < 0 ||
    !Number.isSafeInteger(row.pending_count) ||
    row.pending_count < 0 ||
    row.pending_count > row.report_count ||
    row.reports.length > MODERATION_REPORT_DETAIL_LIMIT ||
    row.reports.length > row.report_count ||
    row.reports_truncated !== (row.report_count > row.reports.length)
  ) {
    throw new Error("invalid_moderation_queue_counts");
  }

  const expectedState =
    row.artifacts_purged_at !== null
      ? "purged"
      : row.deleted_at !== null
        ? "hidden"
        : row.pending_count > 0
          ? "pending"
          : "dismissed";
  if (
    row.state !== expectedState ||
    (row.artifacts_purged_at !== null && row.deleted_at === null)
  ) {
    throw new Error("invalid_moderation_queue_state");
  }

  if (
    (row.report_count === 0) !== (row.latest_report_at === null) ||
    (row.report_count === 0) !== (row.reports.length === 0)
  ) {
    throw new Error("invalid_moderation_queue_latest");
  }

  for (let index = 0; index < row.reports.length; index += 1) {
    const report = row.reports[index]!;
    if (
      !REPORT_REASONS.has(report.reason) ||
      !REPORT_STATUSES.has(report.status) ||
      (report.detail !== null && report.detail.length > 2_000) ||
      (report.contact !== null && report.contact.length > 200)
    ) {
      throw new Error("invalid_moderation_queue_report");
    }
    if (
      index > 0 &&
      !reportComesBefore(row.reports[index - 1]!, report)
    ) {
      throw new Error("invalid_moderation_queue_order");
    }
  }

  if (
    row.reports.length > 0 &&
    Date.parse(row.reports[0]!.created_at) !==
      Date.parse(row.latest_report_at!)
  ) {
    throw new Error("invalid_moderation_queue_latest");
  }

  if (
    !row.reports_truncated &&
    row.reports.filter((report) => report.status === "pending").length !==
      row.pending_count
  ) {
    throw new Error("invalid_moderation_queue_pending_count");
  }
}
