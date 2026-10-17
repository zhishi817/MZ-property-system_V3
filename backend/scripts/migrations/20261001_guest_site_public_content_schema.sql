BEGIN;

DO $$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'schema_migrations_missing';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS guest_site_configs (
  id text PRIMARY KEY,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

CREATE TABLE IF NOT EXISTS guest_site_property_displays (
  property_id text PRIMARY KEY,
  is_published boolean NOT NULL DEFAULT false,
  hero_title text,
  short_description text,
  long_description text,
  hero_image_url text,
  gallery_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  feature_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  amenities jsonb NOT NULL DEFAULT '[]'::jsonb,
  house_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  public_region_label text,
  public_capacity_override integer,
  bedroom_count integer,
  bathroom_count integer,
  bed_count integer,
  checkin_time text,
  checkout_time text,
  location_note text,
  price_label text,
  booking_highlights jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS amenities jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS house_rules jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS bedroom_count integer;
ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS bathroom_count integer;
ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS bed_count integer;
ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS checkin_time text;
ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS checkout_time text;
ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS location_note text;
ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS price_label text;
ALTER TABLE guest_site_property_displays ADD COLUMN IF NOT EXISTS booking_highlights jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS guest_site_translations (
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  locale text NOT NULL,
  source_hash text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, locale)
);

CREATE TABLE IF NOT EXISTS guest_site_inquiries (
  id text PRIMARY KEY,
  property_id text NOT NULL,
  guest_name text NOT NULL,
  guest_phone text NOT NULL,
  guest_email text NOT NULL,
  checkin date NOT NULL,
  checkout date NOT NULL,
  guest_count integer NOT NULL,
  message text,
  status text NOT NULL DEFAULT 'new',
  admin_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_guest_site_property_displays_published
  ON guest_site_property_displays(is_published, sort_order, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_guest_site_inquiries_status
  ON guest_site_inquiries(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guest_site_inquiries_property
  ON guest_site_inquiries(property_id, created_at DESC);

INSERT INTO schema_migrations (version)
VALUES ('20261001_guest_site_public_content_schema')
ON CONFLICT (version) DO NOTHING;

COMMIT;
