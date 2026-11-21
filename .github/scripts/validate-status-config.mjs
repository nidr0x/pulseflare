import { pathToFileURL } from 'node:url'

import config from '../../config/pulse.config.ts'
import { parseStatusConfig } from '../../packages/schema/src/index.ts'

export function validateCheckedInStatusConfig() {
  return parseStatusConfig(config)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  validateCheckedInStatusConfig()
  console.log('Checked-in status config is valid')
}
