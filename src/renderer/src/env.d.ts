/// <reference types="vite/client" />

import type { FakeCharlesApi } from '../../shared/api'

declare global {
  interface Window {
    api: FakeCharlesApi
  }
}

export {}
