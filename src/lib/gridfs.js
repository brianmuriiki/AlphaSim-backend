import mongoose from 'mongoose';
import { GridFSBucket, ObjectId } from 'mongodb';

function bucket() {
  if (!mongoose.connection.db) throw new Error('MongoDB is not connected');
  return new GridFSBucket(mongoose.connection.db, { bucketName: 'simulationRaw' });
}
export async function storeRawResult(simulationId, userId, value) {
  if (value === undefined || value === null) return null;
  const upload = bucket().openUploadStream(`simulation-${simulationId}.json`, { contentType: 'application/json', metadata: { simulationId: String(simulationId), userId: String(userId) } });
  return await new Promise((resolve, reject) => {
    upload.once('finish', () => resolve(upload.id));
    upload.once('error', reject);
    upload.end(Buffer.from(JSON.stringify(value)));
  });
}
export function rawResultStream(id) {
  if (!ObjectId.isValid(id)) throw new Error('Invalid raw result reference');
  return bucket().openDownloadStream(new ObjectId(id));
}
export async function deleteUserRawResults(userId) {
  const files = await bucket().find({ 'metadata.userId': String(userId) }).toArray();
  await Promise.all(files.map((file) => bucket().delete(file._id)));
}
export async function deleteSimulationRawResults(simulationIds, userId) {
  if (!simulationIds.length) return;
  const ids = simulationIds.map(String);
  const files = await bucket().find({ 'metadata.userId': String(userId), 'metadata.simulationId': { $in: ids } }).toArray();
  await Promise.all(files.map((file) => bucket().delete(file._id)));
}
