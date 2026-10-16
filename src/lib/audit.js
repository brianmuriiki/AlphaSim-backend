import { AuditLog } from '../models/AuditLog.js';

export async function audit(req, action, meta = {}) {
  try { await AuditLog.create({ ...(req.userId ? { userId: req.userId } : {}), action, meta, ip: req.ip }); }
  catch (error) { req.log?.warn({ err: error, action }, 'audit event could not be saved'); }
}
