#!/usr/bin/env node
// 推送映射自测：用真实帧形状验证「什么事件触发什么通知」，以及任务终态去重。
// 用法：node scripts/selftest-push.mjs
import { notificationsForFrame } from '../server/push.mjs';

let failed = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra === undefined ? '' : ' -> ' + extra));
  if (!ok) failed += 1;
}

const state = { jobs: new Map(), turns: new Set() };

const approval = notificationsForFrame(
  { type: 'approval/requested', sessionId: 'session-abc12345', approvalId: 'ap-1', toolName: 'Bash', reason: '需要更宽权限' },
  state,
);
check('审批请求触发高优先通知', approval.length === 1 && approval[0].urgency === 'high', JSON.stringify(approval[0] || null));
check('审批通知带工具名与原因', approval[0] && approval[0].body.includes('Bash') && approval[0].body.includes('需要更宽权限'));
check('审批通知 tag 唯一到审批 id', approval[0] && approval[0].tag === 'approval:ap-1');

const question = notificationsForFrame(
  { type: 'question/requested', sessionId: 'session-abc12345', questions: [{ question: '选哪个分支？' }] },
  state,
);
check('提问请求触发通知并带问题文本', question.length === 1 && question[0].body.includes('选哪个分支'), JSON.stringify(question[0] || null));

const err = notificationsForFrame({ type: 'host/agent-error', sessionId: 'session-abc12345', message: '模型返回 500' }, state);
check('agent 错误触发失败通知', err.length === 1 && err[0].title === '任务失败');

const jobsFirst = notificationsForFrame(
  { type: 'session/jobs', sessionId: 's1', jobs: [{ id: 'bash-1', label: 'pnpm test', status: 'completed', detail: 'exit code: 0' }] },
  state,
);
check('任务转为 completed 触发完成通知', jobsFirst.length === 1 && jobsFirst[0].title === '任务完成');

const jobsRepeat = notificationsForFrame(
  { type: 'session/jobs', sessionId: 's1', jobs: [{ id: 'bash-1', label: 'pnpm test', status: 'completed', detail: 'exit code: 0' }] },
  state,
);
check('同一终态重复推送不重复通知（快照去重）', jobsRepeat.length === 0);

const jobsFailed = notificationsForFrame(
  { type: 'session/jobs', sessionId: 's1', jobs: [{ id: 'bash-2', label: 'build', status: 'failed', detail: 'exit code: 1' }] },
  state,
);
check('任务失败触发失败通知', jobsFailed.length === 1 && jobsFailed[0].title.includes('failed'));

const turn1 = notificationsForFrame({ type: 'session/event', sessionId: 's1', event: { type: 'turn/end', seq: 42 } }, state);
const turn2 = notificationsForFrame({ type: 'session/event', sessionId: 's1', event: { type: 'turn/end', seq: 42 } }, state);
check('turn/end 按 seq 去重', turn1.length === 1 && turn2.length === 0);

const chunk = notificationsForFrame({ type: 'session/event', sessionId: 's1', event: { type: 'assistant/chunk', seq: 43 } }, state);
check('普通流式分片不产生通知', chunk.length === 0);

const subscribed = notificationsForFrame({ type: 'session/subscribed', sessionId: 's1', lastSeq: 1 }, state);
check('订阅基线帧不产生通知', subscribed.length === 0);

console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);
