"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const version_1 = require("../version");
exports.router = (0, express_1.Router)();
exports.router.get('/', (_req, res) => {
    res.json({ version: version_1.appVersion, buildTimestamp: version_1.buildTimestamp, commit: version_1.commitRef });
});
