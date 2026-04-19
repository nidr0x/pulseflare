import { defineStatusConfig } from '@pulseflare/schema'

export default defineStatusConfig({
  site: {
    name: 'Acme Status',
    description: 'System health and incident reporting',
    url: 'https://status.acme.dev',
    brand: {
      logo: '/brand/logo.svg',
      icon: '/brand/icon.svg',
    },
    navigation: [
      { label: 'Docs', href: 'https://acme.dev/docs' },
      { label: 'Support', href: 'https://acme.dev/support' },
    ],
  },
  services: [
    {
      id: 'api',
      name: 'Public API',
      group: 'Core platform',
      checks: [
        {
          type: 'http',
          url: 'https://api.acme.dev/health',
          method: 'GET',
          expect: {
            status: [200],
            bodyIncludes: ['ok'],
          },
        },
      ],
    },
    {
      id: 'website',
      name: 'Website',
      checks: [
        {
          type: 'http',
          url: 'https://www.acme.dev',
          expect: {
            status: [200],
          },
        },
      ],
    },
  ],
  notifications: {
    gracePeriodMinutes: 5,
    providers: [
      {
        id: 'ops-webhook',
        type: 'webhook',
        url: 'https://hooks.example.com/pulseflare',
        method: 'POST',
      },
    ],
  },
  maintenances: [
    {
      id: 'database-upgrade',
      title: 'Database upgrade',
      body: 'We are upgrading the primary database.',
      start: '2026-05-01T22:00:00.000Z',
      end: '2026-05-01T23:00:00.000Z',
      services: ['api'],
    },
  ],
})
