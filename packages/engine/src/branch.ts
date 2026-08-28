import { getPath } from './expressions.ts';

/**
 * Mirror of the single If-node condition in content/workflow.json ("Replied?"):
 *
 *   leftValue  = {{ $json.conversations && $json.conversations[0]
 *                   ? $json.conversations[0].lastMessageDirection : 'none' }}
 *   operator   = string equals, caseSensitive: false
 *   rightValue = "inbound"
 *
 * The engine refuses arbitrary JS expressions, so this one is mirrored by
 * hand and pinned to the workflow file by topology.test.ts. Output 0 (true)
 * is the human-takeover branch, output 1 (false) is escalation.
 */
export const REPLIED_CONDITION = {
  leftValue:
    "={{ $json.conversations && $json.conversations[0] ? $json.conversations[0].lastMessageDirection : 'none' }}",
  rightValue: 'inbound',
  operator: { type: 'string', operation: 'equals' },
  caseSensitive: false,
} as const;

export interface BranchDecision {
  replied: boolean;
  /** The value the left side resolved to, for the summary line. */
  observed: string;
  /** Which output index the execution continues on. */
  outputIndex: 0 | 1;
}

export function evaluateReplied(json: unknown): BranchDecision {
  const conversations = getPath(json, 'conversations');
  const first = Array.isArray(conversations) ? conversations[0] : undefined;
  const raw = first ? getPath(first, 'lastMessageDirection') : undefined;
  const observed = first ? String(raw) : 'none';
  const replied = observed.toLowerCase() === REPLIED_CONDITION.rightValue.toLowerCase();
  return { replied, observed, outputIndex: replied ? 0 : 1 };
}
