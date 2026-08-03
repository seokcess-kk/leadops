# Supabase Auth 연동 — 설계

2026-07-31 · "아직 없는 것" 의 Supabase Auth 항목. 발주자 결정: **이메일+비밀번호** ·
**자가가입 없음**(계정은 대시보드에서 생성) · **dev login 경로 유지**(가드 그대로 — E2E 격리) ·
**A안: 서버 전용 Auth**.

## 확인된 전제 (2026-07-31)

- Supabase 프로젝트 배포 완료 (마이그레이션 0016까지 · RLS·시드·RPC 검증됨).
- **legacy HS256 체계** — anon key 헤더 디코드로 확인. 검수 API 의 HS256 검증(`jwt.ts`)
  무변경. 스테이징 검증에서 실 access token 의 `alg` 를 재확증한다.
- `on_auth_user_created` 트리거(0003)가 Supabase `auth.users` 에 적용돼 있다 —
  사용자가 생기면 `profiles` 가 자동 생성된다.
- E2E 는 `LEADOPS_DEV_LOGIN` 경로로 인증한다 — 이 경로를 유지해야 E2E 가 실 Supabase 에
  의존하지 않는다 (token.ts 의 "Auth 붙으면 삭제" 주석은 이 결정으로 대체된다).

## 원칙 — 토큰은 여전히 브라우저에 내려가지 않는다

표준 `@supabase/ssr` 브라우저 클라이언트 패턴(기각한 B안)은 세션 쿠키를 JS 로 읽는다 —
XSS 하나로 검수 권한이 유출되는 경로가 생긴다. 이 저장소가 게이트웨이 프록시를 둔 이유와
정면 충돌하므로, **Supabase 클라이언트를 서버에만 둔다**:

- 로그인·로그아웃·세션 읽기는 전부 서버(route handler·middleware)에서
- 세션 쿠키는 **httpOnly** — 브라우저 JS 가 읽을 수 없다
- 브라우저 번들에 `@supabase/supabase-js` 불포함, `SUPABASE_URL`·`SUPABASE_ANON_KEY` 는
  서버 전용 env (NEXT_PUBLIC 접두사를 쓰지 않는다)

## 인증 흐름

```
POST /api/auth/login  (route handler · 서버)
  body: { email, password }
  → createServerClient(@supabase/ssr, httpOnly 쿠키 어댑터).signInWithPassword
  → 성공: 세션 쿠키 세팅 → { ok: true } (클라이언트가 /today 로 이동)
  → 실패: 401 + { error: { code, message } } — 화면은 코드와 함께 표시 (가짜 성공 없음)

POST /api/auth/logout (route handler · 서버)
  → signOut → 쿠키 제거 → { ok: true } (클라이언트가 /login 으로 이동)

middleware.ts (신설)
  → 세션 확인·만료 임박 시 리프레시(Set-Cookie 갱신, httpOnly 유지)
  → 세션도 dev login 도 없으면 /login 리다이렉트
  → 예외 경로: /login, /api/auth/*, /api/gateway/* (게이트웨이는 자체 401), _next 정적

sessionToken() (token.ts 개편 · async 로 변경)
  1) Supabase 세션 쿠키의 access_token — 있으면 항상 우선
  2) 없으면 기존 dev 경로 (NODE_ENV≠production + LEADOPS_DEV_LOGIN=1 + DEV_USER_ID) — 가드 무변경
  3) 둘 다 없으면 AuthUnavailableError → 게이트웨이가 401 auth_unavailable
```

- dev login 이 켜져 있어도 **Supabase 세션이 있으면 세션이 이긴다** — 스테이징 검증에서
  두 경로가 섞이지 않게 하는 규칙이다.
- middleware 의 dev login 인지: `LEADOPS_DEV_LOGIN=1` 이면 리다이렉트하지 않는다
  (E2E·로컬 개발이 로그인 화면에 막히면 안 된다).

## taimen 변경

| 파일 | 내용 |
|---|---|
| `package.json` | `@supabase/ssr` · `@supabase/supabase-js` 추가 (서버 코드에서만 import) |
| `src/lib/server/supabase.ts` (신설) | httpOnly 쿠키 어댑터를 쓰는 `createServerClient` 팩토리 — route handler 용 (middleware 는 next/headers 불가라 자체 쿠키 어댑터) |
| `src/lib/server/token.ts` | `sessionToken()` async 개편 (우선순위 위 참조) · "삭제한다" 주석을 유지 결정으로 갱신 |
| `src/app/api/auth/login/route.ts` (신설) | POST 로그인 |
| `src/app/api/auth/logout/route.ts` (신설) | POST 로그아웃 |
| `src/app/login/page.tsx` (신설) | 이메일+비번 폼 — 디자인 토큰(`globals.css @theme`)·타이포 관례 준수, 오류는 코드와 함께, 가입 링크 없음 |
| `middleware.ts` (신설) | 세션 리프레시 + 비로그인 가드 |
| `src/app/api/gateway/[...path]/route.ts` | `sessionToken()` await 반영 |
| `src/components/shell/Sidebar.tsx` | 사용자 블록에 로그아웃 버튼 (POST /api/auth/logout → /login) |

- env: `SUPABASE_URL` · `SUPABASE_ANON_KEY` (서버 전용, `taimen/.env.local` — 커밋 금지).
  없으면 Supabase 경로가 조용히 꺼지는 게 아니라 **세션 확인 시도 자체를 건너뛰고**
  dev 경로/401 로 흐른다 — 로컬 개발은 이 env 없이 지금처럼 동작한다.
- 카피 규정 준수: 로그인 화면에 "검색 노출·순위·점유율" 계열 표현 없음 (해당 화면 무관하나 규정 명시).

## 검수 API · DB — 무변경

상한·쿼터·게이트·RLS 는 전부 DB 에 있고 API 는 HS256 `sub` 만 신뢰한다. Supabase 세션의
`sub` 는 `auth.users.id` = `profiles.id` 이므로 기존 RLS·RPC 가 그대로 동작한다.

## 운영 절차 (코드 밖 · 이 작업의 일부로 수행)

1. (발주자) Supabase Dashboard → Authentication → **Add user** 로 `seokcess@glitzy.kr`
   생성 (비밀번호 지정, 자동 확인 체크)
2. (컨트롤러) `profiles` 자동 생성 확인 → 런북 1.2 승격 SQL 을 Supabase 에 실행:
   `update public.profiles set role = 'admin' where email = 'seokcess@glitzy.kr';`
3. 런북 1.3 표에 taimen 의 `SUPABASE_URL`·`SUPABASE_ANON_KEY` 행 추가

## 검증

- **단위** (vitest — taimen 은 테스트 러너가 없으므로 순수 로직을 루트로 빼지 않고,
  게이트는 typecheck + E2E + 스테이징으로 잡는다. `sessionToken()` 우선순위는 E2E(dev 경로)와
  스테이징(세션 경로)이 각각 실증한다)
- **E2E 회귀**: 기존 13+1건 그대로 green (dev 경로 유지 확인 — 사이드바 이메일 단정 포함)
- **스테이징 검증 (완료 기준)**: 로컬 taimen+API 를 Supabase(DB·Auth·prod JWT secret)로
  구성해 브라우저에서 — 실로그인 → `/today` 진입 → 사이드바에 실계정·역할(admin) 표시 →
  게이트웨이 경유 검수 API 200 → 로그아웃 → `/login` 리다이렉트. 이 과정에서 실 access
  token 의 `alg=HS256` 확증
- middleware 가드: 비로그인 + dev login off 상태에서 `/today` 접근 → `/login` 리다이렉트

## 범위 밖

- taimen·API 의 실서버 배포 (VPS·호스팅 — 배포 트랙 별도)
- 비밀번호 재설정 셀프서비스 (대시보드에서 관리자가 처리 — 소수 인원)
- MFA · OAuth 소셜 로그인

## 부기 — 스테이징 검증 결과 (2026-08-03)

"확인된 전제"의 **legacy HS256 판단은 사용자 토큰에는 성립하지 않았다.** anon key 는
legacy 형식이지만 이 프로젝트는 JWT signing keys 체계라 사용자 access token 을
**ES256**(P-256, JWKS 공개)으로 서명한다 — 이 문서가 예고한 재확증 게이트가 스테이징
관통 검증에서 이를 잡아냈다 (전 게이트웨이 요청 401 로 발현).

대응(발주자 승인): 검수 API `jwt.ts` 에 ES256 검증을 추가했다 — alg 허용 목록
(HS256=공유 시크릿·dev/E2E, ES256=`SUPABASE_JWT_PUBLIC_JWK` 정적 주입 공개키),
alg 마다 고정 키 하나라 혼동 공격이 성립하지 않는다. "검수 API 무변경" 항목은 이
결정으로 대체된다.

관통 확인: 실로그인 → `/today` → 사이드바 실계정·admin 표시 → 게이트웨이 경유
검수 API 전 라우트 200 (`/api/me`·leads·review·settings·runs·costs) → 로그아웃
리다이렉트. profiles 자동 생성·admin 승격(런북 1.2)도 실환경에서 확인.
