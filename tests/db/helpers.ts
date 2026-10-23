import { randomUUID } from 'node:crypto';
import pg from 'pg';

// numeric يُعاد كنص من pg افتراضيًا؛ لا نحوله إلى Number.
const port = () => Number(process.env.GL_PG_PORT ?? 54330);
const base = () => ({ host: 'localhost', port: port(), user: 'postgres', password: 'local-test-only' });

export class RpcError extends Error {
  constructor(public code: string | undefined, message: string, public sqlstate?: string) {
    super(message);
  }
}

const READ_ONLY = /^(get_|list_|export_)/;

export class Db {
  constructor(public name: string, public pool: pg.Pool) {}

  async createUser(email = `${randomUUID()}@test.local`): Promise<string> {
    const id = randomUUID();
    await this.pool.query('insert into auth.users(id, email) values ($1, $2)', [id, email]);
    return id;
  }

  session(uid: string | null, extraClaims: Record<string, unknown> = {}) {
    return new Session(this.pool, uid, extraClaims);
  }

  /** استعلام بصلاحيات postgres (إعداد/فحص فقط، وليس إثباتًا لـRLS) */
  async admin(sql: string, params: unknown[] = []) {
    return (await this.pool.query(sql, params)).rows;
  }

  async close() {
    await this.pool.end();
    const a = new pg.Client({ ...base(), database: 'postgres' });
    await a.connect();
    await a.query(`drop database if exists ${this.name} with (force)`);
    await a.end();
  }
}

export async function freshDb(): Promise<Db> {
  const name = 'gl_t_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const a = new pg.Client({ ...base(), database: 'postgres' });
  await a.connect();
  await a.query(`create database ${name} template gl_template`);
  await a.end();
  return new Db(name, new pg.Pool({ ...base(), database: name, max: 8 }));
}

function claims(uid: string | null, extra: Record<string, unknown> = {}) {
  return uid ? JSON.stringify({ sub: uid, role: 'authenticated', ...extra }) : JSON.stringify({ role: 'anon', ...extra });
}

async function asRole(client: pg.PoolClient | pg.Client, uid: string | null, extra: Record<string, unknown> = {}) {
  await client.query(`set local role ${uid ? 'authenticated' : 'anon'}`);
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [claims(uid, extra)]);
}

export function wrapErr(e: any): never {
  if (e && typeof e === 'object' && 'code' in e) throw new RpcError(e.detail ?? e.code, e.message, e.code);
  throw e;
}

/** يحاكي طلب PostgREST: معاملة واحدة بدور authenticated/anon وclaims الجلسة. */
export class Session {
  constructor(private pool: pg.Pool, public uid: string | null, private extra: Record<string, unknown> = {}) {}

  async rpc<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query(READ_ONLY.test(fn) ? 'begin read only' : 'begin');
      await asRole(c, this.uid, this.extra);
      const keys = Object.keys(args);
      const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
      const res = await c.query(sql, keys.map((k) => normalize(args[k])));
      await c.query('commit');
      return res.rows[0].r as T;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      wrapErr(e);
    } finally {
      c.release();
    }
  }

  /** استعلام SQL مباشر بصلاحيات المستخدم (يحاكي وصول REST للجداول) */
  async sql(sql: string, params: unknown[] = []): Promise<any[]> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      await asRole(c, this.uid, this.extra);
      const res = await c.query(sql, params);
      await c.query('commit');
      return res.rows;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      wrapErr(e);
    } finally {
      c.release();
    }
  }

  /** معاملة مفتوحة يتحكم فيها الاختبار (للتزامن) */
  async open() {
    const c = await this.pool.connect();
    await c.query('begin');
    await asRole(c, this.uid, this.extra);
    return {
      rpc: async (fn: string, args: Record<string, unknown> = {}) => {
        const keys = Object.keys(args);
        try {
          const res = await c.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`,
            keys.map((k) => normalize(args[k])));
          return res.rows[0].r;
        } catch (e) { wrapErr(e); }
      },
      query: (sql: string, p: unknown[] = []) => c.query(sql, p),
      commit: async () => { await c.query('commit'); c.release(); },
      rollback: async () => { await c.query('rollback'); c.release(); },
    };
  }
}

function normalize(v: unknown) {
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** عميل دفتر بسيط لاختبارات السيناريو: كل طلب بمعرف جديد ما لم يُمرر */
export class Ledger {
  constructor(public s: Session) {}
  rid() { return randomUUID(); }
  setup(basis = 'عيار 21') { return this.s.rpc('setup_account', { p_request_id: this.rid(), p_weight_basis: basis }); }
  opening(book: 'qat' | 'insta', start: string, money: string, weight?: string | null, expected?: number | null, reason?: string) {
    return this.s.rpc('set_opening', { p_request_id: this.rid(), p_book: book, p_start_date: start, p_opening_money: money,
      p_opening_weight: weight ?? null, p_expected_version: expected ?? null, p_reason: reason ?? null });
  }
  buy(date: string, weight: string, price: string, extra: Record<string, unknown> = {}) {
    return this.s.rpc('add_qat_entry', { p_request_id: this.rid(), p_entry_date: date, p_entry_type: 'buy', p_weight: weight, p_unit_price: price, ...extra });
  }
  sell(date: string, weight: string, price: string, extra: Record<string, unknown> = {}) {
    return this.s.rpc('add_qat_entry', { p_request_id: this.rid(), p_entry_date: date, p_entry_type: 'sell', p_weight: weight, p_unit_price: price, ...extra });
  }
  adjust(date: string, dir: 'cash_add' | 'cash_deduct', amount: string, reason = 'تسوية') {
    return this.s.rpc('add_qat_entry', { p_request_id: this.rid(), p_entry_date: date, p_entry_type: dir, p_amount: amount, p_reason: reason });
  }
  insta(date: string, type: 'in' | 'out', amount: string, extra: Record<string, unknown> = {}) {
    return this.s.rpc('add_insta_entry', { p_request_id: this.rid(), p_entry_date: date, p_entry_type: type, p_amount: amount, ...extra });
  }
  async daily(date: string, field: 'cash' | 'price', value: string | null, reason?: string) {
    const rep = await this.report(date);
    return this.s.rpc('set_daily_value', { p_request_id: this.rid(), p_value_date: date, p_field: field, p_value: value,
      p_expected_version: rep.daily_version ?? null, p_reason: reason ?? null });
  }
  report(date: string) { return this.s.rpc('get_day_report', { p_date: date }); }
  saveCalc(date: string) { return this.s.rpc('save_calc', { p_request_id: this.rid(), p_calc_date: date }); }
  person(name: string) { return this.s.rpc('create_person', { p_request_id: this.rid(), p_name: name }); }
  debt(person: string, date: string, type: 'sent' | 'repaid', amount: string, note?: string) {
    return this.s.rpc('add_debt_entry', { p_request_id: this.rid(), p_person_id: person, p_entry_date: date, p_entry_type: type, p_amount: amount, p_note: note ?? null });
  }
  people(asOf?: string) { return this.s.rpc('list_people', { p_as_of: asOf ?? null }); }
  exportBackup() { return this.s.rpc('export_backup'); }
  state() { return this.s.rpc('get_state'); }
}

/** يقارن الأرقام العشرية كنصوص بعد تطبيعها (130500.00 == 130500) دون تحويل إلى float */
export function dec(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  let [i, f = ''] = String(s).split('.');
  f = f.replace(/0+$/, '');
  const neg = i.startsWith('-');
  i = i.replace('-', '').replace(/^0+(?=\d)/, '');
  const out = f ? `${i}.${f}` : i;
  return neg && out !== '0' ? '-' + out : out;
}
