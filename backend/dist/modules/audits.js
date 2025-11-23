"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const store_1 = require("../store");
exports.router = (0, express_1.Router)();
exports.router.get('/', (req, res) => {
    const { entity } = req.query;
    const list = entity ? store_1.db.audits.filter(a => a.entity === entity) : store_1.db.audits;
    res.json(list.slice(-500));
});
