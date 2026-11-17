import { app } from '@azure/functions';

// Foundation scaffold only. Persistent storage, identity, and Azure queue triggers
// belong to milestone 2; the loopback-only development API is never registered here.
app.http('foundationHealth', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'health',
  handler: async () => ({ jsonBody: { status: 'ok', milestone: 'foundation' } }),
});
