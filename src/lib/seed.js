import { Operator } from '../models/Operator.js';

const definitions = [
  ['abs', 'Arithmetic', 'abs(x)', 1, 1], ['correlation', 'Time Series', 'correlation(x, y, window)', 3, 3], ['covariance', 'Time Series', 'covariance(x, y, window)', 3, 3],
  ['decay_linear', 'Time Series', 'decay_linear(x, window)', 2, 2], ['delay', 'Time Series', 'delay(x, window)', 2, 2], ['group_neutralize', 'Group', 'group_neutralize(x, group)', 2, 2],
  ['if_else', 'Logical', 'if_else(condition, x, y)', 3, 3], ['log', 'Arithmetic', 'log(x)', 1, 1], ['max', 'Arithmetic', 'max(x, y)', 2, 2], ['min', 'Arithmetic', 'min(x, y)', 2, 2],
  ['power', 'Arithmetic', 'power(x, exponent)', 2, 2], ['rank', 'Cross Sectional', 'rank(x)', 1, 1], ['scale', 'Cross Sectional', 'scale(x, scale=1)', 1, 2], ['sign', 'Arithmetic', 'sign(x)', 1, 1],
  ['sqrt', 'Arithmetic', 'sqrt(x)', 1, 1], ['ts_delta', 'Time Series', 'ts_delta(x, window)', 2, 2], ['ts_max', 'Time Series', 'ts_max(x, window)', 2, 2],
  ['ts_mean', 'Time Series', 'ts_mean(x, window)', 2, 2], ['ts_min', 'Time Series', 'ts_min(x, window)', 2, 2], ['ts_rank', 'Time Series', 'ts_rank(x, window)', 2, 2],
  ['ts_std_dev', 'Time Series', 'ts_std_dev(x, window)', 2, 2], ['ts_sum', 'Time Series', 'ts_sum(x, window)', 2, 2], ['winsorize', 'Cross Sectional', 'winsorize(x, std=4)', 1, 2], ['zscore', 'Cross Sectional', 'zscore(x)', 1, 1]
];
export async function seedBuiltinOperators() {
  const operations = definitions.map(([name, category, signature, minArgs, maxArgs]) => ({
    updateOne: {
      filter: { name },
      update: { $setOnInsert: { name, category, signature, minArgs, maxArgs, description: 'Reference signature for editor help.' } },
      upsert: true
    }
  }));
  await Operator.bulkWrite(operations, { ordered: false });
}
