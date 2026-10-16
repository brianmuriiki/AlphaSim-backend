import mongoose from 'mongoose';
const schema = new mongoose.Schema({ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, action: String, meta: mongoose.Schema.Types.Mixed, ip: String }, { timestamps: { createdAt: true, updatedAt: false } });
export const AuditLog = mongoose.model('AuditLog', schema);
