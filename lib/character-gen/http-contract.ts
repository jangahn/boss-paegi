const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isExactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key))
  );
}

export type GenerationSubmitHttpResponse = {
  generationId: string;
  status: "generating";
};

export function parseGenerationSubmitHttpResponse(
  value: unknown,
): GenerationSubmitHttpResponse | null {
  if (
    !isExactObject(value, ["generationId", "status"]) ||
    typeof value.generationId !== "string" ||
    !UUID_RE.test(value.generationId) ||
    value.status !== "generating"
  ) {
    return null;
  }
  return value as GenerationSubmitHttpResponse;
}

export type DollPickHttpResponse = {
  generationId: string;
  doll: Record<string, unknown> & { id: string };
};

export function parseDollPickHttpResponse(
  value: unknown,
  expectedGenerationId: string,
): DollPickHttpResponse | null {
  if (
    !UUID_RE.test(expectedGenerationId) ||
    !isExactObject(value, ["generationId", "doll"]) ||
    value.generationId !== expectedGenerationId ||
    !value.doll ||
    typeof value.doll !== "object" ||
    Array.isArray(value.doll) ||
    typeof (value.doll as Record<string, unknown>).id !== "string" ||
    !UUID_RE.test((value.doll as Record<string, unknown>).id as string)
  ) {
    return null;
  }
  return value as DollPickHttpResponse;
}
