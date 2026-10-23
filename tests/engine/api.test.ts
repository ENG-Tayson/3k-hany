import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// رجوع لنتيجة المراجعة R1/R9: رد 5xx أو مفقود = «تعذر التأكيد» مع نفس request_id؛ ومحتوى معدّل بعده لا يُرسل بمعرّف جديد.
const responses: any[] = [];
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: vi.fn(async () => responses.shift()) }, configError: null }));
import { ApiError, rpc, useSaver } from '../../src/lib/api';

function harness() {
  let saver: ReturnType<typeof useSaver> | null = null;
  function C() { saver = useSaver(); return null; }
  renderToString(createElement(C));
  return saver!;
}

describe('تصنيف أخطاء الحفظ', () => {
  it('504 من البوابة = unknown (ليس «لم يتم الحفظ»)', async () => {
    responses.push({ data: null, error: { message: '<html>504 Gateway Time-out</html>' }, status: 504 });
    const e = await rpc('add_qat_entry', {}).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.kind).toBe('unknown');
  });
  it('رفض من قاعدة البيانات (400 مع detail) = server', async () => {
    responses.push({ data: null, error: { message: 'السداد أكبر من المتبقي', details: 'overpayment', code: 'P0001' }, status: 400 });
    const e = await rpc('add_debt_entry', {}).catch((x) => x);
    expect(e.kind).toBe('server');
    expect(e.code).toBe('overpayment');
  });
  it('إعادة المحاولة بعد 504 أو انقطاع تستخدم نفس request_id', async () => {
    const s = harness();
    const ids: string[] = [];
    const run = (id: string) => { ids.push(id); return rpc('add_qat_entry', { p_request_id: id }); };
    responses.push({ data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 });
    await s.save('fp1', run);
    responses.push({ data: { ok: true }, error: null, status: 200 });
    await s.save('fp1', run);
    responses.push({ data: null, error: { message: '<html>504</html>' }, status: 504 });
    await s.save('fp2', run);
    responses.push({ data: { ok: true }, error: null, status: 200 });
    await s.save('fp2', run);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBe(ids[3]);
    expect(ids[0]).not.toBe(ids[2]);
  });
  it('بعد «تعذر التأكيد» تغيير المحتوى لا يُرسل طلبًا جديدًا', async () => {
    const s = harness();
    const ids: string[] = [];
    const run = (id: string) => { ids.push(id); return rpc('add_qat_entry', { p_request_id: id }); };
    responses.push({ data: null, error: { message: 'Failed to fetch' }, status: 0 });
    await s.save('a', run);
    const r = await s.save('a-edited', run);
    expect(r).toBeNull();
    expect(ids).toHaveLength(1);
  });
  it('بعد رفض نهائي من الخادم يُسمح بمحتوى جديد بمعرّف جديد', async () => {
    const s = harness();
    const ids: string[] = [];
    const run = (id: string) => { ids.push(id); return rpc('x', { p_request_id: id }); };
    responses.push({ data: null, error: { message: 'bad', details: 'invalid_number' }, status: 400 });
    await s.save('a', run);
    responses.push({ data: { ok: true }, error: null, status: 200 });
    await s.save('b', run);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
