import { Logger, UseFilters } from '@nestjs/common';
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
  data: { user?: AuthenticatedUser };
}

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
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  private readonly server!: Namespace;

  constructor(
    private readonly socketAuth: SocketAuthService,
    private readonly chat: ChatService,
    private readonly presence: PresenceService,
  ) {}

  /**
   * Authenticate at the handshake, before the connection is established, so a
   * bad token is rejected with `connect_error` and never becomes a live socket.
   * Doing it in handleConnection would be too late — the client would briefly
   * connect and only then be disconnected.
   */
  afterInit(server: Namespace): void {
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

  async handleConnection(client: AuthedSocket): Promise<void> {
    const user = client.data.user;
    if (!user) {
      client.disconnect(true);
      return;
    }
    // Own room: lets a broadcast exclude this user and a revocation evict them.
    await client.join(userRoom(user.id));
    await this.presence.connected(user.id);
    this.logger.debug(`Socket ${client.id} authenticated as ${user.id}`);
  }

  async handleDisconnect(client: AuthedSocket): Promise<void> {
    const user = client.data.user;
    if (!user) return;
    this.logger.debug(`Socket ${client.id} (${user.id}) disconnected`);
    await this.presence.disconnected(user.id);
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
