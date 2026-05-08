-- 003-onboarding-trigger.sql
-- Automation to create tenant on signup

CREATE OR REPLACE FUNCTION public.handle_new_user() 
RETURNS trigger AS $$
DECLARE
    new_tenant_id UUID;
    tenant_name TEXT;
BEGIN
    -- 1. Create a tenant name based on email
    tenant_name := split_part(NEW.email, '@', 1);

    -- 2. Create the tenant record
    INSERT INTO public.tenants (name, slug)
    VALUES (NEW.email, tenant_name || '-' || floor(random() * 10000)::text)
    RETURNING id INTO new_tenant_id;

    -- 3. Link user to tenant as Admin
    INSERT INTO public.tenant_users (tenant_id, email, auth_user_id, role)
    VALUES (new_tenant_id, NEW.email, NEW.id, 'ADMIN');

    -- 4. Initialize default settings
    INSERT INTO public.tenant_settings (tenant_id)
    VALUES (new_tenant_id);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger on auth.users (Supabase managed table)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
