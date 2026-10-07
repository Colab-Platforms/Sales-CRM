-- Users now log in with a username; email becomes an optional contact field.
ALTER TABLE "users" ADD COLUMN "username" VARCHAR(50);

-- Backfill: <email prefix, lowercased, unsafe chars -> _>_avatar. Duplicates get a
-- numeric suffix. The seeded @avatar.test accounts rank first so they end up as
-- admin_avatar / manager_avatar / sales_avatar.
WITH base AS (
  SELECT
    id,
    left(regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._-]', '_', 'g'), 30) AS b,
    row_number() OVER (
      PARTITION BY left(regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._-]', '_', 'g'), 30)
      ORDER BY (email LIKE '%@avatar.test') DESC, created_at, id
    ) AS rn
  FROM "users"
)
UPDATE "users" u
SET "username" = CASE WHEN base.rn = 1 THEN base.b || '_avatar' ELSE base.b || base.rn::text || '_avatar' END
FROM base
WHERE u.id = base.id;

ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
