import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from 'src/modules/auth/auth.module';
import { GroupGift, GroupGiftSchema } from 'src/modules/group-gifts/schemas/group-gift.schema';
import { WishlistsModule } from 'src/modules/wishlists/wishlists.module';
import { WishmatesModule } from 'src/modules/wishmates/wishmates.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { ChatSystemListener } from './chat-system.listener';
import { Chat, ChatSchema } from './schemas/chat.schema';
import { Message, MessageSchema } from './schemas/message.schema';
import { ReadReceipt, ReadReceiptSchema } from './schemas/read-receipt.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Chat.name, schema: ChatSchema },
      { name: Message.name, schema: MessageSchema },
      { name: ReadReceipt.name, schema: ReadReceiptSchema },
      // Read-only, for group-gift chat authorization. Chat reads the group-gift
      // document rather than importing its module — that would be a cycle
      // (group-gifts provision their chat through ChatService).
      { name: GroupGift.name, schema: GroupGiftSchema },
    ]),
    // SocketAuthService — the handshake authenticator.
    AuthModule,
    // AccessPolicyService + WishlistsService for chat authorization.
    WishlistsModule,
    // Direct chat is gated on an accepted link — see ChatService.openDirect.
    WishmatesModule,
  ],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway, ChatSystemListener],
  // Group gifts provision their chat through this.
  exports: [ChatService],
})
export class ChatModule {}
