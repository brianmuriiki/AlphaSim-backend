import mongoose from 'mongoose';

const folderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Folder', default: null }
}, { timestamps: true });
folderSchema.index({ userId: 1, parentId: 1, name: 1 }, { unique: true });
export const Folder = mongoose.model('Folder', folderSchema);
