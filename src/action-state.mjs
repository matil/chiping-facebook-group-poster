import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FORMAT_VERSION = 1;
const AAD = Buffer.from('chiping-facebook-action-state:v1');
const VERIFIED_PROFILE_FILE = 'verified-profile.json';

function keyFromSecret(secret) {
  const value = String(secret || '');
  if (value.length < 32) throw new Error('FACEBOOK_STATE_ENCRYPTION_KEY must contain at least 32 characters');
  return createHash('sha256').update(value).digest();
}

function encrypt(secret, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return JSON.stringify({
    version: FORMAT_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  });
}

function decrypt(secret, raw) {
  const parsed = JSON.parse(raw);
  if (parsed?.version !== FORMAT_VERSION || !parsed.iv || !parsed.tag || !parsed.ciphertext) {
    throw new Error('Encrypted Facebook state has an unsupported format');
  }
  const decipher = createDecipheriv('aes-256-gcm', keyFromSecret(secret), Buffer.from(parsed.iv, 'base64'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, value, 'utf8');
  await rename(temporary, file);
}

export async function restoreEncryptedActionState({ encryptedFile, secret, dataDir, storageStateFile }) {
  let plain;
  try {
    plain = await readFile(encryptedFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  const state = JSON.parse(decrypt(secret, plain));
  if (!state || typeof state !== 'object' || !state.queue || typeof state.queue !== 'object') {
    throw new Error('Encrypted Facebook state is invalid');
  }
  await atomicWrite(path.join(dataDir, 'queue.json'), JSON.stringify(state.queue, null, 2));
  if (state.storage_state && storageStateFile) {
    await atomicWrite(storageStateFile, JSON.stringify(state.storage_state));
  }
  if (typeof state.verified_profile === 'string' && state.verified_profile.trim()) {
    await atomicWrite(
      path.join(dataDir, VERIFIED_PROFILE_FILE),
      JSON.stringify({ name: state.verified_profile.trim() })
    );
  }
  return true;
}

export async function markVerifiedPostingProfile(dataDir, profileName) {
  const name = String(profileName || '').trim();
  if (!name) throw new Error('Verified Facebook posting profile is missing');
  await atomicWrite(path.join(dataDir, VERIFIED_PROFILE_FILE), JSON.stringify({ name }));
}

export async function saveEncryptedActionState({ encryptedFile, secret, dataDir, storageStateFile }) {
  const queue = await readJson(path.join(dataDir, 'queue.json'));
  if (!queue || typeof queue !== 'object') throw new Error('Facebook queue state was not written');
  const storageState = storageStateFile ? await readJson(storageStateFile) : null;
  const verifiedProfile = await readJson(path.join(dataDir, VERIFIED_PROFILE_FILE));
  const plain = JSON.stringify({
    version: FORMAT_VERSION,
    queue,
    storage_state: storageState || null,
    verified_profile: String(verifiedProfile?.name || '').trim() || null,
  });
  await atomicWrite(encryptedFile, encrypt(secret, plain));
}
