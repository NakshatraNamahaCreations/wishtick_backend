import { Injectable, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from 'src/infra/queue/scheduler-registry';
import { ReservationExpiryService } from './reservation-expiry.service';
import { RESERVATION_EXPIRY_JOB, type ReservationExpiryJobData } from './reservation-expiry.types';

/**
 * Registers the reservation-expiry handler on the shared scheduler queue.
 *
 * Registrar, not `@Processor`: one Worker serves the whole scheduler queue and
 * routes by job name (see SchedulerRegistry). The idempotency and race guards
 * live in ReservationExpiryService.
 */
@Injectable()
export class ReservationExpiryRegistrar implements OnModuleInit {
  constructor(
    private readonly expiry: ReservationExpiryService,
    private readonly registry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(RESERVATION_EXPIRY_JOB, (data) => {
      const { giftId, expiresAtIso } = data as ReservationExpiryJobData;
      return this.expiry.expire(giftId, expiresAtIso);
    });
  }
}
