#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  카톡 매크로 / 관리자앱 빌드 스크립트 (Gradle · AndroidX 없음)
#  aapt2 → javac → d8 → zip → zipalign → apksigner 를 직접 부른다.
#
#  사용법:  ./build.sh [auto|admin|all]     (인자 없으면 all)
#  출력:    android/out/KakaoAuto_v<versionName>.apk
#           android/out/KakaoAdmin_v<versionName>.apk
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── 서명 키 설정 ─────────────────────────────────────────────────────────────
#  의도된 트레이드오프다. 고정 키라야 기존 사용자가 앱을 지우지 않고 덮어쓰기 업데이트를
#  할 수 있으니 keystore/app.jks 를 레포에 두고 기본 비밀번호도 남겨뒀다.
#  대신 비밀번호는 **환경변수 KS_PASS 를 먼저 본다.** 없을 때만 기본값으로 떨어지고,
#  기본값을 쓰면 아래에서 눈에 띄게 경고한다.
#    예) KS_PASS="진짜비번" ./build.sh all
#    CI 는 레포 Settings → Secrets → Actions 의 KEYSTORE_B64 + KS_PASS 로 넘긴다.
KS_PASS_DEFAULT="kakaomacro2026"
KS_PASS="${KS_PASS:-$KS_PASS_DEFAULT}"
if [ "$KS_PASS" = "$KS_PASS_DEFAULT" ]; then KS_PASS_IS_DEFAULT=1; else KS_PASS_IS_DEFAULT=0; fi
KS_ALIAS="app"
KS_CN="KakaoMacro"
KS_VALIDITY_DAYS=10000

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/out"
GEN="$HERE/gen"
BUILD="$HERE/build"
KS_DIR="$HERE/keystore"
KS="$KS_DIR/app.jks"

# ── 로그 헬퍼 ────────────────────────────────────────────────────────────────
C_OK=$'\033[1;32m'; C_ER=$'\033[1;31m'; C_IN=$'\033[1;36m'; C_WA=$'\033[1;33m'; C_0=$'\033[0m'
step() { printf '%s▸ %s%s\n' "$C_IN" "$*" "$C_0"; }
ok()   { printf '%s✔ %s%s\n' "$C_OK" "$*" "$C_0"; }
warn() { printf '%s! %s%s\n' "$C_WA" "$*" "$C_0"; }
die()  { printf '%b✘ %b%b\n' "$C_ER" "$*" "$C_0" >&2; exit 1; }

# ── 0. 기본 서명 비밀번호 경고 ───────────────────────────────────────────────
if [ "$KS_PASS_IS_DEFAULT" = 1 ]; then
  printf '%s\n' "$C_WA"
  printf '  !! 기본 키스토어 비밀번호를 쓰고 있어.\n'
  printf '     레포가 공개되면(또는 한 번이라도 유출되면) 누구나 정품과 똑같은 서명으로\n'
  printf '     개조 APK 를 만들 수 있어서 서명 핀닝(ALLOWED_APP_SIGS)이 무력화돼.\n'
  printf '     → 레포는 Private 으로 유지하고, 비번은 환경변수로 넘겨라:\n'
  printf '         KS_PASS="<진짜 비번>" ./build.sh all\n'
  printf '     → CI 는 GitHub Secret KEYSTORE_B64 + KS_PASS 를 쓴다 (docs/ANTI_ABUSE.md 2단)\n'
  printf '%s\n' "$C_0"
fi

# ── 1. 안드로이드 SDK 찾기 ───────────────────────────────────────────────────
SDK="${ANDROID_HOME:-}"
if [ -z "$SDK" ] || [ ! -d "$SDK/platforms" ]; then
  [ -z "$SDK" ] || warn "ANDROID_HOME 경로에 platforms/ 가 없어: $SDK"
  SDK="${ANDROID_SDK_ROOT:-}"
fi
if [ -z "$SDK" ] || [ ! -d "$SDK/platforms" ]; then
  [ -z "$SDK" ] || warn "ANDROID_SDK_ROOT 경로에 platforms/ 가 없어: $SDK"
  SDK=""
  for cand in "${HOME:-/root}/Android/Sdk" "${HOME:-/root}/Library/Android/sdk" /opt/android-sdk /usr/lib/android-sdk /usr/local/lib/android/sdk; do
    if [ -d "$cand/platforms" ]; then SDK="$cand"; break; fi
  done
fi
if [ -z "$SDK" ] || [ ! -d "$SDK/platforms" ]; then
  die "안드로이드 SDK 를 못 찾았어.
   ANDROID_HOME 또는 ANDROID_SDK_ROOT 환경변수를 SDK 경로로 지정해줘. 예:
     export ANDROID_HOME=\$HOME/Android/Sdk
   SDK 가 아직 없으면 commandline-tools 를 받아서 아래처럼 설치하면 돼:
     sdkmanager \"platforms;android-34\" \"build-tools;34.0.0\""
fi

# ── 2. 플랫폼(android.jar) 고르기 : android-34 우선, 없으면 가장 높은 버전 ────
ANDROID_JAR="$SDK/platforms/android-34/android.jar"
if [ ! -f "$ANDROID_JAR" ]; then
  FOUND=""
  for p in $(ls -1 "$SDK/platforms" 2>/dev/null | grep -E '^android-[0-9]+$' | sed 's/android-//' | sort -n -r); do
    if [ -f "$SDK/platforms/android-$p/android.jar" ]; then FOUND="$p"; break; fi
  done
  [ -n "$FOUND" ] || die "android.jar 이 하나도 없어. 'sdkmanager \"platforms;android-34\"' 로 설치해줘."
  warn "android-34 가 없어서 android-$FOUND 로 컴파일한다 (targetSdk 34 권장)."
  ANDROID_JAR="$SDK/platforms/android-$FOUND/android.jar"
fi

# ── 3. build-tools 최신 버전 자동 선택 ───────────────────────────────────────
[ -d "$SDK/build-tools" ] || die "build-tools 가 없어. 'sdkmanager \"build-tools;34.0.0\"' 로 설치해줘."
BT_VER="$(ls -1 "$SDK/build-tools" 2>/dev/null | grep -E '^[0-9]+(\.[0-9]+)*' | sort -V | tail -n 1 || true)"
[ -n "$BT_VER" ] || die "build-tools 디렉토리가 비어있어. 'sdkmanager \"build-tools;34.0.0\"' 로 설치해줘."
BT="$SDK/build-tools/$BT_VER"
AAPT2="$BT/aapt2"; D8="$BT/d8"; ZIPALIGN="$BT/zipalign"; APKSIGNER="$BT/apksigner"
for t in "$AAPT2" "$D8" "$ZIPALIGN" "$APKSIGNER"; do
  [ -x "$t" ] || die "$t 가 없거나 실행할 수 없어. build-tools($BT_VER) 설치가 깨진 것 같아."
done
command -v javac >/dev/null 2>&1 || die "javac 가 없어. JDK 17 이상을 설치하고 PATH 에 넣어줘."
command -v keytool >/dev/null 2>&1 || die "keytool 이 없어. JDK 설치를 확인해줘."
command -v zip >/dev/null 2>&1 || die "zip 명령이 없어. 'apt-get install zip' 으로 설치해줘."

# ── 4. javac 옵션 결정 ───────────────────────────────────────────────────────
#  SPEC 은 -bootclasspath android.jar 을 쓰라고 하지만 JDK 12+ 는 target 9 이상에서
#  -bootclasspath 를 거부한다. 그래서 먼저 시도해보고 거부당하면 -classpath 로 떨어진다.
JAVAC_LIB=()
probe_javac() {
  local d; d="$(mktemp -d)"
  printf 'class _Probe {}\n' > "$d/_Probe.java"
  if javac -source 17 -target 17 -nowarn -bootclasspath "$ANDROID_JAR" -d "$d" "$d/_Probe.java" >/dev/null 2>&1; then
    JAVAC_LIB=(-bootclasspath "$ANDROID_JAR")
  else
    JAVAC_LIB=(-classpath "$ANDROID_JAR")
  fi
  rm -rf "$d"
}
probe_javac

# ── 5. 키스토어 준비 ─────────────────────────────────────────────────────────
mkdir -p "$KS_DIR"
if [ -n "${KEYSTORE_B64:-}" ]; then
  step "KEYSTORE_B64 환경변수로 서명키를 복원한다"
  printf '%s' "$KEYSTORE_B64" | tr -d '\r\n ' | base64 -d > "$KS.tmp" 2>/dev/null \
    || die "KEYSTORE_B64 디코드 실패. base64 -w0 app.jks 결과를 그대로 넣었는지 확인해줘."
  [ -s "$KS.tmp" ] || die "KEYSTORE_B64 를 디코드했는데 내용이 비어있어."
  mv "$KS.tmp" "$KS"
  ok "서명키 복원 완료 ($KS)"
elif [ ! -f "$KS" ]; then
  step "서명키가 없어서 새로 만든다 (RSA 2048 · ${KS_VALIDITY_DAYS}일)"
  keytool -genkeypair -v \
    -keystore "$KS" -alias "$KS_ALIAS" \
    -keyalg RSA -keysize 2048 -validity "$KS_VALIDITY_DAYS" \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=$KS_CN, OU=KakaoMacro, O=KakaoMacro, L=Seoul, C=KR" >/dev/null
  ok "서명키 생성 완료 ($KS)"
  warn "이 파일(keystore/app.jks)을 잃어버리면 다음 버전을 덮어쓰기 업데이트할 수 없다(사용자가 앱을 지워야 한다).
   지금 바로 레포 밖 안전한 곳에 백업해라 — 예: base64 -w0 keystore/app.jks 를 비밀 저장소에 보관.
   레포에 커밋해서 보관하는 건 Private 레포 전제에서만 해라. 공개로 바꿀 거면 파일을 지우고
   KEYSTORE_B64 + KS_PASS 를 GitHub Secret 으로 옮겨라 (절차: android/README.md 3-2).
   ★ 새로 만든 키는 서명 hex 가 이전과 다르다 → docs/APP_SIGNATURE_HISTORY.md 에 행을 추가하고,
     기존 사용자가 있으면 ALLOWED_APP_SIGS 이관 단계를 처음부터 다시 밟아야 한다 (DEPLOY.md 4-2)."
fi
[ -f "$KS" ] || die "서명키($KS)를 준비하지 못했어."

# ── 6. 모듈 한 개 빌드 ───────────────────────────────────────────────────────
#  $1 = 모듈 디렉토리명 (auto|admin)
#  $2 = 자바 패키지 (com.buseong.kakaoauto)
#  $3 = 출력 APK 이름 접두 (KakaoAuto)
build_module() {
  local mod="$1" pkg="$2" apkname="$3"
  local src="$HERE/$mod"
  local manifest="$src/AndroidManifest.xml"
  local bdir="$BUILD/$mod"
  local gdir="$GEN/$mod"

  [ -f "$manifest" ] || die "$manifest 가 없어."
  [ -d "$src/res" ]  || die "$src/res 가 없어."

  local vname vcode
  vname="$(grep -o 'android:versionName="[^\"]*"' "$manifest" | head -n 1 | sed 's/.*="\(.*\)"/\1/')"
  vcode="$(grep -o 'android:versionCode="[^\"]*"' "$manifest" | head -n 1 | sed 's/.*="\(.*\)"/\1/')"
  [ -n "$vname" ] || die "$manifest 에서 android:versionName 을 못 읽었어."
  [ -n "$vcode" ] || vcode="?"

  printf '\n%s━━━ %s 빌드 (%s · v%s · code %s) ━━━%s\n' "$C_IN" "$mod" "$pkg" "$vname" "$vcode" "$C_0"

  rm -rf "$bdir" "$gdir"
  mkdir -p "$bdir/classes" "$bdir/dex" "$gdir" "$OUT"

  # 6-0. 폰 내장 카카오 엔진 (auto 전용 · ENGINE=0 이면 건너뜀)
  #  nodejs-mobile libnode + agent-messenger 번들을 만들어 assets/ 와 lib/<abi>/ 에 넣는다.
  #  ABI 는 ENGINE_ABIS 로 고른다 (기본 arm64-v8a armeabi-v7a · 에뮬레이터는 x86_64 추가).
  local eng_assets=()
  if [ "$mod" = auto ] && [ "${ENGINE:-1}" != 0 ]; then
    step "engine : 폰 내장 카카오 엔진 (${ENGINE_ABIS:-arm64-v8a armeabi-v7a})"
    "$HERE/engine/build-engine.sh" "$bdir/engine" "$SDK" \
      || die "엔진 빌드 실패. NDK 가 없으면 'sdkmanager \"ndk;27.2.12479018\"', Node 가 없으면 Node 18+ 를 설치해줘.
   엔진 없이 빌드하려면 ENGINE=0 ./build.sh auto"
    eng_assets=(-A "$bdir/engine/assets")
  elif [ "$mod" = auto ]; then
    warn "ENGINE=0 → 폰 내장 카카오 엔진 없이 빌드한다 (알림 답장 경로만 동작)"
  fi

  # 6-1. 리소스 컴파일
  step "aapt2 compile : 리소스"
  "$AAPT2" compile --dir "$src/res" -o "$bdir/res.zip" \
    || die "$mod 리소스 컴파일 실패 (res/ 안의 XML 문법을 확인해줘)"

  # 6-2. 링크 + R.java 생성
  step "aapt2 link : 매니페스트 + R.java"
  "$AAPT2" link \
    -o "$bdir/base.apk" \
    -I "$ANDROID_JAR" \
    --manifest "$manifest" \
    --java "$gdir" \
    --auto-add-overlay \
    ${eng_assets[@]+"${eng_assets[@]}"} \
    "$bdir/res.zip" \
    || die "$mod 링크 실패 (매니페스트나 리소스 참조를 확인해줘)"

  # 6-3. 자바 컴파일
  local srclist="$bdir/sources.txt"
  : > "$srclist"
  [ -d "$src/java" ] || die "$src/java 가 없어. 자바 소스를 먼저 넣어줘."
  find "$src/java" -name '*.java' -type f >> "$srclist"
  local n; n="$(wc -l < "$srclist" | tr -d ' ')"
  [ "$n" -gt 0 ] || die "$src/java 안에 .java 파일이 하나도 없어. 자바 소스를 먼저 넣어줘."
  find "$gdir" -name 'R.java' -type f >> "$srclist"
  n="$(wc -l < "$srclist" | tr -d ' ')"
  step "javac : 자바 소스 $n 개"
  #  -parameters 는 필수다. JDK 21 javac 는 "익명클래스 안의 익명클래스" 생성자에
  #  이름이 빈 MethodParameters 속성을 남기는데, build-tools 34 의 d8 이 그걸 읽다가
  #  NullPointerException 으로 죽는다. -parameters 를 주면 이름(this$0)이 채워져서 통과한다.
  javac -source 17 -target 17 -nowarn -encoding UTF-8 -parameters \
    "${JAVAC_LIB[@]}" \
    -d "$bdir/classes" \
    @"$srclist" \
    || die "$mod 자바 컴파일 실패"

  # 6-4. dex 변환
  step "d8 : dex 변환"
  local d8libs=(--lib "$ANDROID_JAR")
  [ -f "$BT/core-lambda-stubs.jar" ] && d8libs+=(--lib "$BT/core-lambda-stubs.jar")
  local classfiles="$bdir/classes.txt"
  find "$bdir/classes" -name '*.class' -type f > "$classfiles"
  "$D8" --min-api 26 --release "${d8libs[@]}" \
    --output "$bdir/dex" \
    @"$classfiles" \
    || die "$mod dex 변환 실패"
  ls "$bdir/dex"/classes*.dex >/dev/null 2>&1 || die "$mod dex 출력이 비었어."

  # 6-5. dex 를 APK(zip) 안에 넣기
  step "zip : classes.dex 삽입"
  local unsigned="$bdir/unsigned.apk"
  cp "$bdir/base.apk" "$unsigned"
  ( cd "$bdir/dex" && zip -q -X -j "$unsigned" classes*.dex ) \
    || die "$mod dex 삽입 실패"
  if [ -d "$bdir/engine/lib" ]; then
    step "zip : 엔진 네이티브 라이브러리 삽입"
    ( cd "$bdir/engine" && zip -q -X -r "$unsigned" lib ) \
      || die "$mod 엔진 라이브러리 삽입 실패"
  fi

  # 6-6. 정렬
  step "zipalign : 4바이트 정렬"
  local aligned="$bdir/aligned.apk"
  rm -f "$aligned"
  "$ZIPALIGN" -p -f 4 "$unsigned" "$aligned" || die "$mod zipalign 실패"

  # 6-7. 서명
  step "apksigner : 서명"
  local final="$OUT/${apkname}_v${vname}.apk"
  rm -f "$final"
  #  비번은 pass: 대신 env: 로 넘긴다 — pass: 는 같은 기기의 다른 사용자가
  #  ps 로 명령줄을 읽으면 그대로 보인다.
  export KS_PASS_FOR_SIGN="$KS_PASS"
  "$APKSIGNER" sign \
    --ks "$KS" --ks-key-alias "$KS_ALIAS" \
    --ks-pass "env:KS_PASS_FOR_SIGN" --key-pass "env:KS_PASS_FOR_SIGN" \
    --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
    --out "$final" "$aligned" \
    || die "$mod 서명 실패"
  rm -f "$final.idsig"

  ok "$(basename "$final")  ($(du -h "$final" | cut -f1))"
  APKS+=("$final")
}

# ── 7. 서명 지문 출력 ───────────────────────────────────────────────────────
print_sig() {
  local apk="$1"
  local line sha colon plain
  line="$("$APKSIGNER" verify --print-certs "$apk" 2>/dev/null | grep -i 'SHA-256 digest' | head -n 1 || true)"
  if [ -z "$line" ]; then
    warn "$(basename "$apk") 의 서명 지문을 읽지 못했어."
    return 0
  fi
  plain="$(printf '%s' "$line" | sed 's/.*: *//' | tr -d ' :' | tr 'A-F' 'a-f')"
  colon="$(printf '%s' "$plain" | sed 's/../&:/g; s/:$//' | tr 'a-f' 'A-F')"
  printf '  %s\n' "$(basename "$apk")"
  printf '    콜론 있는 형식 : %s\n' "$colon"
  printf '    서버 등록용 hex: %s\n' "$plain"
  SIG_HEXES+=("$plain")
}

# ── 7-1. docs/APP_SIGNATURE.txt 기록 ────────────────────────────────────────
#  이 파일은 "방금 빌드한 APK 의 hex" 만 들고 있는 기계 판독용 파일이다.
#  빌드마다 덮어쓰므로 이력이 남지 않는다 → 알려진 서명 전부는 docs/APP_SIGNATURE_HISTORY.md 에 있다.
#  그래서 "출력 hex 와 APP_SIGNATURE.txt 가 같은지" 확인하는 건 의미가 없다(항상 같다).
#  검증은 아래 check_sig_history() 가 히스토리 파일과 대조해서 해준다.
write_sig_file() {
  local docs="$HERE/../docs"
  local f="$docs/APP_SIGNATURE.txt"
  [ -d "$docs" ] || return 0
  [ "${#SIG_HEXES[@]}" -gt 0 ] || return 0
  printf '%s\n' "${SIG_HEXES[@]}" | awk 'NF && !seen[$0]++' > "$f.tmp" || return 0
  mv "$f.tmp" "$f"
  ok "docs/APP_SIGNATURE.txt 갱신 ($(wc -l < "$f" | tr -d ' ')줄 · 현재 빌드 값)"
}

# ── 7-2. 히스토리 파일과 대조 (서명키가 바뀌었는지 확인) ────────────────────
#  docs/APP_SIGNATURE_HISTORY.md 에 적힌 알려진 hex 중에 방금 값이 있는지 본다.
#  없으면 키스토어가 바뀐 것 → 그대로 배포하면 사용자 전원이 앱을 지워야 한다.
check_sig_history() {
  local hist="$HERE/../docs/APP_SIGNATURE_HISTORY.md"
  [ -f "$hist" ] || return 0
  [ "${#SIG_HEXES[@]}" -gt 0 ] || return 0
  local unknown=0 h
  for h in "${SIG_HEXES[@]}"; do
    if grep -qi -- "$h" "$hist"; then
      ok "서명 hex 가 docs/APP_SIGNATURE_HISTORY.md 에 있는 값이야 (키스토어 그대로)"
    else
      unknown=1
      printf '%s\n' "$C_ER"
      printf '  !! 이 서명 hex 는 docs/APP_SIGNATURE_HISTORY.md 에 없는 값이야:\n'
      printf '       %s\n' "$h"
      printf '     = 서명키(keystore/app.jks)가 바뀌었다는 뜻이다.\n'
      printf '     이대로 배포하면 기존 사용자가 앱을 지우고 다시 깔아야 한다.\n'
      printf '     → 배포를 멈추고 키 백업을 먼저 확인해라 (android/README.md 3-1).\n'
      printf '     → 키를 일부러 바꾼 거면 히스토리 파일에 행을 추가하고 이관 단계를 다시 밟아라.\n'
      printf '%s\n' "$C_0"
    fi
  done
  [ "$unknown" = 0 ] || warn "알 수 없는 서명이 있다 (위 경고 참고)"
}

# ── 8. 메인 ─────────────────────────────────────────────────────────────────
TARGET="${1:-all}"
APKS=()
SIG_HEXES=()
case "$TARGET" in
  auto)  build_module auto  com.buseong.kakaoauto  KakaoAuto ;;
  admin) build_module admin com.buseong.kakaoadmin KakaoAdmin ;;
  all)   build_module auto  com.buseong.kakaoauto  KakaoAuto
         build_module admin com.buseong.kakaoadmin KakaoAdmin ;;
  -h|--help|help)
         printf '사용법: %s [auto|admin|all]\n' "$(basename "$0")"; exit 0 ;;
  *)     die "무슨 뜻인지 모르겠어: '$TARGET'\n사용법: ./build.sh [auto|admin|all]" ;;
esac

printf '\n%s━━━ 서명 SHA-256 ━━━%s\n' "$C_IN" "$C_0"
for a in "${APKS[@]}"; do print_sig "$a"; done
write_sig_file
check_sig_history
cat <<'NOTE'

  ↑ 위의 "서버 등록용 hex" 가 이 빌드의 앱 서명이다.
    docs/APP_SIGNATURE.txt 에도 같은 값을 써뒀다(기계 판독용 · 빌드마다 덮어씀).
    알려진 서명 전부(구버전 포함)는 docs/APP_SIGNATURE_HISTORY.md 에 있다.
    ※ 출력값을 APP_SIGNATURE.txt 와 비교하는 건 의미가 없다 — 방금 그 파일을 덮어썼으니 항상 같다.
      대조는 히스토리 파일과 해라 (위에서 자동으로 한 번 확인했다).

  ℹ️ 위 hex 를 Render ALLOWED_APP_SIGS 에 넣어라 — 지금 넣어도 구버전은 안 잠긴다.
     서명 검사 강도는 APP_SIG_MODE 가 따로 정한다 (안 넣으면 lenient):
       lenient(기본) : app_sig 를 보냈으면 대조, 안 보냈으면 통과 → v1.8 과 공존 가능
       strict        : app_sig 필수 → v1.8 은 전원 차단된다 (전원 v2.0 전환 후에만 켜라)
     → 이관 중        : APP_SIG_MODE 비워두기 + MIN_APP_VERSION=0
     → 전환 완료 후   : APP_SIG_MODE=strict + MIN_APP_VERSION=20
     (Render → Environment, 또는 관리자앱 [설정] → 앱서명 허용목록)
     단계별 확인 방법은 DEPLOY.md 4-2 / android/README.md 5-2 의 표를 봐라.

NOTE
printf '%s완료. 결과물: %s%s\n' "$C_OK" "$OUT" "$C_0"
