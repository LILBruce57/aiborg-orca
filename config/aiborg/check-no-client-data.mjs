#!/usr/bin/env node
// Local guard for this public repo: refuses a commit whose staged lines, file paths, branch name or
// message mention a client from the private client-profile directory. The denylist is read at
// commit time and never stored here. With no profile directory configured it is a no-op.
//
//   node config/aiborg/check-no-client-data.mjs --staged          (pre-commit)
//   node config/aiborg/check-no-client-data.mjs --message <file>  (commit-msg)
//
// Profile directory: AIBORG_PROFILES_DIR, else `profilesDir` in
// <AI-Borg userData>/aiborg-client-profiles.json.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TERM_KEYS = new Set([
  'id',
  'name',
  'displayName',
  'org',
  'orgs',
  'allowedOrgs',
  'owner',
  'login',
  'email',
  'domain',
  'tenant',
  'account',
  'project'
])
const MIN_TERM_LENGTH = 3
// Why: profile values such as `main` or `github.com` would match nearly every commit and push
// people towards --no-verify.
const GENERIC_TERMS = new Set([
  'admin',
  'api',
  'app',
  'default',
  'dev',
  'github',
  'github.com',
  'gitlab',
  'gitlab.com',
  'localhost',
  'main',
  'master',
  'prod',
  'production',
  'staging',
  'test',
  'user',
  'web',
  'www'
])

function aiborgUserDataDir() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'aiborg')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'aiborg')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'aiborg')
}

const UNREADABLE = Symbol('unreadable')

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return UNREADABLE
  }
}

function resolveProfilesDir() {
  if (process.env.AIBORG_PROFILES_DIR) {
    return process.env.AIBORG_PROFILES_DIR
  }
  const sidecarPath = join(aiborgUserDataDir(), 'aiborg-client-profiles.json')
  if (!existsSync(sidecarPath)) {
    return null
  }
  const sidecar = readJson(sidecarPath)
  if (sidecar === UNREADABLE) {
    return UNREADABLE
  }
  return typeof sidecar?.profilesDir === 'string' ? sidecar.profilesDir : null
}

function collectTerms(value, key, terms) {
  if (typeof value === 'string') {
    const term = value.trim().toLowerCase()
    if (key && TERM_KEYS.has(key) && term.length >= MIN_TERM_LENGTH && !GENERIC_TERMS.has(term)) {
      terms.add(term)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTerms(item, key, terms)
    }
    return
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      collectTerms(child, childKey, terms)
    }
  }
}

export function loadClientTerms(profilesDir) {
  const terms = new Set()
  let unreadableFiles = 0
  if (!profilesDir || !existsSync(profilesDir)) {
    return { terms, unreadableFiles }
  }
  for (const file of readdirSync(profilesDir)) {
    if (file.endsWith('.json')) {
      const profile = readJson(join(profilesDir, file))
      if (profile === UNREADABLE) {
        unreadableFiles += 1
      } else {
        collectTerms(profile, null, terms)
      }
    }
  }
  return { terms, unreadableFiles }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Why alphanumeric boundaries: a short term must not match inside a word (`dev` in `device`),
// while `_`, `-`, `/` and `.` still separate it (`acme_inc`, `acme/repo`).
export function findClientTerms(text, terms) {
  const haystack = text.toLowerCase()
  return [...terms].filter((term) =>
    new RegExp(`(?<![a-z0-9])${escapeRegExp(term)}(?![a-z0-9])`).test(haystack)
  )
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function stagedText() {
  const addedLines = git(['diff', '--cached', '--unified=0', '--no-color', '--no-ext-diff'])
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
  const paths = git(['diff', '--cached', '--name-only'])
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  return [...addedLines, paths, branch].join('\n')
}

function main(argv) {
  const profilesDir = resolveProfilesDir()
  if (profilesDir === UNREADABLE) {
    console.error('[aiborg] Refusing commit: the client-profile sidecar could not be parsed.')
    return 1
  }
  const { terms, unreadableFiles } = loadClientTerms(profilesDir)
  // Why fail closed: a profile that cannot be parsed contributes no terms and would let its client through.
  if (unreadableFiles > 0) {
    console.error(
      `[aiborg] Refusing commit: ${unreadableFiles} profile file(s) in the private profile directory could not be parsed.`
    )
    return 1
  }
  if (terms.size === 0) {
    return 0
  }
  const messageIndex = argv.indexOf('--message')
  const text =
    messageIndex !== -1
      ? readFileSync(argv[messageIndex + 1], 'utf8')
      : argv.includes('--staged')
        ? stagedText()
        : ''
  const hits = findClientTerms(text, terms)
  if (hits.length === 0) {
    return 0
  }
  // Why the count only: echoing the matched terms would print client names into CI or shell logs.
  console.error(
    `[aiborg] Refusing commit: ${hits.length} client term(s) from the private profile directory appear in ${messageIndex !== -1 ? 'the commit message' : 'staged changes, paths or the branch name'}. This repo is public.`
  )
  return 1
}

if (process.argv[1]?.endsWith('check-no-client-data.mjs')) {
  process.exitCode = main(process.argv.slice(2))
}
