export type DollPickCompensationStage = "doll_delete" | "storage_remove";

export type DollPickCompensationStep = {
  stage: DollPickCompensationStage;
  run: () => Promise<{ error?: unknown | null }>;
};

export type DollPickCompensationFailure = {
  stage: DollPickCompensationStage;
  error: unknown;
};

/**
 * 생성 확정 전 만든 doll 행·Storage 객체를 순서대로 되돌린다.
 * DB 행 삭제가 실패하면 참조 가능한 행의 이미지를 먼저 지우지 않도록 후속 Storage 삭제를 중단한다.
 */
export async function runDollPickCompensation(
  steps: readonly DollPickCompensationStep[],
): Promise<DollPickCompensationFailure[]> {
  const failures: DollPickCompensationFailure[] = [];
  for (const step of steps) {
    try {
      const result = await step.run();
      if (result?.error != null) {
        failures.push({ stage: step.stage, error: result.error });
        break;
      }
    } catch (error) {
      failures.push({ stage: step.stage, error });
      break;
    }
  }
  return failures;
}
