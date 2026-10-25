// 端到端冒烟测试：直接打 HTTP 接口把核心流程跑一遍（会真实调用 AI）。
// 用法：先 npm run dev，再 npm run smoke   （或 BASE=https://xxx npm run smoke 测线上）
const BASE = process.env.BASE || 'http://localhost:3000';
const tag = Date.now().toString(36).slice(-5);

function client() {
  let cookie = '';
  return async function call(path, method = 'GET', body) {
    const r = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok && r.status !== 404) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 200)}`);
    return { status: r.status, data, headers: r.headers };
  };
}
const ok = (cond, msg) => { if (!cond) throw new Error('✗ ' + msg); console.log('✓ ' + msg); };

const t = client();
const s = client();
const guest = client();

const h = await guest('/api/health');
ok(h.data.db.ok, `数据库连通（${h.data.db.kind}）`);

await t('/api/auth/register', 'POST', { username: `t_${tag}`, password: '1234', nickname: '王老师', role: 'teacher' });
const cls = (await t('/api/classes', 'POST', { name: `冒烟测试班 ${tag}` })).data;
ok(cls.joinCode?.length === 6, `老师建班，加入码 ${cls.joinCode}`);
const batch = (await t(`/api/classes/${cls.id}/students`, 'POST', { names: '小明\n小红', ageBand: 'L1' })).data;
ok(batch.created.length === 2, `批量生成学生账号 ${batch.created.map((c) => c.username).join(', ')}`);
await t(`/api/classes/${cls.id}/assignments`, 'POST', { title: '做一个小游戏', description: '随便做' });

const login = await s('/api/auth/login', 'POST', { username: batch.created[0].username, password: batch.created[0].password });
ok(login.data.ok, '学生用老师生成的账号登录');

const { id } = (await s('/api/projects', 'POST', { workType: 'GAME', title: '点星星' })).data;
const t0 = Date.now();
const chat = await s(`/api/projects/${id}/chat`, 'POST', { message: '做一个点击星星得分的小游戏，30 秒倒计时' });
const ctrl = JSON.parse(chat.data.split('\u0000')[1] || '{}');
ok(ctrl.done && ctrl.version === 1 && !ctrl.error, `AI 生成第 1 版作品（${((Date.now() - t0) / 1000).toFixed(1)}s）${ctrl.error ? ' 错误：' + ctrl.error : ''}`);

const proj = (await s(`/api/projects/${id}`)).data;
ok(proj.project.html.includes('<') && proj.messages.length === 2, '作品和对话已保存');

const raw = await s(`/r/${id}`);
ok(raw.headers.get('content-security-policy')?.includes('sandbox') && raw.data.includes('lqError'), '作品原始页带沙箱头和运行时脚本');

const pub = (await s(`/api/projects/${id}/publish`, 'POST', { visibility: 'public' })).data;
ok(pub.path.startsWith('/w/'), `一键发布 → ${BASE}${pub.path}`);
const w = await guest(pub.path);
ok(w.status === 200 && w.data.includes('点星星'), '游客能打开作品页');
const gallery = await guest('/gallery');
ok(gallery.data.includes(pub.slug), '作品出现在广场');
const like = (await t(`/api/works/${pub.slug}/like`, 'POST')).data;
ok(like.liked && like.likes === 1, '老师点赞');

const tasks = await s('/classes');
const aid = (await t(`/classes/${cls.id}`)).status === 200;
ok(aid && tasks.data.includes('做一个小游戏'), '学生能看到作业');
// 从老师班级页里拿不到 id，直接查学生作业接口所需 id：用 /classes 页面里的提交按钮不方便，这里走数据库无关的方式——重新布置并记下
const a2 = (await t(`/api/classes/${cls.id}/assignments`, 'POST', { title: '第二个作业' })).data;
const sub = (await s(`/api/assignments/${a2.id}/submit`, 'POST', { projectId: id })).data;
ok(sub.ok || sub.id, '学生提交作业');
const subId = sub.id;
if (subId) {
  const g = (await t(`/api/submissions/${subId}/grade`, 'POST', { stars: 5, comment: '真棒！' })).data;
  ok(g.ok, '老师批改打分');
}
const rb = (await s(`/api/projects/${id}/rollback`, 'POST', { seq: 1 })).data;
ok(rb.ok, `版本回退 → 第 ${rb.version ?? '?'} 版`);

// ── 智能体作品：孩子做一个会聊天的 AI 角色，背后是 QCA 上按作品设定建的 Template + 会话 ──
if (h.data.ai?.provider === 'qca' && !process.env.SKIP_AGENT) {
  const { id: aid2 } = (await s('/api/projects', 'POST', { workType: 'AGENT', title: '恐龙博士' })).data;
  const t1 = Date.now();
  const c2 = await s(`/api/projects/${aid2}/chat`, 'POST', {
    message: '做一个会聊天的恐龙博士，知道很多恐龙知识，说话幽默，每次回答完反问我一个小问题。',
  });
  const ctl2 = JSON.parse(c2.data.split('\u0000')[1] || '{}');
  ok(ctl2.version === 1 && !ctl2.error, `Little Q（QCA）做出智能体作品（${((Date.now() - t1) / 1000).toFixed(1)}s）${ctl2.error ? ' 错误：' + ctl2.error : ''}`);
  const p2 = (await s(`/api/projects/${aid2}`)).data.project;
  ok(/id=["']littleq-agent["']/.test(p2.html) && p2.html.includes('LittleQ.chat'), '作品里有角色设定，并调用 LittleQ.chat');

  const say = async (who, path, body) => {
    const r = await who(path, 'POST', body);
    const [text, tail] = String(r.data).split('\u0000');
    return { text, ctl: JSON.parse(tail || '{}') };
  };
  const chatId = `smoke${tag}a1b2c3`;
  const t2 = Date.now();
  const r1 = await say(s, `/api/agent/${aid2}`, { chat: chatId, text: '你好！我叫小明，最喜欢霸王龙。' });
  ok(r1.text.trim() && !r1.ctl.error, `作品里的 AI 角色回答（${((Date.now() - t2) / 1000).toFixed(1)}s）：${r1.text.trim().slice(0, 50)}…`);
  const r2 = await say(s, `/api/agent/${aid2}`, { chat: chatId, text: '我刚才说我最喜欢哪种恐龙？' });
  ok(r2.text.includes('霸王龙'), `同一段对话记得上下文：${r2.text.trim().slice(0, 50)}…`);
  const rs = (await s(`/api/agent/${aid2}`, 'POST', { chat: chatId, reset: true })).data;
  ok(rs.ok, '重新开始对话（归档 QCA 会话）');

  const pub2 = (await s(`/api/projects/${aid2}/publish`, 'POST', { visibility: 'public' })).data;
  const slug2 = pub2.path.split('/').pop();
  const r3 = await say(guest, `/api/agent/${slug2}?s=1`, { chat: `guest${tag}x9y8z7`, text: '恐龙为什么灭绝了？' });
  ok(r3.text.trim() && !r3.ctl.error, `游客在公开作品里和 AI 角色聊天：${r3.text.trim().slice(0, 40)}…`);

  const c3 = await s(`/api/projects/${aid2}/chat`, 'POST', { message: '你还记得我们刚才做的是什么吗？只回答，不要改作品。' });
  const ctl3 = JSON.parse(c3.data.split('\u0000')[1] || '{}');
  ok(!ctl3.error && ctl3.version === null && /恐龙/.test(c3.data), 'Little Q 的创作会话记得之前做了什么');
}

console.log('\n🎉 全部通过');
