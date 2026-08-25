/**
 * Enough of JSON Schema to hold the project format to its published schema.
 *
 * Not a general validator, and not trying to be. It covers the keywords
 * `docs/program.skate.schema.json` actually uses, so the schema shipped for
 * other tools is checked against real documents on every commit rather than
 * being prose that drifts. Anything it does not understand it ignores, which is
 * the safe direction: a keyword this misses is a check not made, never a
 * document wrongly failed.
 *
 * `validate` returns a list of complaints, empty when the document fits.
 */
'use strict';

/** Does `value` match one of the type names JSON Schema uses? */
function typeMatches(value, type) {
  const names = Array.isArray(type) ? type : [type];
  return names.some((name) => {
    if (name === 'null') return value === null;
    if (name === 'array') return Array.isArray(value);
    if (name === 'object')
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (name === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (name === 'number') return typeof value === 'number' && isFinite(value);
    return typeof value === name;
  });
}

function validate(value, schema, where = '') {
  const problems = [];
  const at = where || '(root)';
  if (!schema || typeof schema !== 'object') return problems;

  if (schema.type && !typeMatches(value, schema.type)) {
    problems.push(
      `${at} should be ${[].concat(schema.type).join(' or ')}, got ${JSON.stringify(value)}`,
    );
    return problems; // every other keyword here assumes the type held
  }
  if ('const' in schema && value !== schema.const) {
    problems.push(`${at} should be ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(
      `${at} should be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`,
    );
  }

  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      problems.push(`${at} does not match ${schema.pattern}: ${JSON.stringify(value)}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      problems.push(`${at} is shorter than ${schema.minLength}`);
    }
  }

  if (typeof value === 'number') {
    const limits = [
      ['minimum', (v, n) => v < n, 'below'],
      ['maximum', (v, n) => v > n, 'above'],
      ['exclusiveMinimum', (v, n) => v <= n, 'not above'],
      ['exclusiveMaximum', (v, n) => v >= n, 'not below'],
    ];
    for (const [name, broken, word] of limits) {
      if (schema[name] !== undefined && broken(value, schema[name])) {
        problems.push(`${at} is ${word} ${name} ${schema[name]}: ${value}`);
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => problems.push(...validate(item, schema.items, `${at}[${i}]`)));
  }

  if (typeMatches(value, 'object')) {
    for (const key of schema.required || []) {
      if (!(key in value)) problems.push(`${at} is missing required "${key}"`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (key in value) problems.push(...validate(value[key], child, `${at}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(schema.properties || {})[key]) problems.push(`${at}.${key} is not allowed`);
      }
    }
  }

  return problems;
}

module.exports = { validate };
