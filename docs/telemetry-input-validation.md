# 공개 텔레메트리 입력 검증 계약

`POST /api/telemetry`는 익명 플레이도 받는 공개 라우트다. 아래 검증을 모두 통과한 요청만 인증 판별과 DB-authoritative quota를 포함한 `ingest_telemetry_delta` RPC로 넘긴다. 정상 클라이언트는 `TelemetryCollector`가 만든 정수 `seq`와 `Date#toISOString()` 값을 보내므로 별도 변경이 없다. actor/global/new-session quota와 보존 계약은 [`public-write-quotas.md`](public-write-quotas.md)에 있다.

인증 판별은 analytics owner와 submitter를 분리한다. 회원 row만 raw `owner_id`를 저장하고, 익명·동의 전 사용자는 `owner_id=null`을 유지한 채 세션별 `sha256(session_id:Auth subject)` binding만 저장한다. 점수 연결과 익명→회원 이전은 이 exact binding을 다시 검증하며, UUID만 아는 다른 사용자는 세션을 claim할 수 없다. 익명 이전은 점수·텔레메트리 쓰기와 같은 사용자 잠금을 공유하고 영구 receipt를 남기므로, 이전 완료 뒤 old Auth 삭제 전의 late write도 `account_migrated`로 차단한다.

## 요청 본문

- 상한은 UTF-8 기준 정확히 `64 * 1024`바이트(65,536바이트)이며 경계값은 허용한다.
- 유효한 `Content-Length`가 상한을 넘으면 body를 읽거나 DB를 호출하기 전에 `413 payload_too_large`를 반환한다.
- `Content-Length`가 없거나 실제 크기와 다를 수 있으므로 stream을 읽는 동안 실제 바이트 수도 다시 제한한다. JavaScript 문자열 길이는 용량 판정에 쓰지 않는다.
- 잘못된 `Content-Length`, stream 읽기 실패, 유효하지 않은 UTF-8은 `400 bad_body`, JSON 구문 오류는 `400 bad_json`이다.

## 순서 번호

- 각 이벤트의 `seq`는 PostgreSQL `integer` 범위인 `-2,147,483,648..2,147,483,647`의 정수만 허용한다. 범위 밖·소수·비유한 값 이벤트는 RPC에 전달하지 않는다.
- 누적 진행도를 나타내는 `summary.seqHigh`는 단조 증가 의미에 맞게 `0..2,147,483,647`의 정수만 허용한다. 이 필드가 잘못되면 payload 전체를 `400 invalid_payload`로 거부한다.
- 입력값을 반올림하지 않으므로 서로 다른 외부 값이 같은 `seq`로 합쳐지지 않는다.
- DB `integer`/`bigint`로 저장되는 duration·score·hit/combo/count/APM/refreshHz와 dimension 집계는 bounded integer로 먼저 정규화한다. 프레임 시간·DPR·비율처럼 연속량인 필드는 유한 범위의 소수를 보존한다.

## RPC 응답

- `{ok, mode}`는 필수이고 `mode`는 `full|summary|off`만 허용한다. `reason`과 `lastSeq`도 문자열 길이·PostgreSQL 정수 범위를 검증한다.
- RPC가 오류 없이 resolve했더라도 `null`·빈 객체·부분/타입혼동 응답을 ingest 성공으로 해석하지 않는다.
- 권위 DB가 확정한 hard quota·ownership·budget 거절만 terminal `200 {ok:true,mode:"off",reason,lastSeq}`로 변환한다. RPC resolved error·throw·malformed ACK·secret 부재·`quota_busy`는 `503 + Retry-After: 1`이며 `lastSeq`를 보내지 않는다. 브라우저는 미확정 delta를 보존하고 1~60초 bounded backoff 뒤 재시도한다.
- Auth/profile/member 권위 조회 실패도 `503` fail-closed이며 탈퇴 계정은 `403`이다. 서버 로그에는 원본 Auth UUID/IP/HMAC actor를 넣지 않는다.

## 시간값

- `startedAt`은 필수이며, `summary.endedAt`은 `null` 또는 timezone(`Z`/offset)을 포함한 유효한 ISO timestamp여야 한다.
- 달력에 없는 날짜, timezone 없는 문자열, 유효하지 않은 시·분·초/offset은 거부한다. 통과한 값은 UTC millisecond ISO 문자열로 정규화한다.
- 서버 수신 시각을 기준으로 `[현재-24시간, 현재+5분]` 범위(양 끝 포함)만 허용한다. 최대 30분 게임과 일반적인 클라이언트 시계 오차를 포함하면서 임의의 과거·미래 DB 시각을 막는 창이다.
- `endedAt`이 있으면 `startedAt`보다 빠를 수 없다.

## 회귀 검증

프로덕션 서비스나 DB를 호출하지 않는 경계·결정적 표본 테스트:

```sh
node --test __tests__/telemetry/input-validation.test.ts

# Node 22.6~22.17
node --experimental-strip-types --test __tests__/telemetry/input-validation.test.ts
```

테스트는 PostgreSQL 정수 양 끝, 결정적 정수 표본, discrete/continuous 정규화, RPC ACK 타입혼동, 시간 창 ±1ms, ASCII/한글 UTF-8 64KB 경계, `Content-Length` 조기 거부와 route 응답을 확인한다.
