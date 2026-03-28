-- 多角色支持：新增 user_roles，并从 users.role 回填主角色

CREATE TABLE IF NOT EXISTS user_roles (
  user_id text NOT NULL,
  role_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_name)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role_name ON user_roles(role_name);

-- 回填：每个用户至少包含其主角色 users.role
INSERT INTO user_roles (user_id, role_name)
SELECT u.id::text AS user_id, u.role::text AS role_name
FROM users u
WHERE COALESCE(u.role, '') <> ''
ON CONFLICT (user_id, role_name) DO NOTHING;

