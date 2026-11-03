// 会议室 · 前几轮怎么摊给顾问看（2026-11-03）
// 跑法：node --test test/history.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

let seq = 0;
async function load() {
  return await import(`file:///E:/_DSH/meeting-room/lib/index.js?v=${++seq}`);
}

const round = (q, pairs) => ({ q, a: pairs.map(([name, answer]) => ({ name, answer })) });

test('没有历史就返回空串，不硬凑一段「之前」', async () => {
  const m = await load();
  assert.equal(m.priorRounds({}), '');
  assert.equal(m.priorRounds({ recent: [] }), '');
});

test('两轮的发言全在里面，谁说的标得清', async () => {
  const m = await load();
  const t = {
    recent: [
      round('第一问', [['GLM', '甲的看法'], ['Hy4', '乙的看法']]),
      round('第二问', [['GLM', '甲改了主意'], ['Hy4', '乙还是那样']]),
    ],
  };
  const s = m.priorRounds(t);
  for (const want of ['第一问', '第二问', '甲的看法', '乙的看法', '甲改了主意', '乙还是那样']) {
    assert.ok(s.includes(want), '缺了：' + want);
  }
  assert.ok(s.indexOf('第一问') < s.indexOf('第二问'), '旧的要排在前面');
});

test('超过轮数上限只留最近几轮', async () => {
  const m = await load();
  const recent = Array.from({ length: 6 }, (_, i) => round('第' + (i + 1) + '问', [['A', '说法' + (i + 1)]]));
  const s = m.priorRounds({ recent }, 2);
  assert.ok(!s.includes('第4问'), '第 4 轮不该出现');
  assert.ok(s.includes('第5问') && s.includes('第6问'));
});

test('默认不截发言——P老师：「不要限制字数，限制了之后影响表达」', async () => {
  const m = await load();
  const long = 'y'.repeat(3000);
  const s = m.priorRounds({ recent: [round('长问', [['A', long]])] });
  assert.ok(s.includes(long), '3000 字的发言要原样在，一个字不砍');
  assert.ok(!s.includes('略了'));
});

test('叫不通的记录不算发言，不进历史', async () => {
  const m = await load();
  const t = {
    recent: [{
      q: '问',
      a: [
        { name: 'GLM', answer: '这是真话', ok: true },
        { name: 'Deepseek', answer: '（叫不通：HTTP 502）{"error":"上游不可用"}', ok: false },
        { name: 'Hy4', answer: '（叫不通：HTTP 429）' },   // 老记录没有 ok 字段
      ],
    }],
  };
  const s = m.priorRounds(t);
  assert.ok(s.includes('这是真话'));
  assert.ok(!s.includes('502'), '叫不通的不能当成发言摊给下一位');
  assert.ok(!s.includes('429'));
});

test('太长会截断并说明，不悄悄丢掉整段', async () => {
  const m = await load();
  const recent = [round('长问', [['A', 'x'.repeat(3000)]])];
  // 显式传阀门才截；默认（0）是不截的
  const s = m.priorRounds({ recent }, 3, 3000, 800);
  assert.ok(s.length <= 900, '总长要压在上限附近，实际 ' + s.length);
  assert.ok(s.includes('略了'), '截断要说出来');
});
