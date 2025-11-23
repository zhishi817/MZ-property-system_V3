"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const auth_1 = require("../auth");
exports.router = (0, express_1.Router)();
exports.router.post('/login', auth_1.login);
exports.router.get('/me', auth_1.me);
exports.router.post('/delete-password', auth_1.setDeletePassword);
