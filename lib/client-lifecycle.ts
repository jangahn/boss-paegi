/**
 * Returns true only while an async result still belongs to the live client
 * lifecycle that started it. An epoch is preferable to a boolean cancellation
 * flag because cleanup followed by a new setup can turn that flag back on
 * before the previous promise settles.
 */
export function isCurrentClientEpoch(
  candidateEpoch: number,
  currentEpoch: number,
  mounted: boolean,
): boolean {
  return (
    mounted &&
    Number.isSafeInteger(candidateEpoch) &&
    candidateEpoch >= 0 &&
    candidateEpoch === currentEpoch
  );
}
