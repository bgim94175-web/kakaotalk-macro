import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DIR = process.env.DATA_DIR || join(process.cwd(), 'state')

function key() {
  const raw = process.env.SENDER_KEY || ''
  if (!raw) throw new Error('SENDER_KEY is required')
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex')
  return scryptSync(raw, 'kakao-sender-v1', 32)
}

export function assertKey() {
  key()
}

function pathOf(id) {
  return join(DIR, `${id}.bin`)
}

export async function saveRecord(id, record) {
  await mkdir(DIR, { recursive: true })
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const plain = Buffer.from(JSON.stringify(record), 'utf8')
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  const out = Buffer.concat([iv, tag, ct])
  await writeFile(pathOf(id), out)
}

export async function loadRecord(id) {
  let buf
  try {
    buf = await readFile(pathOf(id))
  } catch (e) {
    if (e && e.code === 'ENOENT') return null
    throw e
  }
  if (buf.length < 12 + 16) return null
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ct), decipher.final()])
  return JSON.parse(plain.toString('utf8'))
}

export async function listIds() {
  await mkdir(DIR, { recursive: true })
  const names = await readdir(DIR)
  return names.filter((n) => n.endsWith('.bin')).map((n) => n.slice(0, -4))
}

export function blankRuntime() {
  return {
    macroSeq: 0,
    roomDueAt: {},
    roomLastSent: {},
    triggerCd: {},
    triggerOnce: {},
    replyLast: {},
    replyDay: '',
    replyCount: 0,
    botDay: '',
    botCount: 0,
    botLast: {},
    warns: {},
    warnAt: {},
    flood: {},
    floodWarn: {},
    said: {},
    games: {},
    scores: {},
    asked: {},
    knownRooms: {},
    gameLast: {},
  }
}
