#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  온디바이스 카카오 엔진 빌드 (build.sh 가 auto 모듈을 만들 때 부른다)
#
#  만드는 것:
#    <출력>/assets/engine/main.js         agent-messenger(kakaotalk) + 엔진 스크립트 한 파일 번들
#    <출력>/assets/engine/NOTICE.txt      번들에 들어간 오픈소스 고지
#    <출력>/lib/<abi>/libnode.so          nodejs-mobile 런타임 (Node 18)
#    <출력>/lib/<abi>/libc++_shared.so    libnode 가 필요로 하는 C++ 런타임 (NDK)
#    <출력>/lib/<abi>/libkmnode.so        libnode 를 프로세스로 띄우는 실행파일 (launcher/kmnode.c)
#
#  사용법:  build-engine.sh <출력 디렉토리> <안드로이드 SDK 경로>
#  환경변수:
#    ENGINE_ABIS   포함할 ABI (기본 "arm64-v8a armeabi-v7a"). 에뮬레이터 시험용: "arm64-v8a x86_64"
#    ANDROID_NDK_HOME / ANDROID_NDK_ROOT   NDK 경로 (없으면 <SDK>/ndk/ 의 최신 버전)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

NODEJS_MOBILE_VERSION="18.20.4"
NODEJS_MOBILE_SHA256="bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af"
NODEJS_MOBILE_URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v${NODEJS_MOBILE_VERSION}/nodejs-mobile-v${NODEJS_MOBILE_VERSION}-android.zip"
MIN_API=26

OUT="${1:?출력 디렉토리를 넘겨줘}"
SDK="${2:-}"
ABIS="${ENGINE_ABIS:-arm64-v8a armeabi-v7a}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$HERE/../.cache"

C_OK=$'\033[1;32m'; C_ER=$'\033[1;31m'; C_IN=$'\033[1;36m'; C_0=$'\033[0m'
step() { printf '%s▸ %s%s\n' "$C_IN" "$*" "$C_0"; }
ok()   { printf '%s✔ %s%s\n' "$C_OK" "$*" "$C_0"; }
die()  { printf '%b✘ %b%b\n' "$C_ER" "$*" "$C_0" >&2; exit 1; }

# ── NDK 찾기 ────────────────────────────────────────────────────────────────
NDK="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
if [ -z "$NDK" ] || [ ! -d "$NDK/toolchains" ]; then
  NDK=""
  if [ -n "$SDK" ] && [ -d "$SDK/ndk" ]; then
    v="$(ls -1 "$SDK/ndk" 2>/dev/null | sort -V | tail -n 1 || true)"
    [ -n "$v" ] && NDK="$SDK/ndk/$v"
  fi
fi
[ -n "$NDK" ] && [ -d "$NDK/toolchains/llvm/prebuilt" ] || die "안드로이드 NDK 를 못 찾았어.
   sdkmanager \"ndk;27.2.12479018\" 로 설치하거나 ANDROID_NDK_HOME 을 지정해줘.
   엔진 없이 빌드하려면: ENGINE=0 ./build.sh auto"
HOST_TAG="$(ls -1 "$NDK/toolchains/llvm/prebuilt" | head -n 1)"
TC="$NDK/toolchains/llvm/prebuilt/$HOST_TAG"
[ -x "$TC/bin/clang" ] || die "NDK clang 이 없어: $TC/bin/clang"

command -v node >/dev/null 2>&1 || die "node 가 없어. 엔진 번들에는 Node.js 18 이상이 필요해 (빌드 PC 기준)."
command -v npm  >/dev/null 2>&1 || die "npm 이 없어."

# ── 1. nodejs-mobile 런타임 받기 (버전 고정 + SHA-256 확인) ──────────────────
mkdir -p "$CACHE"
ZIP="$CACHE/nodejs-mobile-v${NODEJS_MOBILE_VERSION}-android.zip"
RT="$CACHE/nodejs-mobile-v${NODEJS_MOBILE_VERSION}"
if [ ! -f "$ZIP" ]; then
  step "nodejs-mobile v${NODEJS_MOBILE_VERSION} 받기"
  curl -fsSL --retry 3 -o "$ZIP.tmp" "$NODEJS_MOBILE_URL" || die "nodejs-mobile 다운로드 실패: $NODEJS_MOBILE_URL"
  mv "$ZIP.tmp" "$ZIP"
fi
got="$(sha256sum "$ZIP" 2>/dev/null | cut -d' ' -f1 || shasum -a 256 "$ZIP" | cut -d' ' -f1)"
[ "$got" = "$NODEJS_MOBILE_SHA256" ] || { rm -f "$ZIP"; die "nodejs-mobile 해시 불일치 (받은 값 $got). 다시 실행해줘."; }
if [ ! -d "$RT/bin" ]; then
  rm -rf "$RT"; mkdir -p "$RT"
  unzip -q "$ZIP" -d "$RT" || die "nodejs-mobile 압축 해제 실패"
fi

# ── 2. 엔진 스크립트 번들 ────────────────────────────────────────────────────
step "엔진 번들 : agent-messenger → main.js"
if [ ! -d "$HERE/node_modules/agent-messenger" ] || [ "$HERE/package-lock.json" -nt "$HERE/node_modules/.package-lock.json" ]; then
  ( cd "$HERE" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null ) || die "엔진 의존성 설치(npm ci) 실패"
fi
want_lib="$(node -p "require('$HERE/package.json').dependencies['agent-messenger']")"
have_lib="$(node -p "require('$HERE/node_modules/agent-messenger/package.json').version")"
[ "$want_lib" = "$have_lib" ] || die "agent-messenger 버전이 다르다 (package.json $want_lib / 설치 $have_lib). npm ci 를 다시 해줘."
grep -q "agent-messenger@${want_lib}'" "$HERE/src/main.mjs" || die "src/main.mjs 의 LIB 상수를 agent-messenger@${want_lib} 로 맞춰줘."

# agent-messenger 2.38.0 encodes CHECKIN userId with Number(), so ids above
# 2^31-1 become a BSON double and the LOCO session never comes up. POST file
# size is a JS number (int32) while SHIP sends the same size as an int64.
# Both stay library calls; only the BSON type is corrected. Idempotent.
python3 - "$HERE/node_modules/agent-messenger/dist/src/platforms/kakaotalk" <<'PY' || die "LOCO BSON 타입 보정 실패"
import pathlib, sys
root = pathlib.Path(sys.argv[1])
session = root / "protocol/session.js"
media = root / "protocol/media-uploader.js"
st = session.read_text()
old_user = "userId: Number(userId),"
new_user = "userId: Long.fromString(String(userId)),"
if old_user in st:
    st = st.replace(old_user, new_user, 1)
elif new_user not in st:
    raise SystemExit("CHECKIN userId site missing")
session.write_text(st)
mt = media.read_text()
old_size = "s: totalSize,"
new_size = "s: Long.fromNumber(totalSize),"
if old_size in mt:
    mt = mt.replace(old_size, new_size, 1)
elif new_size not in mt:
    raise SystemExit("POST size site missing")
media.write_text(mt)
login = root / "auth/kakao-login.js"
lt = login.read_text()
helper = """function kakaoSentence(data) {
    const m = data && typeof data.message === 'string' ? data.message.trim() : '';
    return m;
}
"""
if "function kakaoSentence" not in lt:
    needle = "const STATUS_DEVICE_NOT_REGISTERED = -100;\n"
    if needle not in lt:
        raise SystemExit("passcode status site missing")
    lt = lt.replace(needle, needle + helper, 1)
repls = [
(
"""            message: typeof data.message === 'string'
                ? `Login failed: ${data.message}`
                : 'Login failed: incorrect email or password.',
        };""",
"""            message: kakaoSentence(data) || 'Login failed: incorrect email or password.',
            status: data.status,
        };""",
),
(
"""        message: `Login failed with status ${data.status}`,
    };""",
"""        message: kakaoSentence(data) || `Login failed with status ${data.status}`,
        status: data.status,
    };""",
),
(
"""        message: `Passcode request failed with status ${data.status ?? 'unknown'}`,
    };""",
"""        message: kakaoSentence(data) || `Passcode request failed with status ${data.status ?? 'unknown'}`,
        status: data.status,
    };""",
),
(
"""                message: `Device registration failed with status ${data.status}`,
            };""",
"""                message: kakaoSentence(data) || `Device registration failed with status ${data.status}`,
                status: data.status,
            };""",
),
]
for old, new in repls:
    if old in lt:
        lt = lt.replace(old, new, 1)
    elif new not in lt:
        raise SystemExit("kakao login message site missing")
# The library has no device-name argument and always sends SM-T870.
# Optional trailing args let one registration attempt use one tablet name.
device_repls = [
(
"""const DEVICE_NAME = 'SM-T870';""",
"""const DEVICE_NAME = 'SM-X710';""",
),
(
"""export async function attemptLogin(email, password, deviceUuid, deviceType, forced, debugLog) {
    const body = new URLSearchParams({
        password,
        device_name: DEVICE_NAME,
        model_name: DEVICE_NAME,""",
"""export async function attemptLogin(email, password, deviceUuid, deviceType, forced, debugLog, deviceName, modelName) {
    const shownName = typeof deviceName === 'string' && deviceName ? deviceName : DEVICE_NAME;
    const shownModel = typeof modelName === 'string' && modelName ? modelName : shownName;
    const body = new URLSearchParams({
        password,
        device_name: shownName,
        model_name: shownModel,""",
),
(
"""    debugLog?.(`device_name=${DEVICE_NAME} device_uuid=${deviceUuid.substring(0, 8)}... forced=${forced}`);""",
"""    debugLog?.(`device_name=${shownName} device_uuid=${deviceUuid.substring(0, 8)}... forced=${forced}`);""",
),
(
"""export async function requestPasscode(email, password, deviceUuid) {
    const headers = buildHeaders(email);""",
"""export async function requestPasscode(email, password, deviceUuid, deviceName, modelName) {
    const shownName = typeof deviceName === 'string' && deviceName ? deviceName : DEVICE_NAME;
    const shownModel = typeof modelName === 'string' && modelName ? modelName : shownName;
    const headers = buildHeaders(email);""",
),
(
"""            device: {
                name: DEVICE_NAME,
                uuid: deviceUuid,
                model: DEVICE_NAME,""",
"""            device: {
                name: shownName,
                uuid: deviceUuid,
                model: shownModel,""",
),
(
"""export async function registerDevice(email, password, _passcode, deviceUuid) {
    const headers = buildHeaders(email);""",
"""export async function registerDevice(email, password, _passcode, deviceUuid, deviceName, modelName) {
    const shownName = typeof deviceName === 'string' && deviceName ? deviceName : DEVICE_NAME;
    const shownModel = typeof modelName === 'string' && modelName ? modelName : shownName;
    const headers = buildHeaders(email);""",
),
(
"""        device: { uuid: deviceUuid },""",
"""        device: { uuid: deviceUuid, name: shownName, model: shownModel },""",
),
]
for old, new in device_repls:
    if old in lt:
        lt = lt.replace(old, new, 1)
    elif new not in lt:
        raise SystemExit("kakao device name site missing")
if "SM-T870" in lt:
    raise SystemExit("SM-T870 is still hardcoded")
login.write_text(lt)
PY

mkdir -p "$OUT/assets/engine"
#  주석·공백을 빼고 순수 ASCII 로 만든다 (1MB → 770KB, 기기에서 파싱할 양이 준다).
#  식별자는 줄이지 않는다 (기기 로그의 스택 트레이스를 읽을 수 있게). 라이선스 고지는 NOTICE.txt 에 있다.
#  ※ KVM 없는 x86_64 에뮬레이터(소프트웨어 CPU)에서는 NaN|0 이 -1 로 계산돼 Node 가 파일을 못 읽는다.
#    엔진 시험은 실기기나 KVM 에뮬레이터에서 해야 한다.
( cd "$HERE" && npx --no-install esbuild src/main.mjs --bundle --platform=node --target=node18 \
    --format=cjs --minify-whitespace --minify-syntax --charset=ascii --legal-comments=none \
    --log-level=warning --outfile="$OUT/assets/engine/main.js" ) \
  || die "엔진 번들 실패"
LC_ALL=C grep -q -P '[^\x00-\x7F]' "$OUT/assets/engine/main.js" && die "main.js 에 비ASCII 바이트가 남았다"
cp "$HERE/NOTICE.txt" "$OUT/assets/engine/NOTICE.txt"
ok "main.js ($(du -h "$OUT/assets/engine/main.js" | cut -f1))"

# ── 3. ABI 별 네이티브 파일 ──────────────────────────────────────────────────
for abi in $ABIS; do
  case "$abi" in
    arm64-v8a)   triple=aarch64-linux-android;   cc_target=aarch64-linux-android$MIN_API ;;
    armeabi-v7a) triple=arm-linux-androideabi;   cc_target=armv7a-linux-androideabi$MIN_API ;;
    x86_64)      triple=x86_64-linux-android;    cc_target=x86_64-linux-android$MIN_API ;;
    *) die "지원하지 않는 ABI: $abi (arm64-v8a · armeabi-v7a · x86_64)" ;;
  esac
  src_node="$RT/bin/$abi/libnode.so"
  src_cxx="$TC/sysroot/usr/lib/$triple/libc++_shared.so"
  [ -f "$src_node" ] || die "nodejs-mobile 에 $abi 런타임이 없어: $src_node"
  [ -f "$src_cxx" ]  || die "NDK 에 $abi libc++_shared.so 가 없어: $src_cxx"

  dst="$OUT/lib/$abi"
  mkdir -p "$dst"
  step "네이티브 : $abi"
  cp "$src_node" "$dst/libnode.so"
  cp "$src_cxx" "$dst/libc++_shared.so"
  "$TC/bin/clang" --target="$cc_target" -O2 -fPIE -pie \
      -o "$dst/libkmnode.so" "$HERE/launcher/kmnode.c" \
      -L"$dst" -lnode -Wl,-rpath,'$ORIGIN' -Wl,--build-id=sha1 \
    || die "$abi 런처 컴파일 실패"
  "$TC/bin/llvm-strip" --strip-unneeded "$dst/libkmnode.so"
done
ok "엔진 준비 완료 (ABI: $ABIS)"
