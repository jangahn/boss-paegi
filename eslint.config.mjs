import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
// 금융 테이블 직접 쓰기·구 금융 RPC·logCreditEvent 금지(§13/§37) — 로컬 AST 룰(CommonJS default import).
import noDirectFinancialWrite from "./eslint-rules/no-direct-financial-write.js";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["app/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    plugins: {
      "boss-paegi": { rules: { "no-direct-financial-write": noDirectFinancialWrite } },
    },
    rules: { "boss-paegi/no-direct-financial-write": "error" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 스크래치 디렉토리(git 미추적, Development/CLAUDE.md) — 린트 제외.
    "_local/**",
    "_archive/**",
  ]),
]);

export default eslintConfig;
