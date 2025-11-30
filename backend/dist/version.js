"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.commitRef = exports.buildTimestamp = exports.appVersion = void 0;
exports.appVersion = require('../package.json').version || '0.0.0';
exports.buildTimestamp = process.env.BUILD_TIMESTAMP || new Date().toISOString();
exports.commitRef = process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT_REF || process.env.RENDER_GIT_COMMIT || '';
