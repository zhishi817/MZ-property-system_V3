-- Consumables/inspection checklist items + enhanced consumables usage records

CREATE TABLE IF NOT EXISTS cleaning_checklist_items (
  id text PRIMARY KEY,
  label text NOT NULL,
  kind text NOT NULL DEFAULT 'consumable',
  required boolean NOT NULL DEFAULT true,
  requires_photo_when_low boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  sort_order integer,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cleaning_checklist_active_sort
  ON cleaning_checklist_items (active, sort_order, created_at);

ALTER TABLE cleaning_consumable_usages ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE cleaning_consumable_usages ADD COLUMN IF NOT EXISTS photo_url text;
ALTER TABLE cleaning_consumable_usages ADD COLUMN IF NOT EXISTS item_label text;

CREATE INDEX IF NOT EXISTS idx_cleaning_consumables_status
  ON cleaning_consumable_usages (status);

INSERT INTO cleaning_checklist_items (id, label, kind, required, requires_photo_when_low, active, sort_order)
VALUES
  ('toilet_paper','卷纸','consumable',true,true,true,10),
  ('facial_tissue','抽纸','consumable',true,true,true,20),
  ('shampoo','洗发水','consumable',true,true,true,30),
  ('conditioner','护发素','consumable',true,true,true,40),
  ('body_wash','沐浴露','consumable',true,true,true,50),
  ('hand_soap','洗手液','consumable',true,true,true,60),
  ('dish_sponge','洗碗海绵','consumable',true,true,true,70),
  ('dish_soap','洗碗皂','consumable',true,true,true,80),
  ('tea_bags','茶包','consumable',true,true,true,90),
  ('coffee','咖啡','consumable',true,true,true,100),
  ('sugar_sticks','条装糖','consumable',true,true,true,110),
  ('bin_bags_large','大垃圾袋（有大垃圾桶才需要）','consumable',true,true,true,120),
  ('bin_bags_small','小垃圾袋','consumable',true,true,true,130),
  ('dish_detergent','洗洁精','consumable',true,true,true,140),
  ('laundry_powder','洗衣粉','consumable',true,true,true,150),
  ('cooking_oil','食用油','consumable',true,true,true,160),
  ('salt_sugar','盐糖','consumable',true,true,true,170),
  ('pepper','花椒（替换旧的花椒瓶带走）','consumable',true,true,true,180),
  ('toilet_cleaner','洁厕灵','consumable',true,true,true,190),
  ('bleach','漂白水（房间里用空的瓶子不要扔掉）','consumable',true,true,true,200),
  ('spare_pillowcase','备用枕套','consumable',true,true,true,210),
  ('other','其他','consumable',false,true,true,900)
ON CONFLICT (id) DO NOTHING;

