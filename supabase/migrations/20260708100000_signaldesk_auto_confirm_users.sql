-- Fix: multiple people could not authenticate.
--
-- Signup required an emailed 6-digit OTP, but the project uses Supabase's
-- built-in email service, which is rate-limited to only a few messages per hour
-- across the whole project. Once that hourly cap was hit
-- (error_code: over_email_send_rate_limit / "429: email rate limit exceeded"),
-- later signups never received a code, so their accounts stayed unconfirmed and
-- every sign-in returned "400: Email not confirmed". The first person in an hour
-- got in; everyone after them was stuck.
--
-- Auto-confirm new accounts at the database level so authentication no longer
-- depends on delivering a confirmation email. Combined with disabling email
-- confirmation in supabase/config.toml, any number of users can sign in.
--
-- Note: this trades email verification for open signup, which is appropriate for
-- this demo app. A production deployment should instead configure custom SMTP
-- (Auth > Emails) and re-enable confirmation so the rate limit no longer applies.

create or replace function public.auto_confirm_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Mark the email as confirmed the moment the account is created, so no
  -- confirmation email is required to sign in. confirmed_at is a generated
  -- column in newer Supabase, so only email_confirmed_at is set here.
  if new.email_confirmed_at is null then
    new.email_confirmed_at := now();
  end if;
  return new;
end; $$;

revoke all on function public.auto_confirm_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_confirm on auth.users;
create trigger on_auth_user_confirm
  before insert on auth.users
  for each row execute function public.auto_confirm_user();

-- Rescue any existing users who were left stranded (unconfirmed) by the rate limit.
update auth.users
   set email_confirmed_at = now()
 where email_confirmed_at is null;
