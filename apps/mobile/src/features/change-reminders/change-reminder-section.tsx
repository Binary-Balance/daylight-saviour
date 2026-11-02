import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
} from 'react';
import {
  AccessibilityInfo,
  AppState,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { australianEnglish as copy } from '@daylight-saviour/copy';

import type { DaylightSaviourPalette } from '../../theme';
import type { ChangeReminderAdapters } from './change-reminder-adapters';
import {
  ConfirmDisableActions,
  DisableFailedActions,
  ExplainerActions,
  FailedActions,
  LoadFailedActions,
  OsBlockedActions,
  PermissionDeniedActions,
  PermissionRevokedActions,
  PreferencesFailedActions,
  RetryPendingActions,
  StartActions,
  TimingControls,
  ZoneFailedActions,
  type ActionProps,
} from './change-reminder-controls';
import {
  createChangeReminderSession,
  type ChangeReminderSessionSnapshot,
} from './change-reminder-session';

// Announces registration starting and finishing, once each. Live regions do
// not suit this: iOS ignores them, and on Android the enabled text would be read
// on every launch and return to the app, because the card restores itself.
function useRegistrationAnnouncements(
  kind: string,
  outcome: string | undefined,
  outcomeReadByRegion: boolean,
) {
  const previousKind = useRef(kind);
  const recheckingBlock = useRef(false);
  useEffect(() => {
    const previous = previousKind.current;
    previousKind.current = kind;
    if (kind === 'saving') {
      // Every return to the app rechecks a blocked permission, usually with no
      // change, so only a new outcome is worth saying.
      recheckingBlock.current = previous === 'os-blocked';
      if (!recheckingBlock.current) {
        AccessibilityInfo.announceForAccessibility(
          copy.changeReminders.saving.body,
        );
      }
    } else if (
      previous === 'saving' &&
      outcome !== undefined &&
      !outcomeReadByRegion &&
      !(recheckingBlock.current && kind === 'os-blocked')
    ) {
      AccessibilityInfo.announceForAccessibility(outcome);
    }
  }, [kind, outcome, outcomeReadByRegion]);
}

function useChangeReminderSession(
  adapters: ChangeReminderAdapters,
  homeTimeZone: string,
) {
  const session = useMemo(
    () => createChangeReminderSession({ adapters, homeTimeZone }),
    [adapters, homeTimeZone],
  );
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );

  useEffect(() => session.start(), [session]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') session.dispatch({ type: 'foreground' });
    });
    return () => subscription.remove();
  }, [session]);
  useEffect(() => {
    if (snapshot.kind !== 'enabled') return;
    return adapters.startTokenRefresh(homeTimeZone, (result) => {
      session.dispatch({ result, type: 'token-refresh' });
    });
  }, [adapters, homeTimeZone, session, snapshot.kind]);

  return { dispatch: session.dispatch, snapshot };
}

function useTestInstallationId(
  adapters: ChangeReminderAdapters,
  snapshot: ChangeReminderSessionSnapshot,
  testBuild: boolean,
) {
  const [installationId, setInstallationId] = useState<string | null>(null);

  useEffect(() => {
    if (
      !testBuild ||
      snapshot.kind !== 'enabled' ||
      adapters.readInstallationId === undefined
    )
      return;
    let active = true;
    void adapters
      .readInstallationId()
      .then((value) => {
        if (active) setInstallationId(value);
      })
      .catch(() => {
        if (active) setInstallationId(null);
      });
    return () => {
      active = false;
    };
  }, [adapters, snapshot, testBuild]);

  return installationId;
}

const reminders = copy.changeReminders;

type Kind = ChangeReminderSessionSnapshot['kind'];

interface Card {
  readonly Actions?: ComponentType<ActionProps>;
  readonly content: { readonly body: string; readonly heading?: string };
  // `busy` states wait on something; `error` states are read out as alerts.
  readonly tone: 'busy' | 'error' | 'plain';
}

// What each state says. `enabled` is left out because its message names the
// timings that are on.
const cards: Record<Exclude<Kind, 'enabled'>, Card> = {
  'confirm-disable': {
    Actions: ConfirmDisableActions,
    content: reminders.disableConfirmation,
    tone: 'plain',
  },
  'disable-failed': {
    Actions: DisableFailedActions,
    content: reminders.disableFailed,
    tone: 'error',
  },
  disabled: {
    Actions: StartActions,
    content: reminders.disabled,
    tone: 'plain',
  },
  disabling: { content: { body: reminders.disabling }, tone: 'busy' },
  explainer: {
    Actions: ExplainerActions,
    content: reminders.explainer,
    tone: 'plain',
  },
  failed: { Actions: FailedActions, content: reminders.failed, tone: 'error' },
  'load-failed': {
    Actions: LoadFailedActions,
    content: reminders.loadFailed,
    tone: 'error',
  },
  loading: { content: { body: reminders.loading }, tone: 'busy' },
  'os-blocked': {
    Actions: OsBlockedActions,
    content: reminders.osBlocked,
    tone: 'error',
  },
  'permission-denied': {
    Actions: PermissionDeniedActions,
    content: reminders.permissionDenied,
    tone: 'error',
  },
  'permission-revoked': {
    Actions: PermissionRevokedActions,
    content: reminders.permissionRevoked,
    tone: 'error',
  },
  'preferences-failed': {
    Actions: PreferencesFailedActions,
    content: reminders.preferencesFailed,
    tone: 'error',
  },
  'retry-pending': {
    Actions: RetryPendingActions,
    content: reminders.retryPending,
    tone: 'error',
  },
  saving: { content: reminders.saving, tone: 'busy' },
  'saving-preferences': {
    content: { body: reminders.savingPreferences },
    tone: 'busy',
  },
  'saving-zone': { content: { body: reminders.savingZone }, tone: 'busy' },
  unavailable: { content: reminders.webUnavailable, tone: 'plain' },
  untouched: {
    Actions: StartActions,
    content: reminders.untouched,
    tone: 'plain',
  },
  'zone-failed': {
    Actions: ZoneFailedActions,
    content: reminders.zoneFailed,
    tone: 'error',
  },
  'zone-mismatch': { content: reminders.zoneMismatch, tone: 'error' },
};

function cardOf(snapshot: ChangeReminderSessionSnapshot): Card {
  return snapshot.kind === 'enabled'
    ? {
        content: {
          body: reminders.enabled.body(snapshot.preferences),
          heading: reminders.enabled.heading,
        },
        tone: 'plain',
      }
    : cards[snapshot.kind];
}

function CardMessage({
  card: { content, tone },
  palette,
}: {
  readonly card: Card;
  readonly palette: DaylightSaviourPalette;
}) {
  return (
    <>
      {'heading' in content ? (
        <Text style={[styles.metadata, { color: palette.secondaryInk }]}>
          {content.heading}
        </Text>
      ) : null}
      {tone === 'busy' ? (
        /*
          Text, not a spinner: nothing in this design loops, so reduced
          motion keeps the same meaning. The label keeps Android from
          reading only "busy". The key stops the message that follows
          reusing this view, because Android keeps a reused view's busy
          state and would read "busy" for that message.
        */
        <Text
          accessibilityLabel={content.body}
          accessibilityLiveRegion="none"
          accessibilityState={{ busy: true }}
          key="pending"
          style={[styles.body, { color: palette.ink }]}
        >
          {content.body}
        </Text>
      ) : (
        <Text
          accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'none'}
          accessibilityRole={tone === 'error' ? 'alert' : undefined}
          style={[styles.body, { color: palette.ink }]}
        >
          {content.body}
        </Text>
      )}
    </>
  );
}

export default function ChangeReminderSection({
  adapters,
  homeTimeZone,
  palette,
  testBuild = false,
  verifiedNoEvent = false,
}: {
  readonly adapters: ChangeReminderAdapters;
  readonly homeTimeZone: string;
  readonly palette: DaylightSaviourPalette;
  readonly testBuild?: boolean;
  readonly verifiedNoEvent?: boolean;
}) {
  const { dispatch, snapshot } = useChangeReminderSession(
    adapters,
    homeTimeZone,
  );
  const installationId = useTestInstallationId(adapters, snapshot, testBuild);

  const card = cardOf(snapshot);
  const Actions = card.Actions;
  useRegistrationAnnouncements(
    snapshot.kind,
    card.tone === 'busy' ? undefined : card.content.body,
    card.tone === 'error' && Platform.OS === 'android',
  );

  return (
    <View style={[styles.card, { borderColor: palette.rule }]}>
      <Text
        accessibilityRole="header"
        style={[styles.metadata, { color: palette.secondaryInk }]}
      >
        {copy.changeReminders.heading}
      </Text>
      <CardMessage card={card} palette={palette} />
      {snapshot.kind === 'enabled' && verifiedNoEvent ? (
        <Text style={[styles.body, { color: palette.ink }]}>
          {copy.changeReminders.noEvent}
        </Text>
      ) : null}
      {snapshot.kind === 'enabled' ||
      snapshot.kind === 'preferences-failed' ||
      snapshot.kind === 'disable-failed' ? (
        <TimingControls
          disabled={snapshot.kind !== 'enabled'}
          onChange={(preferences) =>
            dispatch({ type: 'change-preferences', preferences })
          }
          palette={palette}
          preferences={snapshot.preferences}
        />
      ) : null}
      {Actions === undefined ? null : (
        <Actions
          adapters={adapters}
          dispatch={dispatch}
          kind={snapshot.kind}
          palette={palette}
        />
      )}
      {testBuild && snapshot.kind === 'enabled' && installationId !== null ? (
        <Text
          selectable
          style={[styles.metadata, { color: palette.secondaryInk }]}
        >
          Test installation ID: {installationId}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 17, lineHeight: 25 },
  card: { borderTopWidth: StyleSheet.hairlineWidth, gap: 12, paddingTop: 16 },
  metadata: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.1,
    lineHeight: 18,
  },
});
