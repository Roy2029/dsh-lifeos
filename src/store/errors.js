/**
 * LifeOS — 存储层错误类型（A 线）
 * 所有错误带稳定 code，供 B（application/runtime）映射 HTTP 错误码：
 * - store_unavailable → 503
 * - validation_failed → 422
 * - table_not_found / unit_mismatch / already_open / store_readonly / internal → 500（或按 B 的映射）
 */

export const STORE_ERROR_CODES = Object.freeze({
  STORE_UNAVAILABLE: 'store_unavailable',
  STORE_READONLY: 'store_readonly',
  ALREADY_OPEN: 'already_open',
  VALIDATION_FAILED: 'validation_failed',
  TABLE_NOT_FOUND: 'table_not_found',
  UNIT_MISMATCH: 'unit_mismatch',
  JOURNAL_CORRUPTED: 'journal_corrupted',
  CONFLICT: 'conflict',
  STORE_COMMIT_FAILED: 'store_commit_failed',
  INTERNAL: 'internal',
})

export class StoreError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.details = details
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details }
  }
}
