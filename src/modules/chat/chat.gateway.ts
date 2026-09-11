import { Logger, type OnModuleDestroy, UseFilters } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  USER_FORCE_DISCONNECT,
  type UserForceDisconnectEvent,
} from 'src/common/events/domain-events';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { WsExceptionsFilter } from 'src/common/filters/ws-exceptions.filter';
import type { AuthenticatedUser } from 'src/common/types/authenticated-user';
import { SocketAuthService } from 'src/modules/auth/services/socket-auth.service';
import { PresenceService } from 'src/modules/wishmates/presence.service';
import { WishmatesService } from 'src/modules/wishmates/wishmates.service';
import { ChatService } from './chat.service';
import {
  CHAT_BROADCAST,
  CHAT_FORCE_LEAVE,
  CHAT_NAMESPACE,
  chatRoom,
  userRoom,
  WS_EVENT,
  type ChatBroadcast,
  type ChatForceLeave,
} from './chat.types';

interface AuthedSocket extends Socket {
  data: {
    user?: AuthenticatedUser;
    /**
     * Which conversations this socket has open.
     *
     * Tracked here rather than read back from `socket.rooms` because by the
     * time a disconnect is delivered those are already empty, and the rooms
     * have to be given up for the person to stop counting as reading them.
     */
    chats?: Set<string>;
  };
}

/**
 * How often every live connection is re-asserted as online.
 *
 * Presence expires after ONLINE_TTL_SECONDS so that a phone which dies without
 * sending a disconnect stops reading as online. Nothing renewed it, though, so
 * a connection that simply sat there — which is what a chat screen with nobody
 * typing *is* — expired at ninety seconds and the other side watched them go
 * offline while they were still looking at the conversation.
 *
 * A third of the TTL, so two sweeps can be missed before anybody is wrongly
 * marked away.
 */
const PRESENCE_SWEEP_MS = 30_000;

/**
 * The realtime chat gateway.
 *
 * Authentication happens once, on connect: the handshake token runs through the
 * exact same checks as a REST request (SocketAuthService → JwtStrategy.validate).
 * Every connection joins its own `user:{id}` room, which is what lets a single
 * broadcast exclude one viewer (the anti-spoiler) and lets a revocation
 * force-disconnect a specific user across every instance.
 *
 * Messages are *posted* over REST (so one validation + authorization path serves
 * both transports); this gateway delivers them. It broadcasts by listening to the
 * in-process CHAT_BROADCAST event that ChatService emits after any mutation, so a
 * REST post and a socket action fan out identically.
 */
@UseFilters(new WsExceptionsFilter())
@WebSocketGateway({ namespace: CHAT_NAMESPACE })
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(ChatGateway.name);

  private sweep?: ReturnType<typeof setInterval>;

  @WebSocketServer()
  private readonly server!: Namespace;

  constructor(
    private readonly socketAuth: SocketAuthService,
    private readonly chat: ChatService,
    private readonly presence: PresenceService,
    private readonly wishmates: WishmatesService,
  ) {}

  /**
   * Authenticate at the handshake, before the connection is established, so a
   * bad token is rejected with `connect_error` and never becomes a live socket.
   * Doing it in handleConnection would be too late — the client would briefly
   * connect and only then be disconnected.
   */
  afterInit(server: Namespace): void {
    this.startPresenceSweep();
    server.use((socket: AuthedSocket, next: (err?: Error) => void) => {
      const token =
        (socket.handshake.auth?.token as string | undefined) ??
        socket.handshake.headers.authorization;
      this.socketAuth
        .authenticate(token)
        .then((user) => {
          socket.data.user = user;
          next();
        })
        .catch((err: Error) => next(err));
    });
  }

  onModuleDestroy(): void {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = undefined;
  }

  /**
   * Keeps every connected user's presence from expiring under them.
   *
   * Per instance and over its own sockets, which is the only set it can see —
   * with several instances behind the adapter each renews the connections it
   * is actually holding, and together they cover everybody.
   *
   * `unref` so this timer alone never keeps the process alive: a test suite
   * that finishes should exit, not hang for thirty seconds.
   */
  private startPresenceSweep(): void {
    if (this.sweep) return;
    this.sweep = setInterval(() => {
      // Caught, not merely `void`ed. `void` discards the promise without
      // handling a rejection, and Node exits the process on an unhandled one:
      // a twelve-second Redis blip — a snapshot that could not fork — took the
      // whole backend down through this line, because every `SET` in the sweep
      // came back MISCONF. A missed heartbeat costs a presence key its refresh
      // until the next sweep, which is not worth a process.
      this.touchConnected().catch((err: Error) =>
        this.logger.warn(`Presence sweep failed: ${err.message}`),
      );
    }, PRESENCE_SWEEP_MS);
    this.sweep.unref?.();
  }

  /**
   * Tells this user's WishMates that they came online, or went away.
   *
   * Without this the only presence a client ever heard about was somebody
   * joining the very chat room it was already sitting in, so a header opened
   * before the other person arrived said "Offline" for the rest of the
   * session — the state was correct when it was read and never read again.
   *
   * Addressed to each mate's own room, so it reaches them wherever they are in
   * the app rather than only inside a conversation. Failure is logged and
   * swallowed: a presence dot is not worth refusing a connection over.
   */
  private async announcePresence(userId: string, online: boolean): Promise<void> {
    try {
      const mates = await this.wishmates.mateIdsOf(userId);
      const payload = { userId, online, at: new Date().toISOString() };
      for (const mate of mates) {
        this.server.to(userRoom(mate.toString())).emit(WS_EVENT.PRESENCE, payload);
      }
    } catch (err) {
      this.logger.warn(
        `Could not announce presence for ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Public only so a test can run one sweep without waiting for the timer. */
  async touchConnected(): Promise<void> {
    const seen = new Set<string>();
    for (const socket of this.server.sockets.values()) {
      const user = (socket as AuthedSocket).data.user;
      // One touch per user, not per socket — somebody with a phone and a
      // laptop open is still one presence key.
      if (user && !seen.has(user.id)) {
        seen.add(user.id);
        await this.presence.touch(user.id);
      }
      // Per socket, not per user: two devices can have different chats open.
      for (const chatId of (socket as AuthedSocket).data.chats ?? []) {
        if (user) await this.presence.touchChat(user.id, chatId);
      }
    }
  }

  async handleConnection(client: AuthedSocket): Promise<void> {
    const user = client.data.user;
    if (!user) {
      client.disconnect(true);
      return;
    }
    // Own room: lets a broadcast exclude this user and a revocation evict them.
    await client.join(userRoom(user.id));
    const held = await this.presence.connected(user.id);
    // Only the first connection is news. A second device opening does not make
    // somebody any more online than they already were.
    if (held === 1) await this.announcePresence(user.id, true);
    this.logger.debug(`Socket ${client.id} authenticated as ${user.id}`);
  }

  async handleDisconnect(client: AuthedSocket): Promise<void> {
    const user = client.data.user;
    if (!user) return;
    this.logger.debug(`Socket ${client.id} (${user.id}) disconnected`);
    for (const chatId of client.data.chats ?? []) {
      await this.presence.leftChat(user.id, chatId);
    }
    const held = await this.presence.disconnected(user.id);
    if (held === 0) await this.announcePresence(user.id, false);
  }

  @SubscribeMessage(WS_EVENT.JOIN)
  async onJoin(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { chatId?: string },
  ): Promise<{ joined: string }> {
    const user = ChatGateway.requireUser(client);
    const chatId = ChatGateway.requireChatId(body);
    // Authorize exactly as the REST read path does; throws → WsExceptionsFilter.
    const { chat } = await this.chat.authorize(chatId, user.id);
    await client.join(chatRoom(chatId));
    await this.chat.addParticipant(chat._id, user.id);
    (client.data.chats ??= new Set()).add(chatId);
    await this.presence.enteredChat(user.id, chatId);
    client.to(chatRoom(chatId)).emit(WS_EVENT.PRESENCE, { chatId, userId: user.id, online: true });
    return { joined: chatId };
  }

  @SubscribeMessage(WS_EVENT.LEAVE)
  async onLeave(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { chatId?: string },
  ): Promise<{ left: string }> {
    const user = ChatGateway.requireUser(client);
    const chatId = ChatGateway.requireChatId(body);
    await client.leave(chatRoom(chatId));
    client.data.chats?.delete(chatId);
    await this.presence.leftChat(user.id, chatId);
    client.to(chatRoom(chatId)).emit(WS_EVENT.PRESENCE, { chatId, userId: user.id, online: false });
    return { left: chatId };
  }

  @SubscribeMessage(WS_EVENT.TYPING)
  onTyping(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { chatId?: string; typing?: boolean },
  ): void {
    const user = ChatGateway.requireUser(client);
    const chatId = ChatGateway.requireChatId(body);
    // Only sockets that have joined the room hear it; a non-member never does.
    client.to(chatRoom(chatId)).emit(WS_EVENT.TYPING, {
      chatId,
      userId: user.id,
      typing: body.typing !== false,
    });
  }

  // ── Broadcast fan-out (from ChatService, both REST and socket paths) ─────────

  @OnEvent(CHAT_BROADCAST)
  broadcast(msg: ChatBroadcast): void {
    // Exclude the personal rooms of anyone this message hides from — the socket
    // half of the anti-spoiler. `.except()` resolves across the Redis adapter.
    const target = (msg.hideFromUserIds ?? []).reduce(
      (emitter, uid) => emitter.except(userRoom(uid)),
      this.server.to(chatRoom(msg.chatId)),
    );
    target.emit(msg.event, msg.payload);
  }

  /**
   * A user lost access to a wishlist — evict them from its chat everywhere.
   *
   * `socketsLeave` and the disconnect propagate through the Redis adapter, so the
   * user is removed even from rooms held on other instances. Combined with the
   * REST history re-checking access, a revoked member can neither receive new
   * messages nor read old ones.
   */
  @OnEvent(CHAT_FORCE_LEAVE)
  forceLeave(evt: ChatForceLeave & { chatId?: string }): void {
    if (!evt.chatId) return;
    this.server.in(userRoom(evt.userId)).socketsLeave(chatRoom(evt.chatId));
    this.server.to(userRoom(evt.userId)).emit(WS_EVENT.ERROR, {
      success: false,
      error: { code: 'FORBIDDEN', message: 'You no longer have access to this chat' },
    });
  }

  /**
   * A suspended / force-logged-out user must not keep a live socket. Their REST
   * access is already dead (status + tokensInvalidBefore); this closes the
   * websocket half. `disconnectSockets(true)` fully closes every one of their
   * connections, across instances via the Redis adapter — the counterpart to the
   * room-only `socketsLeave` above.
   */
  @OnEvent(USER_FORCE_DISCONNECT)
  forceDisconnect(evt: UserForceDisconnectEvent): void {
    this.server.to(userRoom(evt.userId)).emit(WS_EVENT.ERROR, {
      success: false,
      error: { code: 'ACCOUNT_SUSPENDED', message: evt.reason },
    });
    this.server.in(userRoom(evt.userId)).disconnectSockets(true);
  }

  private static requireUser(client: AuthedSocket): AuthenticatedUser {
    const user = client.data.user;
    if (!user) {
      client.disconnect(true);
      throw new Error('unauthenticated');
    }
    return user;
  }

  private static requireChatId(body: { chatId?: string }): string {
    if (!body?.chatId) throw new Error('chatId is required');
    return body.chatId;
  }
}
