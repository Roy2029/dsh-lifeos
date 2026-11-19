/**
 * A 线测试夹具：构造最小合法记录（M0 写路径用）。
 * 字段只给必填 + 少量展示字段；其余由 store.normalizeRecord 注入默认值。
 */

import { newId } from '../../../src/domain/ids.js'

export const TZ = 'Asia/Shanghai'
export const NOW = '2026-11-12T12:00:00.000Z'

export function rawRecord(overrides = {}) {
  const id = overrides.id ?? newId('rr')
  return {
    id,
    raw_text: '今天下午做了 30 分钟力量训练。',
    user_local_date: '2026-11-12',
    tz: TZ,
    channel: 'chat',
    source_conversation_id: 'conv-test',
    source_message_id: 'msg-test',
    ...overrides,
  }
}

export function inboxItem(overrides = {}) {
  const id = overrides.id ?? newId('inb')
  return {
    id,
    title: '调研 Agent Memory 的成熟方案',
    status: 'captured',
    ...overrides,
  }
}

export function task(overrides = {}) {
  const id = overrides.id ?? newId('tsk')
  return {
    id,
    title: '给导师发送实验结果',
    status: 'todo',
    ...overrides,
  }
}

export function operationLog(requestId, overrides = {}) {
  const id = overrides.id ?? newId('opl')
  return {
    id,
    actor_type: 'agent',
    action: 'inbox.capture',
    decision: 'allowed',
    status: 'applied',
    occurred_at: NOW,
    idempotency_key: requestId,
    meta_json: { request_id: requestId },
    ...overrides,
  }
}

/** 一次"捕获"事务的 ops：raw + inbox + oplog，跨 3 个 unit。 */
export function captureOps({ raw = rawRecord(), inbox = inboxItem(), oplog = operationLog(`req-${Date.now()}`) } = {}) {
  return {
    raw,
    inbox,
    oplog,
    ops: [
      { unit: 'lifeos_raw', table: 'raw_record', key: raw.id, value: raw },
      { unit: 'lifeos', table: 'inbox_item', key: inbox.id, value: inbox },
      { unit: 'lifeos_log', table: 'operation_log', key: oplog.id, value: oplog },
    ],
  }
}
