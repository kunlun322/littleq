// 纯常量，前后端都能 import（不能引入数据库等 Node 模块）

export const WORK_TYPES = {
  GAME: { label: '小游戏', icon: 'game' },
  TOOL: { label: '小工具', icon: 'tool' },
  ANIMATION: { label: '小动画', icon: 'animation' },
  AGENT: { label: '智能体', icon: 'agent' },
} as const;
export type WorkType = keyof typeof WORK_TYPES;

export const VIS_LABEL = {
  private: '只有我能看',
  class: '班级同学能看',
  public: '所有人能看（进入作品广场）',
} as const;

export const BANDS = {
  L1: { name: '小小鸭', desc: '1-2 年级', icon: 'band-L1' },
  L2: { name: '勇敢鸭', desc: '3-6 年级', icon: 'band-L2' },
  L3: { name: '探险鸭', desc: '初中', icon: 'band-L3' },
} as const;

export const AVATAR_IMAGES: Record<string, { image: string; label: string }> = {
  '🐥': { image: 'duck', label: '小黄鸭' },
  '🐣': { image: 'hatch', label: '破壳鸭' },
  '🦆': { image: 'mallard', label: '绿头鸭' },
  '🐤': { image: 'chick', label: '小鸡' },
  '🐸': { image: 'frog', label: '青蛙' },
  '🐱': { image: 'cat', label: '猫咪' },
  '🐶': { image: 'dog', label: '小狗' },
  '🐼': { image: 'panda', label: '熊猫' },
  '🦊': { image: 'fox', label: '狐狸' },
  '🐰': { image: 'rabbit', label: '兔子' },
};
export const AVATARS = Object.keys(AVATAR_IMAGES);

/** 新建作品时的灵感模板 */
export const STARTERS: { type: WorkType; title: string; prompt: string }[] = [
  { type: 'GAME', title: '接住小黄鸭', prompt: '做一个接东西的小游戏：天上掉下小黄鸭，我用左右键或者手指拖动篮子去接，接到加分，漏掉 3 个就结束。' },
  { type: 'GAME', title: '打地鼠', prompt: '做一个打地鼠游戏，9 个洞，地鼠随机冒出来，点到就加分，30 秒倒计时，最后显示得分。' },
  { type: 'TOOL', title: '我的课程表', prompt: '做一个课程表小工具，周一到周五，每天 6 节课，可以点格子填写课程名，自动保存，颜色可爱一点。' },
  { type: 'TOOL', title: '口算小练习', prompt: '做一个 20 以内加减法口算练习，每次出 10 道题，答对有鼓励，最后显示用时和正确率。' },
  { type: 'ANIMATION', title: '鸭子的一天', prompt: '做一个小动画：小黄鸭早上起床、去池塘游泳、晚上看星星，有简单的场景切换和背景颜色变化。' },
  { type: 'ANIMATION', title: '夜空烟花', prompt: '做一个夜空烟花动画，点一下屏幕就在那里放一朵彩色烟花，还有星星在闪。' },
  { type: 'AGENT', title: '恐龙博士', prompt: '做一个会聊天的恐龙博士，它知道很多恐龙的知识，说话很幽默，每次回答完还会反问我一个关于恐龙的小问题。' },
  { type: 'AGENT', title: '英语小老师', prompt: '做一个英语小老师智能体，我说中文它教我对应的简单英文句子，还会夸我、让我跟着读，界面要可爱。' },
];

/**
 * 注入到作品里的小脚本：
 * 1. 作品运行在沙箱里（没有同源权限），localStorage 会报错，这里换成内存版，保证作品不崩；
 * 2. 运行出错时通知外层页面，好让 Little Q 帮忙修；
 * 3. 提供 window.LittleQ.chat / reset：智能体作品通过外层页面（postMessage）和 QCA 上的角色对话，
 *    作品本身拿不到任何密钥，也发不了网络请求。
 */
export const RUNTIME_SHIM = `<script>(function(){try{window.localStorage.getItem('_')}catch(e){var m={};var s={getItem:function(k){return k in m?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}};try{Object.defineProperty(window,'localStorage',{value:s,configurable:true})}catch(_){}}
function send(msg){try{parent.postMessage({lqError:String(msg).slice(0,300)},'*')}catch(_){}}
window.addEventListener('error',function(e){send((e.message||'出错了')+(e.lineno?' (第 '+e.lineno+' 行)':''))});
window.addEventListener('unhandledrejection',function(e){send(e.reason&&e.reason.message||e.reason)});
var P={},n=0;
function ask(op,text,onDelta){return new Promise(function(res,rej){if(parent===window){rej(new Error('要在 LittleQ 里打开作品，才能和 AI 角色聊天哦'));return}
var id='q'+(++n)+Math.random().toString(36).slice(2,7);var t=setTimeout(function(){delete P[id];rej(new Error('AI 角色想得太久了，再试一次吧'))},150000);
P[id]={res:res,rej:rej,d:onDelta,t:t};parent.postMessage({lqAgent:{op:op,id:id,text:String(text==null?'':text).slice(0,500)}},'*')})}
window.addEventListener('message',function(e){if(e.source!==parent)return;var r=e.data&&e.data.lqAgentReply;if(!r||!P[r.id])return;var p=P[r.id];
if(r.delta&&typeof p.d==='function'){try{p.d(r.delta)}catch(_){}}
if(r.done){clearTimeout(p.t);delete P[r.id];if(r.error)p.rej(new Error(r.error));else p.res(r.text||'')}});
window.LittleQ={chat:function(text,onDelta){return ask('chat',text,onDelta)},reset:function(){return ask('reset','')}};})();</script>`;

export function withShim(html: string) {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + RUNTIME_SHIM);
  return RUNTIME_SHIM + html;
}
