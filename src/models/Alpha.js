import mongoose from 'mongoose';

const alphaSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, default: '', maxlength: 2000 },
  folderId: { type: mongoose.Schema.Types.ObjectId, default: null },
  tags: { type: [String], default: [] },
  currentVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AlphaVersion', default: null },
  draft: { expression: { type: String, maxlength: 50000 }, settings: { type: mongoose.Schema.Types.Mixed } },
  versionCounter: { type: Number, default: 0 },
  runCounter: { type: Number, default: 0 },
  status: { type: String, enum: ['draft', 'testing', 'candidate', 'submitted', 'archived'], default: 'draft' },
  bestMetrics: { sharpe: Number, fitness: Number, turnover: Number },
  brainAlphaId: String,
  deletedAt: { type: Date, default: null }
}, { timestamps: true });
alphaSchema.index({ userId: 1, status: 1, updatedAt: -1 });
alphaSchema.index({ name: 'text', description: 'text', tags: 'text' });

export const Alpha = mongoose.model('Alpha', alphaSchema);
