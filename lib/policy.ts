export const CONSENT_ITEMS = [
  {
    id: "own-image",
    label: "업로드하는 이미지는 본인이 직접 찍었거나 사용 권한이 있는 이미지입니다.",
  },
  {
    id: "no-harassment",
    label: "타인을 비방·괴롭힘·위협할 목적으로 사용하지 않습니다.",
  },
  {
    id: "characterization",
    label: "이미지가 캐릭터로 변형되어 게임에 등장하는 것에 동의합니다.",
  },
  {
    id: "age-14",
    label: "본인은 만 14세 이상입니다. (만 14세 미만은 서비스를 이용할 수 없습니다.)",
  },
] as const;

export const POLICY_NOTICE = {
  imageRetention:
    "업로드한 원본 이미지는 인형 생성이 끝나는 즉시 자동으로 폐기되며, 캐릭터화된 결과 이미지만 저장됩니다.",
  characterization:
    "생성되는 인형은 실제 인물과 가능한 한 닮지 않도록 강하게 캐릭터화됩니다.",
  prohibition:
    "타인 비방·괴롭힘·명예훼손·협박 등 위법 목적의 사용은 금지되며, 위반 시 계정/생성물이 제한될 수 있습니다.",
} as const;

export const SERVICE_NAME = "부장님 패기";
