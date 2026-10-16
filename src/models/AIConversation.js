import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  content: { type: String, required: true, maxlength: 16000 },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  alphaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Alpha', required: true, index: true },
  title: { type: String, required: true, maxlength: 120 },
  messages: { type: [messageSchema], default: [] },
}, { timestamps: true });

schema.index({ userId: 1, alphaId: 1, updatedAt: -1 });
export const AIConversation = mongoose.model('AIConversation', schema);
