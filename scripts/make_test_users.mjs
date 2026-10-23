// يولّد حسابات اختبار للمشروع السحابي: كلمات مرور عشوائية تُحفظ في .env.test.local فقط، ويطبع SQL بالهاش دون كلمات المرور.
import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const tag = randomBytes(3).toString('hex');
const users = ['A', 'B', 'E2E'].map((k) => ({ k, id: randomUUID(), email: `gl-test-${k.toLowerCase()}-${tag}@example.test`, password: randomBytes(18).toString('base64url') }));
const sql = users.map((u) => {
  const hash = bcrypt.hashSync(u.password, 10);
  return `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
values ('00000000-0000-0000-0000-000000000000', '${u.id}', 'authenticated', 'authenticated', '${u.email}', '${hash}', now(), '{"provider":"email","providers":["email"],"gold_ledger_test":true}', '{}', now(), now(), '', '', '', '');
insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
values ('${u.id}', '${u.id}', '{"sub":"${u.id}","email":"${u.email}","email_verified":true}', 'email', now(), now(), now());`;
}).join('\n');
writeFileSync(process.argv[2], sql);
const env = users.map((u) => `GL_TEST_${u.k}_EMAIL=${u.email}\nGL_TEST_${u.k}_PASSWORD=${u.password}\nGL_TEST_${u.k}_ID=${u.id}`).join('\n');
writeFileSync('.env.test.local', `# حسابات اختبار فقط (ليست حساب المالك). لا ترفع هذا الملف.\n${env}\n`);
console.log('emails:', users.map((u) => u.email).join(', '));
