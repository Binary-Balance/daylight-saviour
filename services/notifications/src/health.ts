import type { HttpFunctionOptions, HttpResponseInit } from '@azure/functions';

const unavailableBuildVersion = 'unavailable';

export function health(): HttpResponseInit {
  const buildVersion =
    process.env.BUILD_VERSION?.trim() || unavailableBuildVersion;

  return {
    status: 200,
    headers: {
      'Cache-Control': 'no-store',
    },
    jsonBody: {
      status: 'ok',
      version: buildVersion,
    },
  };
}

export const healthOptions: HttpFunctionOptions = {
  authLevel: 'anonymous',
  handler: health,
  methods: ['GET'],
  route: 'health',
};
