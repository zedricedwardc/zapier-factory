// Client registry: <FACTORY_DIR>/clients.json maps clients -> Zapier login/account/folders.
import fs from 'node:fs';
import path from 'node:path';
import { FACTORY_DIR } from './lib.mjs';

const NAME_RE = /^[a-z0-9-]+$/;
const registryFile = () => path.join(process.env.ZAPIER_FACTORY_DIR || FACTORY_DIR, 'clients.json');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (p, msg) => { throw new Error(`clients.json schema error at ${p}: ${msg}`); };
const strArray = (v, p) => { if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) fail(p, 'must be an array of strings'); };
// Folder ids and title prefixes: an empty entry would match every Zap on the login, so it is refused.
const nonEmptyStrArray = (v, p) => {
  strArray(v, p);
  v.forEach((x, i) => { if (!x.trim()) fail(`${p}[${i}]`, 'must not be empty or whitespace-only (it would claim every Zap on the login)'); });
};

function validate(r) {
  if (!isObj(r)) fail('(root)', 'must be an object');
  if (!isObj(r.logins)) fail('logins', 'must be an object');
  if (!isObj(r.clients)) fail('clients', 'must be an object');
  for (const [name, l] of Object.entries(r.logins)) {
    const p = `logins.${name}`;
    if (!NAME_RE.test(name)) fail(p, 'login name must match /^[a-z0-9-]+$/');
    if (!isObj(l)) fail(p, 'must be an object');
    if (typeof l.email !== 'string' || !l.email) fail(`${p}.email`, 'must be a non-empty string');
    if (l.accountId !== null && (typeof l.accountId !== 'string' || !l.accountId)) fail(`${p}.accountId`, 'must be a non-empty string or null');
  }
  for (const [name, c] of Object.entries(r.clients)) {
    const p = `clients.${name}`;
    if (!NAME_RE.test(name)) fail(p, 'client name must match /^[a-z0-9-]+$/');
    if (!isObj(c)) fail(p, 'must be an object');
    if (typeof c.login !== 'string') fail(`${p}.login`, 'must be a string');
    if (!Object.hasOwn(r.logins, c.login)) fail(`${p}.login`, `"${c.login}" is not defined in logins (known: ${Object.keys(r.logins).join(', ') || 'none'})`);
    nonEmptyStrArray(c.folderIds ?? [], `${p}.folderIds`);
    nonEmptyStrArray(c.namePrefixes ?? [], `${p}.namePrefixes`);
    if (c.ghl !== undefined) {
      if (!isObj(c.ghl)) fail(`${p}.ghl`, 'must be an object');
      if (typeof c.ghl.server !== 'string') fail(`${p}.ghl.server`, 'must be a string');
      strArray(c.ghl.locationIds ?? [], `${p}.ghl.locationIds`);
    }
  }
  return r;
}

export function loadRegistry() {
  const file = registryFile();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { logins: {}, clients: {} };
    throw e;
  }
  let parsed;
  try { parsed = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error(`clients.json is not valid JSON (${file}): ${e.message}`); }
  return validate(parsed);
}

function findClientFile(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const f = path.join(dir, '.zapier-client');
    try {
      if (fs.statSync(f).isFile()) { const v = fs.readFileSync(f, 'utf8').trim(); if (v) return v; }
    } catch { /* not here */ }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function resolveTarget({ client, login } = {}, cwd = process.cwd()) {
  const reg = loadRegistry();
  const known = () => `Known clients: ${Object.keys(reg.clients).join(', ') || 'none'}. Known logins: ${Object.keys(reg.logins).join(', ') || 'none'}`;
  let clientName = null;
  let loginName;
  if (client) clientName = client;
  else if (login) loginName = login;
  else {
    clientName = findClientFile(cwd);
    if (!clientName) throw new Error(`No client or login given and no .zapier-client file found from ${cwd} upward. Pass client or login, or create a .zapier-client file containing the client name. ${known()}`);
  }
  let c = null;
  if (clientName) {
    if (!Object.hasOwn(reg.clients, clientName)) throw new Error(`Unknown client "${clientName}". Known clients: ${Object.keys(reg.clients).join(', ') || 'none'}`);
    c = reg.clients[clientName];
    if (login && login !== c.login) throw new Error(`Client "${clientName}" uses login "${c.login}", not login "${login}". Pass only client, or the client's own login.`);
    loginName = c.login;
  }
  if (!Object.hasOwn(reg.logins, loginName)) throw new Error(`Unknown login "${loginName}". Known logins: ${Object.keys(reg.logins).join(', ') || 'none'}`);
  const l = reg.logins[loginName];
  if (l.accountId == null) throw new Error(`Login "${loginName}" has no account id yet: run node login.mjs ${loginName} to discover the account id`);
  return {
    login: loginName,
    accountId: l.accountId,
    email: l.email,
    client: clientName,
    folderIds: c?.folderIds ?? [],
    namePrefixes: c?.namePrefixes ?? [],
    ghl: c?.ghl ?? null,
  };
}
