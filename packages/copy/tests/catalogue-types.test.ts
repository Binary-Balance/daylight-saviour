import { australianEnglish } from '../src/index.ts';

// @ts-expect-error invalid Home Time Zone notice codes are not public API
australianEnglish.homeTimeZone.notice('future-notice');

// @ts-expect-error invalid Home Time Zone error codes are not public API
australianEnglish.homeTimeZone.errorMessage('future-error');

australianEnglish.dataFreshness.status({
  // @ts-expect-error invalid freshness states are not public API
  freshness: 'future-freshness',
  source: 'cached',
});

const fragmentPackFacts = {
  description: 'verified data current',
  packVersion: 'test-pack',
  validUntil: '2030-12-31T23:59:59.000Z',
};

// @ts-expect-error accessibility labels require structured source and freshness facts
australianEnglish.dataFreshness.accessibility.pack(fragmentPackFacts);

// @ts-expect-error invalid decision reasons are not public API
australianEnglish.livingDossier.decisionUnavailable.message('future-reason');
