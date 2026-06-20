-- Allow customer service users to see all cleaning tasks in manager/calendar views.

CREATE TABLE IF NOT EXISTS roles (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  id text PRIMARY KEY,
  role_id text NOT NULL,
  permission_code text NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_role_perm ON role_permissions(role_id, permission_code);

INSERT INTO roles (id, name, description)
VALUES ('role.customer_service', 'customer_service', '客服')
ON CONFLICT (id) DO NOTHING;

WITH customer_service_roles AS (
  SELECT id
  FROM roles
  WHERE id IN ('role.customer_service', 'customer_service')
     OR name = 'customer_service'
)
INSERT INTO role_permissions (id, role_id, permission_code)
SELECT
  md5(r.id || ':cleaning_app.calendar.view.all'),
  r.id,
  'cleaning_app.calendar.view.all'
FROM customer_service_roles r
ON CONFLICT (role_id, permission_code) DO NOTHING;
