/**
 * 미리 만들어진 부장님 template 캐릭터들. 각 template 의 스타일/구도/비율을 기준으로
 * 사용자 얼굴 identity 를 입히는 multi-reference 생성에 사용.
 *
 * 새 template 추가: Supabase Storage 의 dolls/templates/ 폴더에 PNG 업로드 +
 * 이 배열에 추가.
 */

export type TemplateKey =
  | "plush"
  | "illustration"
  | "clay"
  | "vinyl"
  | "pixar";

type TemplateMeta = {
  key: TemplateKey;
  label: string;
  /** Supabase Storage 의 dolls/templates/ 안 파일명 */
  file: string;
  /** 짧은 영문 hint — prompt 에 스타일 강화용 */
  styleHint: string;
};

export const TEMPLATES: ReadonlyArray<TemplateMeta> = [
  {
    key: "plush",
    label: "솜 인형",
    file: "template-01-plush.png",
    styleHint: "soft plush fabric doll texture, felt material",
  },
  {
    key: "illustration",
    label: "일러스트",
    file: "template-02-illustration.png",
    styleHint: "flat 2D cartoon illustration with crisp outlines",
  },
  {
    key: "clay",
    label: "클레이",
    file: "template-03-clay.png",
    styleHint: "stop-motion clay/plasticine sculpture texture",
  },
  {
    key: "vinyl",
    label: "비닐 피규어",
    file: "template-04-vinyl.png",
    styleHint: "glossy vinyl figurine, smooth plastic shine",
  },
  {
    key: "pixar",
    label: "3D 화난 부장님",
    file: "template-05-pixar.png",
    styleHint: "Pixar-style 3D rendered character, expressive angry face",
  },
];

export const DEFAULT_TEMPLATE_KEY: TemplateKey = "plush";

/** Supabase public URL 빌드. NEXT_PUBLIC_SUPABASE_URL 만 있으면 server/client 양쪽 OK. */
export function templateUrl(file: string): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required");
  return `${base}/storage/v1/object/public/dolls/templates/${file}`;
}

export function resolveTemplate(key?: string | null) {
  const found = TEMPLATES.find((t) => t.key === key);
  const meta = found ?? TEMPLATES.find((t) => t.key === DEFAULT_TEMPLATE_KEY)!;
  return { ...meta, url: templateUrl(meta.file) };
}
