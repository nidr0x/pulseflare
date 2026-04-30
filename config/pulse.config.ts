import { defineStatusConfig } from '@pulseflare/schema'

export default defineStatusConfig({
  site: {
    name: 'Pulseflare',
    description: 'Cloudflare-native uptime monitoring and status pages',
  },
  services: [],
  notifications: { providers: [] },
  maintenances: [],
})
