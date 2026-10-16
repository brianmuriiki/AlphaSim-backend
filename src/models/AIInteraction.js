import mongoose from 'mongoose';
const schema = new mongoose.Schema({ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true }, alphaId: mongoose.Schema.Types.ObjectId, kind: { type: String, required: true }, model: String, promptVersion: String, promptHash: String, tokensIn: Number, tokensOut: Number, outcome: String, accepted: Boolean }, { timestamps: { createdAt: true, updatedAt: false } });
export const AIInteraction = mongoose.model('AIInteraction', schema);
