import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Db, freshDb } from './helpers';

// يطبع بصمة المخطط المحلي (بعد تطبيق المهاجرات من الصفر) لمقارنتها بالمشروع السحابي.
let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => db?.close());

it('بصمة المخطط المحلي', async () => {
  const rows = await db.admin(readFileSync(join(process.cwd(), 'scripts', 'schema_fingerprint.sql'), 'utf8'));
  console.log('LOCAL_SCHEMA_FINGERPRINT', JSON.stringify(rows[0]));
  expect(Number(rows[0].function_count)).toBeGreaterThan(40);
});
