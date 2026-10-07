/**
 * Run every test in this package.
 *
 * The suites are deliberately runnable without a build step and without the GUI:
 * the detector against real on-disk logs, the Host half against a stub Cordis
 * context, and the Client half against a React stub. Together they cover
 * everything except how the badge actually looks in the sidebar, which needs a
 * human eye.
 *
 * Run: node test/run-all.mjs
 *
 * @module dsh-session-watch/test/run-all
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Suites in the order they build on each other. */
const suites = [
  ['detect.test.mjs', '判定规则（纯逻辑）'],
  ['approval-gate-counterfactual.mjs', '审批闸门修复的反证（证明旧代码会误恢复）'],
  ['logs.test.mjs', '日志读取与截断（纯逻辑）'],
  ['transcript.test.mjs', '会话转写与停止归因（纯逻辑）'],
  ['resume.test.mjs', '自动恢复策略（纯逻辑）'],
  ['plugin-smoke.mjs', 'Host 半（真实 DSH home）'],
  ['resume-wiring.mjs', '自动恢复接线（假 Host，隔离 home）'],
  ['snapshot-outcome.test.mjs', '快照报告结果而非意图（假 Host，隔离 home）'],
  ['host-ready.test.mjs', 'Host 未就绪不消耗尝试次数（假 Host，隔离 home）'],
  ['proxy.test.mjs', '用户代理专家工具（假 Host，隔离 home）'],
  ['expert-diagnosis.test.mjs', '专家诊断能力（真实会话语料，只读）'],
  ['config-divergence.test.mjs', '两半策略一致性（假 Host，隔离 home）'],
  ['handoff.test.mjs', '第 2→3 层交接（策略停手后给出下一步）'],
  ['handoff-parked.test.mjs', '交接只在真正需要人时出现（隔离 home）'],
  ['shared-instance.test.mjs', '两半共享同一快照信箱（真实 profile 解析）'],
  ['proxy-apply.test.mjs', '用户代理专家挂载（假 Cordis ctx，隔离 home）'],
  ['preset-drift.mjs', 'user-proxy preset 与 standard 的对账（读真实 asar）'],
  ['enable-resume-logic.test.mjs', '开启第 2 层的配置改写（离屏，不改真实配置）'],
  ['client-smoke.mjs', 'Client 半（React stub）'],
  ['replay.mjs', '真实日志回放（只读报告）'],
]

let failedSuites = 0
for (const [file, label] of suites) {
  console.log(`\n${'='.repeat(60)}\n${label}  —  ${file}\n${'='.repeat(60)}`)
  const result = spawnSync(process.execPath, [path.join(here, file)], {
    stdio: 'inherit',
    cwd: path.join(here, '..'),
  })
  if (result.status !== 0) {
    failedSuites += 1
    console.log(`\n[失败] ${file} 退出码 ${result.status}`)
  }
}

console.log(`\n${'='.repeat(60)}`)
console.log(failedSuites === 0 ? '全部测试通过' : `${failedSuites} 个套件失败`)
process.exit(failedSuites === 0 ? 0 : 1)
