-- 0098: provider_output 증거 계약이 fal의 실제 기본 출력(image/png)을 수용한다.
--
-- fal-ai/flux-pulid는 제출 페이로드에 output_format이 없으면 content_type
-- image/png를 반환한다(2026-07-31 운영 실측). 008901의 이 제약은 jpeg만
-- 허용해 서명 검증까지 통과한 정상 웹훅의 증거 기록(record_generation_submit_
-- provider_output)을 전부 거부했다(gen.webhook_output_record_fail). 앱 계층
-- 파서는 PR #197에서 png를 수용하도록 교정됐고, 이 마이그레이션이 DB 계층을
-- 동일 계약으로 맞춘다. content_type 허용값 확장 외에는 008901과 자구 동일.

alter table public.generation_submit_intents
  drop constraint if exists generation_submit_provider_output_shape;
alter table public.generation_submit_intents
  add constraint generation_submit_provider_output_shape check (
    (provider_output is null) = (provider_output_at is null)
    and (provider_output is null or provider_output_scrubbed_at is null)
    and (
      provider_output is null
      or (
        pg_catalog.jsonb_typeof(provider_output) = 'object'
        and pg_catalog.octet_length(provider_output::text) <= 16384
        and provider_output ?& array['image', 'seed', 'nsfw']
        and provider_output - array['image', 'seed', 'nsfw']
              = '{}'::jsonb
        and pg_catalog.jsonb_typeof(provider_output->'image') = 'object'
        and (provider_output->'image')
              ?& array[
                'url', 'width', 'height', 'content_type', 'file_size'
              ]
        and (provider_output->'image')
              - array[
                'url', 'width', 'height', 'content_type', 'file_size'
              ] = '{}'::jsonb
        and pg_catalog.octet_length(
              provider_output->'image'->>'url'
            ) between 35 and 4096
        and provider_output->'image'->>'url'
              ~ '^https://v3b[.]fal[.]media/files/b/[^[:space:]#]+$'
        and pg_catalog.jsonb_typeof(
              provider_output->'image'->'width'
            ) = 'number'
        and (provider_output->'image'->>'width')::numeric
              between 1 and 40000000
        and (provider_output->'image'->>'width')::numeric
              = pg_catalog.floor(
                  (provider_output->'image'->>'width')::numeric
                )
        and pg_catalog.jsonb_typeof(
              provider_output->'image'->'height'
            ) = 'number'
        and (provider_output->'image'->>'height')::numeric
              between 1 and 40000000
        and (provider_output->'image'->>'height')::numeric
              = pg_catalog.floor(
                  (provider_output->'image'->>'height')::numeric
                )
        and (provider_output->'image'->>'width')::numeric
              * (provider_output->'image'->>'height')::numeric
              <= 40000000
        and (
          provider_output->'image'->'content_type' = 'null'::jsonb
          or provider_output->'image'->>'content_type'
               in ('image/jpeg', 'image/png')
        )
        and (
          provider_output->'image'->'file_size' = 'null'::jsonb
          or (
            pg_catalog.jsonb_typeof(
              provider_output->'image'->'file_size'
            ) = 'number'
            and (provider_output->'image'->>'file_size')::numeric >= 1
            and (provider_output->'image'->>'file_size')::numeric
                  <= 9007199254740991
            and (provider_output->'image'->>'file_size')::numeric
                  = pg_catalog.floor(
                      (provider_output->'image'->>'file_size')::numeric
                    )
          )
        )
        and pg_catalog.jsonb_typeof(provider_output->'seed') = 'number'
        and (provider_output->>'seed')::numeric >= 0
        and (provider_output->>'seed')::numeric <= 9007199254740991
        and (provider_output->>'seed')::numeric
              = pg_catalog.floor((provider_output->>'seed')::numeric)
        and pg_catalog.jsonb_typeof(provider_output->'nsfw') = 'boolean'
      )
    )
  );
