export class AirwallexConfigError extends Error {
  override readonly name = 'AirwallexConfigError';
  constructor(readonly variable: string, message = `Missing required variable: ${variable}`) {
    super(message);
  }
}

/** Contains API response metadata only; never request headers or the request body. */
export class AirwallexApiError extends Error {
  override readonly name = 'AirwallexApiError';
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export class AirwallexSafetyError extends Error {
  override readonly name = 'AirwallexSafetyError';
}

/** Zod location only. Never a received value, issue message, or other echo of the body. */
export interface AirwallexResponseIssue {
  path: string;
  code: string;
}

const ISSUE_CODE = /^[a-z0-9_]{1,64}$/;
const PATH_SEGMENT = /^[A-Za-z0-9_]{1,64}$/;
const ENDPOINT_NAME = /^\/[A-Za-z0-9_./-]{1,200}$/;

/** 路径只保留 schema 键和数组下标，丢掉可能是卡号或自由文本的片段。 */
function safeIssuePath(path: string): string {
  if (path === '') return '';
  return path.split('.').map(segment => (
    PATH_SEGMENT.test(segment) && !/\d{13,}/.test(segment) ? segment : '_'
  )).join('.');
}

function safeIssueCode(code: string): string {
  return ISSUE_CODE.test(code) ? code : 'invalid';
}

/** 端点名不含查询串，避免把调用方放进 query 的值再打印出来。 */
function safeEndpoint(endpoint: string): string {
  const name = endpoint.split('?')[0] ?? '';
  return ENDPOINT_NAME.test(name) ? name : '';
}

export class AirwallexResponseError extends Error {
  override readonly name = 'AirwallexResponseError';
  readonly endpoint: string;
  readonly issues: readonly AirwallexResponseIssue[];
  constructor(endpoint = '', issues: readonly AirwallexResponseIssue[] = []) {
    super('Invalid Airwallex response');
    this.endpoint = safeEndpoint(endpoint);
    this.issues = Object.freeze(issues.slice(0, 32).map(issue => Object.freeze({
      path: safeIssuePath(typeof issue.path === 'string' ? issue.path : ''),
      code: safeIssueCode(typeof issue.code === 'string' ? issue.code : ''),
    })));
  }
}
