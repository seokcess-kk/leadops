# 어댑터 실 API 검증 절차

> 설계서 11장: "가짜 응답만으로 완료 처리하지 않는다."
> 이 문서는 `verifiedAgainstLiveApi` 를 `false` → `true` 로 바꾸기 위한 절차다.

## 왜 필요한가

HIRA·공정위 어댑터의 **엔드포인트 경로·응답 필드명·코드값**은 공개 문서만으로
확정할 수 없었다. data.go.kr 은 스펙을 활용신청자에게만 주는 가이드 문서와
Swagger UI 로 제공한다.

코드값이 틀리면 **수집 자체가 조용히 빗나간다** — 에러 없이 엉뚱한 업종이 수집된다.
그래서 읽어서 확인하지 않고 **호출해서 확인한다**.

## 현재 상태

| 항목 | 상태 | 근거 |
|---|---|---|
| HIRA 엔드포인트 경로 | **부분 검증** | 잘못된 키로 호출 시 `hospInfoServicev2` 만 **401**(경로 존재 + 키 거부), 다른 후보는 500(미등록). `pnpm spike verify` 로 재현 가능 |
| HIRA 응답 필드명 | **미검증** | 실 키 필요 |
| `HIRA_CODES.cl_dental_clinic = 51` | **검증됨** | HIRA 자체 검색 URL: `srchClcd=41,01,21,11,51 & srchClcdNm=치과병원,상급종합,병원,종합병원,치과의원` |
| `HIRA_CODES.cl_dental_hospital = 41` | **검증됨** | 위와 동일 |
| `HIRA_CODES.cl_clinic = 31` | **약한 근거** | 커뮤니티 문서 다수에서 관찰 |
| `HIRA_CODES.dgsbjt_derm = 14` | **미검증** | 실 키 필요 |
| `HIRA_CODES.dgsbjt_plastic = 08` | **미검증** | 실 키 필요 |
| 공정위 엔드포인트 | **미검증** | 후보 3개 모두 500. 데이터셋별로 경로가 다르므로 가이드 문서 필요 |

## 1단계 — 키 발급

1. [data.go.kr](https://www.data.go.kr) 회원가입
2. 아래 데이터셋에 **활용신청** (자동승인, 보통 몇 분~2시간)
   - [건강보험심사평가원_병원정보서비스](https://www.data.go.kr/data/15001698/openapi.do) (15001698)
   - [공정거래위원회_가맹정보_브랜드 목록](https://www.data.go.kr/data/15125467/openapi.do) (15125467)
   - [공정거래위원회_가맹정보_브랜드별 가맹점 현황](https://www.data.go.kr/data/15110241/openapi.do) (15110241)
   - [국세청_사업자등록정보 진위확인 및 상태조회](https://www.data.go.kr/data/15081808/openapi.do) (15081808)
3. 마이페이지 → 오픈API → 인증키에서 **일반 인증키(Decoding)** 복사

> ❗ **Encoding 키가 아니라 Decoding 키**를 넣어야 한다.
> Encoding 키를 넣으면 이중 인코딩되어 `SERVICE_KEY_IS_NOT_REGISTERED_ERROR` 가 난다.

4. 활용신청 상세 화면에서 **가이드 문서(.docx/.hwp)** 를 내려받아 둔다.
   엔드포인트가 우리 후보와 다르면 그 문서의 "요청주소" 를 쓴다.

## 2단계 — 검증 실행

```bash
# .env
FEATURE_SOURCE=live
DATA_GO_KR_SERVICE_KEY=<Decoding 키>
```

```bash
pnpm spike verify
```

이 명령은:
1. 엔드포인트 후보를 순서대로 두드려 **실제로 응답하는 것**을 찾는다
2. 응답 필드가 `HiraHospitalItem` / `FtcBrandItem` 매핑과 맞는지 확인한다
3. **코드값을 경험적으로 검사한다** — `dgsbjtCd=14` 가 피부과라면 반환된 기관명
   대부분에 "피부과" 가 들어 있어야 한다
4. 실제 응답을 `fixtures/http/` 에 녹화한다

### 코드값 검사를 어떻게 읽는가

> **이것은 증명이 아니라 신호다.**
> 코드가 맞으면 보통 80% 이상, 틀리면 5% 미만으로 갈린다. 임계값은 50%다.
> 50~80% 구간이 나오면 표본을 늘려(`numOfRows`) 다시 보거나 사람이 직접 확인한다.

### 상태 코드 읽는 법

| HTTP | 뜻 |
|---|---|
| 401 | **경로는 맞다.** 키가 거부됨 → Decoding 키인지 확인 |
| 403 | 활용신청 승인 대기 중이거나 트래픽 한도 초과 |
| 404 | 경로 없음 |
| 500 | 대개 **미등록 서비스** — 경로가 틀렸거나 이 데이터셋을 활용신청하지 않음 |

## 3단계 — 결과 반영

### 통과한 경우

1. `hira.ts` / `ftc.ts` 의 `verifiedAgainstLiveApi = true`
2. `fixtures/http/*.json` 을 커밋 (`.gitignore` 에서 제외 해제)
3. 녹화된 fixture 로 매핑 회귀 테스트 추가
4. `pnpm spike universe` 로 실제 모집단 `U` 측정 → 소진 곡선 산출

### 실패한 경우

리포트가 알려주는 대로 고친다.

| 진단 | 조치 |
|---|---|
| 다른 후보가 동작 (warn) | `hira.ts` 의 `ENDPOINT` / `ftc.ts` 의 `ENDPOINTS` 를 그 값으로 |
| 필드명 불일치 | `HiraHospitalItem` / `FtcBrandItem` 을 관찰된 키에 맞춤 |
| 코드값 비율 낮음 | `HIRA_CODES` 수정 후 재실행 |
| 전 후보 500 | 가이드 문서의 요청주소를 후보 목록에 추가 |

**`verifiedAgainstLiveApi` 는 통과할 때까지 `false` 로 둔다.** 그래야 스파이크와
워커가 계속 경고한다. 이 플래그를 미리 켜는 것은 "가짜 응답으로 완료 처리"와 같다.

## 검증 도구 자체의 테스트

`packages/adapters/src/verify.test.ts` — 18개 테스트.
가짜 HttpClient 로 "응답이 이러이러할 때 진단이 올바른가" 를 검증한다.
실 API 호출은 하지 않는다(그건 `pnpm spike verify` 의 일이다).
