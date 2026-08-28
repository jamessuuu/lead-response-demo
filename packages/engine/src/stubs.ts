import type { Prng } from './prng.ts';
import { fnv1a16 } from './prng.ts';

/**
 * The stubhouse contract: the response shapes a stand-in returns for every
 * external call the topology makes. The same shapes are served over HTTP by
 * capture/stubhouse (M1) so the recording and the simulator agree.
 *
 * Every shape here is MODELED from the public API documentation. None has
 * been verified against a live LeadConnector, Slack or Sheets endpoint;
 * run files say so (`simulator.stubShapes: "modeled"`).
 */
export type Endpoint =
  | 'ghl.contacts.upsert'
  | 'ghl.conversations.messages'
  | 'ghl.conversations.search'
  | 'slack.chat.postMessage'
  | 'sheets.values.append';

export const ENDPOINTS: Record<Endpoint, { method: 'GET' | 'POST'; url: RegExp; description: string }> = {
  'ghl.contacts.upsert': {
    method: 'POST',
    url: /^https:\/\/services\.leadconnectorhq\.com\/contacts\/upsert$/,
    description: 'LeadConnector contact upsert',
  },
  'ghl.conversations.messages': {
    method: 'POST',
    url: /^https:\/\/services\.leadconnectorhq\.com\/conversations\/messages$/,
    description: 'LeadConnector send message (SMS or Email)',
  },
  'ghl.conversations.search': {
    method: 'GET',
    url: /^https:\/\/services\.leadconnectorhq\.com\/conversations\/search\?/,
    description: 'LeadConnector conversation search',
  },
  'slack.chat.postMessage': {
    method: 'POST',
    url: /^https:\/\/slack\.com\/api\/chat\.postMessage$/,
    description: 'Slack chat.postMessage (what the Slack node calls)',
  },
  'sheets.values.append': {
    method: 'POST',
    url: /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/[^/]+\/values\/[^:]+:append/,
    description: 'Sheets values.append (what the Google Sheets node calls)',
  },
};

export function classifyEndpoint(method: string, url: string): Endpoint {
  for (const [id, e] of Object.entries(ENDPOINTS) as Array<[Endpoint, (typeof ENDPOINTS)[Endpoint]]>) {
    if (e.method === method && e.url.test(url)) return id;
  }
  throw new Error(`No stub answers ${method} ${url}`);
}

export interface StubCall {
  endpoint: Endpoint;
  body: unknown;
  /** Epoch ms when the call completed, for timestamps inside responses. */
  completedAtMs: number;
}

export interface StubState {
  /** Contact ids the CRM already holds (a duplicate delivery finds its contact here). */
  knownContacts: Set<string>;
  /** What the conversation search reports for the last message. */
  replyDirection: 'inbound' | 'outbound';
  locationId: string;
}

export interface StubResult {
  status: number;
  body: unknown;
}

/** A stable contact id for a lead: the same person upserts to the same id. */
export function contactIdFor(locationId: string, email: string, phone: string): string {
  return `c_${fnv1a16(`${locationId}|${email}|${phone}`)}`;
}

function field(body: unknown, key: string): string {
  const v = body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  return v === undefined || v === null ? '' : String(v);
}

export function answer(call: StubCall, state: StubState, prng: Prng): StubResult {
  const iso = new Date(call.completedAtMs).toISOString();
  switch (call.endpoint) {
    case 'ghl.contacts.upsert': {
      const email = field(call.body, 'email');
      const phone = field(call.body, 'phone');
      const id = contactIdFor(state.locationId, email, phone);
      const isNew = !state.knownContacts.has(id);
      state.knownContacts.add(id);
      return {
        status: 200,
        body: {
          new: isNew,
          contact: {
            id,
            locationId: state.locationId,
            firstName: field(call.body, 'firstName'),
            lastName: field(call.body, 'lastName'),
            email,
            phone,
            source: field(call.body, 'source'),
            tags: (call.body as { tags?: unknown })?.tags ?? [],
            dateAdded: iso,
          },
        },
      };
    }
    case 'ghl.conversations.messages': {
      const type = field(call.body, 'type');
      const contactId = field(call.body, 'contactId');
      const conversationId = `conv_${fnv1a16(`${state.locationId}|${contactId}`)}`;
      const messageId = `msg_${prng.hex(16)}`;
      const body: Record<string, unknown> = {
        conversationId,
        messageId,
        msg: 'Message queued successfully.',
      };
      if (type === 'Email') body.emailMessageId = `em_${prng.hex(16)}`;
      return { status: 200, body };
    }
    case 'ghl.conversations.search': {
      const contactId = field(call.body, 'contactId');
      const conversationId = `conv_${fnv1a16(`${state.locationId}|${contactId}`)}`;
      return {
        status: 200,
        body: {
          conversations: [
            {
              id: conversationId,
              contactId,
              locationId: state.locationId,
              lastMessageType: 'TYPE_SMS',
              lastMessageDirection: state.replyDirection,
              unreadCount: state.replyDirection === 'inbound' ? 1 : 0,
              dateUpdated: iso,
            },
          ],
          total: 1,
        },
      };
    }
    case 'slack.chat.postMessage': {
      const channel = field(call.body, 'channel');
      const ts = `${Math.floor(call.completedAtMs / 1000)}.${prng.digits(6)}`;
      return {
        status: 200,
        body: { ok: true, channel, ts, message: { type: 'message', text: field(call.body, 'text'), ts } },
      };
    }
    case 'sheets.values.append': {
      const spreadsheetId = field(call.body, 'spreadsheetId');
      const sheet = field(call.body, 'sheet');
      const columns = Number(field(call.body, 'columns')) || 0;
      const lastCol = String.fromCharCode(64 + Math.max(1, Math.min(26, columns)));
      const row = 2 + prng.int(400);
      return {
        status: 200,
        body: {
          spreadsheetId,
          tableRange: `${sheet}!A1:${lastCol}${row - 1}`,
          updates: {
            spreadsheetId,
            updatedRange: `${sheet}!A${row}:${lastCol}${row}`,
            updatedRows: 1,
            updatedColumns: columns,
            updatedCells: columns,
          },
        },
      };
    }
  }
}

/** Error bodies for the injected faults, in each service's own shape. */
export const FAULT_BODIES = {
  ghl429: { statusCode: 429, message: 'Too Many Requests', error: 'Too Many Requests' },
  slack401: { ok: false, error: 'invalid_auth' },
} as const;
