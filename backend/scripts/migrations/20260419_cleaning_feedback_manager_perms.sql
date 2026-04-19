-- Allow manager-side cleaning app roles to report issues and upload evidence
-- Fixes customer_service / offline_manager seeing "权限不足" in property feedback photo upload.

CREATE TABLE IF NOT EXISTS roles (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_roles_name ON roles(name);

CREATE TABLE IF NOT EXISTS role_permissions (
  id text PRIMARY KEY,
  role_id text NOT NULL,
  permission_code text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_role_perm ON role_permissions(role_id, permission_code);
CREATE INDEX IF NOT EXISTS idx_role_perm_role ON role_permissions(role_id);

INSERT INTO roles (id, name, description)
SELECT 'role.customer_service', 'customer_service', '客服'
WHERE NOT EXISTS (
  SELECT 1
  FROM roles
  WHERE id IN ('role.customer_service', 'customer_service') OR name = 'customer_service'
);

INSERT INTO roles (id, name, description)
SELECT 'role.offline_manager', 'offline_manager', '线下运营'
WHERE NOT EXISTS (
  SELECT 1
  FROM roles
  WHERE id IN ('role.offline_manager', 'offline_manager') OR name = 'offline_manager'
);

WITH target_roles AS (
  SELECT id
  FROM roles
  WHERE id IN ('role.customer_service', 'customer_service')
     OR name = 'customer_service'
  UNION
  SELECT id
  FROM roles
  WHERE id IN ('role.offline_manager', 'offline_manager')
     OR name = 'offline_manager'
),
target_perms AS (
  SELECT 'cleaning_app.issues.report'::text AS permission_code
  UNION ALL
  SELECT 'cleaning_app.media.upload'::text AS permission_code
)
INSERT INTO role_permissions (id, role_id, permission_code)
SELECT
  CONCAT('seed:', REPLACE(tr.id, ' ', '_'), ':', REPLACE(tp.permission_code, '.', '_')) AS id,
  tr.id AS role_id,
  tp.permission_code
FROM target_roles tr
CROSS JOIN target_perms tp
ON CONFLICT (role_id, permission_code) DO NOTHING;
