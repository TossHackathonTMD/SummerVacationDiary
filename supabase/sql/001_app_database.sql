-- 나의 여름방학 일기 · Supabase database bootstrap
--
-- 이 파일은 Supabase SQL Editor에서 한 번에 실행할 수 있습니다.
-- 기존 diary_ai_rate_limits 데이터는 삭제하지 않지만, 같은 이름의 RPC는
-- 현재 Edge Function 계약에 맞는 구현으로 CREATE OR REPLACE 합니다.
--
-- 서버에 저장하는 데이터
--   1. 익명 client ID/IP의 salt 포함 SHA-256 hash별 AI quota counter
--   2. 익명 client hash별 방문일과 일기 완성 활동일
--
-- 서버에 저장하지 않는 데이터
--   사진, 일기 제목·본문·선택 날짜·날씨, 완성 JPEG, AI 분석 결과
-- 이 데이터는 현재 앱 정책대로 기기 Storage/localStorage에만 남습니다.

begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. AI 검사 quota
-- ---------------------------------------------------------------------------

create table if not exists public.diary_ai_rate_limits (
  scope text not null,
  identifier_hash text not null,
  action text not null,
  window_kind text not null,
  window_start timestamptz not null,
  request_count integer not null default 0,
  updated_at timestamptz not null default now(),
  constraint diary_ai_rate_limits_pkey primary key (
    scope,
    identifier_hash,
    action,
    window_kind,
    window_start
  ),
  constraint diary_ai_rate_limits_action_check
    check (action in ('sketch', 'analyze', 'all', 'ad-reward')),
  constraint diary_ai_rate_limits_request_count_check
    check (request_count >= 0),
  constraint diary_ai_rate_limits_scope_check
    check (scope in ('user', 'ip', 'service')),
  constraint diary_ai_rate_limits_window_kind_check
    check (window_kind in ('short', 'day'))
);

create index if not exists diary_ai_rate_limits_window_start_idx
  on public.diary_ai_rate_limits (window_start);

-- 'ad-reward'는 리워드 광고로 하루 1회 늘려준 보너스를 세는 행입니다.
-- 위 create table은 기존 배포본에는 적용되지 않으므로(if not exists),
-- 이미 만들어진 테이블의 check 제약을 여기서 다시 붙입니다. 이 스크립트를
-- 통째로 다시 실행해도 안전하도록 drop 후 add 하는 형태로 씁니다.
alter table public.diary_ai_rate_limits
  drop constraint if exists diary_ai_rate_limits_action_check;
alter table public.diary_ai_rate_limits
  add constraint diary_ai_rate_limits_action_check
    check (action in ('sketch', 'analyze', 'all', 'ad-reward'));

alter table public.diary_ai_rate_limits enable row level security;
revoke all on table public.diary_ai_rate_limits
  from public, anon, authenticated;

-- Edge Function에서 만든 SHA-256 hex만 DB 식별자로 받습니다.
create or replace function private.is_sha256_hex(p_value text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select p_value ~ '^[0-9a-f]{64}$';
$$;

create or replace function private.read_diary_quota_counter(
  p_scope text,
  p_identifier_hash text,
  p_action text,
  p_window_kind text,
  p_window_start timestamptz
)
returns integer
language sql
stable
set search_path = pg_catalog, public
as $$
  select coalesce((
    select request_count
    from public.diary_ai_rate_limits
    where scope = p_scope
      and identifier_hash = p_identifier_hash
      and action = p_action
      and window_kind = p_window_kind
      and window_start = p_window_start
  ), 0);
$$;

create or replace function private.increment_diary_quota_counter(
  p_scope text,
  p_identifier_hash text,
  p_action text,
  p_window_kind text,
  p_window_start timestamptz
)
returns integer
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
begin
  insert into public.diary_ai_rate_limits (
    scope,
    identifier_hash,
    action,
    window_kind,
    window_start,
    request_count,
    updated_at
  ) values (
    p_scope,
    p_identifier_hash,
    p_action,
    p_window_kind,
    p_window_start,
    1,
    clock_timestamp()
  )
  on conflict (scope, identifier_hash, action, window_kind, window_start)
  do update set
    request_count = public.diary_ai_rate_limits.request_count + 1,
    updated_at = clock_timestamp()
  returning request_count into v_count;

  return v_count;
end;
$$;

-- 유료 OpenAI 호출 전에 모든 관련 counter를 한 transaction에서 검사하고
-- 허용된 경우에만 함께 증가시킵니다. service 일일 lock을 포함한 하나의
-- advisory lock으로 병렬 요청의 check-then-increment 경쟁을 막습니다.
create or replace function public.consume_diary_ai_inspection_quota(
  p_run_sketch boolean,
  p_run_analyze boolean,
  p_user_hash text,
  p_ip_hash text,
  p_short_window_start timestamptz,
  p_day_window_start timestamptz,
  p_user_daily_limit integer,
  p_ip_short_limit integer,
  p_ip_daily_limit integer,
  p_service_sketch_daily_limit integer,
  p_service_analyze_daily_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_decision text := 'allowed';
  v_user_all integer;
  v_user_bonus integer;
  v_ip_short integer;
  v_ip_day integer;
  v_service_sketch integer;
  v_service_analyze integer;
begin
  if not coalesce(p_run_sketch, false)
     and not coalesce(p_run_analyze, false) then
    raise exception using errcode = '22023', message = 'at least one inspection action is required';
  end if;

  if not private.is_sha256_hex(p_user_hash)
     or not private.is_sha256_hex(p_ip_hash) then
    raise exception using errcode = '22023', message = 'invalid identifier hash';
  end if;

  if p_short_window_start is null or p_day_window_start is null
     or p_user_daily_limit < 1
     or p_ip_short_limit < 1
     or p_ip_daily_limit < 1
     or p_service_sketch_daily_limit < 1
     or p_service_analyze_daily_limit < 1 then
    raise exception using errcode = '22023', message = 'invalid quota arguments';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('diary-ai-quota:' || p_day_window_start::text, 0)
  );

  v_user_all := private.read_diary_quota_counter(
    'user', p_user_hash, 'all', 'day', p_day_window_start
  );
  -- 리워드 광고로 얻은 오늘의 보너스. grant 함수가 1회로 막아두므로 사실상
  -- 0 또는 1이고, 그만큼 이 기기의 하루 한도를 올려줍니다. 한도를 올리는
  -- 대신 사용량을 깎지 않는 이유는, 사용자가 실제로 몇 번 썼는지가 그대로
  -- 남아 있어야 로그와 화면의 "n/N" 표시가 서로 어긋나지 않기 때문입니다.
  v_user_bonus := private.read_diary_quota_counter(
    'user', p_user_hash, 'ad-reward', 'day', p_day_window_start
  );
  v_ip_short := private.read_diary_quota_counter(
    'ip', p_ip_hash, 'all', 'short', p_short_window_start
  );
  v_ip_day := private.read_diary_quota_counter(
    'ip', p_ip_hash, 'all', 'day', p_day_window_start
  );
  v_service_sketch := private.read_diary_quota_counter(
    'service', 'global', 'sketch', 'day', p_day_window_start
  );
  v_service_analyze := private.read_diary_quota_counter(
    'service', 'global', 'analyze', 'day', p_day_window_start
  );

  if v_user_all >= p_user_daily_limit + v_user_bonus then
    v_decision := 'device-daily';
  elsif v_ip_short >= p_ip_short_limit then
    v_decision := 'ip-short';
  elsif v_ip_day >= p_ip_daily_limit then
    v_decision := 'ip-daily';
  elsif (p_run_sketch and v_service_sketch >= p_service_sketch_daily_limit)
     or (p_run_analyze and v_service_analyze >= p_service_analyze_daily_limit) then
    v_decision := 'service-daily';
  end if;

  if v_decision = 'allowed' then
    v_user_all := private.increment_diary_quota_counter(
      'user', p_user_hash, 'all', 'day', p_day_window_start
    );
    v_ip_short := private.increment_diary_quota_counter(
      'ip', p_ip_hash, 'all', 'short', p_short_window_start
    );
    v_ip_day := private.increment_diary_quota_counter(
      'ip', p_ip_hash, 'all', 'day', p_day_window_start
    );

    if p_run_sketch then
      v_service_sketch := private.increment_diary_quota_counter(
        'service', 'global', 'sketch', 'day', p_day_window_start
      );
    end if;

    if p_run_analyze then
      v_service_analyze := private.increment_diary_quota_counter(
        'service', 'global', 'analyze', 'day', p_day_window_start
      );
    end if;
  end if;

  return jsonb_build_object(
    'decision', v_decision,
    'userAll', v_user_all,
    'userBonus', v_user_bonus,
    'ipShort', v_ip_short,
    'ipDay', v_ip_day,
    'serviceSketch', v_service_sketch,
    'serviceAnalyze', v_service_analyze
  );
end;
$$;

create or replace function public.refund_diary_ai_inspection_quota(
  p_run_sketch boolean,
  p_run_analyze boolean,
  p_user_hash text,
  p_ip_hash text,
  p_short_window_start timestamptz,
  p_day_window_start timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_user_all integer;
  v_user_bonus integer;
  v_ip_short integer;
  v_ip_day integer;
  v_service_sketch integer;
  v_service_analyze integer;
begin
  if not private.is_sha256_hex(p_user_hash)
     or not private.is_sha256_hex(p_ip_hash)
     or p_short_window_start is null
     or p_day_window_start is null then
    raise exception using errcode = '22023', message = 'invalid refund arguments';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('diary-ai-quota:' || p_day_window_start::text, 0)
  );

  update public.diary_ai_rate_limits
  set request_count = greatest(request_count - 1, 0),
      updated_at = clock_timestamp()
  where scope = 'user'
    and identifier_hash = p_user_hash
    and action = 'all'
    and window_kind = 'day'
    and window_start = p_day_window_start;

  update public.diary_ai_rate_limits
  set request_count = greatest(request_count - 1, 0),
      updated_at = clock_timestamp()
  where scope = 'ip'
    and identifier_hash = p_ip_hash
    and action = 'all'
    and window_kind = 'short'
    and window_start = p_short_window_start;

  update public.diary_ai_rate_limits
  set request_count = greatest(request_count - 1, 0),
      updated_at = clock_timestamp()
  where scope = 'ip'
    and identifier_hash = p_ip_hash
    and action = 'all'
    and window_kind = 'day'
    and window_start = p_day_window_start;

  if coalesce(p_run_sketch, false) then
    update public.diary_ai_rate_limits
    set request_count = greatest(request_count - 1, 0),
        updated_at = clock_timestamp()
    where scope = 'service'
      and identifier_hash = 'global'
      and action = 'sketch'
      and window_kind = 'day'
      and window_start = p_day_window_start;
  end if;

  if coalesce(p_run_analyze, false) then
    update public.diary_ai_rate_limits
    set request_count = greatest(request_count - 1, 0),
        updated_at = clock_timestamp()
    where scope = 'service'
      and identifier_hash = 'global'
      and action = 'analyze'
      and window_kind = 'day'
      and window_start = p_day_window_start;
  end if;

  v_user_all := private.read_diary_quota_counter(
    'user', p_user_hash, 'all', 'day', p_day_window_start
  );
  v_user_bonus := private.read_diary_quota_counter(
    'user', p_user_hash, 'ad-reward', 'day', p_day_window_start
  );
  v_ip_short := private.read_diary_quota_counter(
    'ip', p_ip_hash, 'all', 'short', p_short_window_start
  );
  v_ip_day := private.read_diary_quota_counter(
    'ip', p_ip_hash, 'all', 'day', p_day_window_start
  );
  v_service_sketch := private.read_diary_quota_counter(
    'service', 'global', 'sketch', 'day', p_day_window_start
  );
  v_service_analyze := private.read_diary_quota_counter(
    'service', 'global', 'analyze', 'day', p_day_window_start
  );

  return jsonb_build_object(
    'userAll', v_user_all,
    'userBonus', v_user_bonus,
    'ipShort', v_ip_short,
    'ipDay', v_ip_day,
    'serviceSketch', v_service_sketch,
    'serviceAnalyze', v_service_analyze
  );
end;
$$;

create or replace function public.read_diary_ai_inspection_quota(
  p_user_hash text,
  p_ip_hash text,
  p_short_window_start timestamptz,
  p_day_window_start timestamptz
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private
as $$
declare
  v_user_all integer;
  v_user_bonus integer;
  v_ip_short integer;
  v_ip_day integer;
  v_service_sketch integer;
  v_service_analyze integer;
begin
  if not private.is_sha256_hex(p_user_hash)
     or not private.is_sha256_hex(p_ip_hash)
     or p_short_window_start is null
     or p_day_window_start is null then
    raise exception using errcode = '22023', message = 'invalid quota read arguments';
  end if;

  v_user_all := private.read_diary_quota_counter(
    'user', p_user_hash, 'all', 'day', p_day_window_start
  );
  v_user_bonus := private.read_diary_quota_counter(
    'user', p_user_hash, 'ad-reward', 'day', p_day_window_start
  );
  v_ip_short := private.read_diary_quota_counter(
    'ip', p_ip_hash, 'all', 'short', p_short_window_start
  );
  v_ip_day := private.read_diary_quota_counter(
    'ip', p_ip_hash, 'all', 'day', p_day_window_start
  );
  v_service_sketch := private.read_diary_quota_counter(
    'service', 'global', 'sketch', 'day', p_day_window_start
  );
  v_service_analyze := private.read_diary_quota_counter(
    'service', 'global', 'analyze', 'day', p_day_window_start
  );

  return jsonb_build_object(
    'userAll', v_user_all,
    'userBonus', v_user_bonus,
    'ipShort', v_ip_short,
    'ipDay', v_ip_day,
    'serviceSketch', v_service_sketch,
    'serviceAnalyze', v_service_analyze
  );
end;
$$;

-- 리워드 광고를 끝까지 본 기기에 오늘의 AI 검사 기회를 1회 더 줍니다.
--
-- 하루 1회로 막는 일이 이 함수의 존재 이유입니다. 클라이언트가 같은 요청을
-- 여러 번 보내도(중복 탭, 재시도, 조작) 'ad-reward' counter가 p_max_bonus에
-- 닿는 순간부터는 아무것도 증가시키지 않고 'already-granted'만 돌려줍니다.
-- consume 쪽과 같은 advisory lock을 잡기 때문에, 광고 보상과 검사 요청이
-- 동시에 들어와도 한도 계산이 갈라지지 않습니다.
create or replace function public.grant_diary_ai_ad_reward(
  p_user_hash text,
  p_ip_hash text,
  p_short_window_start timestamptz,
  p_day_window_start timestamptz,
  p_max_bonus integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_decision text;
  v_user_all integer;
  v_user_bonus integer;
  v_ip_short integer;
  v_ip_day integer;
  v_service_sketch integer;
  v_service_analyze integer;
begin
  if not private.is_sha256_hex(p_user_hash)
     or not private.is_sha256_hex(p_ip_hash)
     or p_short_window_start is null
     or p_day_window_start is null
     or p_max_bonus < 1 then
    raise exception using errcode = '22023', message = 'invalid ad reward arguments';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('diary-ai-quota:' || p_day_window_start::text, 0)
  );

  v_user_bonus := private.read_diary_quota_counter(
    'user', p_user_hash, 'ad-reward', 'day', p_day_window_start
  );

  if v_user_bonus >= p_max_bonus then
    v_decision := 'already-granted';
  else
    v_user_bonus := private.increment_diary_quota_counter(
      'user', p_user_hash, 'ad-reward', 'day', p_day_window_start
    );
    v_decision := 'granted';
  end if;

  v_user_all := private.read_diary_quota_counter(
    'user', p_user_hash, 'all', 'day', p_day_window_start
  );
  v_ip_short := private.read_diary_quota_counter(
    'ip', p_ip_hash, 'all', 'short', p_short_window_start
  );
  v_ip_day := private.read_diary_quota_counter(
    'ip', p_ip_hash, 'all', 'day', p_day_window_start
  );
  v_service_sketch := private.read_diary_quota_counter(
    'service', 'global', 'sketch', 'day', p_day_window_start
  );
  v_service_analyze := private.read_diary_quota_counter(
    'service', 'global', 'analyze', 'day', p_day_window_start
  );

  return jsonb_build_object(
    'decision', v_decision,
    'userAll', v_user_all,
    'userBonus', v_user_bonus,
    'ipShort', v_ip_short,
    'ipDay', v_ip_day,
    'serviceSketch', v_service_sketch,
    'serviceAnalyze', v_service_analyze
  );
end;
$$;

-- 오래된 counter 정리용. 자동 실행을 원하면 Supabase Cron에서 이 RPC를
-- 매일 호출합니다. 앱 요청 경로에서는 실행하지 않습니다.
create or replace function public.cleanup_diary_ai_rate_limits(
  p_before timestamptz default (now() - interval '8 days')
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_deleted bigint;
begin
  delete from public.diary_ai_rate_limits
  where window_start < p_before;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. 방문·연속 일기 기록
-- ---------------------------------------------------------------------------

create table if not exists public.diary_user_progress (
  user_hash text primary key,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_seen_on date not null,
  visit_days integer not null default 1 check (visit_days >= 1),
  updated_at timestamptz not null default now(),
  constraint diary_user_progress_hash_check
    check (user_hash ~ '^[0-9a-f]{64}$')
);

create table if not exists public.diary_activity_days (
  user_hash text not null references public.diary_user_progress(user_hash)
    on delete cascade,
  activity_date date not null,
  completed_at timestamptz not null default now(),
  primary key (user_hash, activity_date),
  constraint diary_activity_days_hash_check
    check (user_hash ~ '^[0-9a-f]{64}$')
);

create index if not exists diary_activity_days_activity_date_idx
  on public.diary_activity_days (activity_date);

create table if not exists public.diary_milestones (
  metric text not null check (metric in ('streak', 'total-days')),
  threshold integer not null check (threshold > 0),
  tier text not null check (tier in ('small', 'special')),
  title text not null,
  message text not null,
  primary key (metric, threshold)
);

insert into public.diary_milestones (
  metric,
  threshold,
  tier,
  title,
  message
) values
  ('streak', 1, 'small', '첫 일기 도장을 찍었어요', '오늘의 여름을 멋지게 남겼어요.'),
  ('streak', 2, 'small', '이틀 연속 기록했어요', '어제의 이야기에 오늘의 이야기가 이어졌어요.'),
  ('streak', 3, 'small', '벌써 사흘째예요', '작은 기록이 즐거운 습관이 되고 있어요.'),
  ('streak', 5, 'special', '다섯 번째 도장 완성', '손가락을 모두 펼 만큼 도장을 모았어요.'),
  ('streak', 7, 'special', '일주일 연속 일기 달성', '한 주의 여름이 일기장에 담겼어요.'),
  ('streak', 10, 'small', '열흘 연속 기록했어요', '열 번의 하루가 한 줄로 이어졌어요.'),
  ('streak', 14, 'special', '2주 동안 이어왔어요', '하루하루가 멋진 이야기가 됐어요.'),
  ('streak', 21, 'small', '3주 연속 기록했어요', '도장 친구가 오늘도 기다리고 있었어요.'),
  ('streak', 28, 'small', '4주 연속 기록했어요', '네 주의 장면이 차곡차곡 모였어요.'),
  ('streak', 30, 'special', '한 달의 기록 완성', '한 달 동안 매일의 장면을 남겼어요.'),
  ('streak', 35, 'small', '5주 연속 기록했어요', '꾸준한 기록이 일기장을 채우고 있어요.'),
  ('streak', 42, 'small', '6주 연속 기록했어요', '여섯 주의 이야기가 길게 이어졌어요.'),
  ('streak', 50, 'special', '50개의 하루를 이었어요', '정말 단단한 기록 습관이 생겼어요.'),
  ('streak', 60, 'small', '두 달 연속 기록했어요', '두 달의 하루가 모두 일기가 됐어요.'),
  ('streak', 75, 'small', '75일 연속 기록했어요', '도장 친구와 오래 멋진 길을 걸었어요.'),
  ('streak', 90, 'small', '90일 연속 기록했어요', '한 계절만큼의 이야기가 모였어요.'),
  ('streak', 100, 'special', '100일 연속 일기 달성', '백 번의 하루가 한 권의 이야기가 됐어요.'),
  ('streak', 150, 'small', '150일 연속 기록했어요', '매일 남긴 마음이 큰 이야기가 됐어요.'),
  ('streak', 180, 'special', '반년을 기록했어요', '여섯 달의 시간이 일기장에 담겼어요.'),
  ('streak', 200, 'small', '200일 연속 기록했어요', '이백 개의 하루를 빠짐없이 남겼어요.'),
  ('streak', 300, 'small', '300일 연속 기록했어요', '삼백 번의 도장이 멋진 길이 됐어요.'),
  ('streak', 365, 'special', '한 해를 기록했어요', '사계절의 이야기를 모두 담았어요.'),
  ('total-days', 10, 'small', '지금까지 10일을 기록했어요', '연속 기록과 상관없이 열 개의 하루가 남았어요.'),
  ('total-days', 30, 'special', '30일의 이야기를 모았어요', '다시 시작한 날까지 모두 소중한 기록이에요.'),
  ('total-days', 50, 'special', '50일을 기록했어요', '일기장에 쉰 개의 하루가 차곡차곡 쌓였어요.'),
  ('total-days', 100, 'special', '100일을 기록했어요', '이어진 날과 다시 시작한 날이 모두 모였어요.'),
  ('total-days', 200, 'small', '200일을 기록했어요', '오랫동안 남긴 하루가 큰 이야기가 됐어요.'),
  ('total-days', 365, 'special', '365일을 기록했어요', '기록한 날들이 한 해만큼 모였어요.')
on conflict (metric, threshold) do update set
  tier = excluded.tier,
  title = excluded.title,
  message = excluded.message;

alter table public.diary_user_progress enable row level security;
alter table public.diary_activity_days enable row level security;
alter table public.diary_milestones enable row level security;

revoke all on table public.diary_user_progress
  from public, anon, authenticated;
revoke all on table public.diary_activity_days
  from public, anon, authenticated;
revoke all on table public.diary_milestones
  from public, anon, authenticated;

create or replace function private.diary_kst_today()
returns date
language sql
stable
parallel safe
set search_path = pg_catalog
as $$
  select (statement_timestamp() at time zone 'Asia/Seoul')::date;
$$;

-- 오늘 작성 완료가 있으면 오늘을, 아직 없다면 어제를 기준으로 연속 일수를
-- 계산합니다. 어제까지 이어 온 사용자는 오늘 작성 전에도 기록이 0으로
-- 보이지 않습니다. 이틀 이상 비면 0이며 최고 기록은 계산하거나 저장하지 않습니다.
create or replace function private.diary_current_streak(
  p_user_hash text,
  p_today date
)
returns integer
language sql
stable
set search_path = pg_catalog, public
as $$
  with anchor as (
    select case
      when exists (
        select 1 from public.diary_activity_days
        where user_hash = p_user_hash and activity_date = p_today
      ) then p_today
      when exists (
        select 1 from public.diary_activity_days
        where user_hash = p_user_hash and activity_date = p_today - 1
      ) then p_today - 1
      else null::date
    end as activity_date
  ),
  ordered_days as (
    select
      d.activity_date,
      row_number() over (order by d.activity_date desc) as position
    from public.diary_activity_days d
    cross join anchor a
    where d.user_hash = p_user_hash
      and a.activity_date is not null
      and d.activity_date <= a.activity_date
  )
  select coalesce(count(*) filter (
    where o.activity_date = a.activity_date - (o.position::integer - 1)
  ), 0)::integer
  from anchor a
  left join ordered_days o on true;
$$;

create or replace function private.diary_milestones_for_completion(
  p_current_streak integer,
  p_total_activity_days integer,
  p_newly_completed boolean
)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select case
    when not p_newly_completed then '[]'::jsonb
    else coalesce(jsonb_agg(
      jsonb_build_object(
        'metric', metric,
        'threshold', threshold,
        'tier', tier,
        'title', title,
        'message', message
      ) order by case metric when 'streak' then 0 else 1 end, threshold
    ), '[]'::jsonb)
  end
  from public.diary_milestones
  where (metric = 'streak' and threshold = p_current_streak)
     or (metric = 'total-days' and threshold = p_total_activity_days);
$$;

create or replace function public.record_diary_app_visit(
  p_user_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_today date := private.diary_kst_today();
  v_previous_seen_on date;
  v_visit_days integer;
  v_current_streak integer;
  v_total_activity_days integer;
begin
  if not private.is_sha256_hex(p_user_hash) then
    raise exception using errcode = '22023', message = 'invalid user hash';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('diary-progress:' || p_user_hash, 0)
  );

  select last_seen_on
  into v_previous_seen_on
  from public.diary_user_progress
  where user_hash = p_user_hash;

  insert into public.diary_user_progress (
    user_hash,
    first_seen_at,
    last_seen_at,
    last_seen_on,
    visit_days,
    updated_at
  ) values (
    p_user_hash,
    v_now,
    v_now,
    v_today,
    1,
    v_now
  )
  on conflict (user_hash) do update set
    last_seen_at = v_now,
    last_seen_on = greatest(public.diary_user_progress.last_seen_on, v_today),
    visit_days = public.diary_user_progress.visit_days + case
      when public.diary_user_progress.last_seen_on < v_today then 1
      else 0
    end,
    updated_at = v_now
  returning visit_days into v_visit_days;

  select count(*)::integer
  into v_total_activity_days
  from public.diary_activity_days
  where user_hash = p_user_hash;

  v_current_streak := private.diary_current_streak(p_user_hash, v_today);

  return jsonb_build_object(
    'activityDate', to_char(v_today, 'YYYY-MM-DD'),
    'previousLastSeenOn', case
      when v_previous_seen_on is null then null
      else to_char(v_previous_seen_on, 'YYYY-MM-DD')
    end,
    'daysAway', case
      when v_previous_seen_on is null then null
      else greatest(v_today - v_previous_seen_on, 0)
    end,
    'visitDays', v_visit_days,
    'currentStreak', v_current_streak,
    'totalActivityDays', v_total_activity_days,
    'completedToday', exists (
      select 1 from public.diary_activity_days
      where user_hash = p_user_hash and activity_date = v_today
    )
  );
end;
$$;

create or replace function public.read_diary_progress(
  p_user_hash text
)
returns jsonb
language plpgsql
security definer
stable
set search_path = pg_catalog, public, private
as $$
declare
  v_today date := private.diary_kst_today();
  v_last_seen_on date;
  v_visit_days integer := 0;
  v_current_streak integer;
  v_total_activity_days integer;
begin
  if not private.is_sha256_hex(p_user_hash) then
    raise exception using errcode = '22023', message = 'invalid user hash';
  end if;

  select last_seen_on, visit_days
  into v_last_seen_on, v_visit_days
  from public.diary_user_progress
  where user_hash = p_user_hash;

  v_visit_days := coalesce(v_visit_days, 0);

  select count(*)::integer
  into v_total_activity_days
  from public.diary_activity_days
  where user_hash = p_user_hash;

  v_current_streak := private.diary_current_streak(p_user_hash, v_today);

  return jsonb_build_object(
    'activityDate', to_char(v_today, 'YYYY-MM-DD'),
    'lastSeenOn', case
      when v_last_seen_on is null then null
      else to_char(v_last_seen_on, 'YYYY-MM-DD')
    end,
    'daysAway', case
      when v_last_seen_on is null then null
      else greatest(v_today - v_last_seen_on, 0)
    end,
    'visitDays', v_visit_days,
    'currentStreak', v_current_streak,
    'totalActivityDays', v_total_activity_days,
    'completedToday', exists (
      select 1 from public.diary_activity_days
      where user_hash = p_user_hash and activity_date = v_today
    )
  );
end;
$$;

create or replace function public.record_diary_completion(
  p_user_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_today date := private.diary_kst_today();
  v_inserted integer := 0;
  v_current_streak integer;
  v_total_activity_days integer;
  v_visit_days integer;
  v_milestones jsonb;
begin
  if not private.is_sha256_hex(p_user_hash) then
    raise exception using errcode = '22023', message = 'invalid user hash';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('diary-progress:' || p_user_hash, 0)
  );

  insert into public.diary_user_progress (
    user_hash,
    first_seen_at,
    last_seen_at,
    last_seen_on,
    visit_days,
    updated_at
  ) values (
    p_user_hash,
    v_now,
    v_now,
    v_today,
    1,
    v_now
  )
  on conflict (user_hash) do update set
    last_seen_at = v_now,
    last_seen_on = greatest(public.diary_user_progress.last_seen_on, v_today),
    visit_days = public.diary_user_progress.visit_days + case
      when public.diary_user_progress.last_seen_on < v_today then 1
      else 0
    end,
    updated_at = v_now
  returning visit_days into v_visit_days;

  insert into public.diary_activity_days (
    user_hash,
    activity_date,
    completed_at
  ) values (
    p_user_hash,
    v_today,
    v_now
  )
  on conflict (user_hash, activity_date) do nothing;

  get diagnostics v_inserted = row_count;

  select count(*)::integer
  into v_total_activity_days
  from public.diary_activity_days
  where user_hash = p_user_hash;

  v_current_streak := private.diary_current_streak(p_user_hash, v_today);
  v_milestones := private.diary_milestones_for_completion(
    v_current_streak,
    v_total_activity_days,
    v_inserted = 1
  );

  return jsonb_build_object(
    'activityDate', to_char(v_today, 'YYYY-MM-DD'),
    'newlyCompleted', v_inserted = 1,
    'completedToday', true,
    'visitDays', v_visit_days,
    'currentStreak', v_current_streak,
    'totalActivityDays', v_total_activity_days,
    'milestones', v_milestones
  );
end;
$$;

-- 익명 사용자가 앱 데이터 삭제를 요청할 때 Edge Function이 호출할 RPC입니다.
create or replace function public.delete_diary_progress(
  p_user_hash text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_deleted integer;
begin
  if not private.is_sha256_hex(p_user_hash) then
    raise exception using errcode = '22023', message = 'invalid user hash';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('diary-progress:' || p_user_hash, 0)
  );

  delete from public.diary_user_progress
  where user_hash = p_user_hash;

  get diagnostics v_deleted = row_count;
  return v_deleted = 1;
end;
$$;

-- 12주 활동 목록 기능 제거 후 이전 설치에 남은 private helper도 정리합니다.
drop function if exists private.diary_recent_activity_days(text, date, integer);

-- ---------------------------------------------------------------------------
-- 3. RPC 권한
-- ---------------------------------------------------------------------------

revoke all on function public.consume_diary_ai_inspection_quota(
  boolean, boolean, text, text, timestamptz, timestamptz,
  integer, integer, integer, integer, integer
) from public, anon, authenticated;
revoke all on function public.refund_diary_ai_inspection_quota(
  boolean, boolean, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.read_diary_ai_inspection_quota(
  text, text, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.grant_diary_ai_ad_reward(
  text, text, timestamptz, timestamptz, integer
) from public, anon, authenticated;
revoke all on function public.cleanup_diary_ai_rate_limits(timestamptz)
  from public, anon, authenticated;
revoke all on function public.record_diary_app_visit(text)
  from public, anon, authenticated;
revoke all on function public.read_diary_progress(text)
  from public, anon, authenticated;
revoke all on function public.record_diary_completion(text)
  from public, anon, authenticated;
revoke all on function public.delete_diary_progress(text)
  from public, anon, authenticated;

grant execute on function public.consume_diary_ai_inspection_quota(
  boolean, boolean, text, text, timestamptz, timestamptz,
  integer, integer, integer, integer, integer
) to service_role;
grant execute on function public.refund_diary_ai_inspection_quota(
  boolean, boolean, text, text, timestamptz, timestamptz
) to service_role;
grant execute on function public.read_diary_ai_inspection_quota(
  text, text, timestamptz, timestamptz
) to service_role;
grant execute on function public.grant_diary_ai_ad_reward(
  text, text, timestamptz, timestamptz, integer
) to service_role;
grant execute on function public.cleanup_diary_ai_rate_limits(timestamptz)
  to service_role;
grant execute on function public.record_diary_app_visit(text)
  to service_role;
grant execute on function public.read_diary_progress(text)
  to service_role;
grant execute on function public.record_diary_completion(text)
  to service_role;
grant execute on function public.delete_diary_progress(text)
  to service_role;

commit;

-- 설치 확인
-- select public.read_diary_ai_inspection_quota(
--   repeat('a', 64), repeat('b', 64),
--   date_trunc('hour', now()), date_trunc('day', now())
-- );
-- select public.record_diary_app_visit(repeat('a', 64));
-- select public.record_diary_completion(repeat('a', 64));
-- select public.read_diary_progress(repeat('a', 64));
