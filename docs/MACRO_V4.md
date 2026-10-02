# 매크로 v4 — 계정 기본값 + 방별 덮어쓰기 설계 명세

사용자 요청:
1. 오픈프로필 갠톡에서 특정 메시지(키워드)에 반응하는 규칙 추가 (기존 '모든 갠톡 응답'과 병행)
2. 계정마다 매크로 설정 가능 (계정 기본값)
3. 방마다 쿨타임·랜덤쿨타임·메시지 등 설정 가능 (방별 덮어쓰기)
4. 일일 발송 제한 관련 전부 제거

## 1. 설정 해상도 (3단계: 전역 → 계정 → 방)

유효값(effective) = **방별 덮어쓰기 > 계정 기본값 > 전역 기본값**.
덮어쓰기는 "사용함" 플래그가 켜진 항목만 우선한다. 꺼져 있으면 상위 단계 값을 쓴다.

대상 값: `message`(발송 메시지), `cooldownMinMin`/`cooldownMaxMin`(쿨타임 분, 이 사이 랜덤),
`minMessages`(마지막 발송 뒤 새 메시지 N개 이상 쌓여야 재발송).

## 2. Settings 모델 (Settings.java)

기존 `Macro` 를 아래로 확장한다. **기존 저장값 하위호환 필수**(옛 intervalMinMin/intervalMaxMin/dailyLimit/message/rooms 보존).

```
Macro {
  boolean enabled;                 // 전역 매크로 on/off (유지)
  // 전역 기본값
  String message;                  // 유지
  int cooldownMinMin = 20;         // 기존 intervalMinMin 을 읽어 마이그레이션
  int cooldownMaxMin = 40;         // 기존 intervalMaxMin
  int minMessages = 1;             // 유지
  String sendImages; int imageEveryN; List<String> images;   // 유지
  String quietFrom, quietTo;       // 유지
  List<String> rooms;              // 대상 방 선택 (유지)
  // 신규: 계정 기본값  (accKey -> AccountCfg)
  Map<String,AccountCfg> accountCfgs;
  // 신규: 방별 덮어쓰기 + 방별 다음 발송 시각  (roomKey -> RoomCfg)
  Map<String,RoomCfg> roomCfgs;
  // dailyLimit 필드 제거 (하위호환 위해 fromJson 에서 읽되 무시)
}

AccountCfg {
  boolean on = true;               // 이 계정 매크로 사용 (계정 화면의 '발송 대상 계정'과 별개로,
                                   //  매크로 자체를 계정 단위로 끌 수 있게)
  boolean hasMsg; String message;
  boolean hasCd;  int cdMinMin, cdMaxMin;
  boolean hasMin; int minMessages;
}

RoomCfg {
  boolean enabled = true;          // 이 방만 매크로 끄기
  boolean hasMsg; String message;
  boolean hasCd;  int cdMinMin, cdMaxMin;
  boolean hasMin; int minMessages;
  long nextAt;                     // 이 방의 다음 발송 예정 시각 (방별 타이머)
}
```

### 해석 메서드 (다른 파일이 쓰는 공개 API — 시그니처 고정)
```
String  effMessage(RoomRef r);        // room.hasMsg ? : acc.hasMsg ? : global
int     effCdMinMin(RoomRef r);       // 쿨타임 하한(분)
int     effCdMaxMin(RoomRef r);       // 쿨타임 상한(분)
int     effMinMessages(RoomRef r);
boolean roomActive(RoomRef r);        // enabled(전역) && accCfg.on && roomCfg.enabled && accountOn(r.acc)
long    roomNextAt(RoomRef r);        // roomCfg.nextAt (없으면 0)
void    setRoomNextAt(RoomRef r, long at);
AccountCfg accCfg(String accKey);     // 없으면 기본 생성해 반환(저장은 호출측 save)
RoomCfg    roomCfg(RoomRef r);        // 없으면 기본 생성해 반환
```
- `roomCfgs`/`accountCfgs` 는 선택된 방/계정에 대해서만 lazily 생성. 선택 해제된 방의 cfg 는 정리해도 된다.
- `message` 가 유효값으로 비어 있으면 그 방은 발송하지 않고 로그로 알린다.

## 3. Scheduler — 방별 타이머 (Scheduler.java)

기존: 전역 nextAt 하나 → 모든 방에 같은 메시지.
신규: **방마다 nextAt**. 한 알람에서 모든 대상 방을 돌며 "지금 >= roomNextAt(r) 이고 새 메시지 조건 충족"인 방만 보낸다.

- `ensureScheduled`: 대상 방들의 roomNextAt 중 **가장 이른 시각**에 알람을 잡는다(없으면 안 잡음).
  roomNextAt 이 0인 방은 지금부터 effCd 범위 랜덤으로 초기화.
- `runDue`: 대상 방(roomActive) 순회. 각 방에 대해
  now >= roomNextAt(r) && othersSinceMine(r) >= effMinMessages(r) 이면
  effMessage(r) 발송 → 성공 시 setRoomNextAt(r, now + 랜덤(effCdMin~effCdMax)).
  아직 때가 아니거나 조건 미충족이면 건너뛴다. 발송 성공 여부와 무관하게 다음 알람은 재계산.
- 계정 간 간격(crossAccountGapMs)은 KakaoListener.sendTo 가 이미 처리하므로 그대로 둔다.
- **일일 한도 체크 전부 제거** (limit, MainActivity.sentToday 기반 중단). 발송 카운트 표시는 유지해도 됨(제한만 제거).
- 방해금지 시간(quietFrom~quietTo)은 전역으로 유지.

## 4. 오픈프로필 키워드 규칙 (AutoReply.java)

`AutoReplyCfg` 에 키워드 규칙 목록 추가:
```
AutoReplyCfg {
  boolean enabled;                 // 기존 '모든 갠톡에 응답' (유지)
  ... 기존 필드 유지 ...
  List<KeywordRule> rules;         // 신규
}
KeywordRule {
  boolean enabled = true;
  String pattern;                  // 감지 문자열
  String mode;                     // contains|exact|startsWith|regex
  boolean ignoreCase = true;
  String reply;                    // 보낼 답장 ({이름}{시간}{날짜} 치환)
  long cooldownMs;                 // 이 규칙의 발신자별 쿨다운 (기본 6시간)
}
```
`onDirectMessage` 동작:
1. 1:1 갠톡 판정(기존 로직) 통과 후, **키워드 규칙을 먼저** 순회 — 매치되는 첫 규칙이 있으면
   그 규칙의 reply 발송(규칙별+발신자별 쿨다운 적용) 후 종료.
2. 매치되는 규칙이 없고 `enabled`(모든 갠톡 응답)가 켜져 있으면 기존 일반 응답 발송.
3. 둘 다 아니면 아무것도 안 함.
운영시간(hourFrom~hourTo)·scope(ALL/UNKNOWN/EXCEPT)·랜덤지연은 양쪽 공통 적용. **일일 한도 제거.**

## 5. UI

### 전역/계정 기본값
- MacroDetail: 매크로 상세의 '메시지'·'쿨타임'은 **전역 기본값** 편집. 라벨에 "기본값"임을 명시.
  (쿨타임 = 기존 '발송 간격' 을 쿨타임 용어로. min~max 랜덤.)
- ScreenAccounts: 각 계정 카드에 '매크로 기본값' 진입 → 그 계정의 message/cooldown/minMessages 덮어쓰기
  + 계정 매크로 on/off. "설정 안 함"이면 전역값을 따른다고 표시.

### 방별 덮어쓰기
- ScreenRooms: 각 방 행을 탭하면(체크박스와 별도로 › 영역) 그 방의 덮어쓰기 편집 화면:
  이 방 매크로 on/off, 메시지(덮어쓰기/기본값 따름), 쿨타임(덮어쓰기/기본값), 최소 메시지.
  현재 유효값을 함께 보여줘 "지금 이 방은 무엇으로 보내지는지" 알 수 있게.

### 일일 제한 제거
- MacroDetail '발송 제한' 화면에서 '하루 최대 발송' 항목 제거(방해금지 시간은 유지).
- MainActivity 홈 요약에서 일일 한도 표시 제거.
- AutoReply UI 의 '하루 최대 응답' 제거.

### 오픈프로필 키워드 규칙
- MacroDetail autoReply 화면에 '키워드 규칙' 섹션: 규칙 목록(사용 토글·✕삭제) + 추가/편집
  (감지 문자열·비교 방식·답장·쿨다운). 메시지 추적(Trigger)의 규칙 편집 UI와 같은 형태로.

## 6. 하위호환
- fromJson: 옛 `intervalMinMin/Max` → `cooldownMinMin/Max`. 옛 `message`·`rooms` 유지.
  옛 `dailyLimit` 는 읽되 버린다. accountCfgs/roomCfgs 없으면 빈 맵(전부 전역값 따름).
- 기존 사용자는 업데이트 후에도 같은 메시지·같은 주기로 모든 방에 발송(전역값) — 동작 동일.
