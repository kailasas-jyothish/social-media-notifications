#!/usr/bin/env node
/**
 * Dokploy control script.
 *
 *   node scripts/dokploy.mjs probe          # discover the API surface + auth
 *   node scripts/dokploy.mjs find           # locate the app by name
 *   node scripts/dokploy.mjs show           # dump the app's current config
 *   node scripts/dokploy.mjs configure      # git source + Dockerfile build + domain + /data volume
 *   node scripts/dokploy.mjs push-env       # upload .env to the app
 *   node scripts/dokploy.mjs deploy         # trigger a deploy
 *   node scripts/dokploy.mjs setup          # configure, push-env, then deploy
 *
 * Reads DOKPLOY_URL, DOKPLOY_API_KEY, DOKPLOY_APP_NAME, DOKPLOY_GIT_URL,
 * DOKPLOY_GIT_BRANCH from .env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const fileEnv = readEnvFile(envPath);
const env = { ...fileEnv, ...process.env };

const BASE = (env.DOKPLOY_URL || '').replace(/\/+$/, '');
const KEY = env.DOKPLOY_API_KEY || '';
const APP_NAME = env.DOKPLOY_APP_NAME || 'Social-media-notifications';
const GIT_URL = env.DOKPLOY_GIT_URL || '';
const GIT_BRANCH = env.DOKPLOY_GIT_BRANCH || 'main';

// Runtime env vars the app actually needs (everything except the Dokploy ones).
const RUNTIME_KEYS = Object.keys(fileEnv).filter((k) => !k.startsWith('DOKPLOY_'));

if (!BASE || !KEY) {
  console.error('Set DOKPLOY_URL and DOKPLOY_API_KEY in .env first.');
  process.exit(1);
}

const headers = {
  'x-api-key': KEY,
  authorization: `Bearer ${KEY}`,
  'content-type': 'application/json',
  accept: 'application/json',
};

async function call(method, route, payload) {
  const url = `${BASE}/api/${route.replace(/^\/+/, '')}`;
  const init = { method, headers };
  let target = url;
  if (method === 'GET' && payload && Object.keys(payload).length) {
    target += `?${new URLSearchParams(payload)}`;
  } else if (payload) {
    init.body = JSON.stringify(payload);
  }
  const res = await fetch(target, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body, url: target };
}

const GET = (route, params) => call('GET', route, params);
const POST = (route, payload) => call('POST', route, payload);

/** Try several candidate routes and return the first that succeeds. */
async function tryRoutes(candidates) {
  const attempts = [];
  for (const [method, route, payload] of candidates) {
    const r = await call(method, route, payload);
    attempts.push({ method, route, status: r.status });
    if (r.ok) return { ...r, route, method, attempts };
  }
  return { ok: false, attempts };
}

// ---------------------------------------------------------------- commands

async function probe() {
  console.log(`Dokploy base: ${BASE}`);
  for (const doc of ['/swagger', '/swagger/json', '/api/openapi.json', '/openapi.json']) {
    const res = await fetch(`${BASE}${doc}`, { headers }).catch(() => null);
    if (res?.ok) {
      const ct = res.headers.get('content-type') || '';
      console.log(`  docs: ${BASE}${doc}  (${res.status}, ${ct})`);
      if (ct.includes('json')) {
        const spec = await res.json().catch(() => null);
        const paths = spec?.paths ? Object.keys(spec.paths) : [];
        const interesting = paths.filter((p) => /application|project|domain|deploy|env/i.test(p));
        console.log(`  ${paths.length} paths in spec; relevant ones:`);
        for (const p of interesting.slice(0, 80)) {
          console.log(`    ${Object.keys(spec.paths[p]).join(',').toUpperCase().padEnd(12)} ${p}`);
        }
        fs.writeFileSync(path.join(root, 'dokploy-openapi.json'), JSON.stringify(spec, null, 2));
        console.log('  full spec written to dokploy-openapi.json');
        return;
      }
    }
  }
  console.log('  no OpenAPI doc found; probing known routes');
  const r = await tryRoutes([
    ['GET', 'project.all'],
    ['GET', 'projects.all'],
    ['GET', 'settings.health'],
    ['GET', 'auth.get'],
    ['GET', 'user.get'],
  ]);
  console.log(JSON.stringify(r.attempts, null, 2));
  if (r.ok) console.log(`auth works via ${r.method} ${r.route}`);
  else console.log('none of the probe routes answered 2xx — share the output and I will adjust.');
}

async function listProjects() {
  const r = await tryRoutes([
    ['GET', 'project.all'],
    ['GET', 'projects.all'],
  ]);
  if (!r.ok) throw new Error(`cannot list projects: ${JSON.stringify(r.attempts)}`);
  return Array.isArray(r.body) ? r.body : r.body?.data || [];
}

/**
 * Dokploy nests services one level deeper than the old docs suggest:
 * project -> environments[] -> applications[]. project.all returns only a
 * stub per application, so the id is re-fetched through application.one.
 */
async function findApp() {
  const projects = await listProjects();
  const seen = [];
  for (const project of projects) {
    for (const environment of project.environments || []) {
      for (const stub of environment.applications || []) {
        const name = stub.name || stub.appName;
        seen.push(name);
        if (String(name).toLowerCase() === APP_NAME.toLowerCase()) {
          const r = await GET('application.one', { applicationId: stub.applicationId });
          if (!r.ok) throw new Error(`application.one failed: ${r.status} ${JSON.stringify(r.body)}`);
          return { app: r.body, project, environment };
        }
      }
    }
  }
  throw new Error(`application "${APP_NAME}" not found. Applications visible: ${seen.join(', ') || '(none)'}`);
}

async function show() {
  const { app, project, environment } = await findApp();
  const source =
    app.sourceType === 'git'
      ? `${app.customGitUrl || '(no url)'} @ ${app.customGitBranch || '(no branch)'}`
      : `${app.repository || '(no repo)'} @ ${app.branch || '(no branch)'}`;
  console.log(`project: ${project.name} / ${environment.name} (${app.environmentId})`);
  console.log(`app:     ${app.name} (${app.applicationId})`);
  console.log(`source:  ${app.sourceType} ${source}`);
  console.log(`build:   ${app.buildType} ${app.dockerfile || ''}`);
  console.log(`domains: ${(app.domains || []).map((d) => `${d.https ? 'https' : 'http'}://${d.host} -> :${d.port}`).join(', ') || '(none)'}`);
  console.log(`mounts:  ${(app.mounts || []).map((m) => `${m.volumeName || m.type}:${m.mountPath}`).join(', ') || '(none)'}`);
  console.log(`env:     ${app.env ? `${app.env.split('\n').filter(Boolean).length} vars` : '(none)'}`);
  console.log(`status:  ${app.applicationStatus}`);
  console.log(`webhook: ${BASE}/api/deploy/${app.refreshToken}`);
  return { app, project, environment };
}

async function configure() {
  if (!GIT_URL) throw new Error('set DOKPLOY_GIT_URL in .env (e.g. https://github.com/you/social-media-notifications.git)');
  const { app } = await findApp();
  const applicationId = app.applicationId;

  // Public repo over a plain git URL: no GitHub App install, no deploy key.
  const src = await tryRoutes([
    ['POST', 'application.saveGitProvider', { applicationId, customGitUrl: GIT_URL, customGitBranch: GIT_BRANCH, customGitBuildPath: '/', customGitSSHKeyId: null, enableSubmodules: false, watchPaths: [] }],
    ['POST', 'application.update', { applicationId, sourceType: 'git', customGitUrl: GIT_URL, customGitBranch: GIT_BRANCH, customGitBuildPath: '/' }],
  ]);
  if (!src.ok) throw new Error(`could not set git source: ${JSON.stringify(src.attempts)}`);
  console.log(`source set  ${GIT_URL} @ ${GIT_BRANCH}  (via ${src.route})`);

  // The repo ships a Dockerfile; nixpacks (the default) would ignore it.
  const build = await tryRoutes([
    ['POST', 'application.update', { applicationId, buildType: 'dockerfile', dockerfile: 'Dockerfile' }],
    ['POST', 'application.saveBuildType', { applicationId, buildType: 'dockerfile', dockerfile: 'Dockerfile', dockerContextPath: '', dockerBuildStage: '', isStaticSpa: false }],
  ]);
  if (!build.ok) throw new Error(`could not set build type: ${JSON.stringify(build.attempts)}`);
  console.log(`build set   dockerfile ./Dockerfile  (via ${build.route})`);

  // Dedupe state lives in DATA_DIR and must survive redeploys.
  const mountPath = fileEnv.DATA_DIR || '/data';
  if ((app.mounts || []).some((m) => m.mountPath === mountPath)) {
    console.log(`mount ok    ${mountPath} already mounted`);
  } else {
    const mount = await tryRoutes([
      ['POST', 'mounts.create', { type: 'volume', volumeName: 'social-notify-data', mountPath, serviceId: applicationId, serviceType: 'application' }],
      ['POST', 'mount.create', { type: 'volume', volumeName: 'social-notify-data', mountPath, serviceId: applicationId, serviceType: 'application' }],
    ]);
    if (!mount.ok) throw new Error(`could not create volume mount: ${JSON.stringify(mount.attempts)}`);
    console.log(`mount set   volume social-notify-data -> ${mountPath}  (via ${mount.route})`);
  }

  // WebSub will not deliver without a public HTTPS callback, so the domain is
  // part of configuration rather than a nicety.
  const publicUrl = fileEnv.PUBLIC_URL || '';
  const host = publicUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  // Scheme is authoritative: Let's Encrypt refuses shared domains like
  // sslip.io, so an http:// PUBLIC_URL must not get a cert-bearing router or
  // the edge answers every TLS handshake with an internal error.
  const https = publicUrl.startsWith('https://');
  // This server fronts 80/443 with Caddy, which only serves hosts written into
  // its own config — a Dokploy domain record never reaches it. An IP:port
  // PUBLIC_URL means we are bypassing the edge via a published port instead,
  // so there is no domain to attach.
  if (/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(host)) {
    console.log(`domain      skipped (PUBLIC_URL is a published port: ${publicUrl})`);
  } else if (!host) {
    console.log('domain      skipped (PUBLIC_URL is empty)');
  } else {
    const port = Number(fileEnv.PORT || 3000);
    const existing = (app.domains || []).find((d) => d.host === host);
    if (existing && existing.https === https && existing.port === port) {
      console.log(`domain ok   ${publicUrl} already attached`);
    } else {
      const payload = { host, path: '/', port, https, applicationId, domainType: 'application', certificateType: https ? 'letsencrypt' : 'none' };
      const domain = existing
        ? await tryRoutes([['POST', 'domain.update', { domainId: existing.domainId, ...payload }]])
        : await tryRoutes([['POST', 'domain.create', payload]]);
      if (!domain.ok) throw new Error(`could not save domain: ${JSON.stringify(domain.attempts)}`);
      console.log(`domain set  ${publicUrl} -> :${port}  (via ${domain.route})`);
    }
  }
}

function envBlock() {
  return RUNTIME_KEYS.map((k) => `${k}=${fileEnv[k] ?? ''}`).join('\n');
}

async function pushEnv() {
  const { app } = await findApp();
  const applicationId = app.applicationId;
  const r = await tryRoutes([
    ['POST', 'application.saveEnvironment', { applicationId, env: envBlock() }],
    ['POST', 'application.update', { applicationId, env: envBlock() }],
  ]);
  if (!r.ok) throw new Error(`could not save env: ${JSON.stringify(r.attempts)}`);
  console.log(`env pushed (${RUNTIME_KEYS.length} vars) via ${r.route}`);
}

async function deploy() {
  const { app } = await findApp();
  const applicationId = app.applicationId;
  const r = await tryRoutes([
    ['POST', 'application.deploy', { applicationId }],
    ['POST', 'application.redeploy', { applicationId }],
  ]);
  if (!r.ok) throw new Error(`could not deploy: ${JSON.stringify(r.attempts)}`);
  console.log(`deploy triggered via ${r.route}`);
}

const commands = {
  probe,
  find: show,
  show,
  configure,
  'push-env': pushEnv,
  deploy,
  setup: async () => { await configure(); await pushEnv(); await deploy(); },
};

const cmd = process.argv[2] || 'probe';
const fn = commands[cmd];
if (!fn) {
  console.error(`unknown command "${cmd}". Available: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}
fn().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
