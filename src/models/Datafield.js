import mongoose from 'mongoose';
const schema = new mongoose.Schema({ region: String, universe: String, delay: Number, datasetId: String, name: String, description: String, type: String, coverage: mongoose.Schema.Types.Mixed, ownerUserId: { type: mongoose.Schema.Types.ObjectId, default: null } }, { timestamps: true });
schema.index({ ownerUserId: 1, region: 1, universe: 1, delay: 1, datasetId: 1, name: 1 }, { unique: true });
schema.index({ name: 'text', description: 'text' });
export const Datafield = mongoose.model('Datafield', schema);
