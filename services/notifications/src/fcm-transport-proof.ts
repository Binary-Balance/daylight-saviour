import type {
  FcmChangeReminderResult,
  FcmChangeReminderSender,
} from './fcm-change-reminder-sender.js';

interface FcmTransportProofRegistration {
  readonly deviceToken: string;
  readonly homeTimeZone: string;
  readonly installationId: string;
}

export interface FcmTransportProofDependencies {
  readonly registrationResolver: {
    readonly getFcmProofSubscription: (
      installationId: string,
    ) => Promise<FcmTransportProofRegistration | null>;
  };
  readonly sender: Pick<FcmChangeReminderSender, 'sendTransportProof'>;
}

/**
 * Immediate transport evidence only. Calendar facts and scheduling never enter
 * this interface; target and matching Home Time Zone come from stored state.
 */
export function createFcmTransportProof(
  installationId: string,
  dependencies: FcmTransportProofDependencies,
) {
  return {
    async send(): Promise<FcmChangeReminderResult | null> {
      const registration =
        await dependencies.registrationResolver.getFcmProofSubscription(
          installationId,
        );
      if (registration === null) return null;
      return dependencies.sender.sendTransportProof(
        registration,
        registration.homeTimeZone,
      );
    },
  };
}
