BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
  IF to_regclass('public.roles') IS NULL THEN
    RAISE EXCEPTION 'roles_missing';
  END IF;
  IF to_regclass('public.role_permissions') IS NULL THEN
    RAISE EXCEPTION 'role_permissions_missing';
  END IF;
END $$;

WITH target_roles AS (
  SELECT id
    FROM roles
   WHERE id IN ('role.admin', 'admin', 'role.finance_staff', 'finance_staff')
      OR name IN ('admin', 'finance_staff')
)
INSERT INTO role_permissions (id, role_id, permission_code)
SELECT md5(target_roles.id || ':personnel_settlements.profile_documents.view'),
       target_roles.id,
       'personnel_settlements.profile_documents.view'
  FROM target_roles
ON CONFLICT (role_id, permission_code) DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('20261016_personnel_profile_documents_view_permission')
ON CONFLICT (version) DO NOTHING;

COMMIT;
