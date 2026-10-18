/**
 * Firebase Cloud Functions 入口（Spark 免费计划可部署，**无需绑信用卡**）。
 *
 * 赛事规则原文：「通过 Cloud Run **或 Firebase** 部署在 Google Cloud 上」——本文件即 Firebase 路线，
 * 与 Cloud Run 路线（Dockerfile / deploy-cloudrun.sh）共用同一套服务端代码，零逻辑分叉。
 *
 * 部署方式（全流程在 Cloud Shell 中完成，免安装、免绑卡）：
 *   见 DEPLOY_FIREBASE.md —— 约 10 分钟。
 *
 * 构建：npm run build:functions（esbuild 单文件 bundle 至 functions-bundle/index.cjs，
 *   package.json 的 main 字段指向该产物，firebase-tools 据此识别函数入口）。
 *
 * 导入顺序铁律：functions-env.js 必须排在第一位（见其文件头说明）。
 */
import './functions-env.js';
import * as functions from 'firebase-functions';
import app from './index.js';

/** Express app 托管为 HTTPS 函数；hosting 把 /api/**  rewrite 到此函数 */
export const api = functions.https.onRequest(app);
