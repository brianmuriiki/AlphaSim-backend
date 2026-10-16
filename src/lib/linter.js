import { Operator } from '../models/Operator.js';
import { Datafield } from '../models/Datafield.js';

const builtinOps = new Map([
  ['rank', [1, 1]], ['ts_delta', [2, 2]], ['ts_rank', [2, 2]], ['ts_mean', [2, 2]], ['ts_std_dev', [2, 2]],
  ['group_neutralize', [2, 2]], ['winsorize', [2, 2]], ['scale', [1, 2]], ['zscore', [1, 1]], ['abs', [1, 1]],
  ['log', [1, 1]], ['sqrt', [1, 1]], ['sign', [1, 1]], ['delay', [2, 2]], ['correlation', [3, 3]], ['covariance', [3, 3]],
  ['decay_linear', [2, 2]], ['ts_sum', [2, 2]], ['ts_min', [2, 2]], ['ts_max', [2, 2]], ['if_else', [3, 3]],
  ['min', [2, 2]], ['max', [2, 2]], ['power', [2, 2]]
]);
const precedence = { '==': 1, '!=': 1, '>': 1, '<': 1, '>=': 1, '<=': 1, '+': 2, '-': 2, '*': 3, '/': 3, '%': 3, '^': 4 };
function syntaxError(message, line, col) { return Object.assign(new SyntaxError(message), { code: 'SYNTAX', line, col }); }

function tokenize(source) {
  const out = [];
  const re = /\/\/[^\n]*|\s+|(?:\d+(?:\.\d*)?|\.\d+)|[A-Za-z_][A-Za-z0-9_.]*|==|!=|>=|<=|[()+\-*/%^,;=<>]/y;
  let index = 0;
  while (index < source.length) {
    re.lastIndex = index;
    const match = re.exec(source);
    if (!match) {
      const before = source.slice(0, index).split('\n');
      throw syntaxError(`Unexpected character '${source[index]}'`, before.length, before.at(-1).length + 1);
    }
    const value = match[0]; index = re.lastIndex;
    if (/^\s+$/.test(value) || value.startsWith('//')) continue;
    const line = source.slice(0, match.index).split('\n');
    out.push({ value, line: line.length, col: line.at(-1).length + 1, start: match.index, end: index, type: /^\d|^\./.test(value) ? 'number' : /^[A-Za-z_]/.test(value) ? 'identifier' : 'symbol' });
  }
  out.push({ value: '<eof>', line: source.split('\n').length, col: 1, type: 'eof' });
  return out;
}

export function parseExpression(source) {
  const tokens = tokenize(source);
  let cursor = 0;
  const peek = () => tokens[cursor];
  const take = () => tokens[cursor++];
  const fail = (message, token = peek()) => { throw syntaxError(message, token.line, token.col); };
  function primary() {
    const token = take();
    if (token.type === 'number') return { type: 'number', value: Number(token.value), token };
    if (token.value === '(') { const expression = binary(0); if (peek().value !== ')') fail("Expected ')'", peek()); take(); return expression; }
    if (token.value === '-' || token.value === '+') return { type: 'unary', op: token.value, value: primary(), token };
    if (token.type === 'identifier') {
      if (peek().value !== '(') return { type: 'identifier', name: token.value, token };
      take(); const args = [];
      if (peek().value !== ')') { do { args.push(binary(0)); if (peek().value !== ',') break; take(); } while (true); }
      if (take().value !== ')') fail("Expected ')' after function arguments");
      return { type: 'call', name: token.value, args, token };
    }
    fail(`Expected an expression, found '${token.value}'`, token);
  }
  function binary(min) {
    let left = primary();
    while ((precedence[peek().value] ?? -1) >= min) {
      const op = take(); const prec = precedence[op.value];
      const right = binary(prec + (op.value === '^' ? 0 : 1));
      left = { type: 'binary', op: op.value, left, right, token: op };
    }
    return left;
  }
  const statements = [];
  while (peek().type !== 'eof') {
    if (peek().value === ';') { take(); continue; }
    let assignment = null;
    if (peek().type === 'identifier' && tokens[cursor + 1]?.value === '=') assignment = take();
    if (assignment) take();
    const expression = binary(0);
    statements.push({ type: assignment ? 'assignment' : 'expression', name: assignment?.value, expression, token: assignment ?? expression.token });
    if (peek().value === ';') take();
    else if (peek().type !== 'eof') fail("Expected ';' between statements");
  }
  if (!statements.length) fail('Expression is empty');
  return statements;
}

function walk(node, visit) { visit(node); if (node.type === 'call') node.args.forEach((item) => walk(item, visit)); if (node.type === 'binary') { walk(node.left, visit); walk(node.right, visit); } if (node.type === 'unary') walk(node.value, visit); }

export async function lintExpression(source, { region, universe, delay, ownerUserId } = {}) {
  const errors = []; const warnings = [];
  let statements;
  try { statements = parseExpression(source); }
  catch (error) { return { errors: [{ code: error.code ?? 'SYNTAX', message: error.message, line: error.line ?? 1, col: error.col ?? 1 }], warnings: [] }; }
  const operators = await Operator.find().lean();
  const opMap = new Map([...builtinOps.entries()].map(([name, [minArgs, maxArgs]]) => [name, { minArgs, maxArgs }]));
  for (const operator of operators) opMap.set(operator.name.toLowerCase(), operator);
  const fieldFilter = { $or: [{ ownerUserId: null }, ...(ownerUserId ? [{ ownerUserId }] : [])] };
  if (region) fieldFilter.region = region;
  if (universe) fieldFilter.universe = universe;
  if (delay !== undefined) fieldFilter.delay = delay;
  const fieldSet = new Set((await Datafield.find(fieldFilter).select('name').lean()).map((field) => field.name.toLowerCase()));
  const assigned = new Set();
  const declared = [];
  for (let i = 0; i < statements.length; i += 1) {
    const statement = statements[i];
    const refs = [];
    walk(statement.expression, (node) => {
      if (node.type === 'call') {
        const operator = opMap.get(node.name.toLowerCase());
        if (!operator) errors.push({ code: 'UNKNOWN_OPERATOR', message: `Unknown operator '${node.name}'`, line: node.token.line, col: node.token.col });
        else if (node.args.length < (operator.minArgs ?? 0) || node.args.length > (operator.maxArgs ?? Number.MAX_SAFE_INTEGER)) errors.push({ code: 'ARITY', message: `${node.name} received ${node.args.length} arguments`, line: node.token.line, col: node.token.col });
      } else if (node.type === 'identifier') refs.push(node);
    });
    for (const ref of refs) {
      const name = ref.name.toLowerCase();
      if (assigned.has(name) || name === 'true' || name === 'false') continue;
      if (fieldSet.size && !fieldSet.has(name)) errors.push({ code: 'UNKNOWN_DATAFIELD', message: `Unknown datafield '${ref.name}'`, line: ref.token.line, col: ref.token.col });
    }
    if (statement.type === 'assignment') {
      if (i === statements.length - 1) errors.push({ code: 'FINAL_ASSIGNMENT', message: 'Final statement must be an expression, not an assignment', line: statement.token.line, col: statement.token.col });
      if (refs.some((ref) => ref.name.toLowerCase() === statement.name.toLowerCase())) warnings.push({ code: 'UNUSED_VARIABLE', message: `Assignment '${statement.name}' uses itself`, line: statement.token.line, col: statement.token.col });
      assigned.add(statement.name.toLowerCase());
      declared.push({ name: statement.name.toLowerCase(), token: statement.token });
    }
    walk(statement.expression, (node) => { if (node.type === 'number' && node.value > 252) warnings.push({ code: 'LARGE_LOOKBACK', message: `Large numeric window (${node.value})`, line: node.token.line, col: node.token.col }); });
  }
  for (const item of declared) {
    let used = false;
    for (const statement of statements) {
      if (statement.type === 'assignment' && statement.token.start <= item.token.start) continue;
      const refs = []; walk(statement.expression, (node) => { if (node.type === 'identifier') refs.push(node.name.toLowerCase()); });
      if (refs.includes(item.name)) { used = true; break; }
    }
    if (!used) warnings.push({ code: 'UNUSED_VARIABLE', message: `Variable '${item.name}' is never used`, line: item.token.line, col: item.token.col });
  }
  if (!fieldSet.size) warnings.push({ code: 'DATAFIELD_CATALOG_UNAVAILABLE', message: 'Datafield names could not be checked because no catalog is available', line: 1, col: 1 });
  return { errors, warnings };
}
