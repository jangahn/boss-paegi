const KST_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Return the civil date at an exact instant in Korea Standard Time.
 *
 * `toLocaleDateString("en-CA")` is not a stable YYYY-MM-DD contract on every
 * JavaScript runtime. Building from named parts keeps the legal effective-date
 * boundary deterministic, including the UTC 15:00 KST-midnight transition.
 */
export function kstDateAt(
  instant: Date | number | string = new Date(),
): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("invalid_instant");
  }

  const parts = new Map(
    KST_DATE_FORMATTER.formatToParts(date).map((part) => [
      part.type,
      part.value,
    ]),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  if (!year || !month || !day) {
    throw new Error("kst_date_format_failed");
  }
  return `${year}-${month}-${day}`;
}
