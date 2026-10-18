/**
 * API 基址 —— 供 hooks/pages 中少数直连 fetch 使用。
 * 语义与 useApi.ts 的 BASE 对齐（2026-10-18 混合部署双 /api 修复）：
 * VITE_API_BASE 允许带或不带 `/api` 后缀，这里统一归一化为「不含 /api 的源地址」，
 * 由各调用方自行拼接 `/api/...`：
 * - 未设 VITE_API_BASE（默认）：空串，相对路径走同源（Cloud Run / Firebase Functions / 本地 dev proxy）
 * - 设了 VITE_API_BASE：绝对源地址，适配混合部署（Firebase Hosting 前端 + Render API）
 */
const RAW: string = (import.meta.env.VITE_API_BASE as string) || '';
export const API_BASE: string = RAW.replace(/\/+$/, '').replace(/\/api$/, '');
