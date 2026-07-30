begin;
select plan(6);

select ok(
  has_function_privilege(
    'service_role',
    'public.like_escape(text)',
    'EXECUTE'
  ),
  'service_role can execute the private admin search dependency'
);
select ok(
  not has_function_privilege('anon', 'public.like_escape(text)', 'EXECUTE'),
  'anon cannot execute the private admin search dependency'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.like_escape(text)',
    'EXECUTE'
  ),
  'authenticated cannot execute the private admin search dependency'
);

set local role service_role;
select is(
  public.like_escape(E'a%b_c\\d'),
  E'a\\%b\\_c\\\\d',
  'service_role receives literal LIKE escaping'
);
select lives_ok(
  $$ select * from public.search_members('literal_%', 1) $$,
  'member search can invoke its private escaping dependency'
);
select lives_ok(
  $$ select * from public.search_orders('literal_%', null, 1, 0) $$,
  'order search can invoke its private escaping dependency'
);

select * from finish();
rollback;
