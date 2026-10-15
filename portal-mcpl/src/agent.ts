/**
 * PortalAgent — the agent-facing surface over a PortalClient.
 *
 * Wires client events into AgentState (watermarks + pending pings) and routes
 * tool calls to RPC. Transport, cache, and resume are the client's job; durable
 * read-state is AgentState's; this class is the glue + the tool dispatch table.
 *
 * The remaining integration seam is binding this to an McplConnection (from
 * @animalabs/mcpl-core): forward tools/list → `toolDefinitions`, tools/call →
 * `handleToolCall`, and emit a PUSH_EVENT whenever `onPing` fires. That binding
 * is intentionally not done here so this package stays transport-agnostic and
 * unit-testable. See README for the ~30-line adapter sketch.
 */
import type { PortalClient } from '@animalabs/portal-client';
import type { AddressReason, PortalMessage } from '@animalabs/portal-protocol';
import { AgentState, type PendingPing } from './agent-state.js';
import {
  buildCandidates,
  channelLabel,
  formatChannelLabel,
  parseChannelRef,
  resolveChannelRef,
  type ResolveResult,
} from './channel-names.js';
import { chunkText } from './chunk.js';
import { toolDefinitions } from './tools.js';

/**
 * Tools retired where the host opens and closes channels itself
 * (hostOwnsChannelLifecycle): each answer says nothing ran and points to the
 * host's own channel tools.
 */
const RETIRED_WHEN_HOST_OWNS_CHANNELS: Readonly<Record<string, string>> = {
  subscribe_channel:
    'subscribe_channel is retired here: this host opens and closes channels itself, so nothing ran. ' +
    "Open the channel with your host's own channel tool instead, such as channel_open.",
  unsubscribe_channel:
    'unsubscribe_channel is retired here: this host opens and closes channels itself, so nothing ran. ' +
    "Close the channel with your host's own channel tool instead, such as channel_close.",
  list_subscriptions:
    'list_subscriptions is retired here: this host keeps track of open channels itself, so nothing ran. ' +
    "Your host's own channel tool lists them, such as channel_list.",
  set_reaction_visibility:
    'set_reaction_visibility is retired here, so nothing ran: reactions show in a channel while it is open, ' +
    "and this host opens and closes channels itself. To show or hide them, open or close the channel with your host's " +
    'own channel tools, such as channel_open and channel_close.',
};

export interface PortalAgentOptions {
  /** Restore persisted read-state (watermarks + pings). */
  state?: AgentState;
  /** Called when a new message is addressed to this persona — wire to a push. */
  onPing?: (ping: PendingPing) => void;
  /** The surrounding MCPL host owns open/close state in Chronicle. This
   *  disables the legacy subscription tools and mention auto-subscribe while
   *  leaving the standalone Claude Code channel behavior unchanged. */
  hostOwnsChannelLifecycle?: boolean;
  /** Called after this persona does something PUBLIC (posts, reacts, edits) —
   *  a beacon for supervisors that can't see every channel it acts in. */
  onPublicActivity?: (kind: 'message' | 'reaction' | 'edit') => void;
}

export class PortalAgent {
  readonly state: AgentState;
  private onPing?: (ping: PendingPing) => void;
  private hostOwnsChannelLifecycle: boolean;
  private onPublicActivity?: (kind: 'message' | 'reaction' | 'edit') => void;

  constructor(
    private client: PortalClient,
    opts: PortalAgentOptions = {},
  ) {
    this.state = opts.state ?? new AgentState();
    this.onPing = opts.onPing;
    this.hostOwnsChannelLifecycle = opts.hostOwnsChannelLifecycle === true;
    this.onPublicActivity = opts.onPublicActivity;
    this.client.on('message', (e) => this.ingest(e.message, e.addressedToMe, e.reasons));
    this.client.on('messageUpdate', (e) => {
      // An edit to a message we track refreshes its preview but isn't a new ping.
      this.state.ingest(e.message, false, e.reasons);
    });
    // A transport `resume` restores the event stream but NOT the relay session's
    // subscriptions (the new session starts empty). Reapply from durable state.
    // The fresh-`identify` path already carries them via the client's replay set.
    if (!this.hostOwnsChannelLifecycle) {
      this.client.on('resumed', () => this.reapplySubscriptions());
    }
  }

  /** Re-assert this agent's durable subscriptions on the live session. */
  private reapplySubscriptions(): void {
    for (const channelId of this.state.subscriptionList()) {
      this.client.subscribe(channelId).catch(() => {});
    }
  }

  private ingest(message: PortalMessage, addressedToMe: boolean, reasons: AddressReason[]): void {
    // Auto-subscribe to a channel the moment we're addressed there. A mention is
    // delivered regardless of subscription, but the relay drops *ambient*
    // (non-mention) messages for unsubscribed personas — so without this, the
    // agent never sees the chatter between mentions. Subscribing now means
    // subsequent ambient messages are delivered and accumulate for the next wake.
    if (!this.hostOwnsChannelLifecycle && addressedToMe && this.state.subscribe(message.channelId)) {
      if (process.env.PORTAL_DEBUG) {
        console.error(`[portal-cc] auto-subscribed to ${message.channelId} (addressed here)`);
      }
      this.client.subscribe(message.channelId).catch(() => {});
    }
    const wasPing = this.state.ingest(message, addressedToMe, reasons);
    if (wasPing && this.onPing) {
      this.onPing({ message, reasons, at: message.createdAt });
    }
  }

  get tools(): typeof toolDefinitions {
    if (!this.hostOwnsChannelLifecycle) return toolDefinitions;
    return toolDefinitions.filter((tool) => !Object.hasOwn(RETIRED_WHEN_HOST_OWNS_CHANNELS, tool.name));
  }

  /** Server-authoritative pending pings, including any accrued while this
   *  session was offline. Used by the channel binding for reconnect catch-up. */
  async pendingPingsFromRelay(): Promise<PendingPing[]> {
    const { pings } = await this.client.call('get_pending_pings', {});
    return pings;
  }

  /** Fetch a window of messages centred on `messageId` (the relay returns the
   *  older and newer halves; the anchor itself may not be included). */
  private async fetchAround(
    channelId: string,
    messageId: string,
    limit: number,
    threadId?: string,
  ): Promise<{ messages: PortalMessage[] }> {
    const half = Math.max(1, Math.floor(limit / 2));
    const [older, newer] = await Promise.all([
      this.client.fetchHistory({ channelId, threadId, before: messageId, limit: half }),
      this.client.fetchHistory({ channelId, threadId, after: messageId, limit: half }),
    ]);
    const seen = new Set<string>();
    const messages = [...older.messages, ...newer.messages]
      .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return { messages };
  }

  /**
   * Resolve a channel reference — raw snowflake, `portal:<id>`, or the
   * `#name (Guild)` label the listings print — to a relay channel id. Reads the
   * live cache every call (never a startup snapshot: a renamed or re-granted
   * channel must resolve to what it is NOW). See channel-names.ts.
   */
  resolveChannelRef(ref: string): ResolveResult {
    return resolveChannelRef(ref, () =>
      buildCandidates(this.client.cache.allChannels(), this.client.cache.allGuilds()));
  }

  /** `#name (Guild)` for a cached channel; the raw id when unknown. */
  labelFor(channelId: string): string {
    const c = this.client.cache.getChannel(channelId);
    if (!c) return channelId;
    return formatChannelLabel(c.name ?? c.id, c.guildId ? this.client.cache.getGuild(c.guildId)?.name : undefined);
  }

  /** Dispatch a tool call. Returns a plain JSON-able result. */
  async handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    // A tool that won't run is answered before its arguments are looked at:
    // a retired tool's pointer, or an unknown name's nearest tools, is the
    // whole answer, whatever channel the call names.
    if (this.hostOwnsChannelLifecycle && Object.hasOwn(RETIRED_WHEN_HOST_OWNS_CHANNELS, name)) {
      throw new Error(RETIRED_WHEN_HOST_OWNS_CHANNELS[name]);
    }
    if (!toolDefinitions.some((tool) => tool.name === name)) {
      throw new Error(unknownToolMessage(name, this.tools));
    }
    // THE chokepoint for channel addressing: every tool that takes a channelId
    // goes through here, so a name is resolved exactly once, before any side
    // effect, or the call fails audibly — never a silent pick, never a name
    // passed downstream hoping the relay rejects it. Ids pass through untouched.
    if (typeof args.channelId === 'string' && args.channelId.trim()) {
      const parsed = parseChannelRef(args.channelId);
      if (parsed?.kind !== 'id') {
        const resolved = this.resolveChannelRef(args.channelId);
        if (!resolved.ok) {
          throw new Error(`Nothing ran: channelId ${shortJson(args.channelId)} ${resolved.message}`);
        }
        args = { ...args, channelId: resolved.id };
      } else if (parsed.id !== args.channelId) {
        args = { ...args, channelId: parsed.id }; // `portal:<id>` → bare id
      }
    }
    // threadId goes through the same chokepoint. Absent or null means no
    // thread. Anything else must name one, in a form channelId accepts, or
    // the call is refused here, before anything is sent or read: a value that
    // named no thread used to be dropped, and the post landed in the parent.
    // A threadId equal to channelId names the thread itself, which channelId
    // alone already addresses.
    if (args.threadId === null) {
      args = { ...args, threadId: undefined };
    } else if (args.threadId !== undefined) {
      const parsed = typeof args.threadId === 'string' ? parseChannelRef(args.threadId) : null;
      // Threads aren't addressable by label, so only an id names one.
      if (parsed?.kind !== 'id') {
        throw new Error(
          `Nothing ran: threadId ${shortJson(args.threadId)} isn't a thread id. A thread is named by its id ` +
            "(or portal:<id>), as create_thread returns it and as a message's threadId shows it; " +
            'null or no threadId means no thread.',
        );
      }
      args = { ...args, threadId: parsed.id === args.channelId ? undefined : parsed.id };
    }
    switch (name) {
      case 'send_message': {
        // Discord caps content at 2000 chars — split long messages into
        // sequential sends (files/reply/mentions ride on the first chunk).
        const content = optStr(args.content, 'content');
        const chunks = content !== undefined ? chunkText(content) : [content];
        const posted: string[] = [];
        let first: unknown;
        for (let i = 0; i < chunks.length; i++) {
          let result: unknown;
          try {
            result = await this.client.sendMessage({
              channelId: str(args.channelId, 'channelId'),
              // Every chunk goes to the same place: a thread under channelId
              // when one is named, else channelId itself.
              threadId: optStr(args.threadId, 'threadId'),
              content: chunks[i],
              ...(i === 0
                ? {
                    files: args.files as never,
                    replyToId: optStr(args.replyToId, 'replyToId'),
                    mentionPersonaIds: args.mentionPersonaIds as string[] | undefined,
                  }
                : {}),
            });
          } catch (e) {
            if (i === 0) throw e;
            // The earlier parts are posted, so a refusal of this part, which
            // says nothing ran for its own call, isn't the whole answer; and
            // posting them was public activity.
            this.onPublicActivity?.('message');
            throw new Error(
              `Only part of the message was sent: the first ${i} of ${chunks.length} parts were posted ` +
                `(${posted.map((id) => JSON.stringify(id)).join(', ')}), and part ${i + 1} wasn't. ` +
                `Its call answered: "${(e as Error).message}" ` +
                'To send the rest, call send_message with only the text that didn\'t go out; fetch_around shows what did.',
            );
          }
          const id = (result as { messageId?: unknown } | undefined)?.messageId;
          if (typeof id === 'string') posted.push(id);
          first ??= result;
        }
        this.onPublicActivity?.('message');
        return first;
      }
      case 'edit_message': {
        const edited = await this.client.editMessage(str(args.messageId, 'messageId'), str(args.content, 'content'));
        this.onPublicActivity?.('edit');
        return edited;
      }
      case 'delete_message':
        return this.client.deleteMessage(str(args.messageId, 'messageId'));
      case 'react': {
        const reacted = await this.client.react(
          str(args.messageId, 'messageId'),
          str(args.emoji, 'emoji'),
          Boolean(args.visible),
          Boolean(args.native),
        );
        this.onPublicActivity?.('reaction');
        return reacted;
      }
      case 'unreact':
        return this.client.unreact(str(args.messageId, 'messageId'), str(args.emoji, 'emoji'), Boolean(args.native));
      case 'fetch_history':
        return this.client.fetchHistory({
          channelId: str(args.channelId, 'channelId'),
          threadId: optStr(args.threadId, 'threadId'),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          before: optStr(args.before, 'before'),
          after: optStr(args.after, 'after'),
        });
      case 'fetch_around':
        return this.fetchAround(
          str(args.channelId, 'channelId'),
          str(args.messageId, 'messageId'),
          typeof args.limit === 'number' ? args.limit : 50,
          optStr(args.threadId, 'threadId'),
        );
      case 'list_guilds':
        return this.client.call('list_guilds', {});
      case 'list_channels': {
        // Each channel carries its `label` — the exact string every channelId
        // argument accepts (display form == address form). Threads/categories
        // are labelled too but remain id-only addresses.
        const guildId = str(args.guildId, 'guildId');
        const guildName = this.client.cache.getGuild(guildId)?.name;
        const res = (await this.client.call('list_channels', { guildId })) as {
          channels: Array<{ id: string; name: string | null; type: string }>;
        };
        return {
          channels: res.channels.map((c) => ({
            ...c,
            label: formatChannelLabel(c.name ?? c.id, guildName),
          })),
        };
      }
      case 'create_thread':
        return this.client.call('create_thread', {
          channelId: str(args.channelId, 'channelId'),
          name: str(args.name, 'name'),
        });
      case 'subscribe_channel': {
        const channelId = str(args.channelId, 'channelId');
        this.state.subscribe(channelId); // durable; persisted via onChange
        return this.client.subscribe(channelId);
      }
      case 'unsubscribe_channel': {
        const channelId = str(args.channelId, 'channelId');
        this.state.unsubscribe(channelId);
        return this.client.unsubscribe(channelId);
      }
      case 'list_subscriptions':
        // Durable agent state is the source of truth (survives reconnect/restart).
        return { channelIds: this.state.subscriptionList() };
      case 'list_members':
        return this.client.call('list_members', {
          guildId: str(args.guildId, 'guildId'),
          query: optStr(args.query, 'query'),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        });
      case 'resolve_mentions':
        return this.client.call('resolve_mentions', {
          guildId: str(args.guildId, 'guildId'),
          handles: (args.handles as string[]) ?? [],
        });
      case 'list_roles':
        return this.client.call('list_roles', { guildId: str(args.guildId, 'guildId') });
      case 'list_emojis':
        return this.client.call('list_emojis', { guildId: optStr(args.guildId, 'guildId') });
      case 'set_reaction_visibility': {
        const channelId = str(args.channelId, 'channelId');
        const visible = Boolean(args.visible);
        // Durable per-channel opt-in; persisted via onChange. Reactions are shown
        // in context but NEVER wake the agent (see server.ts push path).
        this.state.setReactionVisibility(channelId, visible);
        return visible
          ? `Reaction visibility ON for ${channelId}. Reactions there now appear in your context as they happen (they never wake you). Subscribe to the channel if you aren't already, so its reactions reach you.`
          : `Reaction visibility OFF for ${channelId}.`;
      }
      case 'list_pins':
        return this.client.call('list_pins', { channelId: str(args.channelId, 'channelId') });
      case 'voice_join':
        return this.client.call('voice_join', { channelId: str(args.channelId, 'channelId') });
      case 'voice_leave':
        return this.client.call('voice_leave', { channelId: str(args.channelId, 'channelId') });
      case 'voice_speak':
        return this.client.call('voice_speak', {
          channelId: str(args.channelId, 'channelId'),
          text: str(args.text, 'text'),
          ...(args.requestId !== undefined ? { requestId: str(args.requestId, 'requestId') } : {}),
          ...(args.grant !== undefined ? { grant: args.grant as never } : {}),
        });
      case 'get_pending_pings':
        // Server-authoritative: includes pings accrued while this session was
        // offline (the relay accumulates for every persona, online or not).
        return this.client.call('get_pending_pings', {});
      case 'list_unread':
        return this.client.call('list_unread', {});
      case 'channel_missed':
        return this.client.call('channel_missed', { channelId: str(args.channelId, 'channelId') });
      case 'mark_read': {
        const channelId = str(args.channelId, 'channelId');
        const uptoCreatedAt = optStr(args.uptoCreatedAt, 'uptoCreatedAt');
        // Advance the server watermark (durable) and the local live-wake state.
        this.state.markRead(channelId, uptoCreatedAt);
        await this.client.call('mark_read', { channelId, uptoCreatedAt });
        return { ok: true };
      }
      default:
        throw new Error(unknownToolMessage(name, this.tools));
    }
  }
}

/** A string argument, refused by name before anything runs. */
function str(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`Nothing ran: ${name} must be a string, got ${shortJson(v)}.`);
  return v;
}
/** An optional string argument: absent when undefined or null, refused by name when it's anything else. */
function optStr(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`Nothing ran: ${name} must be a string when given, got ${shortJson(v)}.`);
  return v;
}
/** A caller's value for an error message, bounded so a huge one isn't echoed whole. */
export function shortJson(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(typeof v);
  }
  if (s.length <= 60) return s;
  // A cut string keeps its closing quote, so the message around it still reads.
  return s.startsWith('"') ? `${s.slice(0, 59)}…"` : `${s.slice(0, 60)}…`;
}

/**
 * The refusal for a tool name the server doesn't have. It names the closest
 * of the tools this agent can call, so a typo is fixed in one step.
 */
export function unknownToolMessage(name: unknown, available: readonly { name: string }[]): string {
  const asked = typeof name === 'string' ? name : '';
  const close = available
    .map((tool) => ({ name: tool.name, distance: editDistance(asked, tool.name) }))
    .filter((c) => c.distance <= Math.max(2, Math.floor(asked.length / 3)))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((c) => `"${c.name}"`);
  const lead = `There's no Portal tool named ${shortJson(name)}, so nothing ran.`;
  return close.length > 0
    ? `${lead} Did you mean ${close.join(' or ')}?`
    : `${lead} Call one of the tools listed for you.`;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}
