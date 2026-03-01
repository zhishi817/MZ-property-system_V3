DO $$ BEGIN
  BEGIN
    CREATE TABLE IF NOT EXISTS public_access (
      area text PRIMARY KEY,
      password_hash text NOT NULL,
      password_enc text,
      password_updated_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz DEFAULT now()
    );
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    ALTER TABLE public_access ADD COLUMN IF NOT EXISTS password_enc text;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

