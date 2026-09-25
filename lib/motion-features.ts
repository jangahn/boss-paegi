// Motion 기능 묶음(v1.65) — `components/motion/MotionProvider.tsx` 가 하이드레이션 뒤 비동기로 불러온다(첫 로드는 `m` + LazyMotion
// 약 4.6KB 만). domAnimation = 애니메이션 · 퇴장(AnimatePresence) · 누름/호버 제스처. 레이아웃 애니메이션(domMax, +25KB)은 쓰지 않는다.
import { domAnimation } from "motion/react";

export default domAnimation;
