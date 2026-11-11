export type FailureReason = 'limit_exceeded' | 'merchant_category_not_allowed' | 'currency_not_allowed' | 'card_inactive' | 'other';

export function mapFailureReason(reason: string | null | undefined): FailureReason {
  switch (reason) {
    case 'LIMIT_EXCEEDED': return 'limit_exceeded';
    case 'MERCHANT_CATEGORY_NOT_ALLOWED': return 'merchant_category_not_allowed';
    case 'CURRENCY_NOT_ALLOWED': return 'currency_not_allowed';
    case 'CARD_INACTIVE': return 'card_inactive';
    default: return 'other';
  }
}
