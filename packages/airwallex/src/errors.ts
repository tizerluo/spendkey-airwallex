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

export class AirwallexResponseError extends Error {
  override readonly name = 'AirwallexResponseError';
  constructor() { super('Invalid Airwallex response'); }
}
