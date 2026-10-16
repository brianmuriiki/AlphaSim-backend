import mongoose from 'mongoose';

const simulationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  alphaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Alpha', required: true, index: true },
  versionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AlphaVersion', required: true },
  runNumber: { type: Number, required: true },
  expressionSnapshot: { type: String, required: true },
  settingsSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  status: { type: String, enum: ['queued', 'running', 'completed', 'failed', 'cancelled'], default: 'queued', index: true },
  brainProgressUrl: String,
  brainSimulationId: String,
  brainAlphaId: String,
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  deltaVsPrevious: { type: mongoose.Schema.Types.Mixed, default: null },
  rawResultRef: { type: mongoose.Schema.Types.ObjectId, select: false },
  error: { code: String, message: String },
  slotReleased: { type: Boolean, default: false },
  slotReserved: { type: Boolean, default: false },
  experimentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Experiment', default: null, index: true },
  timing: { queuedAt: { type: Date, default: Date.now }, startedAt: Date, finishedAt: Date }
}, { timestamps: true });
simulationSchema.index({ userId: 1, createdAt: -1 });
simulationSchema.index({ alphaId: 1, createdAt: -1 });
simulationSchema.index({ alphaId: 1, runNumber: 1 }, { unique: true });

export const Simulation = mongoose.model('Simulation', simulationSchema);
