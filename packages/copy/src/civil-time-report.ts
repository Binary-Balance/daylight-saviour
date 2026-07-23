import type {
  ChangeDirection,
  CivilTimeDecisionUnavailableReason,
  DaylightSavingStatus,
  CivilTimeReportPhase,
  LocalDateTime,
} from '@daylight-saviour/domain';

export interface HourCycleContext {
  readonly homeTimeZone: string;
  readonly uses24hourClock: boolean;
}

export interface SecondaryCopyInput {
  readonly event: {
    readonly direction: ChangeDirection;
    readonly instant: string;
  } | null;
  readonly installationSeed: string;
  readonly localDate: Pick<LocalDateTime, 'day' | 'month' | 'year'>;
  readonly phase: CivilTimeReportPhase;
  readonly status: DaylightSavingStatus;
  readonly zoneId: string;
}

const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function twoDigits(value: number) {
  return value.toString().padStart(2, '0');
}

function formatTime(local: LocalDateTime, context: HourCycleContext) {
  if (context.uses24hourClock) {
    return `${twoDigits(local.hour)}:${twoDigits(local.minute)}`;
  }

  const period = local.hour >= 12 ? 'pm' : 'am';
  const hour = local.hour % 12 || 12;
  return `${hour}:${twoDigits(local.minute)} ${period}`;
}

function formatDate(local: LocalDateTime) {
  return `${local.day} ${months[local.month - 1]} ${local.year}`;
}

function formatOffset(offsetSeconds: number) {
  const sign = offsetSeconds >= 0 ? '+' : '-';
  const absoluteMinutes = Math.abs(offsetSeconds) / 60;
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `UTC${sign}${twoDigits(hours)}:${twoDigits(minutes)}`;
}

function plural(value: number, unit: string) {
  return `${value} ${unit}${value === 1 ? '' : 's'}`;
}

function formatAbsoluteDuration(totalSeconds: number) {
  let remaining = Math.floor(Math.abs(totalSeconds));
  if (remaining < 1) return 'now';

  const parts: string[] = [];
  for (const [unit, size] of [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
    ['second', 1],
  ] as const) {
    const value = Math.floor(remaining / size);
    remaining %= size;
    if (value > 0) parts.push(plural(value, unit));
    if (parts.length === 2) break;
  }
  return parts.join(', ');
}

function formatOffsetAmount(offsetDeltaSeconds: number) {
  const absoluteMinutes = Math.abs(offsetDeltaSeconds) / 60;
  return absoluteMinutes % 60 === 0
    ? plural(absoluteMinutes / 60, 'hour')
    : plural(absoluteMinutes, 'minute');
}

const daylightSavingVariants = Object.freeze({
  amendmentActive:
    'Daylight saving amendment active. The clock has accepted temporary terms.',
  annualAdjustment:
    'Annual adjustment in force. Civil time is operating under seasonal instructions.',
  approvedExtension:
    'Evening light extension approved. Morning light has lodged no comment.',
  borrowedHour:
    'One hour remains seasonally reassigned. The ledger knows where it went.',
  clockAdvanced:
    'The clock remains advanced. Temporal administration appears satisfied.',
  daylightFiled:
    'Extra evening daylight is on file. No further paperwork is required today.',
  daylightInForce:
    'Daylight saving remains in force. The clocks are following the published arrangement.',
  daylightOnDuty:
    'Daylight saving is on duty. Standard time is awaiting its next roster.',
  eveningAllocation:
    'Evening daylight allocation remains current. Sunrise has been advised.',
  extendedHours:
    'Seasonally extended daylight hours continue. The clock is keeping formal minutes.',
  forwardOrder:
    'Forward clock order remains active. All displayed facts are proceeding accordingly.',
  hourOnLoan:
    'One hour is still on seasonal loan. Repayment terms appear later in the record.',
  laterLight:
    'Later light remains scheduled. Civil time has stamped the arrangement current.',
  officialAdvance:
    'Official clock advance continues. The sun remains outside the reporting line.',
  operationalDaylight:
    'Seasonal daylight arrangement operational. The clock has nothing further to declare.',
  paperworkCurrent:
    'Daylight saving paperwork current. Civil time continues under amended hours.',
  seasonalAuthority:
    'Seasonal time authority applies. Watches and ovens should now agree.',
  seasonalClock:
    'Seasonal clock settings remain active. The record is unusually untroubled.',
  seasonalDifference:
    'The seasonal difference is active. Time continues despite the administrative flourish.',
  seasonalDirective:
    'Seasonal directive observed. The clock has moved and retained its dignity.',
  seasonalOffset:
    'Seasonal offset confirmed. Evening light has the later appointment.',
  seasonalProvision:
    'Seasonal provision remains applied. Standard time will return by separate notice.',
  shiftedSchedule:
    'Shifted schedule current. The clock is one administrative hour ahead.',
  summerArrangement:
    'Summer-time arrangement remains recorded. No daily intervention is needed.',
  summerClock:
    'Summer clock setting active. Civil time has adopted its warm-weather posture.',
  temporaryAdvance:
    'Temporary annual advance continues. The return date remains properly filed.',
  timeAdjusted:
    'Civil time is seasonally adjusted. Actual daylight declined to sign the form.',
  timeInSummerDress:
    'The clock remains in summer dress. Its standard uniform is safely stored.',
  warmSeasonRule:
    'Warm-season rule active. Time is complying with the local ordinance.',
  workingAsAmended:
    'Clock working as amended. The original hour remains available for later restoration.',
});

const standardTimeVariants = Object.freeze({
  clocksUnamended:
    'Clocks remain unamended. Civil time is using its standard filing arrangement.',
  daylightUnshifted:
    'Daylight is unshifted by seasonal rule. The clock may proceed normally.',
  defaultArrangement:
    'Default time arrangement applies. No seasonal annotation is currently attached.',
  hourAccountedFor:
    'Every hour is presently accounted for. The temporal ledger balances.',
  noAdvance:
    'No seasonal advance is active. The clock is keeping ordinary office hours.',
  noAmendment:
    'No clock amendment applies. Standard time remains sufficient for present purposes.',
  noBorrowing:
    'No hour is currently borrowed. Civil time has closed that facility.',
  noSeasonalAdjustment:
    'No seasonal adjustment is in force. The clocks have retained their baseline.',
  ordinaryClock:
    'Ordinary clock settings apply. Time has avoided unnecessary ceremony.',
  originalHours:
    'Original hours remain in service. Evening light has received no special allocation.',
  paperworkDormant:
    'Seasonal paperwork dormant. Standard time is handling the current shift.',
  regularOffset:
    'Regular offset confirmed. The clock has no seasonal addendum.',
  standardAuthority:
    'Standard time authority applies. All hours are appearing in their usual order.',
  standardClock:
    'Standard clock setting active. The record contains no temporary advance.',
  standardCondition:
    'Standard-time conditions continue. Temporal administration is quiet today.',
  standardHours:
    'Standard hours remain current. The clock is not participating in seasonal theatre.',
  standardIssue:
    'Standard issue time is in use. No special handling instructions apply.',
  standardMeasure:
    'Time is proceeding by standard measure. Nothing has been added for daylight.',
  standardOperating:
    'Standard time remains operational. The clock has returned all borrowed minutes.',
  standardOrder:
    'Standard order is in force. The hours are exactly where the record left them.',
  standardPosture:
    'The clock is in standard posture. Seasonal adjustments are presently inactive.',
  standardProcedure:
    'Standard procedure applies. Civil time requires no amendment this morning.',
  standardRecord:
    'Standard time is on record. Seasonal provisions are waiting offstage.',
  standardSetting:
    'Standard setting confirmed. The clock is declining optional complexity.',
  timeAtBaseline:
    'Civil time is at baseline. The seasonal machinery is parked.',
  timeUnaltered:
    'Time remains seasonally unaltered. The paperwork is pleasingly brief.',
  usualHours: 'Usual hours apply. The clock has filed nothing exceptional.',
  winterArrangement:
    'Cool-season arrangement current. Standard time has resumed the desk.',
  winterClock: 'Winter clock setting applies. The hour account is settled.',
  workingAsStandard:
    'Clock working as standard. No daylight-saving adjustment is currently recorded.',
});

const noEventVariants = Object.freeze({
  calendarClear:
    'The verified calendar contains no clock change. Civil time may remain seated.',
  clockExcused:
    'The clock is excused from seasonal adjustment. Its attendance record is complete.',
  clockLeftAlone:
    'No clock interference is scheduled. Common sense has entered the minutes.',
  clockStable:
    'Clock setting stable. No seasonal movement appears in the verified record.',
  daylightUnregulated:
    'Daylight remains outside clock administration. The schedule is clear.',
  emptyAdjustmentQueue:
    'Adjustment queue empty. The clock has no seasonal business pending.',
  noAppointment:
    'No Change Event appointment exists. The clock may keep its current plans.',
  noChangeFiled:
    'No clock adjustment is filed. Civil time may rest unbothered.',
  noClockOrder:
    'No clock movement order is present. The record is refreshingly uneventful.',
  noEventPending:
    'No Change Event is pending. Every listed hour keeps its place.',
  noForwardOrBack:
    'Neither forward nor backward movement is scheduled. The clock approves.',
  noHourShuffle:
    'No hour shuffle is recorded. Temporal administration has shown restraint.',
  noIntervention:
    'No seasonal intervention is planned. The time display can remain composed.',
  noMovement:
    'No clock movement appears ahead. Civil time continues without choreography.',
  noSeasonalBusiness:
    'No seasonal clock business is scheduled. The file can remain thin.',
  noSeasonalDetour:
    'No seasonal detour is recorded. Time is taking the direct route.',
  noSwitch:
    'No seasonal switch is listed. The clock remains on one set of instructions.',
  nothingToAdjust:
    'Nothing is scheduled for adjustment. The hour retains secure tenure.',
  offsetSteady:
    'The verified offset remains steady. No clock amendment is waiting.',
  paperworkEmpty:
    'Seasonal paperwork empty. The clock has escaped additional duties.',
  recordQuiet:
    'Change Event record quiet. Time is proceeding without a special notice.',
  scheduleUndisturbed:
    'Schedule undisturbed. No seasonal clock order has been issued.',
  stableByRule:
    'Stable by verified rule. The clock is spared an annual performance.',
  steadyHours: 'Hours remain steady. No seasonal reassignment is on the books.',
  timeUnmoved:
    'Civil time remains unmoved. The adjustment machinery has no work order.',
  transitionAbsent:
    'No transition is present in verified data. The clock stays put.',
  unalteredCalendar:
    'Calendar verified and unaltered. No hour is due to disappear or repeat.',
  uncomplicatedTime:
    'Time remains uncomplicated. The verified schedule contains no clock change.',
  unchangedAhead:
    'No change lies ahead in verified data. The current offset keeps the role.',
  verifiedStillness:
    'Verified stillness continues. The clock has no seasonal forms to process.',
});

const regionalVariants = Object.freeze({
  antarctic: Object.freeze({
    fieldOffice:
      'Antarctic clock record current. The field office has enough weather already.',
    frozenFile:
      'The polar time file is in order. No extra drama has been requisitioned.',
    iceLedger:
      'Station clock ledger balanced. The ice remains outside administrative control.',
    polarDesk:
      'Polar civil-time desk reporting. The clock has completed its cold review.',
    stationRecord:
      'Station time record verified. Latitude has not simplified the paperwork.',
    southernFile:
      'Southernmost time file current. The clock remains professionally composed.',
  }),
  indianOcean: Object.freeze({
    islandDesk:
      'Indian Ocean time desk reporting. The clock is current and the horizon unconcerned.',
    islandFile:
      'Island clock file verified. Distance has not excused the paperwork.',
    offshoreLedger:
      'Offshore time ledger current. The hour remains properly accounted for.',
    oceanOffice:
      'Ocean territory office confirms the time. The tide filed separately.',
    remoteRecord:
      'Remote-island record in order. The clock has reached the same conclusion.',
    territoryTime:
      'Territory time confirmed. The surrounding ocean declined an adjustment form.',
  }),
  lordHowe: Object.freeze({
    halfHourAttention:
      'Lord Howe timing noted. Even half an hour receives full administrative attention.',
    islandPrecision:
      'Island clock precision confirmed. Thirty minutes is not being rounded away.',
    localDifference:
      'Local time difference recorded exactly. The half-hour has retained counsel.',
    measuredChange:
      'Lord Howe clock record current. Fractional hours remain first-class facts.',
    preciseLedger:
      'Half-hour ledger balanced. Civil time has resisted convenient approximation.',
    thirtyMinuteFile:
      'Thirty-minute rule filed in full. The clock accepts no coarse summaries.',
  }),
  mainland: Object.freeze({
    broadOffice:
      'Mainland time office reporting. Local rules remain attached to the correct region.',
    jurisdictionFiled:
      'Regional jurisdiction recorded. The clock is not guessing from longitude.',
    localRule:
      'Local rule confirmed. Neighbouring clocks may have filed different instructions.',
    regionalDesk:
      'Regional time desk current. State borders remain surprisingly relevant to clocks.',
    regionalRecord:
      'Mainland regional record verified. Offset alone was not asked to name the place.',
    stateFile:
      'State and regional file in order. Civil time remains locally administered.',
  }),
  pacific: Object.freeze({
    islandAuthority:
      'Pacific island time authority confirmed. The clock has its own regional brief.',
    islandRecord:
      'Island time record current. Mainland assumptions were left on shore.',
    localHorizon:
      'Pacific horizon noted. The local clock still follows its own verified rule.',
    offshoreOffice:
      'Offshore clock office reporting. The regional file remains distinct.',
    pacificDesk:
      'Pacific time desk current. The date line has not been invited to improvise.',
    territoryFile:
      'Territory clock file verified. Geography appears before offset in this record.',
  }),
});

const eventVariants = Object.freeze({
  aftermath: Object.freeze({
    'Backward Change': Object.freeze({
      amendmentApplied:
        'Backward Change applied. The repeated hour has completed its second appearance.',
      clockRestored:
        'Clock restored by one adjustment. Standard time has resumed the file.',
      eventRecorded:
        'Backward Change recorded. The clock has returned the borrowed interval.',
      repeatedHourFiled:
        'Repeated hour filed and complete. Civil time is using the new offset now.',
    }),
    'Forward Change': Object.freeze({
      amendmentApplied:
        'Forward Change applied. The skipped interval is now a matter of record.',
      clockAdvanced:
        'Clock advanced as scheduled. The new civil time is already in force.',
      eventRecorded:
        'Forward Change recorded. The missing hour has been administratively resolved.',
      skippedHourFiled:
        'Skipped hour filed and complete. Civil time is using the new offset now.',
    }),
  }),
  approaching: Object.freeze({
    'Backward Change': Object.freeze({
      backwardApproaching:
        'Backward Change approaching. The repeated hour is preparing an encore.',
      returnScheduled:
        'Clock return scheduled. Civil time has located the earlier setting.',
      standardTimeDue:
        'Standard time is approaching. The seasonal hour is nearing repayment.',
      transitionFiled:
        'Backward transition filed. The clock will revisit one interval.',
    }),
    'Forward Change': Object.freeze({
      daylightApproaching:
        'Daylight saving is approaching. The clock has received advance instructions.',
      forwardApproaching:
        'Forward Change approaching. One local interval will be omitted by rule.',
      seasonalAdvanceDue:
        'Seasonal advance due soon. The hour ledger is preparing a gap.',
      transitionFiled:
        'Forward transition filed. The clock will proceed directly to the later time.',
    }),
  }),
  'reminder-day': Object.freeze({
    'Backward Change': Object.freeze({
      changeTomorrow:
        'Backward Change is within 24 hours. The repeated interval is fully documented.',
      finalNotice:
        'Final-day notice active. The clock is preparing to move back.',
      returnImminent:
        'Standard-time return imminent. One hour will appear twice locally.',
      todayOrTomorrow:
        'Clock return is close. The local-time transformation remains shown below.',
    }),
    'Forward Change': Object.freeze({
      changeTomorrow:
        'Forward Change is within 24 hours. The skipped interval is fully documented.',
      finalNotice:
        'Final-day notice active. The clock is preparing to move forward.',
      skipImminent:
        'Seasonal advance imminent. One local interval will not occur.',
      todayOrTomorrow:
        'Clock advance is close. The local-time transformation remains shown below.',
    }),
  }),
  'reminder-week': Object.freeze({
    'Backward Change': Object.freeze({
      weekNotice:
        'Backward Change is within one week. The repeated hour has been notified.',
      returnDue:
        'Clock return due this week. Standard time is clearing its desk.',
      repeatedHourNear:
        'A repeated local interval is near. The exact transformation is on file.',
      weekFiled:
        'One-week backward notice filed. The clock will reverse by the stated amount.',
    }),
    'Forward Change': Object.freeze({
      weekNotice:
        'Forward Change is within one week. The skipped hour has been notified.',
      advanceDue:
        'Clock advance due this week. Seasonal time is clearing its desk.',
      skippedHourNear:
        'A skipped local interval is near. The exact transformation is on file.',
      weekFiled:
        'One-week forward notice filed. The clock will advance by the stated amount.',
    }),
  }),
});

const secondaryCatalogue = Object.freeze({
  broad: Object.freeze({
    daylightSaving: daylightSavingVariants,
    noEvent: noEventVariants,
    standardTime: standardTimeVariants,
  }),
  event: eventVariants,
  regional: regionalVariants,
});

type RegionalCatalogue = keyof typeof regionalVariants;

function regionalCatalogueFor(zoneId: string): RegionalCatalogue {
  if (zoneId === 'Australia/Lord_Howe') return 'lordHowe';
  if (zoneId.startsWith('Antarctica/')) return 'antarctic';
  if (zoneId.startsWith('Indian/')) return 'indianOcean';
  if (zoneId.startsWith('Pacific/')) return 'pacific';
  return 'mainland';
}

function stableHash(value: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function localDayOrdinal(local: SecondaryCopyInput['localDate']) {
  return Math.floor(
    Date.UTC(local.year, local.month - 1, local.day) / 86_400_000,
  );
}

function itemAt(items: readonly string[], index: number) {
  return items[((index % items.length) + items.length) % items.length]!;
}

function selectSecondaryCopy(input: SecondaryCopyInput) {
  if (
    input.phase !== 'ordinary' &&
    input.phase !== 'no-event' &&
    input.event !== null
  ) {
    const variants = Object.values(
      eventVariants[input.phase][input.event.direction],
    );
    return itemAt(
      variants,
      stableHash(
        `${input.installationSeed}|${input.zoneId}|${input.event.instant}|${input.event.direction}|${input.phase}`,
      ),
    );
  }

  const broad =
    input.phase === 'no-event'
      ? noEventVariants
      : input.status === 'Daylight saving time applies'
        ? daylightSavingVariants
        : standardTimeVariants;
  const regional = regionalVariants[regionalCatalogueFor(input.zoneId)];
  const eligible = [...Object.values(broad), ...Object.values(regional)];
  const seed = stableHash(`${input.installationSeed}|${input.zoneId}`);
  return itemAt(eligible, seed + localDayOrdinal(input.localDate));
}

const phaseLabels = {
  aftermath: 'CHANGE RECORDED',
  approaching: 'CHANGE APPROACHING',
  'no-event': 'NO CHANGE SCHEDULED',
  ordinary: 'NO CHANGE IMMINENT',
  'reminder-day': 'CHANGE WITHIN 24 HOURS',
  'reminder-week': 'CHANGE WITHIN 7 DAYS',
} as const satisfies Record<CivilTimeReportPhase, string>;

const unavailableMessages = {
  'before-coverage':
    'The selected instant precedes this Time-Zone Data Pack coverage.',
  'invalid-instant':
    'The current instant is invalid. Civil-time facts are hidden.',
  'unsupported-zone':
    'This Home Time Zone is not supported. Choose an Australian Home Time Zone.',
  'validity-expired':
    'The Validity Horizon has passed. New verified data is required before civil-time facts can be shown.',
} as const satisfies Record<CivilTimeDecisionUnavailableReason, string>;

export const civilTimeReport = Object.freeze({
  accessibility: Object.freeze({
    clock: (facts: {
      readonly abbreviation: string;
      readonly clock: string;
      readonly currentOffset: string;
    }) =>
      `Home Time Zone current time, ${facts.clock}, ${facts.abbreviation}, ${facts.currentOffset}`,
    countdown: (secondsUntil: number) =>
      `Countdown, ${formatAbsoluteDuration(secondsUntil)} until Change Event`,
    homeTimeZone: (facts: {
      readonly friendlyLabel: string;
      readonly zoneId: string;
    }) => `Home Time Zone, ${facts.friendlyLabel}, ${facts.zoneId}`,
    openZoneSelectionHint: 'Opens Australian Home Time Zone selection',
  }),
  changeEvent: Object.freeze({
    clocksMove: (offsetDeltaSeconds: number) =>
      `Clocks move ${formatOffsetAmount(offsetDeltaSeconds)} · Home Time Zone`,
    completedHeading: 'CHANGE COMPLETED',
    countdown: (secondsUntil: number) =>
      `In ${formatAbsoluteDuration(secondsUntil)}`,
    countdownHeading: 'COUNTDOWN',
    date: formatDate,
    directionArrow: (direction: ChangeDirection) =>
      direction === 'Forward Change' ? '→' : '←',
    elapsed: (secondsUntil: number) => {
      const duration = formatAbsoluteDuration(secondsUntil);
      return duration === 'now' ? 'Applied now' : `${duration} ago`;
    },
    heading: (relation: 'completed' | 'upcoming') =>
      relation === 'completed' ? 'RECENT CHANGE EVENT' : 'NEXT CHANGE EVENT',
    localTimeChange: (facts: {
      readonly after: LocalDateTime;
      readonly before: LocalDateTime;
      readonly context: HourCycleContext;
    }) =>
      `${formatTime(facts.before, facts.context)} → ${formatTime(facts.after, facts.context)}`,
    localTimeHeading: 'LOCAL TIME',
    offsetChange: (facts: {
      readonly afterSeconds: number;
      readonly beforeSeconds: number;
    }) =>
      `${formatOffset(facts.beforeSeconds)} → ${formatOffset(facts.afterSeconds)}`,
    utcOffsetHeading: 'UTC OFFSET',
  }),
  clock: Object.freeze({
    currentMetadata: (facts: {
      readonly abbreviation: string;
      readonly currentOffset: string;
    }) => `${facts.abbreviation} · ${facts.currentOffset} · HOME TIME ZONE`,
    format: (facts: {
      readonly context: HourCycleContext;
      readonly localDateTime: LocalDateTime;
    }) => formatTime(facts.localDateTime, facts.context),
    utcOffset: formatOffset,
  }),
  decisionUnavailable: Object.freeze({
    fallbackZoneLabel: 'Unsupported Home Time Zone',
    heading: 'Civil-time decision unavailable',
    label: (freshness: 'decision-unavailable' | 'expired') =>
      freshness === 'expired' ? 'REFRESH REQUIRED' : 'DECISION UNAVAILABLE',
    message: (reason: CivilTimeDecisionUnavailableReason) =>
      Object.prototype.hasOwnProperty.call(unavailableMessages, reason)
        ? unavailableMessages[reason as CivilTimeDecisionUnavailableReason]
        : 'Civil-time facts are unavailable. Choose a supported Home Time Zone or try again later.',
  }),
  daylightSavingStatusHeading: 'DAYLIGHT SAVING STATUS',
  document: Object.freeze({
    label: 'DAYLIGHT SAVIOUR · CIVIL TIME RECORD',
    reference: 'DS—04',
  }),
  homeTimeZoneHeading: 'HOME TIME ZONE',
  noEvent: Object.freeze({
    body: 'No countdown required. Your Home Time Zone remains on its recorded offset.',
    heading: 'No Change Event scheduled within verified data',
    label: 'CHANGE EVENT RECORD',
    mark: '✓ CIVIL TIME LEFT IN PEACE',
  }),
  phaseLabel: (phase: CivilTimeReportPhase) => phaseLabels[phase],
  secondary: Object.freeze({
    catalogue: secondaryCatalogue,
    select: selectSecondaryCopy,
  }),
});
