-- Customer service manual CMS category and permissions.

ALTER TABLE cms_pages ADD COLUMN IF NOT EXISTS guide_role text;
CREATE INDEX IF NOT EXISTS idx_cms_pages_type_category ON cms_pages(page_type, category);
CREATE INDEX IF NOT EXISTS idx_cms_pages_guide_role ON cms_pages(guide_role);

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

WITH perms(permission_code) AS (
  VALUES
    ('menu.cms'),
    ('menu.cms.customer_service_manual.visible'),
    ('cms_pages.view'),
    ('cms_pages.write')
),
customer_service_roles AS (
  SELECT id FROM roles WHERE id IN ('role.customer_service', 'customer_service') OR name = 'customer_service'
)
INSERT INTO role_permissions (id, role_id, permission_code)
SELECT
  md5(r.id || ':' || p.permission_code),
  r.id,
  p.permission_code
FROM customer_service_roles r
CROSS JOIN perms p
ON CONFLICT (role_id, permission_code) DO NOTHING;
