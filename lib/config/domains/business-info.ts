import { z } from "zod";
import type { DomainEntry } from "../registry";

// 사업자정보 도메인 — PG(카드사)·카카오페이 입점 심사 요건: 상호·사업자번호·대표자·주소·유선전화(휴대폰 불가)를
// 메인 + 결제페이지에 상시 노출(사업자등록증과 일치 필수). 통신판매업 번호는 일부 카드사(KB국민) 필수.
// 유일 소비처 = 전역 SiteFooter. 0061 로 site_content(소개·FAQ)에서 분리 — 발행단위(CAS)·변경이력 독립.
export const businessInfoSchema = z.object({
  companyName: z.string().trim().min(1).max(60),
  ownerName: z.string().trim().min(1).max(30),
  bizRegNo: z.string().trim().min(1).max(20),
  /** 통신판매업 신고번호 — 신고 완료 전 빈 값 허용(노출 시 생략). */
  mailOrderNo: z.string().trim().max(40),
  address: z.string().trim().min(1).max(120),
  /** 유선번호만 가능(휴대폰 불가) — 카카오페이 입점 요건. */
  phone: z.string().trim().min(1).max(20),
  email: z.string().trim().min(3).max(120),
});

// 도메인 value = { info?: ... } — 미설정(빈 객체)을 값 안에 인코딩(codeDefault 는 T 필수).
// info 가 있으면 전 필드 검증(부분 입력 발행 차단), 없으면 푸터 비노출.
export const businessInfoConfigSchema = z.object({
  info: businessInfoSchema.optional(),
});

export type BusinessInfo = z.infer<typeof businessInfoSchema>;
export type BusinessInfoConfig = z.infer<typeof businessInfoConfigSchema>;

/** 미설정 = 푸터 비노출(심사 전 준비 단계) — 콘솔에서 채워 발행하면 즉시 노출. */
export const BUSINESS_INFO_DEFAULT: BusinessInfoConfig = {};

export const businessInfoEntry: DomainEntry<BusinessInfoConfig> = {
  schema: businessInfoConfigSchema,
  codeDefault: BUSINESS_INFO_DEFAULT,
};
