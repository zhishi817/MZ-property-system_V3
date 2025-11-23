"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const dictionaries_1 = require("../dictionaries");
exports.router = (0, express_1.Router)();
exports.router.get('/dictionaries', (req, res) => {
    res.json(dictionaries_1.dictionaries);
});
