#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# 백업·복구 리허설 (Phase 7 완료 기준 — "DB 복구 리허설 1회")
#
# ❗ **복원해 보지 않은 백업은 백업이 아니다.** 이 스크립트는 덤프를 만들고, 비어 있는
#    데이터베이스에 복원한 뒤, 원본과 대조한다. 대조하지 않으면 "복원 명령이 성공했다" 는
#    사실만 알 수 있고 그것은 데이터가 돌아왔다는 뜻이 아니다.
#
# 확인하는 것:
#   1. 덤프가 만들어지고 크기가 0 이 아니다
#   2. 빈 DB 에 복원이 끝난다
#   3. 테이블별 행 수가 원본과 같다
#   4. **RLS·정책·GRANT·함수가 함께 복원된다** — 이것이 빠지면 복원된 DB 는 무방비다
#   5. 복원본에서 규칙이 여전히 강제된다 (익명 SELECT 차단)
#
# 사용법:
#   scripts/restore-rehearsal.sh [SOURCE_DSN]
#   기본 SOURCE_DSN: postgres://postgres:leadops@127.0.0.1:55432/leadops
#
# 필요:
#   pg_dump · pg_restore · psql (컨테이너 안의 것을 쓰므로 로컬 설치 불필요)
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

SOURCE_DSN="${1:-postgres://postgres:leadops@127.0.0.1:55432/leadops}"
CONTAINER="${LEADOPS_PG_CONTAINER:-leadops-pg}"
STAMP="$(date +%Y%m%d_%H%M%S)"
RESTORE_DB="leadops_restore_${STAMP}"
DUMP_PATH="/tmp/leadops_${STAMP}.dump"

# 컨테이너 안에서 실행한다 — 클라이언트 버전이 서버와 어긋나 실패하는 일을 없앤다.
# (pg_dump 는 서버보다 오래된 클라이언트를 거부한다.)
#
# ❗ `MSYS_NO_PATHCONV=1` 이 필요하다. Git Bash 는 `/tmp/x.dump` 같은 인자를
#    `C:/Users/.../tmp/x.dump` 로 **바꿔서** 전달하고, 그러면 컨테이너 안에 없는 경로가 된다.
pg() { MSYS_NO_PATHCONV=1 docker exec -i "$CONTAINER" "$@"; }

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# 원본 DB 이름을 DSN 에서 뽑는다.
SOURCE_DB="${SOURCE_DSN##*/}"
SOURCE_DB="${SOURCE_DB%%\?*}"

say "1/6  원본 확인 — ${SOURCE_DB}"
pg psql -U postgres -d "$SOURCE_DB" -tAc "select 'ok'" >/dev/null
SOURCE_SIZE=$(pg psql -U postgres -d "$SOURCE_DB" -tAc "select pg_database_size(current_database())")
echo "     크기: ${SOURCE_SIZE} bytes"

say "2/6  덤프 생성"
# custom 형식(-Fc)을 쓴다. 병렬 복원이 가능하고 선택 복원도 된다.
pg pg_dump -U postgres -d "$SOURCE_DB" -Fc -f "$DUMP_PATH"
DUMP_SIZE=$(pg stat -c %s "$DUMP_PATH")
if [ "$DUMP_SIZE" -lt 1024 ]; then
  echo "     ✗ 덤프가 너무 작습니다 (${DUMP_SIZE} bytes). 실패로 처리합니다." >&2
  exit 1
fi
echo "     ${DUMP_PATH} (${DUMP_SIZE} bytes)"

say "3/6  빈 DB 에 복원 — ${RESTORE_DB}"
pg psql -U postgres -d postgres -c "create database \"${RESTORE_DB}\"" >/dev/null
# ❗ 역할은 클러스터 전역이라 덤프에 없다. 원본과 같은 클러스터에 복원하므로 이미 존재한다.
#    다른 클러스터로 옮길 때는 `pg_dumpall --roles-only` 를 먼저 적용해야 한다 (runbook 참고).
pg pg_restore -U postgres -d "$RESTORE_DB" --no-owner --exit-on-error "$DUMP_PATH"

say "4/6  테이블별 행 수 대조"
count_sql="select table_name, (xpath('/row/c/text()',
             query_to_xml(format('select count(*) as c from public.%I', table_name),
             false, true, '')))[1]::text::bigint as n
           from information_schema.tables
           where table_schema = 'public' and table_type = 'BASE TABLE'
           order by table_name"

SRC_COUNTS=$(pg psql -U postgres -d "$SOURCE_DB"  -tAF'|' -c "$count_sql")
DST_COUNTS=$(pg psql -U postgres -d "$RESTORE_DB" -tAF'|' -c "$count_sql")

if [ "$SRC_COUNTS" != "$DST_COUNTS" ]; then
  echo "     ✗ 행 수가 다릅니다." >&2
  diff <(echo "$SRC_COUNTS") <(echo "$DST_COUNTS") || true
  pg psql -U postgres -d postgres -c "drop database if exists \"${RESTORE_DB}\" with (force)" >/dev/null
  exit 1
fi
TABLES=$(echo "$SRC_COUNTS" | wc -l | tr -d ' ')
ROWS=$(echo "$SRC_COUNTS" | awk -F'|' '{s+=$2} END {print s}')
echo "     테이블 ${TABLES}개 · 행 ${ROWS}개 일치"

say "5/6  보안 객체 복원 확인 (RLS · 정책 · 함수 · GRANT)"
check() {
  local label="$1" sql="$2"
  local src dst
  src=$(pg psql -U postgres -d "$SOURCE_DB"  -tAc "$sql")
  dst=$(pg psql -U postgres -d "$RESTORE_DB" -tAc "$sql")
  if [ "$src" != "$dst" ]; then
    echo "     ✗ ${label}: 원본 ${src} / 복원 ${dst}" >&2
    return 1
  fi
  echo "     ${label}: ${dst}"
}

FAILED=0
# ❗ RLS 가 켜진 테이블 수. 복원본에서 꺼져 있으면 그 DB 는 무방비다.
check "RLS 활성 테이블" \
  "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relrowsecurity" || FAILED=1
check "RLS 정책" \
  "select count(*) from pg_policies where schemaname='public'" || FAILED=1
check "SECURITY DEFINER 함수" \
  "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef" || FAILED=1
check "authenticated 쓰기 GRANT (0이어야 한다)" \
  "select count(*) from information_schema.role_table_grants where grantee='authenticated' and table_schema='public' and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')" || FAILED=1

say "6/6  복원본에서 규칙이 여전히 강제되는지"
#
# 익명(anon) 역할로 검수 후보를 읽으려 해 본다.
#
# ❗ 통과 조건이 둘이다. 이 저장소는 정책과 GRANT 를 **두 겹**으로 두므로:
#     - `permission denied`  GRANT 조차 없다 (더 강한 결과)
#     - `0`                  GRANT 는 있으나 정책이 전부 걸러 냈다
#    행이 하나라도 나오면 RLS·GRANT 가 복원되지 않은 것이다.
ANON_OUT=$(pg psql -U postgres -d "$RESTORE_DB" -tAc "
  begin;
  set local role anon;
  select count(*) from review_items;
  rollback;" 2>&1 || true)

if printf '%s' "$ANON_OUT" | grep -q 'permission denied'; then
  echo "     익명 SELECT 차단 확인 (GRANT 없음 — permission denied)"
elif [ "$(printf '%s' "$ANON_OUT" | tail -1 | tr -d '[:space:]')" = "0" ]; then
  echo "     익명 SELECT 차단 확인 (정책이 전부 차단 — 0행)"
else
  echo "     ✗ 익명 역할이 review_items 를 읽었습니다 — RLS·GRANT 가 복원되지 않았습니다." >&2
  echo "       출력: ${ANON_OUT}" >&2
  FAILED=1
fi

say "정리"
pg psql -U postgres -d postgres -c "drop database if exists \"${RESTORE_DB}\" with (force)" >/dev/null
pg rm -f "$DUMP_PATH"
echo "     복원 DB·덤프 삭제 완료"

if [ "$FAILED" -ne 0 ]; then
  printf '\n\033[31m✗ 리허설 실패 — 위 항목을 확인하세요.\033[0m\n\n'
  exit 1
fi

printf '\n\033[32m✓ 복구 리허설 통과\033[0m  (%s → %s, 테이블 %s개 · 행 %s개)\n\n' \
  "$SOURCE_DB" "$RESTORE_DB" "$TABLES" "$ROWS"
