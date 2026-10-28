export const isTauri = false

export class FetchConnectError extends TypeError {}

export function apiFetch(input: string | URL, init: RequestInit = {}) {
  return globalThis.fetch(input, init)
}
