import { setServers } from 'node:dns'

export function configureDns(setServersImplementation = setServers) {
  setServersImplementation(['1.1.1.1'])
}
