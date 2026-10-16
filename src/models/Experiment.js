import mongoose from 'mongoose';

const experimentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  baseVersionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AlphaVersion', required: true },
  parameterGrid: [{ path: String, values: [mongoose.Schema.Types.Mixed] }],
  simulationIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Simulation' }],
  status: { type: String, enum: ['queued', 'running', 'completed', 'failed', 'cancelled'], default: 'queued' },
  progress: { total: { type: Number, default: 0 }, done: { type: Number, default: 0 }, failed: { type: Number, default: 0 } }
}, { timestamps: true });
export const Experiment = mongoose.model('Experiment', experimentSchema);
