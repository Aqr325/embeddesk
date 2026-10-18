/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API 基址：混合部署（Firebase Hosting 前端 + 独立 API）时设为完整地址，如 https://embeddesk-api.onrender.com/api */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
