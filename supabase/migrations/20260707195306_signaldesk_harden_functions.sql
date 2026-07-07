-- Lock down SECURITY DEFINER functions: remove default PUBLIC execute grants.
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.increment_usage(uuid, timestamptz) from public, anon, authenticated;

revoke all on function public.create_api_key(text) from public, anon;
grant execute on function public.create_api_key(text) to authenticated;

revoke all on function public.activate_account() from public, anon;
grant execute on function public.activate_account() to authenticated;

do $$ begin
  revoke all on function public.rls_auto_enable() from public, anon, authenticated;
exception when undefined_function then null; end $$;
