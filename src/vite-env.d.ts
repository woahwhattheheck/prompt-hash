/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_DEMO_MARKETPLACE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

