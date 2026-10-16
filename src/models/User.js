import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  displayName: { type: String, required: true, trim: true },
  brainConnection: {
    status: { type: String, enum: ['none', 'connected', 'expired'], default: 'none' },
    encryptedSession: { type: Buffer, select: false },
    sessionExpiresAt: Date,
    lastVerifiedAt: Date,
    mode: { type: String, enum: ['mock', 'official'], default: null }
  },
  encryptedAiApiKey: { type: Buffer, select: false },
  preferences: { theme: { type: String, default: 'dark' }, defaultSettingsPreset: String, editorFontSize: { type: Number, default: 14 } },
  aiUsage: { monthlyTokens: { type: Number, default: 0 }, resetAt: { type: Date, default: () => new Date() } },
  activeSimulationCount: { type: Number, default: 0 }
}, { timestamps: true });

export const User = mongoose.model('User', userSchema);
