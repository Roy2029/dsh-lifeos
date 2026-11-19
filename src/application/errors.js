/** B：应用层结构化错误（service 与 task-service 共用，避免循环依赖）。 */
export class LifeosError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'LifeosError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
