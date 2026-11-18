/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Sync relay offered by default in this build (e.g. the publisher's hosted relay). */
  readonly VITE_SYNC_RELAY_URL?: string;
}
