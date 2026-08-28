import type { NormalizedLead } from '@lrd/schema';

/**
 * Line-for-line port of the "Normalize Lead" Code node in content/workflow.json.
 * The node's jsCode is pinned by a test that hashes it; if the workflow
 * changes, the test fails until this port and the hash are updated together.
 *
 * Differences from the node, on purpose: `receivedAt` comes from the engine's
 * injected clock instead of `new Date()`, so a run is reproducible.
 */
export const PORTED_FROM_JSCODE_SHA256 = 'c0fd478ef6b61dd24fb3181bdfba6f260fdfdee613ea7dd3427ac82a303310f8';

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {};
}

export function normalizeLead(input: unknown, receivedAt: string): NormalizedLead {
  const root = asRecord(input);
  const raw = 'body' in root && root.body !== undefined && root.body !== null ? asRecord(root.body) : root;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== null && String(raw[k]).trim() !== '') {
        return String(raw[k]).trim();
      }
    }
    return '';
  };

  let firstName = pick('first_name', 'firstName');
  let lastName = pick('last_name', 'lastName');
  const fullName = pick('name', 'full_name', 'fullName');
  if (!firstName && fullName) {
    const parts = fullName.split(/\s+/);
    firstName = parts.shift() ?? '';
    lastName = parts.join(' ');
  }

  // Phone -> rough E.164. Demo assumes US 10-digit numbers; adjust to the client's market.
  let phone = pick('phone', 'phone_number', 'phoneNumber', 'mobile').replace(/[^\d+]/g, '');
  if (phone && !phone.startsWith('+')) {
    if (phone.length === 10) phone = '+1' + phone;
    else if (phone.length === 11 && phone.startsWith('1')) phone = '+' + phone;
  }

  return {
    firstName: firstName || 'there',
    lastName,
    email: pick('email', 'email_address').toLowerCase(),
    phone,
    source: pick('source', 'utm_source', 'form_name') || 'website-form',
    interest: pick('service', 'interest', 'treatment') || 'a treatment',
    receivedAt,
  };
}
