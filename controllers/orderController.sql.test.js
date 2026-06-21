'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'orderController.js'), 'utf8');

function readBalancedBlock(text, openIndex) {
  assert.strictEqual(text[openIndex], '(', 'readBalancedBlock must start at an opening parenthesis');

  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inSingleQuote) {
      if (ch === "'" && next === "'") {
        i += 1;
      } else if (ch === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (ch === '"') inDoubleQuote = false;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }

    if (ch === '(') {
      depth += 1;
      continue;
    }

    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return {
          content: text.slice(openIndex + 1, i),
          endIndex: i,
        };
      }
    }
  }

  throw new Error('Unclosed SQL parenthesis block');
}

function splitTopLevelList(input) {
  const parts = [];
  let current = '';
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];

    if (inSingleQuote) {
      current += ch;
      if (ch === "'" && next === "'") {
        current += next;
        i += 1;
      } else if (ch === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (inDoubleQuote) {
      current += ch;
      if (ch === '"') inDoubleQuote = false;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      current += ch;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      current += ch;
      continue;
    }

    if (ch === '(') {
      depth += 1;
      current += ch;
      continue;
    }

    if (ch === ')') {
      depth -= 1;
      current += ch;
      continue;
    }

    if (ch === ',' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = '';
      continue;
    }

    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) parts.push(trimmed);
  return parts;
}

const insertRegex = /INSERT\s+INTO\s+orders\s*\(/gi;
let checkedInserts = 0;
let match;

while ((match = insertRegex.exec(source)) !== null) {
  const columnsOpenIndex = insertRegex.lastIndex - 1;
  const columnsBlock = readBalancedBlock(source, columnsOpenIndex);
  const afterColumns = source.slice(columnsBlock.endIndex + 1);
  const valuesMatch = /VALUES\s*\(/i.exec(afterColumns);

  assert(valuesMatch, `orders insert #${checkedInserts + 1} is missing a VALUES clause`);

  const valuesOpenIndex = columnsBlock.endIndex + 1 + valuesMatch.index + valuesMatch[0].lastIndexOf('(');
  const valuesBlock = readBalancedBlock(source, valuesOpenIndex);
  const columns = splitTopLevelList(columnsBlock.content).map((column) => column.replace(/\s+/g, ' ').trim());
  const values = splitTopLevelList(valuesBlock.content).map((value) => value.replace(/\s+/g, ' ').trim());

  checkedInserts += 1;

  assert.strictEqual(
    values.length,
    columns.length,
    [
      `orders insert #${checkedInserts} has ${columns.length} columns but ${values.length} values.`,
      `Columns: ${columns.join(', ')}`,
      `Values: ${values.join(', ')}`,
    ].join('\n')
  );

  const paymentStateIndex = columns.indexOf('payment_state');
  if (paymentStateIndex !== -1) {
    assert(
      /^\$\d+$/.test(values[paymentStateIndex]),
      `orders insert #${checkedInserts} must bind payment_state with a numbered SQL placeholder.`
    );
  }

  const placeholders = values
    .flatMap((value) => Array.from(value.matchAll(/\$(\d+)/g), (placeholder) => Number(placeholder[1])));
  const maxPlaceholder = placeholders.length ? Math.max(...placeholders) : 0;
  const used = new Set(placeholders);

  for (let n = 1; n <= maxPlaceholder; n += 1) {
    assert(used.has(n), `orders insert #${checkedInserts} skips SQL placeholder $${n}`);
  }

  insertRegex.lastIndex = valuesBlock.endIndex + 1;
}

assert(checkedInserts > 0, 'No INSERT INTO orders statements were found in orderController.js');
console.log(`orderController SQL shape tests passed (${checkedInserts} orders inserts checked)`);