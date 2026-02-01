// This is a simplified example config file for quickstart
// Some not frequently used features are omitted/commented out here
// For a full-featured example, please refer to `uptime.config.full.ts`

// Don't edit this line
import { MaintenanceConfig, PageConfig, WorkerConfig } from './types/config'

const pageConfig: PageConfig = {
  // Title for your status page
  title: 'nidr0x Homelab status page',
  // Links shown at the header of your status page, could set `highlight` to `true`
  links: [
    { link: 'https://github.com/nidr0x', label: 'GitHub' },
    { link: 'mailto:nidr0x@gmail.com', label: 'Email me', highlight: true },
  ],
}

const workerConfig: WorkerConfig = {
  // Define all your monitors here
  monitors: [
    {
      id: 'adguard_home',
      name: 'AdGuard Home',
      method: 'GET',
      target: 'https://dns.nidr0x.win',
      tooltip: 'Network-wide ads & trackers blocking DNS server',
      statusPageLink: 'https://dns.nidr0x.win',
    },
    {
      id: 'freshrss',
      name: 'FreshRSS',
      method: 'GET',
      target: 'https://rss.nidr0x.win/',
      tooltip: 'Self-hosted RSS feed aggregator',
      statusPageLink: 'https://rss.nidr0x.win',
      headers: {
        'CF-Access-Client-Id': 'GITHUB_SECRET_CF_ACCESS_ID',
        'CF-Access-Client-Secret': 'GITHUB_SECRET_CF_ACCESS_SECRET',
      },
    },
    {
      id: 'homeassistant',
      name: 'Home Assistant',
      method: 'GET',
      target: 'https://ha.nidr0x.win/',
      tooltip: 'Open source home automation',
      statusPageLink: 'https://ha.nidr0x.win',
      headers: {
        'CF-Access-Client-Id': 'GITHUB_SECRET_CF_ACCESS_ID',
        'CF-Access-Client-Secret': 'GITHUB_SECRET_CF_ACCESS_SECRET',
      },
    },
    {
      id: 'homebridge',
      name: 'Homebridge',
      method: 'GET',
      target: 'https://homebridge.nidr0x.win/',
      tooltip: 'HomeKit support for the impatient',
      statusPageLink: 'https://homebridge.nidr0x.win',
      headers: {
        'CF-Access-Client-Id': 'GITHUB_SECRET_CF_ACCESS_ID',
        'CF-Access-Client-Secret': 'GITHUB_SECRET_CF_ACCESS_SECRET',
      },
    },
    {
      id: 'teslamate',
      name: 'TeslaMate',
      method: 'GET',
      target: 'https://tesla.nidr0x.win/',
      tooltip: 'A self-hosted Tesla data logger',
      statusPageLink: 'https://tesla.nidr0x.win',
      headers: {
        'CF-Access-Client-Id': 'GITHUB_SECRET_CF_ACCESS_ID',
        'CF-Access-Client-Secret': 'GITHUB_SECRET_CF_ACCESS_SECRET',
      },
    },
    {
      id: 'transmission',
      name: 'Transmission',
      method: 'GET',
      target: 'https://transmission.nidr0x.win/',
      tooltip: 'Fast, easy and free BitTorrent client',
      statusPageLink: 'https://transmission.nidr0x.win',
      headers: {
        'CF-Access-Client-Id': 'GITHUB_SECRET_CF_ACCESS_ID',
        'CF-Access-Client-Secret': 'GITHUB_SECRET_CF_ACCESS_SECRET',
      },
    },
  ],
  // [Optional] Notification settings
  notification: {
    // [Optional] Notification webhook settings, if not specified, no notification will be sent
    // More info at Wiki: https://github.com/lyc8503/UptimeFlare/wiki/Setup-notification
    webhook: {
      // [Required] webhook URL (example: Telegram Bot API)
      url: 'https://api.telegram.org/bot123456:ABCDEF/sendMessage',
      // [Optional] HTTP method, default to 'GET' for payloadType=param, 'POST' otherwise
      // method: 'POST',
      // [Optional] headers to be sent
      // headers: {
      //   foo: 'bar',
      // },
      // [Required] Specify how to encode the payload
      // Should be one of 'param', 'json' or 'x-www-form-urlencoded'
      // 'param': append url-encoded payload to URL search parameters
      // 'json': POST json payload as body, set content-type header to 'application/json'
      // 'x-www-form-urlencoded': POST url-encoded payload as body, set content-type header to 'x-www-form-urlencoded'
      payloadType: 'x-www-form-urlencoded',
      // [Required] payload to be sent
      // $MSG will be replaced with the human-readable notification message
      payload: {
        chat_id: 12345678,
        text: '$MSG',
      },
      // [Optional] timeout calling this webhook, in millisecond, default to 5000
      timeout: 10000,
    },
    // [Optional] timezone used in notification messages, default to "Etc/GMT"
    timeZone: 'Europe/Madrid',
    // [Optional] grace period in minutes before sending a notification
    // notification will be sent only if the monitor is down for N continuous checks after the initial failure
    // if not specified, notification will be sent immediately
    gracePeriod: 5,
  },
}

// You can define multiple maintenances here
// During maintenance, an alert will be shown at status page
// Also, related downtime notifications will be skipped (if any)
// Of course, you can leave it empty if you don't need this feature

// const maintenances: MaintenanceConfig[] = []

const maintenances: MaintenanceConfig[] = [
  {
    // [Optional] Monitor IDs to be affected by this maintenance
    monitors: ['adguard_home', 'homeassistant'],
    // [Optional] default to "Scheduled Maintenance" if not specified
    title: 'Maintenance Example',
    // Description of the maintenance, will be shown at status page
    body: 'This is a maintenance example for the new monitors',
    // Start time of the maintenance, in UNIX timestamp or ISO 8601 format
    start: '2024-01-01T00:00:00+00:00',
    // [Optional] end time of the maintenance, in UNIX timestamp or ISO 8601 format
    // if not specified, the maintenance will be considered as on-going
    end: '2024-01-01T01:00:00+00:00',
    // [Optional] color of the maintenance alert at status page, default to "yellow"
    color: 'blue',
  },
]

// Don't edit this line
export { maintenances, pageConfig, workerConfig }
