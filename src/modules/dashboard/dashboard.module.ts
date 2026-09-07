import { Module } from '@nestjs/common';
import { ChatModule } from 'src/modules/chat/chat.module';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';
import { UsersModule } from 'src/modules/users/users.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  // UsersModule re-exports MongooseModule, so the User model (which the
  // aggregation starts from) is available here. ChatModule and NotificationsModule
  // supply the unread counts for the chat and notification sections.
  imports: [UsersModule, ChatModule, NotificationsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
  exports: [DashboardService],
})
export class DashboardModule {}
