import mongoose from 'mongoose';
const schema = new mongoose.Schema({ name: { type: String, unique: true }, category: String, signature: String, minArgs: Number, maxArgs: Number, description: String, examples: [String] }, { timestamps: true });
schema.index({ name: 'text', description: 'text' });
export const Operator = mongoose.model('Operator', schema);
