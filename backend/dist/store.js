"use strict";
var _a, _b;
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
exports.addAudit = addAudit;
exports.getRoleIdByName = getRoleIdByName;
exports.roleHasPermission = roleHasPermission;
const uuid_1 = require("uuid");
exports.db = {
    keySets: [],
    keyFlows: [],
    orders: [],
    cleaningTasks: [],
    cleaners: [],
    properties: [],
    inventoryItems: [],
    stockMovements: [],
    audits: [],
    landlords: [],
    financeTransactions: [],
    payouts: [],
    companyPayouts: [],
    users: [],
    roles: [],
    permissions: [],
    rolePermissions: [],
};
// seed sample data
if (exports.db.keySets.length === 0) {
    exports.db.keySets.push({
        id: (0, uuid_1.v4)(),
        set_type: 'guest',
        status: 'available',
        code: 'G-1001',
        items: [
            { item_type: 'key', code: 'K-G-1001' },
            { item_type: 'fob', code: 'F-G-1001' },
        ],
    }, {
        id: (0, uuid_1.v4)(),
        set_type: 'spare_1',
        status: 'available',
        code: 'S1-1001',
        items: [
            { item_type: 'key', code: 'K-S1-1001' },
            { item_type: 'fob', code: 'F-S1-1001' },
        ],
    }, {
        id: (0, uuid_1.v4)(),
        set_type: 'spare_2',
        status: 'in_transit',
        code: 'S2-1001',
        items: [
            { item_type: 'key', code: 'K-S2-1001' },
            { item_type: 'fob', code: 'F-S2-1001' },
        ],
    });
}
function formatDate(d) {
    return d.toISOString().slice(0, 10);
}
if (exports.db.cleaningTasks.length === 0) {
    const today = new Date();
    for (let i = 0; i < 10; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        exports.db.cleaningTasks.push({ id: (0, uuid_1.v4)(), date: formatDate(d), status: i % 3 === 0 ? 'scheduled' : 'pending' });
    }
}
if (exports.db.cleaners.length === 0) {
    exports.db.cleaners.push({ id: (0, uuid_1.v4)(), name: 'Alice', capacity_per_day: 4 }, { id: (0, uuid_1.v4)(), name: 'Bob', capacity_per_day: 3 }, { id: (0, uuid_1.v4)(), name: 'Charlie', capacity_per_day: 5 });
}
if (exports.db.properties.length === 0) {
    exports.db.properties.push({ id: (0, uuid_1.v4)(), code: 'RM-1001', address: '123 Collins St, Melbourne', type: '2b2b', capacity: 4, region: 'Melbourne City', area_sqm: 65, building_name: 'Collins Tower', building_facilities: ['gym', 'pool'], bed_config: 'Queen×1, Single×2', wifi_ssid: 'Collins123', wifi_password: 'pass123', safety_smoke_alarm: 'ok', safety_extinguisher: 'ok', floor: '23', parking_type: 'garage', parking_space: 'B2-17', access_type: 'keybox', keybox_location: 'Lobby left wall', keybox_code: '4321', garage_guide_link: 'https://example.com/garage' }, { id: (0, uuid_1.v4)(), code: 'RM-1002', address: '88 Southbank Blvd, Melbourne', type: '1b1b', capacity: 2, region: 'Southbank', area_sqm: 45, building_name: 'Southbank One', building_facilities: ['gym'], bed_config: 'Queen×1', wifi_ssid: 'SB88', wifi_password: 'pwd88', floor: '12', parking_type: 'visitor', access_type: 'smartlock' });
}
if (exports.db.inventoryItems.length === 0) {
    const id1 = (0, uuid_1.v4)();
    const id2 = (0, uuid_1.v4)();
    exports.db.inventoryItems.push({ id: id1, name: '纸巾', sku: 'TP-001', unit: '包', threshold: 10, bin_location: 'A1', quantity: 8 }, { id: id2, name: '洗涤液', sku: 'DL-002', unit: '瓶', threshold: 5, bin_location: 'B2', quantity: 12 });
}
function addAudit(entity, entity_id, action, before, after, actor_id) {
    exports.db.audits.push({ id: (0, uuid_1.v4)(), actor_id, action, entity, entity_id, before, after, timestamp: new Date().toISOString() });
}
if (exports.db.landlords.length === 0) {
    const p1 = (_a = exports.db.properties[0]) === null || _a === void 0 ? void 0 : _a.id;
    const p2 = (_b = exports.db.properties[1]) === null || _b === void 0 ? void 0 : _b.id;
    exports.db.landlords.push({ id: (0, uuid_1.v4)(), name: 'MZ Holdings', phone: '0400 000 000', email: 'owner@mz.com', management_fee_rate: 0.1, payout_bsb: '062000', payout_account: '123456', property_ids: p1 ? [p1] : [] }, { id: (0, uuid_1.v4)(), name: 'John Doe', phone: '0411 111 111', email: 'john@example.com', management_fee_rate: 0.08, payout_bsb: '063000', payout_account: '654321', property_ids: p2 ? [p2] : [] });
}
if (exports.db.financeTransactions.length === 0) {
    exports.db.financeTransactions.push({ id: (0, uuid_1.v4)(), kind: 'income', amount: 220.0, currency: 'AUD', ref_type: 'order', ref_id: 'o-1', occurred_at: new Date().toISOString(), note: '房费' }, { id: (0, uuid_1.v4)(), kind: 'expense', amount: 60.0, currency: 'AUD', ref_type: 'cleaning', ref_id: 'w-1', occurred_at: new Date().toISOString(), note: '清洁费' });
}
if (exports.db.payouts.length === 0 && exports.db.landlords.length) {
    const l = exports.db.landlords[0];
    exports.db.payouts.push({ id: (0, uuid_1.v4)(), landlord_id: l.id, period_from: '2025-11-01', period_to: '2025-11-30', amount: 1200, invoice_no: 'INV-001', status: 'pending' });
}
// RBAC seed
if (exports.db.roles.length === 0) {
    const adminId = (0, uuid_1.v4)();
    const csId = (0, uuid_1.v4)(); // 客服
    const cleanMgrId = (0, uuid_1.v4)(); // 清洁/检查管理员人员
    const cleanerId = (0, uuid_1.v4)(); // 清洁和检查人员
    const financeId = (0, uuid_1.v4)(); // 财务人员
    const inventoryId = (0, uuid_1.v4)(); // 仓库管理员
    const maintenanceId = (0, uuid_1.v4)(); // 维修人员
    exports.db.roles.push({ id: adminId, name: 'admin' }, { id: csId, name: 'customer_service' }, { id: cleanMgrId, name: 'cleaning_manager' }, { id: cleanerId, name: 'cleaner_inspector' }, { id: financeId, name: 'finance_staff' }, { id: inventoryId, name: 'inventory_manager' }, { id: maintenanceId, name: 'maintenance_staff' });
    exports.db.permissions = [
        { code: 'property.write' },
        { code: 'order.view' },
        { code: 'order.create' },
        { code: 'order.write' },
        { code: 'order.sync' },
        { code: 'keyset.manage' },
        { code: 'key.flow' },
        { code: 'cleaning.view' },
        { code: 'cleaning.schedule.manage' },
        { code: 'cleaning.task.assign' },
        { code: 'finance.payout' },
        { code: 'finance.tx.write' },
        { code: 'inventory.move' },
        { code: 'landlord.manage' },
        { code: 'rbac.manage' },
    ];
    function grant(roleId, codes) {
        codes.forEach(c => exports.db.rolePermissions.push({ role_id: roleId, permission_code: c }));
    }
    // 管理员：所有权限
    grant(adminId, exports.db.permissions.map(p => p.code));
    // 客服：房源可写、订单查看/编辑、查看清洁安排、可管理订单（允许创建）、允许录入公司/房源支出
    grant(csId, ['property.write', 'order.view', 'order.write', 'order.manage', 'cleaning.view', 'finance.tx.write']);
    // 清洁/检查管理员：清洁排班与任务分配（仅查看房源，无写权限）
    grant(cleanMgrId, ['cleaning.schedule.manage', 'cleaning.task.assign']);
    // 清洁/检查人员：无写权限，仅查看（后端接口默认允许 GET）
    grant(cleanerId, []);
    // 财务人员：财务结算与交易录入、房东/房源管理
    grant(financeId, ['finance.payout', 'finance.tx.write', 'landlord.manage', 'property.write']);
    // 仓库管理员：仓库与钥匙管理
    grant(inventoryId, ['inventory.move', 'keyset.manage', 'key.flow']);
    // 维修人员：暂无写接口，预留
    grant(maintenanceId, []);
}
function getRoleIdByName(name) {
    var _a;
    return (_a = exports.db.roles.find(r => r.name === name)) === null || _a === void 0 ? void 0 : _a.id;
}
function roleHasPermission(roleName, perm) {
    const rid = getRoleIdByName(roleName);
    if (!rid)
        return false;
    return exports.db.rolePermissions.some(rp => rp.role_id === rid && rp.permission_code === perm);
}
