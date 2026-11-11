import { DecisionSchema, mockDecision, type Decision } from '@sr/schema';
import { expect, it } from 'vitest';

it('imports schema types and validates a decision through the workspace dependency', () => {
  const decision: Decision = DecisionSchema.parse(mockDecision);
  expect(decision).toEqual(mockDecision);
  expect(DecisionSchema.safeParse({ ...decision, action: 'invalid' }).success).toBe(false);
});
