BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
  IF to_regclass('public.guest_site_property_displays') IS NULL THEN
    RAISE EXCEPTION 'guest_site_property_displays_missing';
  END IF;
END $$;

ALTER TABLE guest_site_property_displays
  ADD COLUMN IF NOT EXISTS amenity_selections jsonb NOT NULL DEFAULT '[]'::jsonb;

INSERT INTO schema_migrations (version)
VALUES ('20261002_guest_site_amenity_selections')
ON CONFLICT (version) DO NOTHING;

COMMIT;
