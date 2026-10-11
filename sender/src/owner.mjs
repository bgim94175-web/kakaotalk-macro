// 배포 겹침 울타리.
// Render 는 새 서버를 켠 뒤 몇 초 지나서 예전 서버를 끈다. 그 사이 두 서버가 같은 카카오 계정에 붙으면
// 카카오는 나중에 붙은 쪽만 남기고 먼저 붙은 쪽을 내보낸다(KICKOUT). 예전 서버가 이것을 "로그인 끊김"으로 알고
// 저장된 로그인을 지우면, 새 서버가 멀쩡히 붙어 있어도 다음 재시작 때 손님이 다시 로그인해야 했다.
// 그래서 마지막으로 켜진 서버 하나만 주인으로 둔다(sender_owner 한 줄).
//   주인이 아닌 서버: 로그인을 지우지 않고, 다시 붙지 않고, 카카오 연결을 모두 닫는다(Hub.standDown).
//   주인: 20초마다 고동(beat)을 남긴다. 주인이 90초 넘게 조용하면(새 서버가 배포 실패로 꺼짐) 남은 서버가 다시 시작해 주인이 된다.
//   막 켜진 주인이 3분 안에 KICKOUT 을 받으면(울타리가 없던 예전 서버가 다시 붙음) 지우지 않고 잠시 뒤 다시 붙어 본다.

import { randomUUID } from 'node:crypto'

export const BEAT_MS = 20000
export const STALE_MS = 90000
export const GRACE_MS = 180000
const GRACE_TRIES = 2

export class Owner {
  /** store: claimOwner·ownerBeat·ownerRow 가 없으면 울타리 없이 늘 주인이다(시험용 저장소). */
  constructor(store, opt) {
    const o = opt || {}
    this.store = store && typeof store.claimOwner === 'function' ? store : null
    this.now = o.now || (() => Date.now())
    this.graceMs = o.graceMs == null ? GRACE_MS : o.graceMs
    this.retryMs = o.retryMs == null ? 5000 : o.retryMs
    this.boot = randomUUID()
    this.bootAt = this.now()
    this.claimed = false
    this.lost = false
    this.lostFns = []
  }

  async claim() {
    if (!this.store) {
      this.claimed = true
      return true
    }
    const now = this.now()
    this.claimed = await this.store.claimOwner(this.boot, this.bootAt, now, now - STALE_MS)
    if (!this.claimed) this.setLost()
    return this.claimed
  }

  /** 'mine' | 'lost' | 'unknown'(주인 칸을 아직 못 썼거나 읽지 못함) */
  async check() {
    if (!this.store) return 'mine'
    if (this.lost) return 'lost'
    if (!this.claimed) return 'unknown'
    let row
    try {
      row = await this.store.ownerRow()
    } catch {
      return 'unknown'
    }
    if (row && row.boot !== this.boot) {
      this.setLost()
      return 'lost'
    }
    return 'mine'
  }

  /** 20초마다. 'mine' | 'lost' | 'orphan'(주인이 조용함 → 다시 시작해 주인이 된다) | 'unknown' */
  async tick() {
    if (!this.store) return 'mine'
    const now = this.now()
    try {
      if (!this.lost && !this.claimed) {
        await this.claim()
        return this.claimed ? 'mine' : 'lost'
      }
      if (!this.lost) {
        if (await this.store.ownerBeat(this.boot, now)) return 'mine'
        this.setLost()
        return 'lost'
      }
      const row = await this.store.ownerRow()
      return !row || now - Number(row.beat) > STALE_MS ? 'orphan' : 'lost'
    } catch {
      return 'unknown'
    }
  }

  onLost(fn) {
    if (this.lost) fn()
    else this.lostFns.push(fn)
  }

  setLost() {
    if (this.lost) return
    this.lost = true
    for (const fn of this.lostFns.splice(0)) {
      try { fn() } catch {}
    }
  }

  /**
   * 저장된 로그인을 지우기 직전에 묻는다(KICKOUT·토큰 무효).
   * 'wipe' 지운다 | 'keep' 주인이 아니거나 알 수 없음: 지우지 않고 멈춘다 | 'retry' 막 켜진 주인: 지우지 않고 잠시 뒤 다시 붙는다
   */
  async verdict(reason, slot) {
    const own = await this.check()
    if (own !== 'mine') return 'keep'
    if (this.store && reason === 'kicked' && this.now() - this.bootAt < this.graceMs && (slot.graceTries || 0) < GRACE_TRIES) {
      slot.graceTries = (slot.graceTries || 0) + 1
      return 'retry'
    }
    return 'wipe'
  }
}
