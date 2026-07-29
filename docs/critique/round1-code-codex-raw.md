# codex 코드 리뷰 라운드 1 — 원본

> 모델: gpt-5.6-sol · codex-cli 0.145.0 · 2026-07-29
> 대상: packages/ · apps/ 구현 (일부는 수정 이전 스냅샷)
> 판정은 docs/04-code-review-round1.md 참조

---

1. [SEVERITY: HIGH] 전역 동시성 제한은 응답 헤더까지만 유지되어, 느리거나 거대한 응답 본문은 제한 없이 동시에 처리된다. `packages/http/src/client.ts:138-144`에서 `#send()`가 헤더를 받자마자 limiter를 반납하고, 본문은 이후 `191-193`에서 읽는다. release를 본문 소비·폐기까지 포함하는 `try/finally` 바깥으로 이동하라.

2. [SEVERITY: HIGH] `totalTimeoutMs`는 전체 시간이 아니라 소켓 무활동 타임아웃이므로 slow-drip 응답이 영원히 연결을 점유할 수 있다. `packages/http/src/client.ts:259-261`의 `req.setTimeout()`은 트래픽마다 갱신되며 절대 deadline이 아니다. 요청 시작 시 별도 타이머/`AbortSignal.timeout()`을 만들고 응답 완료·오류 시 정리하라.

3. [SEVERITY: HIGH] 본문 크기 cap은 저장량만 제한하고 스트림·압축 해제를 중단하지 않아 압축 폭탄의 CPU·대역폭 소비가 사실상 무제한이다. `packages/http/src/client.ts:304-317`은 상한 이후 chunk를 버리면서도 callback으로 계속 진행하고, `320-322`의 pipeline은 EOF까지 돈다. cap 도달 즉시 upstream과 decompressor를 파괴하되 의도된 truncation을 별도 정상 결과로 처리하라.

4. [SEVERITY: HIGH] 공공데이터 `serviceKey`가 URL·오류·재시도 로그에 그대로 노출된다. `packages/adapters/src/dataGoKr.ts:49-55`가 키를 query에 넣은 전체 `url.href`를 전달하고, `packages/http/src/client.ts:120,166,174,260`은 그 URL을 로그와 예외에 포함한다. URL 로깅 전에 민감 query를 마스킹하고, serviceKey는 인코딩 여부를 정규화한 뒤 안전하게 추가하라.

5. [SEVERITY: HIGH] 원격 robots 패턴으로 생성되는 정규식은 중첩된 `.*` 때문에 ReDoS를 유발할 수 있다. `packages/http/src/robots.ts:91-103`은 공격자가 제공한 다수의 `*`를 그대로 `.*`로 만들고 `133-149`에서 요청 경로마다 실행한다. 연속 wildcard를 합치고 패턴 길이·wildcard 수를 제한하거나 선형시간 glob matcher로 교체하라.

6. [SEVERITY: MEDIUM] NAT64 검사가 `/96`이 아니라 사실상 `/32`여서 테스트 정책이 비-loopback IPv6까지 허용한다. `packages/http/src/ip.ts:228-230`은 첫 4바이트만 확인하므로 `64:ff9b:dead:beef::7f00:1`을 `nat64:loopback`으로 오분류하고, `packages/http/src/ssrf.ts:51-54`의 suffix 허용이 이를 통과시킨다. NAT64 prefix 12바이트를 검사하고 정책 완화는 reason 문자열 대신 원래 주소 자체가 `::1/128` 또는 mapped-loopback인지 재검증하라.

7. [SEVERITY: MEDIUM] RateLimiter의 슬롯 양도 사이에 새 acquire가 끼면 전역 상한을 초과한다. `packages/http/src/rateLimiter.ts:92-95`가 active를 먼저 감소시키고 waiter를 깨우며, 깨어난 waiter는 `83-90`에서 다시 증가시키므로 그 사이 신규 호출이 빈 슬롯을 선점할 수 있다. waiter가 있으면 카운트를 바꾸지 않고 슬롯 소유권만 직접 양도하라.

8. [SEVERITY: MEDIUM] robots의 UA 그룹 규칙과 crawl-delay가 서로 다른 선택 로직을 사용해 선택된 그룹의 delay가 무시된다. `packages/http/src/robots.ts:107-118`은 접두사 최장 그룹을 고르지만 `133-137`은 정확한 token 키 또는 `*`만 조회하므로 `LeadOpsBot/1.0`에 대한 `User-agent: LeadOpsBot` delay가 적용되지 않는다. 그룹 선택 함수가 규칙과 delay를 함께 반환하도록 통합하고 빈 user-agent도 거부하라.

9. [SEVERITY: MEDIUM] `redactPII`는 키 이름 휴리스틱 밖의 담당자명과 국제 전화번호를 그대로 통과시킨다. `packages/core/src/redact.ts:24,30-46,87-90` 때문에 `{owner:"김민수", tel:"+82-10-1234-5678"}`가 보존되며, `103-109`의 사후 assert는 전화번호조차 검사하지 않는다. 경계 DTO의 허용 필드 기반 직렬화와 대소문자 정규화 키 정책을 쓰고, 국제번호 및 전화번호 사후 검사를 추가하라.

10. [SEVERITY: MEDIUM] 운영 환경에서 `NODE_ENV`가 빠지면 mock이 기본값으로 조용히 부팅된다. `packages/core/src/env.ts:28-31`은 각각 `development`와 `mock`을 기본값으로 두며, production 차단은 `56-64`에서 명시적으로 production인 경우에만 동작한다. 배포 진입점에서는 두 값을 필수화하고 mock factory 자체도 production 런타임 검사를 수행하라.

11. [SEVERITY: LOW] malformed data.go.kr 성공 응답이 정상적인 빈 결과로 fail-open 된다. `packages/adapters/src/dataGoKr.ts:77-90`은 header/resultCode 또는 body가 없어도 성공으로 처리하며, `packages/adapters/src/adapters.test.ts:36`의 “body 자체가 없어도 죽지 않는다” 테스트는 이 고장을 명시적으로 정상화한다. 성공 응답에는 `header.resultCode === "00"`과 객체 body를 요구하라.

12. [SEVERITY: LOW] SSRF 기본정책 테스트 하나는 IP 차단 구현이 깨져도 통과한다. `packages/http/src/client.test.ts:245-247`은 임의 포트 loopback을 사용해 포트 검사에서 먼저 실패하므로 loopback 분류를 검증하지 않는다. 허용 포트의 로컬 서버 또는 주입 resolver/transport로 실제 IP 판정 경로를 단독 검증하고, protocol-relative redirect·keep-alive 재사용·slow-drip·손상 압축·getter/Map/TypedArray redaction 테스트도 추가하라.

견고: IPv4 CIDR의 `+96` 계산(`packages/http/src/ip.ts:158-176`), 6to4의 bytes 2..6 추출(`232-234`), 상대·protocol-relative·cross-protocol redirect의 홉별 재검증(`packages/http/src/client.ts:131-157`)은 올바르다.
180,808
1. [SEVERITY: HIGH] 전역 동시성 제한은 응답 헤더까지만 유지되어, 느리거나 거대한 응답 본문은 제한 없이 동시에 처리된다. `packages/http/src/client.ts:138-144`에서 `#send()`가 헤더를 받자마자 limiter를 반납하고, 본문은 이후 `191-193`에서 읽는다. release를 본문 소비·폐기까지 포함하는 `try/finally` 바깥으로 이동하라.

2. [SEVERITY: HIGH] `totalTimeoutMs`는 전체 시간이 아니라 소켓 무활동 타임아웃이므로 slow-drip 응답이 영원히 연결을 점유할 수 있다. `packages/http/src/client.ts:259-261`의 `req.setTimeout()`은 트래픽마다 갱신되며 절대 deadline이 아니다. 요청 시작 시 별도 타이머/`AbortSignal.timeout()`을 만들고 응답 완료·오류 시 정리하라.

3. [SEVERITY: HIGH] 본문 크기 cap은 저장량만 제한하고 스트림·압축 해제를 중단하지 않아 압축 폭탄의 CPU·대역폭 소비가 사실상 무제한이다. `packages/http/src/client.ts:304-317`은 상한 이후 chunk를 버리면서도 callback으로 계속 진행하고, `320-322`의 pipeline은 EOF까지 돈다. cap 도달 즉시 upstream과 decompressor를 파괴하되 의도된 truncation을 별도 정상 결과로 처리하라.

4. [SEVERITY: HIGH] 공공데이터 `serviceKey`가 URL·오류·재시도 로그에 그대로 노출된다. `packages/adapters/src/dataGoKr.ts:49-55`가 키를 query에 넣은 전체 `url.href`를 전달하고, `packages/http/src/client.ts:120,166,174,260`은 그 URL을 로그와 예외에 포함한다. URL 로깅 전에 민감 query를 마스킹하고, serviceKey는 인코딩 여부를 정규화한 뒤 안전하게 추가하라.

5. [SEVERITY: HIGH] 원격 robots 패턴으로 생성되는 정규식은 중첩된 `.*` 때문에 ReDoS를 유발할 수 있다. `packages/http/src/robots.ts:91-103`은 공격자가 제공한 다수의 `*`를 그대로 `.*`로 만들고 `133-149`에서 요청 경로마다 실행한다. 연속 wildcard를 합치고 패턴 길이·wildcard 수를 제한하거나 선형시간 glob matcher로 교체하라.

6. [SEVERITY: MEDIUM] NAT64 검사가 `/96`이 아니라 사실상 `/32`여서 테스트 정책이 비-loopback IPv6까지 허용한다. `packages/http/src/ip.ts:228-230`은 첫 4바이트만 확인하므로 `64:ff9b:dead:beef::7f00:1`을 `nat64:loopback`으로 오분류하고, `packages/http/src/ssrf.ts:51-54`의 suffix 허용이 이를 통과시킨다. NAT64 prefix 12바이트를 검사하고 정책 완화는 reason 문자열 대신 원래 주소 자체가 `::1/128` 또는 mapped-loopback인지 재검증하라.

7. [SEVERITY: MEDIUM] RateLimiter의 슬롯 양도 사이에 새 acquire가 끼면 전역 상한을 초과한다. `packages/http/src/rateLimiter.ts:92-95`가 active를 먼저 감소시키고 waiter를 깨우며, 깨어난 waiter는 `83-90`에서 다시 증가시키므로 그 사이 신규 호출이 빈 슬롯을 선점할 수 있다. waiter가 있으면 카운트를 바꾸지 않고 슬롯 소유권만 직접 양도하라.

8. [SEVERITY: MEDIUM] robots의 UA 그룹 규칙과 crawl-delay가 서로 다른 선택 로직을 사용해 선택된 그룹의 delay가 무시된다. `packages/http/src/robots.ts:107-118`은 접두사 최장 그룹을 고르지만 `133-137`은 정확한 token 키 또는 `*`만 조회하므로 `LeadOpsBot/1.0`에 대한 `User-agent: LeadOpsBot` delay가 적용되지 않는다. 그룹 선택 함수가 규칙과 delay를 함께 반환하도록 통합하고 빈 user-agent도 거부하라.

9. [SEVERITY: MEDIUM] `redactPII`는 키 이름 휴리스틱 밖의 담당자명과 국제 전화번호를 그대로 통과시킨다. `packages/core/src/redact.ts:24,30-46,87-90` 때문에 `{owner:"김민수", tel:"+82-10-1234-5678"}`가 보존되며, `103-109`의 사후 assert는 전화번호조차 검사하지 않는다. 경계 DTO의 허용 필드 기반 직렬화와 대소문자 정규화 키 정책을 쓰고, 국제번호 및 전화번호 사후 검사를 추가하라.

10. [SEVERITY: MEDIUM] 운영 환경에서 `NODE_ENV`가 빠지면 mock이 기본값으로 조용히 부팅된다. `packages/core/src/env.ts:28-31`은 각각 `development`와 `mock`을 기본값으로 두며, production 차단은 `56-64`에서 명시적으로 production인 경우에만 동작한다. 배포 진입점에서는 두 값을 필수화하고 mock factory 자체도 production 런타임 검사를 수행하라.

11. [SEVERITY: LOW] malformed data.go.kr 성공 응답이 정상적인 빈 결과로 fail-open 된다. `packages/adapters/src/dataGoKr.ts:77-90`은 header/resultCode 또는 body가 없어도 성공으로 처리하며, `packages/adapters/src/adapters.test.ts:36`의 “body 자체가 없어도 죽지 않는다” 테스트는 이 고장을 명시적으로 정상화한다. 성공 응답에는 `header.resultCode === "00"`과 객체 body를 요구하라.

12. [SEVERITY: LOW] SSRF 기본정책 테스트 하나는 IP 차단 구현이 깨져도 통과한다. `packages/http/src/client.test.ts:245-247`은 임의 포트 loopback을 사용해 포트 검사에서 먼저 실패하므로 loopback 분류를 검증하지 않는다. 허용 포트의 로컬 서버 또는 주입 resolver/transport로 실제 IP 판정 경로를 단독 검증하고, protocol-relative redirect·keep-alive 재사용·slow-drip·손상 압축·getter/Map/TypedArray redaction 테스트도 추가하라.

견고: IPv4 CIDR의 `+96` 계산(`packages/http/src/ip.ts:158-176`), 6to4의 bytes 2..6 추출(`232-234`), 상대·protocol-relative·cross-protocol redirect의 홉별 재검증(`packages/http/src/client.ts:131-157`)은 올바르다.
