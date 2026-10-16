import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema({
  region: { type: String, default: 'USA' }, universe: { type: String, default: 'TOP3000' }, delay: { type: Number, default: 1 },
  decay: Number, neutralization: String, truncation: Number, pasteurization: String, nanHandling: String, language: { type: String, default: 'FASTEXPR' }
}, { _id: false, strict: 'throw' });

const alphaVersionSchema = new mongoose.Schema({
  alphaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Alpha', required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  versionNumber: { type: Number, required: true },
  expression: { type: String, required: true, maxlength: 50000 },
  contentHash: { type: String, required: true },
  settings: { type: settingsSchema, default: () => ({}) },
  parentVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AlphaVersion', default: null },
  source: { type: String, enum: ['manual', 'ai', 'sweep'], default: 'manual' },
  note: { type: String, default: '' }
}, { timestamps: { createdAt: true, updatedAt: false } });
alphaVersionSchema.index({ alphaId: 1, versionNumber: -1 }, { unique: true });

export const AlphaVersion = mongoose.model('AlphaVersion', alphaVersionSchema);
