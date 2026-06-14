#!/usr/bin/env node
// Renders the README Inputs/Outputs tables from action.yml between marker comments.
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HIDDEN_INPUTS = new Set(['integration-backend', 'postman-stack']);

const INPUTS_START = '<!-- inputs-table:start -->';
const INPUTS_END = '<!-- inputs-table:end -->';
const OUTPUTS_START = '<!-- outputs-table:start -->';
const OUTPUTS_END = '<!-- outputs-table:end -->';

function cell(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

export function renderInputsTable(actionYamlText) {
  const action = parse(actionYamlText);
  const rows = Object.entries(action.inputs ?? {}).filter(([name]) => !HIDDEN_INPUTS.has(name)).map(([name, spec]) => {
    const required = spec?.required === true ? 'yes' : 'no';
    const fallback = spec?.default === undefined || spec.default === '' ? '' : `\`${cell(spec.default)}\``;
    return `| \`${name}\` | ${cell(spec?.description)} | ${required} | ${fallback} |`;
  });
  return ['| Name | Description | Required | Default |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

export function renderOutputsTable(actionYamlText) {
  const action = parse(actionYamlText);
  const rows = Object.entries(action.outputs ?? {}).map(
    ([name, spec]) => `| \`${name}\` | ${cell(spec?.description)} | n/a | n/a |`
  );
  return ['| Name | Description | Required | Default |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

function replaceBetween(text, start, end, replacement) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`README markers ${start} / ${end} not found or out of order`);
  }
  return `${text.slice(0, startIndex + start.length)}\n${replacement}\n${text.slice(endIndex)}`;
}

export function renderReadme(readmeText, actionYamlText) {
  let next = replaceBetween(readmeText, INPUTS_START, INPUTS_END, renderInputsTable(actionYamlText));
  next = replaceBetween(next, OUTPUTS_START, OUTPUTS_END, renderOutputsTable(actionYamlText));
  return next;
}

function main() {
  const actionYamlText = readFileSync(resolve(repoRoot, 'action.yml'), 'utf8');
  const readmePath = resolve(repoRoot, 'README.md');
  const readmeText = readFileSync(readmePath, 'utf8');
  const next = renderReadme(readmeText, actionYamlText);
  if (next !== readmeText) {
    writeFileSync(readmePath, next);
    process.stderr.write('README.md tables updated from action.yml\n');
  } else {
    process.stderr.write('README.md tables already up to date\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
